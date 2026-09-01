import { loadConfig, saveConfig, newConfig, configPath, posthogKey, suppressed } from '../telemetry/index.js';
import * as log from '../util/log.js';

export interface TelemetryArgs {
  action?: 'on' | 'off' | 'status';
}

/** Manage anonymous usage telemetry: `skillmaxxing telemetry on|off|status`. */
export function telemetry(args: TelemetryArgs): void {
  const action = args.action ?? 'status';
  const existing = loadConfig();
  const cfg = existing ?? newConfig(new Date().toISOString());

  if (action === 'on') {
    cfg.enabled = true;
    cfg.prompted = true;
    saveConfig(cfg);
    log.success('Telemetry enabled (anonymous only). Disable any time: skillmaxxing telemetry off');
    if (!posthogKey()) log.dim('Note: no analytics backend is configured in this build, so nothing is sent yet.');
    return;
  }

  if (action === 'off') {
    cfg.enabled = false;
    cfg.prompted = true;
    saveConfig(cfg);
    log.success('Telemetry disabled. No usage data will be sent.');
    return;
  }

  if (action === 'status') {
    log.heading('skillmaxxing telemetry');
    if (!existing) {
      log.info(`Status:   not yet configured${suppressed() ? ' (suppressed by environment)' : " — you'll be asked on first run"}`);
    } else {
      log.info(`Status:   ${cfg.enabled ? 'ON' : 'OFF'}${suppressed() ? ' (suppressed by environment)' : ''}`);
      log.info(`Anon ID:  ${cfg.anonId}`);
    }
    log.info(`Backend:  ${posthogKey() ? 'configured' : 'none in this build'}`);
    log.info(`Config:   ${configPath()}`);
    log.dim('Collected: version, OS, agent, command names, skill create/optimize counts, error types.');
    log.dim('Never collected: code, file paths, prompts, skill contents, or any personal data.');
    log.dim('Honors CI and DO_NOT_TRACK=1. One-off opt-out: SKILLMAX_TELEMETRY=off');
    return;
  }

  log.error(`Unknown telemetry action: ${action} (use on|off|status)`);
  process.exitCode = 1;
}
