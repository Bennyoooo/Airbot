import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates } from '../../src/commands/list.js';
import type { InstalledSkill, SkillState } from '../../src/types.js';

function skill(name: string): InstalledSkill {
  return {
    name,
    meta: { name, description: `${name} desc` },
    path: `/tmp/skills/${name}`,
    agent: 'claude',
    scope: 'project',
    isSymlink: false,
  };
}

function state(name: string, id = name, origin: SkillState['origin'] = 'created'): SkillState {
  return {
    name,
    id,
    origin,
    trusted: false,
    version: '1.0.0',
    lifecycle: 'committed',
    scoreHistory: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

test('mergeStates attaches sidecars by id and reports unmatched records', () => {
  const installed = [skill('alpha'), skill('beta')];
  const states = [state('alpha'), state('gamma')];

  const { merged, unmatched } = mergeStates(installed, states);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].state?.origin, 'created');
  assert.equal(merged[1].state, undefined, 'beta has no sidecar');
  assert.deepEqual(
    unmatched.map((s) => s.name),
    ['gamma'],
    'gamma recorded but not installed',
  );
});

test('mergeStates prefers an exact id match over a name match', () => {
  const installed = [skill('alpha')];
  const byName = state('alpha', 'team/alpha', 'workspace');
  const byId = state('alpha', 'alpha', 'created');

  const { merged, unmatched } = mergeStates(installed, [byName, byId]);

  assert.equal(merged[0].state?.id, 'alpha');
  assert.equal(merged[0].state?.origin, 'created');
  assert.deepEqual(unmatched, [byName], 'namespaced record stays unmatched');
});

test('mergeStates falls back to name match for namespaced identities', () => {
  const installed = [skill('alpha')];
  const namespaced = state('alpha', 'team/alpha', 'workspace');

  const { merged, unmatched } = mergeStates(installed, [namespaced]);

  assert.equal(merged[0].state?.id, 'team/alpha');
  assert.equal(unmatched.length, 0);
});
