import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { checkModel } from '../src/check.mjs';
import { fixtureTree } from './helpers/fixtureTree.mjs';

const SPEC = {
  spec: 'spec/demo.qnt',
  driver: { path: 'test/D.t.sol', contract: 'D' },
  solidityOut: 'gen',
  fixtureOut: 'fix',
  run: { traces: 4, maxSteps: 20, maxSamples: 5000, seed: '0x1', invariant: 'allInvariants' },
  state: { n: 'uint256' },
  actions: { go: {} },
};

const tree = (over = {}) => fixtureTree({ spec: { ...SPEC, ...over } });

// --- the spec itself -------------------------------------------------------
//
// The schema hash covers the config: the state shape and the action names. It
// does not cover the model. Without a spec hash a `.qnt` file could be
// rewritten from top to bottom and `check` would still report ok, against
// traces describing whatever it said before - which is the single drift the
// whole design exists to catch.

test('a spec edited without a regeneration is named', () => {
  const { model, root, specAbs } = tree();
  assert.deepEqual(checkModel(model, root).problems, []);

  fs.appendFileSync(specAbs, '\n// one more line\n');
  const { problems } = checkModel(model, root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /spec\/demo\.qnt has changed since these 1 fixture\(s\)/);
});

// Whitespace is not exempt: quint's sampler is fed the file, and "it only moved
// a comment" is a judgement `check` is in no position to make.
test('any change to the spec counts, including a comment', () => {
  const { model, root, specAbs } = tree();
  fs.writeFileSync(specAbs, `${fs.readFileSync(specAbs, 'utf8')}// c\n`);
  assert.match(checkModel(model, root).problems[0], /has changed/);
});

// A fixture from before the field carries no hash at all. That is not evidence
// the spec changed - it is evidence nothing is known - and saying otherwise
// would be a guess presented as a fact.
test('a fixture with no spec hash says so, rather than claiming a change', () => {
  const { model, root } = fixtureTree({ spec: SPEC, meta: { specHash: undefined } });
  const { problems } = checkModel(model, root);
  assert.match(problems.join('\n'), /carry no spec hash - they predate it/);
  assert.doesNotMatch(problems.join('\n'), /has changed/);
});

test('a spec file that has been deleted is named, not thrown', () => {
  const { model, root, specAbs } = tree();
  fs.rmSync(specAbs);
  assert.match(checkModel(model, root).problems.join('\n'), /cannot read spec\/demo\.qnt to hash it/);
});

// --- the run parameters ----------------------------------------------------
//
// Each of these changes which traces come out, and none of them touches the
// schema hash.

for (const [key, value] of [
  ['seed', '0xdeadbeef'],
  ['traces', 40],
  ['maxSteps', 99],
  ['maxSamples', 1],
  ['invariant', 'somethingElse'],
  ['backend', 'typescript'],
]) {
  test(`run.${key} changed in the config without a regeneration is named`, () => {
    // The config has moved on; the fixture still carries what it was generated
    // with. `fixtureTree` derives meta from the model it is handed, so the
    // stale value goes in as an override.
    const stale = key === 'backend' ? 'rust' : SPEC.run[key];
    const { model, root } = fixtureTree({
      spec: { ...SPEC, run: { ...SPEC.run, [key]: value } },
      meta: { [key]: key === 'seed' ? String(stale) : stale },
    });

    const { problems } = checkModel(model, root);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], new RegExp(`run\\.${key} is `));
  });
}

// Six lines saying `undefined` would bury the one fact that matters.
test('a fixture predating run-parameter checks reports that once', () => {
  const { model, root } = fixtureTree({
    spec: SPEC,
    meta: { traces: undefined, maxSteps: undefined, maxSamples: undefined, invariant: undefined },
  });
  const { problems } = checkModel(model, root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /record no run\.traces, run\.maxSteps, run\.maxSamples, run\.invariant/);
});

// --- the missing-fixture early exit ---------------------------------------
//
// The caller sums `bytes` and `cap` to police the global total. One `undefined`
// makes that sum NaN, `allocated > total` false, and the ceiling silently stops
// applying to every other spec.

test('a spec with no fixture directory still reports its numbers', () => {
  const { model, root } = tree();
  fs.rmSync(path.join(root, 'fix', 'demo'), { recursive: true });
  const r = checkModel(model, root);
  assert.match(r.problems.join('\n'), /no fixtures at/);
  assert.equal(r.bytes, 0);
  assert.equal(r.cap, model.maxBytes, 'a reserved allocation is spent whether or not it is generated');
  assert.deepEqual(r.warnings, []);
  assert.ok(Number.isFinite(r.bytes + r.cap));
});
