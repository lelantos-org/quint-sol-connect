import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildModel } from '../src/config.mjs';
import { checkModel } from '../src/check.mjs';
import { TOOL_VERSION } from '../src/gen.mjs';

const SPEC = {
  spec: 'spec/demo.qnt',
  driver: { path: 'test/D.t.sol', contract: 'D' },
  solidityOut: 'gen',
  fixtureOut: 'fix',
  state: { n: 'uint256' },
  actions: { go: {}, stop: {} },
};

/** A tree `checkModel` considers consistent, with the given per-action counts. */
function tree(counts, coverage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qcs-cov-'));
  const model = buildModel('demo', coverage ? { ...SPEC, coverage } : SPEC, {});

  const dir = path.join(root, 'fix', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    spec: SPEC.spec,
    quintVersion: '0.32.0',
    toolVersion: TOOL_VERSION,
    seed: '0x1',
    traceIndex: 0,
    steps: 3,
    actions: ['go', 'stop'],
    schemaHash: model.schemaHash,
    testName: 'test_quint_demo_000',
    exemplar: true,
    itf: 'fix/demo/exemplar.itf.json',
    ...(counts ? { actionCounts: counts } : {}),
  };
  fs.writeFileSync(path.join(dir, 'trace-000.json'), JSON.stringify({ meta, steps: '0x00' }));
  fs.writeFileSync(path.join(dir, 'exemplar.itf.json'), '{}');

  const gen = path.join(root, 'gen');
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(
    path.join(gen, 'DemoSpec.sol'),
    `library DemoSpec { bytes32 internal constant SCHEMA_HASH = ${model.schemaHash}; }`,
  );
  fs.writeFileSync(path.join(gen, 'DemoSpecReplay.sol'), '');
  // `check` also verifies every fixture is replayed by a test, so the stub has
  // to name the fixture path the way the generator would.
  fs.writeFileSync(
    path.join(gen, 'DemoTraces.t.sol'),
    'function test_quint_demo_000() public { _replay("fix/demo/trace-000.json"); }',
  );
  return { model, root };
}

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
