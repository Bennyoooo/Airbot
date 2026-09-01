import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ensureDir } from '../util/fs.js';
import { SKILLS_GUIDANCE, REFLECT_NUDGE } from '../plugin/guidance.js';
import { countToolUses, shouldReflect, markReflected, readSession } from '../plugin/sessions.js';
import { spawnReflector, reflectRun, isReflecting, type ReflectAgent } from '../plugin/reflect.js';
import * as log from '../util/log.js';

export type ReflectMode = 'auto' | 'nudge';

export interface PluginArgs {
  action: 'install' | 'uninstall' | 'status' | 'guidance' | 'on-tool' | 'on-stop' | 'reflect-run';
  agent?: ReflectAgent;
  mode?: ReflectMode;
  threshold?: number;
  project?: boolean;
  /** Transcript path for the reflect-run watchdog. */
  transcriptPath?: string;
}

const DEFAULT_THRESHOLD = 10;
/** Per-session minimum interval between reflections (complements the global lock). */
const REFLECT_COOLDOWN_MS = 30 * 60 * 1000;

/** Identify hooks we own (any of our bin names), keyed on our unique subcommands. */
function isOurHook(command: unknown): boolean {
  return typeof command === 'string' && /\bplugin (guidance|on-tool|on-stop)\b/.test(command);
}

// ---------- shared helpers ----------

function pkgVersion(): string {
  try {
    return createRequire(import.meta.url)('../../package.json').version ?? 'latest';
  } catch {
    return 'latest';
  }
}

/**
 * Resolve a command that will reliably invoke this CLI from inside a hook on ANY
 * machine, indefinitely — the hook must never point at a binary that disappears.
 * Priority:
 *   1. Running as a real GLOBAL install -> bare `skillmaxxing` (fast, persistent).
 *   2. A stable bin on PATH that is NOT an ephemeral npx-cache bin -> use it.
 *   3. Otherwise -> `npx -y skillmaxxing@<version>` (self-sufficient, no global
 *      install needed; pinned for reproducibility). `persistent:false` so the
 *      installer can recommend a global install for speed.
 */
function resolveCli(): { cmd: string; persistent: boolean } {
  const here = fileURLToPath(import.meta.url);
  try {
    const globalRoot = fs.realpathSync(execSync('npm root -g', { encoding: 'utf-8' }).trim());
    if (here.startsWith(globalRoot + path.sep)) return { cmd: 'skillmaxxing', persistent: true };
  } catch {
    /* npm not available — fall through */
  }
  for (const bin of ['skillmaxxing', 'skill-maxing', 'skillmax']) {
    try {
      const p = execSync(`command -v ${bin}`, { encoding: 'utf-8' }).trim();
      if (p && !fs.realpathSync(p).includes(`${path.sep}_npx${path.sep}`)) {
        return { cmd: bin, persistent: true };
      }
    } catch {
      /* not on PATH */
    }
  }
  return { cmd: `npx -y skillmaxxing@${pkgVersion()}`, persistent: false };
}

function readStdin(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function claudeSettingsPath(project: boolean): string {
  return project
    ? path.join(process.cwd(), '.claude', 'settings.json')
    : path.join(os.homedir(), '.claude', 'settings.json');
}

function readJson(file: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

interface HookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string }[];
}

/** Drop any hook groups in `list` that belong to skill-maxing. */
function stripOurs(list: HookEntry[] | undefined): HookEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((g) => !(g.hooks ?? []).some((h) => isOurHook(h.command)));
}

// ---------- install / uninstall / status ----------

function install(args: PluginArgs): void {
  const agent: ReflectAgent = args.agent ?? 'claude';
  const mode: ReflectMode = args.mode ?? 'auto';
  const threshold = args.threshold ?? DEFAULT_THRESHOLD;

  if (agent === 'codex') {
    installCodex();
    return;
  }

  const { cmd: cli, persistent } = resolveCli();
  const file = claudeSettingsPath(args.project ?? false);
  const settings = readJson(file);
  settings.hooks = settings.hooks ?? {};

  // Two hooks only — no per-tool hook. SessionStart injects standing guidance
  // (Layer A); Stop runs the reflection loop (Layer B), counting tool calls from
  // the transcript so there is zero per-tool overhead on any install path.
  settings.hooks.SessionStart = [
    ...stripOurs(settings.hooks.SessionStart),
    { hooks: [{ type: 'command', command: `${cli} plugin guidance` }] },
  ];
  settings.hooks.Stop = [
    ...stripOurs(settings.hooks.Stop),
    {
      hooks: [
        {
          type: 'command',
          command: `${cli} plugin on-stop --agent ${agent} --mode ${mode} --threshold ${threshold}`,
        },
      ],
    },
  ];
  // Remove any legacy per-tool hooks left by older installs.
  settings.hooks.PostToolUse = stripOurs(settings.hooks.PostToolUse);
  if (Array.isArray(settings.hooks.PostToolUse) && settings.hooks.PostToolUse.length === 0) {
    delete settings.hooks.PostToolUse;
  }

  writeJson(file, settings);

  log.success(`Skill Maxing installed for Claude Code (${mode} mode).`);
  log.info(`  hooks written to ${file}`);
  log.info(`  SessionStart: standing skill-creation guidance`);
  log.info(
    mode === 'auto'
      ? `  Stop: background reflection after ${threshold}+ tool calls (trusted:false drafts)`
      : `  Stop: in-session reminder after ${threshold}+ tool calls`,
  );
  if (!persistent) {
    log.warn(
      'Hooks use `npx` (no global install found) — adds latency at each turn end. ' +
        'For best speed: npm i -g skillmaxxing && skillmaxxing plugin install',
    );
  }
  log.info('No explicit trigger needed — restart your agent session to activate.');
  log.info('Uninstall any time with: skillmaxxing plugin uninstall');
}

