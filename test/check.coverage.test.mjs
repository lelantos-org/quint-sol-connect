import test from 'node:test';
import assert from 'node:assert/strict';

import { checkModel } from '../src/check.mjs';
import { fixtureTree } from './helpers/fixtureTree.mjs';

const SPEC = {
  spec: 'spec/demo.qnt',
  driver: { path: 'test/D.t.sol', contract: 'D' },
  solidityOut: 'gen',
  fixtureOut: 'fix',
  state: { n: 'uint256' },
  actions: { go: {}, stop: {} },
};

/** A clean tree whose one fixture reports the given per-action counts. */
const tree = (counts, coverage) =>
  fixtureTree({
    spec: coverage ? { ...SPEC, coverage } : SPEC,
    meta: { actionCounts: counts ?? undefined },
  });

test('coverage floors pass when the traces meet them', () => {
  const { model, root } = tree({ go: 10, stop: 4 }, { minSteps: { go: 5, stop: 1 } });
  assert.deepEqual(checkModel(model, root).problems, []);
});

// The failure this exists for: an action that quietly stops being exercised.
// Every trace still replays green, it just stops testing that action.
test('an action below its floor is named, with both numbers', () => {
  const { model, root } = tree({ go: 10, stop: 1 }, { minSteps: { stop: 5 } });
  const { problems } = checkModel(model, root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /`stop` ran 1 time\(s\).*floor is 5/);
});

test('an action that vanished entirely is named', () => {
  const { model, root } = tree({ go: 10 }, { minSteps: { stop: 1 } });
  assert.match(checkModel(model, root).problems[0], /`stop` ran 0 time\(s\)/);
});

test('a floor naming an action the spec does not have is rejected', () => {
  const { model, root } = tree({ go: 1 }, { minSteps: { nope: 1 } });
  assert.match(checkModel(model, root).problems[0], /not one of this spec's actions/);
});

// Counts are optional metadata; only a declared floor makes them required.
test('fixtures without counts are fine until a floor needs them', () => {
  const noCounts = tree(null, null);
  assert.deepEqual(checkModel(noCounts.model, noCounts.root).problems, []);

  const withFloor = tree(null, { minSteps: { go: 1 } });
  assert.match(checkModel(withFloor.model, withFloor.root).problems[0], /carry no per-action counts/);
});
