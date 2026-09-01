import * as fs from 'node:fs';
import type { Scope } from '../types.js';
import {
  stageDraft,
  commitDraft,
  listDrafts,
  discardDraft,
  type SkillDraft,
} from '../create/skillify.js';
import { findUpdateTarget } from '../create/match.js';
import { scanLocalSkills } from '../discover/local.js';
import { loadCuratedIndex } from '../discover/index.js';
import * as log from '../util/log.js';

export interface SkillifyArgs {
  draftPath?: string;
  commit?: string;
  listDrafts?: boolean;
  discard?: string;
  allowExec?: boolean;
  /** Bypass the prefer-update check and create anyway. */
  forceNew?: boolean;
  scope: Scope;
  agents?: string[];
  copy?: boolean;
  force?: boolean;
}

function readDraft(p: string): SkillDraft {
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (
    !d ||
    typeof d.name !== 'string' ||
    typeof d.description !== 'string' ||
    typeof d.body !== 'string'
  ) {
    throw new Error('draft must include string name, description, and body');
  }
  return d as SkillDraft;
}

export async function skillify(args: SkillifyArgs): Promise<void> {
  if (args.listDrafts) {
    const drafts = listDrafts();
    if (drafts.length === 0) log.info('No staged drafts.');
    else {
      log.heading('Staged drafts');
      for (const d of drafts) log.info(`  ${d}`);
    }
    return;
  }

  if (args.discard) {
    discardDraft(args.discard);
    log.success(`Discarded draft "${args.discard}".`);
    return;
  }

  if (args.commit) {
    await commitDraft(args.commit, {
      scope: args.scope,
      agents: args.agents,
      copy: args.copy,
      force: args.force,
    });
    log.success(`Committed "${args.commit}" (trusted: false).`);
    return;
  }

  if (!args.draftPath) {
    log.error('Usage: skillmaxxing skillify --draft <draft.json> | --commit <name> | --list-drafts');
    process.exitCode = 1;
    return;
  }

  const draft = readDraft(args.draftPath);

  if (!args.forceNew) {
    const existing = [...scanLocalSkills(), ...loadCuratedIndex()];
    const m = findUpdateTarget(draft.name, draft.description, existing);
    if (m.target) {
      log.warn(`Prefer-update: ${m.reason}.`);
      log.info(`Update/optimize "${m.target.name}" instead, or pass --new to create anyway.`);
      process.exitCode = 1;
      return;
    }
  }

  const res = await stageDraft(draft, { allowExec: args.allowExec });
  if (!res.ok) {
    log.error(`Staging failed: ${res.detail}`);
    process.exitCode = 1;
    return;
  }
  log.success(`Staged "${draft.name}" at ${res.dir}`);
  if (res.smokePassed === true) log.success('Smoke test passed.');
  else if (res.smokePassed === false) log.warn('Smoke test failed.');
  else if (res.detail) log.info(res.detail);
  log.info(`Review it, then commit: skillmaxxing skillify --commit ${draft.name}`);
}
