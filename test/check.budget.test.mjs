import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildModel } from '../src/config.mjs';
import { checkModel } from '../src/check.mjs';
import { TOOL_VERSION, EXEMPLAR_ITF } from '../src/gen.mjs';

const SPEC = {
  spec: 'spec/demo.qnt',
  driver: { path: 'test/D.t.sol', contract: 'D' },
  solidityOut: 'gen',
  fixtureOut: 'fix',
  state: { n: 'uint256' },
  actions: { go: {} },
};

/** A tree `checkModel` considers clean, with `blobBytes` of padding in the blob. */
function tree({ budget, blobBytes = 8, exemplar = true, extraItf = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qcs-budget-'));
  const model = buildModel('demo', budget ? { ...SPEC, budget } : SPEC, {});

  const dir = path.join(root, 'fix', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    spec: SPEC.spec,
    toolVersion: TOOL_VERSION,
    schemaHash: model.schemaHash,
    testName: 'test_quint_demo_000',
    ...(exemplar ? { exemplar: true, itf: `fix/demo/${EXEMPLAR_ITF}` } : {}),
  };
  fs.writeFileSync(
    path.join(dir, 'trace-000.json'),
    JSON.stringify({ meta, steps: `0x${'ab'.repeat(blobBytes)}` }),
  );
  if (exemplar) fs.writeFileSync(path.join(dir, EXEMPLAR_ITF), '{}');
  if (extraItf) fs.writeFileSync(path.join(dir, extraItf), '{}');

  const gen = path.join(root, 'gen');
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(
    path.join(gen, 'DemoSpec.sol'),
    `library DemoSpec { bytes32 internal constant SCHEMA_HASH = ${model.schemaHash}; }`,
  );
  fs.writeFileSync(path.join(gen, 'DemoSpecReplay.sol'), '');
  fs.writeFileSync(
    path.join(gen, 'DemoTraces.t.sol'),
    'function test_quint_demo_000() public { _replay("fix/demo/trace-000.json"); }',
  );
  return { model, root };
}

// --- the byte budget -------------------------------------------------------

test('a spec inside its budget is clean, and reports the numbers', () => {
  const { model, root } = tree();
  const r = checkModel(model, root);
  assert.deepEqual(r.problems, []);
  assert.equal(r.cap, 512_000);
  assert.ok(r.bytes > 0);
});

test('a spec over its budget is named, with both numbers', () => {
  const { model, root } = tree({ budget: { maxBytes: 100 }, blobBytes: 4000 });
  const { problems } = checkModel(model, root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /over the byte budget/);
});

// The commit that legitimately adds an action should not be the one that first
// meets a hard wall.
test('a spec near its budget warns rather than failing', () => {
  // Measure first, then set a cap the tree sits just under, so the test does
  // not depend on the exact size of the meta JSON.
  const probe = tree({ blobBytes: 150 });
  const bytes = checkModel(probe.model, probe.root).bytes;

  const { model, root } = tree({
    budget: { maxBytes: Math.ceil(bytes / 0.9) },
    blobBytes: 150,
  });
  const { problems, warnings } = checkModel(model, root);
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /approaching the byte budget/);
});

test('ITF companions count against the budget, being committed bytes too', () => {
  const a = tree();
  const withoutItf = checkModel(a.model, a.root).bytes;
  fs.appendFileSync(path.join(a.root, 'fix', 'demo', EXEMPLAR_ITF), 'x'.repeat(500));
  assert.ok(checkModel(a.model, a.root).bytes > withoutItf);
});

// --- the exemplar rule -----------------------------------------------------

test('a spec with no exemplar is named', () => {
  const { model, root } = tree({ exemplar: false });
  assert.match(checkModel(model, root).problems.join('\n'), /no fixture is marked/);
});

// Without this, an ITF written before the exemplar rule lingers forever and
// quietly spends the byte budget.
test('a stale non-exemplar ITF is named', () => {
  const { model, root } = tree({ extraItf: 'trace-005.itf.json' });
  const { problems } = checkModel(model, root);
  assert.match(problems.join('\n'), /stale ITF companion\(s\): trace-005\.itf\.json/);
  assert.match(problems.join('\n'), /gen --itf/);
});
