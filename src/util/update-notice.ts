import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureDir } from './fs.js';

/**
 * Once-a-day "update available" notice (the standard npm-tool pattern). Hooks
 * bake a pinned CLI version, so nothing self-updates — this just tells the user a
 * newer version exists. It never blocks beyond the fetch timeout, never throws,
 * and never changes anything. Disable with SKILLMAX_NO_UPDATE_CHECK=1.
 */

const PKG = 'skillmaxxing';
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PKG}/dist-tags`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

function stateFile(): string {
  return path.join(os.homedir(), '.skillmax', 'update-check.json');
}

interface CheckState {
  lastCheckAt: string;
  latest?: string;
}

function load(): CheckState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) as CheckState;
  } catch {
    return null;
  }
}

function save(s: CheckState): void {
  try {
    const f = stateFile();
    ensureDir(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
  } catch {
    /* best-effort */
  }
}

/** Numeric semver compare: true if `latest` is strictly newer than `current` (pre-release suffix ignored). */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function suppressed(): boolean {
  if (process.env.SKILLMAX_NO_UPDATE_CHECK === '1') return true;
  if (process.env.SKILLMAX_REFLECT === '1') return true; // background reflector, not a user
  if (process.env.CI && process.env.CI !== 'false') return true;
  return false;
}

async function fetchLatest(): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(DIST_TAGS_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { latest?: unknown };
    return typeof data.latest === 'string' ? data.latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function printNotice(latest: string, current: string): void {
  process.stderr.write(
    `\nskillmaxxing ${current} → ${latest} available.\n` +
      `  update: npm i -g skillmaxxing@latest   (npx users: npx skillmaxxing@latest plugin install)\n\n`,
  );
}

/**
 * Check at most once per CHECK_INTERVAL_MS; notify from cache in between. Call
 * from user-facing command paths only (skip hooks/reflector).
 */
export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  if (suppressed()) return;
  const state = load();

  if (state?.lastCheckAt && Date.now() - Date.parse(state.lastCheckAt) < CHECK_INTERVAL_MS) {
    if (state.latest && isNewer(state.latest, currentVersion)) printNotice(state.latest, currentVersion);
    return;
  }

  const latest = await fetchLatest();
  save({ lastCheckAt: new Date().toISOString(), latest: latest ?? state?.latest });
  if (latest && isNewer(latest, currentVersion)) printNotice(latest, currentVersion);
}
