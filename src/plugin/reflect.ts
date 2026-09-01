import { spawn, type ChildProcess } from 'node:child_process';
import { acquireReflectorLock, releaseReflectorLock } from './locks.js';

/**
 * Background reflection (Hermes "Layer B"): a forked, headless agent that reviews
 * the just-finished session and, if it finds reusable work or an outdated skill,
 * creates/improves exactly one skill — autonomously, no user trigger.
 *
 * Safety guards (after the 0.1.0 runaway-CPU incident):
 *  - a global single-flight lock so reflectors never stack (acquireReflectorLock),
 *  - a hard wall-clock timeout that SIGKILLs a stuck reflector,
 *  - `--max-turns` so the agent can't loop indefinitely,
 *  - recursion guard via REFLECT_ENV.
 * The watchdog (reflectRun) enforces all of these; the hook just spawns it.
 */

export type ReflectAgent = 'claude' | 'codex';

/** Env flag set on the spawned reflector so its own Stop hook no-ops (no recursion). */
export const REFLECT_ENV = 'SKILLMAX_REFLECT';

/** Hard wall-clock cap for a single reflector run. */
export const REFLECT_TIMEOUT_MS = 5 * 60 * 1000;

/** Max agent turns for the reflector so it cannot loop. */
export const REFLECT_MAX_TURNS = 25;

const ALLOWED_TOOLS =
  'Read,Glob,Grep,Write,Edit,Bash(airbot:*),Bash(skillmaxxing:*),Bash(skill-maxing:*),Bash(skillmax:*),Bash(npx:*)';

export function isReflecting(): boolean {
  return process.env[REFLECT_ENV] === '1';
}

export function buildReflectionPrompt(transcriptPath: string): string {
  return [
    'You are the Airbot background reflector. Review the coding session transcript at:',
    `  ${transcriptPath}`,
    '',
    'Decide whether the session contains EITHER:',
    '  (a) a reusable workflow worth saving as a new skill, or',
    '  (b) a skill that was used and turned out incomplete/outdated/wrong.',
    '',
    'If neither, do nothing and exit — most sessions should produce no skill.',
    'If one applies, take exactly ONE action, conservatively:',
    '  - First search existing skills: `airbot discover "<capability>" --json`.',
    '  - PREFER updating an existing skill over creating a near-duplicate.',
    '  - To create: write a draft JSON (name, description, body, optional scripts, and a',
    '    REQUIRED eval scaffold — at least one scorable task; an agent-judge task with a',
    '    rubric is fine for prose) then `airbot skillify --draft <file> --commit <name>`.',
    '    A skill with no eval task is rejected, so the loop can grade it later.',
    '  - CHOOSE SCOPE (avoid skill pollution): default to PROJECT scope. Add `-g` for',
    '    user/global scope ONLY if the skill transfers to ANY codebase — e.g. a general',
    '    language/framework technique, a debugging method, a git workflow. A skill about',
    '    THIS repo (its build, layout, deps, conventions) stays project-local. When unsure,',
    '    keep it project-local: `airbot skillify --draft <file> --commit <name>` (add',
    '    `-g` only for the reusable case).',
    '  - To improve: run the eval-gated `airbot optimize` loop.',
    '',
    'New/changed skills are recorded trusted:false for the user to review. Do NOT modify',
    'project source code. Do NOT install or execute untrusted skills. One skill at most.',
  ].join('\n');
}

/**
 * Spawn the watchdog (this CLI's `plugin reflect-run`) detached so the Stop hook
 * returns immediately. The watchdog owns the lock + timeout. Returns true if a
 * process was launched.
 */
export function spawnReflector(opts: {
  cli: string;
  agent: ReflectAgent;
  transcriptPath: string;
  cwd: string;
}): boolean {
  const cmd = `${opts.cli} plugin reflect-run --agent ${opts.agent} --transcript ${JSON.stringify(
    opts.transcriptPath,
  )}`;
  try {
    const child = spawn(cmd, {
      cwd: opts.cwd,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      shell: true, // cli may be a multi-token "npx -y airbot-cli@x"
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Watchdog body: acquire the global lock, run the reflector agent under a hard
 * timeout, then release the lock. Exits the process when done. If the lock is
 * already held by a live reflector, exits immediately (single-flight).
 */
export function reflectRun(opts: { agent: ReflectAgent; transcriptPath: string }): void {
  if (!opts.transcriptPath) {
    process.exit(0);
  }
  if (!acquireReflectorLock()) {
    process.exit(0); // another reflector is already running
  }

  const env = { ...process.env, [REFLECT_ENV]: '1' };
  const prompt = buildReflectionPrompt(opts.transcriptPath);

  let command: string;
  let args: string[];
  if (opts.agent === 'claude') {
    command = 'claude';
    args = ['-p', prompt, '--max-turns', String(REFLECT_MAX_TURNS), '--allowedTools', ALLOWED_TOOLS];
  } else {
    command = 'codex';
    args = ['exec', prompt];
  }

  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'ignore' });
  } catch {
    releaseReflectorLock();
    process.exit(0);
    return;
  }

  const kill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, REFLECT_TIMEOUT_MS);
  const hardExit = setTimeout(() => {
    releaseReflectorLock();
    process.exit(0);
  }, REFLECT_TIMEOUT_MS + 10_000);

  const finish = (): void => {
    clearTimeout(kill);
    clearTimeout(hardExit);
    releaseReflectorLock();
    process.exit(0);
  };
  child.on('exit', finish);
  child.on('error', finish);
}