const CODEX_MARK_START = '<!-- skill-maxing:start -->';
const CODEX_MARK_END = '<!-- skill-maxing:end -->';

function installCodex(): void {
  // Codex lacks programmatic Stop/PostToolUse hooks, so we deliver the standing
  // guidance via AGENTS.md (Layer A). The agent then self-evolves per instruction.
  const file = path.join(process.cwd(), 'AGENTS.md');
  let body = '';
  try {
    body = fs.readFileSync(file, 'utf-8');
  } catch {
    /* new file */
  }
  const block = `${CODEX_MARK_START}\n## Skill Maxing\n\n${SKILLS_GUIDANCE}\n${CODEX_MARK_END}`;
  const re = new RegExp(`${CODEX_MARK_START}[\\s\\S]*?${CODEX_MARK_END}`);
  body = re.test(body) ? body.replace(re, block) : `${body.trimEnd()}\n\n${block}\n`;
  fs.writeFileSync(file, body.replace(/^\n+/, ''));
  log.success('Skill Maxing installed for Codex (guidance written to AGENTS.md).');
  log.info('Codex has no Stop hook; self-evolution runs in-session via standing guidance.');
}

function uninstall(args: PluginArgs): void {
  const agent: ReflectAgent = args.agent ?? 'claude';
  if (agent === 'codex') {
    const file = path.join(process.cwd(), 'AGENTS.md');
    try {
      const body = fs.readFileSync(file, 'utf-8');
      const re = new RegExp(`\\n*${CODEX_MARK_START}[\\s\\S]*?${CODEX_MARK_END}\\n*`);
      fs.writeFileSync(file, body.replace(re, '\n'));
      log.success('Removed Skill Maxing guidance from AGENTS.md.');
    } catch {
      log.info('Nothing to uninstall.');
    }
    return;
  }
  const file = claudeSettingsPath(args.project ?? false);
  const settings = readJson(file);
  if (settings.hooks) {
    settings.hooks.SessionStart = stripOurs(settings.hooks.SessionStart);
    settings.hooks.PostToolUse = stripOurs(settings.hooks.PostToolUse);
    settings.hooks.Stop = stripOurs(settings.hooks.Stop);
    for (const k of ['SessionStart', 'PostToolUse', 'Stop']) {
      if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) delete settings.hooks[k];
    }
  }
  writeJson(file, settings);
  log.success(`Removed Skill Maxing hooks from ${file}.`);
}

function status(args: PluginArgs): void {
  const file = claudeSettingsPath(args.project ?? false);
  const settings = readJson(file);
  const owned: string[] = [];
  for (const k of ['SessionStart', 'PostToolUse', 'Stop']) {
    const groups: HookEntry[] = settings.hooks?.[k] ?? [];
    if (groups.some((g) => (g.hooks ?? []).some((h) => isOurHook(h.command)))) owned.push(k);
  }
  if (owned.length > 0) {
    log.success(`Skill Maxing is active for Claude Code: ${owned.join(', ')} hooks (${file}).`);
  } else {
    log.info('Skill Maxing is not installed for Claude Code. Run: skillmaxxing plugin install');
  }
}

// ---------- hook entrypoints ----------

function guidance(): void {
  // SessionStart additionalContext — injects the standing nudge into the agent.
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SKILLS_GUIDANCE },
    }),
  );
}

function onTool(): void {
  // Deprecated no-op: tool counting moved to the Stop hook (transcript-based).
  // Retained so hooks left by older installs do not error.
}

function onStop(args: PluginArgs): void {
  if (isReflecting()) return; // recursion guard: the reflector must never re-trigger
  const input = readStdin();
  const id = typeof input.session_id === 'string' ? input.session_id : 'default';
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const mode: ReflectMode = args.mode ?? 'auto';
  const threshold = args.threshold ?? DEFAULT_THRESHOLD;

  const count = transcriptPath ? countToolUses(transcriptPath) : 0;
  if (!shouldReflect(id, count, threshold)) return; // not enough new work since last reflection

  // Per-session cooldown: never reflect more than once per window, even on a very
  // active session. Complements the global single-flight lock in the watchdog.
  const last = readSession(id).reflectedAt;
  if (last && Date.now() - Date.parse(last) < REFLECT_COOLDOWN_MS) return;

  markReflected(id, count, new Date().toISOString());

  if (mode === 'nudge') {
    // One-line reminder; the agent acts on the standing SessionStart guidance.
    console.log(JSON.stringify({ systemMessage: `Skill Maxing: ${REFLECT_NUDGE}` }));
    return;
  }
  if (transcriptPath) {
    // Spawn the watchdog; the single-flight lock + hard timeout live inside it.
    spawnReflector({ cli: resolveCli().cmd, agent: args.agent ?? 'claude', transcriptPath, cwd: process.cwd() });
  }
}

export async function plugin(args: PluginArgs): Promise<void> {
  switch (args.action) {
    case 'install':
      return install(args);
    case 'uninstall':
      return uninstall(args);
    case 'status':
      return status(args);
    case 'guidance':
      return guidance();
    case 'on-tool':
      return onTool();
    case 'on-stop':
      return onStop(args);
    case 'reflect-run':
      return reflectRun({ agent: args.agent ?? 'claude', transcriptPath: args.transcriptPath ?? '' });
    default:
      log.error(`Unknown plugin action: ${args.action}`);
      process.exitCode = 1;
  }
}
