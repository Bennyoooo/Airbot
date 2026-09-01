import * as readline from 'node:readline/promises';
import { loadConfig, saveConfig, newConfig, type TelemetryConfig } from './config.js';
import { capture, posthogKey } from './posthog.js';

export { configPath, loadConfig, saveConfig, newConfig } from './config.js';
export type { TelemetryConfig } from './config.js';
export { posthogKey } from './posthog.js';

/** True inside the background reflector (a forked agent), not a user session. */
function isReflector(): boolean {
  return process.env.SKILLMAX_REFLECT === '1';
}

/**
 * Hard environment-level suppression, independent of the saved config:
 *  - CI: machine runs are noise, not users (matches Next.js/Homebrew behavior).
 *  - DO_NOT_TRACK=1: the cross-tool privacy standard (consoledonottrack.com).
 *  - SKILLMAX_TELEMETRY=off: explicit per-invocation kill switch.
 */
export function suppressed(): boolean {
  if (process.env.SKILLMAX_TELEMETRY === 'off') return true;
  if (process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true') return true;
  if (process.env.CI && process.env.CI !== 'false') return true;
  return false;
}

let cached: TelemetryConfig | null | undefined;
function cfg(): TelemetryConfig | null {
  if (cached === undefined) cached = loadConfig();
  return cached;
}

/** Sending is allowed only with consent, a configured backend, and no suppression. */
export function isEnabled(): boolean {
  if (suppressed()) return false;
  const c = cfg();
  return !!c && c.enabled && !!posthogKey();
}

function baseProps(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $lib: 'skillmaxxing-cli',
    version,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    source: isReflector() ? 'reflector' : 'user',
    ...extra,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * First-run consent + daily active ping. Prompts once (default YES) when
 * interactive; in CI / DO_NOT_TRACK it stays dark and does not even create a
 * decision. Never throws.
 */
export async function init(version: string): Promise<void> {
  if (suppressed()) return; // never write config or prompt in CI / DNT
  let c = cfg();
  if (!c) {
    c = newConfig(new Date().toISOString());
    cached = c;
    saveConfig(c);
  }

  if (!c.prompted) {
    if (isReflector()) return; // a forked agent must not prompt; wait for a real session
    await promptOnce(c, version);
    return;
  }

  // Already decided: emit at most one "active" ping per day.
  if (c.enabled && c.lastActive !== today() && !isReflector()) {
    c.lastActive = today();
    saveConfig(c);
    if (isEnabled()) {
      await capture({ event: 'active', distinctId: c.anonId, properties: baseProps(version) });
    }
  }
}

async function promptOnce(c: TelemetryConfig, version: string): Promise<void> {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  let enable = true; // default YES per chosen posture

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = (
        await rl.question(
          'skillmaxxing can send anonymous usage stats (no code, no paths) to improve the tool. Enable? [Y/n] ',
        )
      )
        .trim()
        .toLowerCase();
      enable = !(ans === 'n' || ans === 'no');
    } catch {
      enable = true;
    } finally {
      rl.close();
    }
  }

  c.enabled = enable;
  c.prompted = true;
  c.lastActive = today();
  saveConfig(c);

  if (!interactive) {
    process.stderr.write(
      'skillmaxxing: anonymous usage telemetry is on by default — disable any time with `skillmaxxing telemetry off`\n',
    );
  } else if (enable) {
    process.stdout.write('Thanks! Telemetry on. Turn it off any time: skillmaxxing telemetry off\n');
  } else {
    process.stdout.write('No telemetry. Enable later with: skillmaxxing telemetry on\n');
  }

  if (enable && isEnabled()) {
    await capture({ event: 'install', distinctId: c.anonId, properties: baseProps(version) });
  }
}

/** Which CLI command was run. Suppressed inside the reflector (its calls are noise). */
export async function trackCommand(command: string, version: string): Promise<void> {
  if (isReflector() || !isEnabled()) return;
  await capture({ event: 'command', distinctId: cfg()!.anonId, properties: baseProps(version, { command }) });
}

/** A skill lifecycle outcome (create/optimize/promote/revert). Allowed in the reflector. */
export async function trackSkill(
  action: 'create' | 'optimize' | 'promote' | 'revert',
  version: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!isEnabled()) return;
  await capture({
    event: 'skill_lifecycle',
    distinctId: cfg()!.anonId,
    properties: baseProps(version, { action, ...extra }),
  });
}

/** An anonymized CLI error: the command and the error class only. */
export async function trackError(command: string, errType: string, version: string): Promise<void> {
  if (!isEnabled()) return;
  await capture({
    event: 'cli_error',
    distinctId: cfg()!.anonId,
    properties: baseProps(version, { command, errType }),
  });
}

/** Test hook: drop the in-process config cache so a fresh load picks up changes. */
export function resetCacheForTests(): void {
  cached = undefined;
}
