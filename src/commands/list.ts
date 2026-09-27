import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentAdapter, InstalledSkill, Scope, SkillState } from '../types.js';
import { ALL_AGENTS } from '../agents/registry.js';
import { readSkillMeta } from '../util/frontmatter.js';
import { isSymlink } from '../util/fs.js';
import { listStates } from '../state/store.js';
import * as log from '../util/log.js';

export interface ListArgs {
  agent?: string;
  scope?: Scope;
  json?: boolean;
  /** Merge in the ~/.skillmax state sidecars: origin, trusted, lifecycle, dates. */
  state?: boolean;
}

export interface SkillWithState extends InstalledSkill {
  state?: SkillState;
}

/**
 * Attach each installed skill's state sidecar (matched by id, then name) and
 * report the sidecars no installed skill claimed — skills created/recorded on
 * this machine but not installed in the scanned scopes (e.g. project skills of
 * other repos, or skills since removed).
 */
export function mergeStates(
  skills: InstalledSkill[],
  states: SkillState[],
): { merged: SkillWithState[]; unmatched: SkillState[] } {
  const claimed = new Set<SkillState>();
  const merged: SkillWithState[] = skills.map((skill) => {
    const state =
      states.find((s) => s.id === skill.name) ?? states.find((s) => s.name === skill.name);
    if (state) claimed.add(state);
    return state ? { ...skill, state } : { ...skill };
  });
  return { merged, unmatched: states.filter((s) => !claimed.has(s)) };
}

export async function list(args: ListArgs): Promise<void> {
  const projectDir = process.cwd();
  const skills: InstalledSkill[] = [];

  const agents = args.agent
    ? ALL_AGENTS.filter(a => a.name === args.agent)
    : ALL_AGENTS;

  for (const agent of agents) {
    if (!args.scope || args.scope === 'global') {
      skills.push(...scanDir(agent, agent.globalSkillsDir, 'global'));
    }
    if (!args.scope || args.scope === 'project') {
      const projDir = path.join(projectDir, agent.projectSkillsDir);
      skills.push(...scanDir(agent, projDir, 'project'));
    }
  }

  if (args.state) {
    return listWithState(skills, args);
  }

  if (args.json) {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  if (skills.length === 0) {
    log.info('No skills installed.');
    return;
  }

  log.heading(`Installed skills (${skills.length})`);
  const rows: string[][] = [['Name', 'Agent', 'Scope', 'Link', 'Description']];
  for (const s of skills) {
    rows.push([
      s.name,
      s.agent,
      s.scope,
      s.isSymlink ? 'sym' : 'copy',
      truncate(s.meta.description, 50),
    ]);
  }
  log.table(rows);
}

function listWithState(skills: InstalledSkill[], args: ListArgs): void {
  const { merged, unmatched } = mergeStates(skills, listStates());

  if (args.json) {
    console.log(JSON.stringify({ skills: merged, unmatchedStates: unmatched }, null, 2));
    return;
  }

  if (merged.length === 0 && unmatched.length === 0) {
    log.info('No skills installed and no state records found.');
    return;
  }

  if (merged.length > 0) {
    log.heading(`Installed skills (${merged.length})`);
    const rows: string[][] = [['Name', 'Agent', 'Scope', 'Origin', 'Trusted', 'Lifecycle', 'Created']];
    for (const s of merged) {
      rows.push([
        s.name,
        s.agent,
        s.scope,
        s.state?.origin ?? '-',
        s.state ? String(s.state.trusted) : '-',
        s.state?.lifecycle ?? '-',
        day(s.state?.createdAt),
      ]);
    }
    log.table(rows);
  }

  if (unmatched.length > 0) {
    log.heading(`Recorded but not installed in this scan (${unmatched.length})`);
    const rows: string[][] = [['Name', 'Origin', 'Trusted', 'Lifecycle', 'Created', 'Updated']];
    for (const s of unmatched) {
      rows.push([s.name, s.origin, String(s.trusted), s.lifecycle, day(s.createdAt), day(s.updatedAt)]);
    }
    log.table(rows);
    log.dim('These have state sidecars in ~/.skillmax/state but no SKILL.md in the scanned scopes');
    log.dim('(often project-scoped skills of other repos, or skills that were removed).');
  }
}

function day(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : '-';
}

function scanDir(agent: AgentAdapter, dir: string, scope: Scope): InstalledSkill[] {
  const results: InstalledSkill[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(dir, entry.name);
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, 'utf-8');
      const meta = readSkillMeta(content);
      if (!meta) continue;

      results.push({
        name: meta.name,
        meta,
        path: skillDir,
        agent: agent.name,
        scope,
        isSymlink: isSymlink(skillDir),
      });
    }
  } catch {
    // directory doesn't exist
  }
  return results;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max - 3) + '...';
}
