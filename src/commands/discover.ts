import type { Scope } from '../types.js';
import { collectSources } from '../discover/collect.js';
import { rankCandidates } from '../discover/rank.js';
import { install } from './install.js';
import * as log from '../util/log.js';

export interface DiscoverArgs {
  query: string;
  repos?: string[];
  json?: boolean;
  limit?: number;
  /** Name of a result to install (the discover→install handoff). */
  install?: string;
  scope: Scope;
  agents?: string[];
  copy?: boolean;
  force?: boolean;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export async function discover(args: DiscoverArgs): Promise<void> {
  const { candidates, errors } = await collectSources({
    repos: args.repos,
    projectDir: process.cwd(),
  });
  for (const e of errors) log.warn(`Source '${e.source}' unavailable: ${e.message}`);

  let ranked = rankCandidates(args.query, candidates);
  if (args.query.trim()) ranked = ranked.filter((r) => r.score > 0);
  const limited = ranked.slice(0, args.limit ?? 20);

  if (limited.length === 0) {
    log.warn(`No skills matched "${args.query}".`);
    process.exitCode = 1; // explicit non-empty contract (review I2)
    return;
  }

  // Discover → install handoff.
  if (args.install) {
    const pick = limited.find((r) => r.name.toLowerCase() === args.install!.toLowerCase());
    if (!pick) {
      log.error(`"${args.install}" is not in the results.`);
      process.exitCode = 1;
      return;
    }
    if (!pick.source) {
      if (pick.installed) {
        log.info(`${pick.name} is already installed locally.`);
        return;
      }
      log.error(`${pick.name} has no installable source.`);
      process.exitCode = 1;
      return;
    }
    // NOTE: install re-resolves the source to HEAD. Exact pinned-commit install
    // (using pick.commitSha) needs a fetch-by-SHA path the depth-1 clone can't
    // do today — tracked as a known gap (review F2). We surface the resolved
    // commit for provenance.
    if (pick.commitSha) {
      log.info(`${pick.name} discovered at ${pick.commitSha.slice(0, 10)}; installing from ${pick.source}.`);
    } else {
      log.info(`Installing ${pick.name} from ${pick.source}...`);
    }
    await install({
      source: pick.source,
      scope: args.scope,
      agents: args.agents,
      copy: args.copy,
      force: args.force,
    });
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }

  log.heading(`Skills matching "${args.query}" (${limited.length})`);
  log.table([
    ['', 'name', 'origin', 'source', 'description'],
    ...limited.map((r) => [
      r.installed ? '✓' : ' ',
      r.name,
      r.origin,
      r.source || '(local)',
      truncate(r.description, 50),
    ]),
  ]);
  log.info(`Install one with: skillmaxxing discover "${args.query}" --install <name>`);
}
