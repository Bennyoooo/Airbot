import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTmpDir, cleanTmpDir } from '../helpers/tmp.js';

const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CI: process.env.CI,
  SKILLMAX_NO_UPDATE_CHECK: process.env.SKILLMAX_NO_UPDATE_CHECK,
  SKILLMAX_REFLECT: process.env.SKILLMAX_REFLECT,
};

let tmpHome: string;
let mod: typeof import('../../src/util/update-notice.js');

before(async () => {
  mod = await import('../../src/util/update-notice.js');
});

beforeEach(() => {
  tmpHome = makeTmpDir('home');
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CI;
  delete process.env.SKILLMAX_NO_UPDATE_CHECK;
  delete process.env.SKILLMAX_REFLECT;
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
  cleanTmpDir(tmpHome);
});

function captureStderr(fn: () => Promise<void>): Promise<string> {
  let out = '';
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as NodeJS.WriteStream).write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then(() => out)
    .finally(() => {
      process.stderr.write = orig;
    });
}

// Seed a fresh cache so maybeNotifyUpdate uses it (no network) rather than fetching.
function seedCache(latest: string): void {
  const dir = path.join(tmpHome, '.skillmax');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'update-check.json'),
    JSON.stringify({ lastCheckAt: new Date().toISOString(), latest }),
  );
}

test('isNewer compares semver numerically, ignoring pre-release', () => {
  assert.equal(mod.isNewer('0.1.4', '0.1.3'), true);
  assert.equal(mod.isNewer('0.2.0', '0.1.9'), true);
  assert.equal(mod.isNewer('1.0.0', '0.9.9'), true);
  assert.equal(mod.isNewer('0.1.3', '0.1.3'), false);
  assert.equal(mod.isNewer('0.1.2', '0.1.3'), false);
  assert.equal(mod.isNewer('0.1.4-beta.1', '0.1.3'), true);
});

test('notifies from cache when a newer version is known', async () => {
  seedCache('9.9.9');
  const out = await captureStderr(() => mod.maybeNotifyUpdate('0.1.4'));
  assert.match(out, /9\.9\.9 available/);
  assert.match(out, /npm i -g skillmaxxing@latest/);
});

test('stays silent from cache when already current', async () => {
  seedCache('0.1.4');
  const out = await captureStderr(() => mod.maybeNotifyUpdate('0.1.4'));
  assert.equal(out, '');
});

test('SKILLMAX_NO_UPDATE_CHECK=1 suppresses everything (no fetch, no file)', async () => {
  process.env.SKILLMAX_NO_UPDATE_CHECK = '1';
  const out = await captureStderr(() => mod.maybeNotifyUpdate('0.0.1'));
  assert.equal(out, '');
  assert.equal(fs.existsSync(path.join(tmpHome, '.skillmax', 'update-check.json')), false);
});

test('reflector context is suppressed', async () => {
  process.env.SKILLMAX_REFLECT = '1';
  seedCache('9.9.9');
  const out = await captureStderr(() => mod.maybeNotifyUpdate('0.1.4'));
  assert.equal(out, '');
});
