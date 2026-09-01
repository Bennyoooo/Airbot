import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ALL_AGENTS } from '../agents/registry.js';
import { readGlobalLock } from '../lock/global.js';
import { isSymlink, fileExists } from '../util/fs.js';
import { listStates, deleteState } from '../state/store.js';
import * as log from '../util/log.js';

const execFileAsync = promisify(execFile);

export interface DoctorArgs {
  /**
   * Remove dangling skill links and prune the state of skills confirmed gone.
   * Without it, doctor only reports.
   */
  fix?: boolean;
}

export async function doctor(args: DoctorArgs = {}): Promise<void> {
  log.heading('skillmaxxing doctor');
  let issues = 0;

  log.heading('Agent Detection');
  for (const agent of ALL_AGENTS) {
    const installed = await agent.detectInstalled();
    const cliFound = await checkCli(agent.cliCommand);

    if (installed) {
      log.success(`${agent.displayName}: config directory found`);
    } else {
      log.dim(`${agent.displayName}: not installed`);
    }

    if (cliFound) {
      log.success(`${agent.displayName}: '${agent.cliCommand}' on PATH`);
    } else if (installed) {
      log.warn(`${agent.displayName}: config exists but '${agent.cliCommand}' not on PATH`);
    }
  }

  log.heading('Global Skills Health');
  const lock = readGlobalLock();
  const entries = Object.entries(lock.skills);

  if (entries.length === 0) {
    log.info('No global skills installed.');
  }

  for (const [name, entry] of entries) {
    for (const agentName of entry.agents) {
      const agent = ALL_AGENTS.find(a => a.name === agentName);
      if (!agent) {
        log.warn(`${name}: references unknown agent '${agentName}'`);
        issues++;
        continue;
      }

      const skillDir = path.join(agent.globalSkillsDir, name);
      if (!fileExists(skillDir)) {
        log.error(`${name}: missing at ${skillDir} (agent: ${agent.displayName})`);
        issues++;
        continue;
      }

      if (isSymlink(skillDir)) {
        const target = fs.readlinkSync(skillDir);
        const resolved = path.resolve(path.dirname(skillDir), target);
        if (!fileExists(resolved)) {
          log.error(`${name}: broken symlink → ${resolved} (agent: ${agent.displayName})`);
          issues++;
          continue;
        }
      }

      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fileExists(skillMd)) {
        log.warn(`${name}: directory exists but no SKILL.md (agent: ${agent.displayName})`);
        issues++;
        continue;
      }

      log.success(`${name}: OK (${agent.displayName})`);
    }
  }

  // Disk-vs-state reconciliation across every agent and both scopes. This catches
  // the dangling-symlink class of bug (a skill linked into an agent whose draft
  // target was later deleted) that the lock-only pass above can miss — and is the
  // only pass that offers --fix.
  issues += reconcileSkills(args.fix === true);

  log.heading('Summary');
  if (issues === 0) {
    log.success('No issues found.');
  } else if (args.fix) {
    log.info(`Cleaned what could be auto-fixed. Re-run 'skillmaxxing doctor' to confirm.`);
  } else {
    log.warn(
      `${issues} issue(s) found. Run 'skillmaxxing doctor --fix' to clean dangling skills, ` +
        `or 'skillmaxxing update' to refresh stale installs.`,
    );
  }
}

/**
 * Walk every agent's global + project skill dir, classify each entry as a live
 * skill or a dangling link, and cross-check against state sidecars. Reports
 * dangling links and orphan state. With `fix`, unlinks the dangling entries and
 * prunes state ONLY for names whose link we just removed — so we never delete the
 * state of a skill that merely lives under a different cwd or another agent.
 * Returns the count of unresolved issues.
 */
function reconcileSkills(fix: boolean): number {
  log.heading('Skill / State Reconciliation');
  const projectDir = process.cwd();
  const dangling: { agent: string; scope: string; name: string; path: string }[] = [];
  const liveNames = new Set<string>();

  for (const agent of ALL_AGENTS) {
    const dirs: [string, string][] = [
      ['global', agent.globalSkillsDir],
      ['project', path.join(projectDir, agent.projectSkillsDir)],
    ];
    for (const [scope, base] of dirs) {
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue; // dir absent for this agent/scope
      }
      for (const e of dirEntries) {
        const p = path.join(base, e.name);
        if (isSymlink(p) && !fileExists(p)) {
          dangling.push({ agent: agent.displayName, scope, name: e.name, path: p });
        } else if (fileExists(path.join(p, 'SKILL.md'))) {
          liveNames.add(e.name);
        }
      }
    }
  }

  const states = listStates();
  const danglingNames = new Set(dangling.map(d => d.name));
  const orphanStates = states.filter(s => !liveNames.has(s.name));

  log.info(`Live installed skills: ${liveNames.size}   State records: ${states.length}`);

  if (dangling.length === 0 && orphanStates.length === 0) {
    log.success('Skills and state are consistent.');
    return 0;
  }

  if (dangling.length > 0) {
    log.warn(`Dangling skill links (target deleted): ${dangling.length}`);
    for (const d of dangling) log.dim(`  ${d.name}  [${d.agent}/${d.scope}]`);
  }
  if (orphanStates.length > 0) {
    log.warn(`State records with no live skill: ${orphanStates.length}`);
    for (const s of orphanStates) {
      log.dim(`  ${s.name}  [${s.origin}/${s.lifecycle}]${danglingNames.has(s.name) ? ' (dangling)' : ''}`);
    }
  }

  if (!fix) {
    return dangling.length + orphanStates.length;
  }

  let unlinked = 0;
  for (const d of dangling) {
    try {
      fs.unlinkSync(d.path);
      unlinked++;
    } catch {
      log.warn(`  could not remove ${d.path}`);
    }
  }
  let pruned = 0;
  for (const s of orphanStates) {
    if (danglingNames.has(s.name) && deleteState(s.id)) pruned++;
  }
  log.success(`Removed ${unlinked} dangling link(s); pruned ${pruned} orphan state record(s).`);

  const remaining = orphanStates.filter(s => !danglingNames.has(s.name));
  if (remaining.length > 0) {
    log.info(
      `${remaining.length} state record(s) have no install here but no dangling link either ` +
        `(may be a project skill under another directory, or another agent) — left untouched.`,
    );
  }
  return remaining.length; // dangling links resolved; only untouchable state remains
}

async function checkCli(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}
