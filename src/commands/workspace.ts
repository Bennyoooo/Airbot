import { publish, sync, listRegistry } from '../workspace/registry.js';
import { reviewPromote, poolEval } from '../workspace/collab.js';
import { isValidChannel } from '../workspace/channels.js';
import { stripTerminalEscapes } from '../util/sanitize.js';
import type { Channel } from '../types.js';
import * as log from '../util/log.js';

/** Untrusted registry fields are sanitized before display (review: ANSI injection). */
const clean = stripTerminalEscapes;

export interface WorkspaceArgs {
  action: 'publish' | 'sync' | 'list' | 'pool' | 'promote';
  registryDir?: string;
  skillDir?: string;
  skillName?: string;
  channel?: string;
  by?: string;
  json?: boolean;
  // collab (U15)
  approve?: boolean;
  approver?: string;
  score?: number;
}

function channelOf(value: string | undefined, fallback?: Channel): Channel | undefined {
  if (value === undefined) return fallback;
  if (!isValidChannel(value)) throw new Error(`invalid channel "${value}" (dev|beta|stable)`);
  return value;
}

export async function workspace(args: WorkspaceArgs): Promise<void> {
  if (!args.registryDir) {
    log.error('Usage: skillmaxxing workspace <action> --registry <dir> [options]');
    process.exitCode = 1;
    return;
  }
  const now = new Date().toISOString();

  switch (args.action) {
    case 'publish': {
      if (!args.skillDir) {
        log.error('Usage: workspace publish --registry <dir> --skill-dir <dir> --channel dev');
        process.exitCode = 1;
        return;
      }
      const entry = publish(args.skillDir, args.registryDir, {
        channel: channelOf(args.channel, 'dev')!,
        publishedBy: args.by ?? 'unknown',
        at: now,
      });
      log.success(`Published ${entry.name}@${entry.version} to ${entry.channel}.`);
      log.info('Commit and push the registry repo to share with your team.');
      return;
    }

    case 'sync': {
      const synced = sync(args.registryDir, { channel: channelOf(args.channel), at: now });
      if (args.json) {
        console.log(JSON.stringify(synced, null, 2));
        return;
      }
      if (synced.length === 0) {
        log.warn('Nothing to sync.');
        return;
      }
      log.heading(`Synced ${synced.length} skill(s)`);
      for (const s of synced) {
        log.info(`  ${clean(s.name)} [${clean(s.channel)}]${s.collided ? ` (namespaced as ${clean(s.id)} -- local skill preserved)` : ''}`);
      }
      log.info('Synced skills are trusted:false and live under ~/.skillmax/workspace; install or optimize from there.');
      return;
    }

    case 'list': {
      const entries = listRegistry(args.registryDir, channelOf(args.channel));
      if (args.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        log.info('Registry is empty.');
        return;
      }
      log.table([
        ['name', 'channel', 'version', 'by'],
        ...entries.map((e) => [clean(e.name), clean(e.channel), clean(e.version), clean(e.publishedBy)]),
      ]);
      return;
    }

    case 'pool': {
      if (!args.skillName || args.score === undefined) {
        log.error('Usage: workspace pool --registry <dir> --skill <name> --score <0..1> [--by <who>]');
        process.exitCode = 1;
        return;
      }
      poolEval(args.registryDir, {
        skill: args.skillName,
        score: args.score,
        by: args.by ?? 'unknown',
        at: now,
      });
      log.success(`Pooled eval result for ${args.skillName} (${args.score}).`);
      return;
    }

    case 'promote': {
      if (!args.skillName) {
        log.error('Usage: workspace promote --registry <dir> --skill <name> --channel <beta|stable> --approve --approver <who>');
        process.exitCode = 1;
        return;
      }
      const target = channelOf(args.channel);
      if (!target) {
        log.error('promote requires --channel <beta|stable>');
        process.exitCode = 1;
        return;
      }
      const res = reviewPromote(args.registryDir, {
        skill: args.skillName,
        toChannel: target,
        approve: args.approve ?? false,
        approver: args.approver,
        at: now,
      });
      if (!res.ok) {
        log.error(res.reason);
        process.exitCode = 1;
        return;
      }
      log.success(`Promoted ${args.skillName} to ${target} (approved by ${args.approver}).`);
      return;
    }

    default:
      log.error(`Unknown workspace action: ${args.action}`);
      process.exitCode = 1;
  }
}
