import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentAdapter, Scope } from '../types.js';
import { parseSource, sourceLabel } from '../source/parser.js';
import { resolveSource, cleanupResolved } from '../source/resolver.js';
import { detectInstalledAgents, getAgentOrThrow } from '../agents/registry.js';
import { symlinkOrCopy, fileExists } from '../util/fs.js';
import { addGlobalLockEntry, getGlobalLockEntry } from '../lock/global.js';
import { addProjectLockEntry, computeSkillHash, readProjectLock } from '../lock/project.js';
import { ensureValidName } from '../util/collision.js';
import * as log from '../util/log.js';

export interface InstallArgs {
  source: string;
  agents?: string[];
  scope: Scope;
  copy?: boolean;
  /** Overwrite an existing unmanaged skill of the same name (review C2/I6). */
  force?: boolean;
}

/**
 * A source under a transient dir (a draft, an npx/git temp clone, or the OS temp
 * dir) must never be SYMLINKED into an agent — the target gets cleaned up and the
 * skill dangles. Force a copy for these so installed skills are self-contained.
 */
function isTransientSource(p: string): boolean {
  const r = path.resolve(p);
  return (
    r.includes(`${path.sep}.skillmax${path.sep}drafts${path.sep}`) ||
    r.includes('skillmax-clone-') ||
    r.startsWith(path.resolve(os.tmpdir()) + path.sep)
  );
}

export async function install(args: InstallArgs): Promise<void> {
  const parsed = parseSource(args.source);
  log.info(`Resolving ${sourceLabel(parsed)}...`);

  const skills = await resolveSource(parsed);
  log.info(`Found ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);

  let agents: AgentAdapter[];
  if (args.agents && args.agents.length > 0) {
    agents = args.agents.map(a => getAgentOrThrow(a));
  } else {
    agents = await detectInstalledAgents();
    if (agents.length === 0) {
      log.warn('No supported agents detected. Use --agent to specify one.');
      return;
    }
    log.info(`Detected agents: ${agents.map(a => a.displayName).join(', ')}`);
  }

  const projectDir = process.cwd();

  for (const skill of skills) {
    const nameCheck = ensureValidName(skill.name);
    if (!nameCheck.ok) {
      log.warn(`Skipping skill: ${nameCheck.reason}`);
      continue;
    }

    // A skill already recorded in our lock is managed by skillmaxxing and may be
    // refreshed (this is the `update` path). An on-disk skill we do NOT track is
    // unmanaged — refuse to clobber it (it may be a locally-optimized skill)
    // unless --force (review C2).
    const tracked = args.scope === 'global'
      ? !!getGlobalLockEntry(skill.name)
      : !!readProjectLock(projectDir).skills[skill.name];

    log.heading(`Installing ${skill.name}`);

    for (const agent of agents) {
      const destDir = args.scope === 'global'
        ? path.join(agent.globalSkillsDir, skill.name)
        : path.join(projectDir, agent.projectSkillsDir, skill.name);

      if (fileExists(destDir) && !tracked && !args.force) {
        log.warn(
          `${skill.name} already exists at ${destDir} and is not managed by Skill Maxing. ` +
            `Use --force to overwrite. Skipping.`,
        );
        continue;
      }

      const mode = symlinkOrCopy(skill.dir, destDir, args.copy || isTransientSource(skill.dir));
      log.success(`${agent.displayName} (${args.scope}): ${mode === 'symlink' ? 'linked' : 'copied'} → ${destDir}`);
    }

    if (args.scope === 'global') {
      addGlobalLockEntry(skill.name, {
        source: parsed.raw,
        sourceType: parsed.type,
        ref: parsed.ref,
        commitSha: skill.commitSha,
        agents: agents.map(a => a.name),
      });
    } else {
      addProjectLockEntry(projectDir, skill.name, {
        source: parsed.raw,
        sourceType: parsed.type,
        ref: parsed.ref,
        computedHash: computeSkillHash(skill.dir),
      });
    }
  }

  cleanupResolved(skills);
  log.success(`Installed ${skills.length} skill(s) into ${agents.length} agent(s)`);
}
