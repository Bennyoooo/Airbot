#!/usr/bin/env node

import { install } from './commands/install.js';
import { discover } from './commands/discover.js';
import { skillify } from './commands/skillify.js';
import { optimize, type OptimizeArgs } from './commands/optimize.js';
import { workspace, type WorkspaceArgs } from './commands/workspace.js';
import { plugin, type PluginArgs } from './commands/plugin.js';
import { list } from './commands/list.js';
import { remove } from './commands/remove.js';
import { update } from './commands/update.js';
import { init } from './commands/init.js';
import { doctor } from './commands/doctor.js';
import { telemetry, type TelemetryArgs } from './commands/telemetry.js';
import * as tele from './telemetry/index.js';
import { maybeNotifyUpdate } from './util/update-notice.js';
import { createRequire } from 'node:module';
import * as log from './util/log.js';
import type { Scope } from './types.js';

// Read the version from package.json so --version / help never drift from the
// published package.
const VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.substring(2, eq)] = arg.substring(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[arg.substring(2)] = next;
          i++;
        } else {
          flags[arg.substring(2)] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const shortMap: Record<string, string> = { g: 'global', a: 'agent', s: 'scope', y: 'yes', h: 'help' };
      const long = shortMap[arg[1]] ?? arg[1];
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[long] = next;
        i++;
      } else {
        flags[long] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printHelp(): void {
  console.log(`skillmaxxing v${VERSION}

Self-evolving skills for your coding agent — auto-create and auto-improve skills as you work.

Usage:
  skillmaxxing <command> [options]

Commands:
  plugin <action>     Self-evolving plugin: install|uninstall|status (hooks, no trigger)
  install <source>    Install skills from GitHub, URL, or local path
  discover <query>    Find skills by intent (curated index, repos, local)
  skillify            Create a skill from a draft (--draft/--commit/--list-drafts)
  optimize <action>   Eval-gated optimize: score|apply|gate|promote|revert
  workspace <action>  Team registry: publish|sync|list|pool|promote
  list [--state]      List installed skills (--state adds origin/trust/lifecycle records)
  remove <names...>   Remove installed skills
  update [names...]   Update installed skills to latest
  init [name]         Create a new skill template
  doctor [--fix]      Check agent integrations + skill health (--fix cleans dangling skills)
  telemetry <action>  Anonymous usage stats: on|off|status

Options:
  -g, --global        Install/operate at global scope (default: project)
  -a, --agent <name>  Target specific agent (claude, codex, cursor, opencode, hermes)
  --copy              Force copy instead of symlink
  --force             Overwrite an existing unmanaged skill of the same name
  --repo <owner/repo> Extra repo source(s) to scan during discover (comma-sep)
  --limit <n>         Max discover results (default 20)
  --install <name>    Install a named result (discover command)
  --json              Output as JSON (list/discover commands)
  --state             Merge ~/.skillmax state records into list (origin, trusted, lifecycle)
  -y, --yes           Skip confirmation prompts
  -h, --help          Show help
  --version           Show version

Examples:
  skillmaxxing plugin install                  Turn on self-evolving skills (no trigger needed)
  skillmaxxing plugin install --agent codex    Enable it for Codex
  skillmaxxing install owner/repo              Install skills from GitHub
  skillmaxxing install ./my-skills -g          Install local skills globally
  skillmaxxing discover "code review"          Find a skill by intent
  skillmaxxing list                            List all installed skills
  skillmaxxing list --state                    ...with origin/trust/lifecycle records
  skillmaxxing doctor                          Check health
  skillmaxxing doctor --fix                     Remove dangling skills + reconcile state
`);
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = positional[0];

  if (flags.version === true) {
    console.log(VERSION);
    return;
  }

  if (!command || flags.help) {
    printHelp();
    return;
  }

  const scope: Scope = flags.global === true ? 'global' : 'project';
  const agentFlag = typeof flags.agent === 'string' ? flags.agent : undefined;
  const agents = agentFlag ? agentFlag.split(',') : undefined;

  // Telemetry: never from the silent hook subcommands (they run constantly and
  // non-interactively) nor from the telemetry command itself (toggling settings
  // shouldn't trigger the consent prompt). init() handles first-run consent.
  const HOOK_SUBCOMMANDS = new Set(['guidance', 'on-tool', 'on-stop', 'reflect-run']);
  const isHookCall = command === 'plugin' && HOOK_SUBCOMMANDS.has(positional[1]);
  const isTelemetryCmd = command === 'telemetry';
  if (!isHookCall && !isTelemetryCmd) {
    await tele.init(VERSION);
    await tele.trackCommand(command, VERSION);
  }

  try {
    switch (command) {
      case 'install':
      case 'add':
      case 'i': {
        const source = positional[1];
        if (!source) {
          log.error('Usage: skillmaxxing install <source>');
          process.exit(1);
        }
        await install({ source, agents, scope, copy: flags.copy === true, force: flags.force === true });
        break;
      }

      case 'discover':
      case 'search':
      case 'find': {
        const query = positional.slice(1).join(' ');
        if (!query) {
          log.error('Usage: skillmaxxing discover "<what you want>" [--repo owner/repo] [--install <name>]');
          process.exit(1);
        }
        const repos = typeof flags.repo === 'string' ? flags.repo.split(',') : undefined;
        const limit = typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : undefined;
        await discover({
          query,
          repos,
          json: flags.json === true,
          limit: Number.isNaN(limit) ? undefined : limit,
          install: typeof flags.install === 'string' ? flags.install : undefined,
          scope,
          agents,
          copy: flags.copy === true,
          force: flags.force === true,
        });
        break;
      }

      case 'skillify':
      case 'create': {
        await skillify({
          draftPath: typeof flags.draft === 'string' ? flags.draft : undefined,
          commit: typeof flags.commit === 'string' ? flags.commit : undefined,
          listDrafts: flags['list-drafts'] === true,
          discard: typeof flags.discard === 'string' ? flags.discard : undefined,
          allowExec: flags['allow-exec'] === true,
          forceNew: flags.new === true,
          scope,
          agents,
          copy: flags.copy === true,
          force: flags.force === true,
        });
        // A committed skill is a create event (also fires for autonomous reflector creates).
        if (typeof flags.commit === 'string') await tele.trackSkill('create', VERSION);
        break;
      }

      case 'optimize':
      case 'opt': {
        const action = positional[1] as OptimizeArgs['action'];
        if (!action) {
          log.error('Usage: skillmaxxing optimize <score|apply|gate|promote|revert> [options]');
          process.exit(1);
        }
        const num = (k: string): number | undefined => {
          if (typeof flags[k] !== 'string') return undefined;
          const n = Number(flags[k]);
          return Number.isNaN(n) ? undefined : n; // a non-numeric flag is not a silent 0/NaN
        };
        const str = (k: string): string | undefined =>
          typeof flags[k] === 'string' ? (flags[k] as string) : undefined;
        await optimize({
          action,
          skillName: str('skill'),
          skillDir: str('skill-dir'),
          editsPath: str('edits'),
          evalPath: str('eval'),
          rolloutsPath: str('rollouts'),
          liveDir: str('live'),
          candidateDir: str('candidate'),
          version: str('version'),
          step: num('step'),
          total: num('total'),
          base: num('base'),
          min: num('min'),
          scheduler: str('scheduler') as OptimizeArgs['scheduler'],
          current: num('current'),
          candidate: num('candidate'),
          best: num('best'),
          score: num('score'),
          allowExec: flags['allow-exec'] === true,
          json: flags.json === true,
        });
        if (action === 'promote') await tele.trackSkill('promote', VERSION);
        else if (action === 'revert') await tele.trackSkill('revert', VERSION);
        break;
      }

      case 'workspace':
      case 'ws': {
        const action = positional[1] as WorkspaceArgs['action'];
        if (!action) {
          log.error('Usage: skillmaxxing workspace <publish|sync|list|pool|promote> --registry <dir> [options]');
          process.exit(1);
        }
        const str = (k: string): string | undefined =>
          typeof flags[k] === 'string' ? (flags[k] as string) : undefined;
        await workspace({
          action,
          registryDir: str('registry'),
          skillDir: str('skill-dir'),
          skillName: str('skill'),
          channel: str('channel'),
          by: str('by'),
          approver: str('approver'),
          approve: flags.approve === true,
          score:
            typeof flags.score === 'string' && !Number.isNaN(Number(flags.score))
              ? Number(flags.score)
              : undefined,
          json: flags.json === true,
        });
        break;
      }

      case 'plugin': {
        const action = positional[1] as PluginArgs['action'];
        if (!action) {
          log.error('Usage: skillmaxxing plugin <install|uninstall|status> [--agent claude|codex] [--mode auto|nudge] [--threshold N] [--project]');
          process.exit(1);
        }
        const pAgent = agentFlag === 'codex' ? 'codex' : agentFlag === 'claude' ? 'claude' : undefined;
        const pMode = flags.mode === 'nudge' ? 'nudge' : flags.mode === 'auto' ? 'auto' : undefined;
        const pThreshold =
          typeof flags.threshold === 'string' && !Number.isNaN(Number(flags.threshold))
            ? Number(flags.threshold)
            : undefined;
        await plugin({
          action,
          agent: pAgent,
          mode: pMode,
          threshold: pThreshold,
          project: flags.project === true,
          transcriptPath: typeof flags.transcript === 'string' ? flags.transcript : undefined,
        });
        break;
      }

      case 'list':
      case 'ls':
        await list({
          agent: agentFlag,
          scope: flags.global === true ? 'global' : undefined,
          json: flags.json === true,
          state: flags.state === true,
        });
        break;

      case 'remove':
      case 'rm': {
        const names = positional.slice(1);
        if (names.length === 0) {
          log.error('Usage: skillmaxxing remove <skill-name> [skill-name...]');
          process.exit(1);
        }
        await remove({ names, agent: agentFlag, scope: flags.global === true ? 'global' : undefined });
        break;
      }

      case 'update':
      case 'upgrade': {
        const names = positional.slice(1);
        await update({ names: names.length > 0 ? names : undefined, scope: flags.global === true ? 'global' : undefined });
        break;
      }

      case 'init': {
        const name = positional[1];
        await init({ name });
        break;
      }

      case 'doctor':
        await doctor({ fix: flags.fix === true });
        break;

      case 'telemetry': {
        const action = positional[1] as TelemetryArgs['action'];
        telemetry({ action });
        break;
      }

      default:
        log.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    if (!isHookCall && !isTelemetryCmd) {
      try {
        await tele.trackError(command, err instanceof Error ? err.name : 'Error', VERSION);
      } catch {
        /* telemetry must never mask the real error */
      }
    }
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // After a successful command, surface a once-a-day update notice (never for hooks).
  if (!isHookCall) await maybeNotifyUpdate(VERSION);
}

main();
