import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';

import { Decls, resolveType } from '../src/types.mjs';
import { lowerValue, stepArrayAbi, LowerError } from '../src/lower.mjs';
import { buildModel } from '../src/config.mjs';
import { indexActions, GenError } from '../src/gen.mjs';

const resolve = (desc, hint = 'X') => resolveType(desc, new Decls(), { path: 'x', hint });

const set = (...items) => ({ __t: 'set', items });
const map = (...entries) => ({ __t: 'map', entries });
const rec = (fields) => ({ __t: 'rec', fields });
const variant = (tag) => ({ __t: 'variant', tag, value: { __t: 'tup', items: [] } });

test('integer widths are enforced, not wrapped', () => {
  assert.equal(lowerValue(resolve('uint8'), 255n, 'p'), 255n);
  assert.throws(() => lowerValue(resolve('uint8'), 256n, 'p'), LowerError);
  assert.throws(() => lowerValue(resolve('uint256'), -1n, 'p'), (e) => /negative/.test(e.message));
  assert.equal(lowerValue(resolve('int8'), -128n, 'p'), -128n);
  assert.throws(() => lowerValue(resolve('int8'), 128n, 'p'), LowerError);
});

test('sets are sorted ascending, because Quint sets have no order', () => {
  const node = resolve({ set: 'uint256' });
  assert.deepEqual(lowerValue(node, set(9n, 2n, 7n), 'p'), [2n, 7n, 9n]);
});

test('maps are sorted by key and flattened into the entry struct', () => {
  const node = resolve(
    { map: { key: 'uint256', value: { record: { hits: 'uint256' }, name: 'E' } }, entryName: 'Row' },
    'Entries',
  );
  const out = lowerValue(node, map([3n, rec({ hits: 1n })], [1n, rec({ hits: 5n })]), 'p');
  assert.deepEqual(out, [
    { key: 1n, hits: 5n },
    { key: 3n, hits: 1n },
  ]);
});

test('a duplicate map key is an error, not a last-one-wins', () => {
  const node = resolve({ map: { key: 'uint256', value: 'uint256' } }, 'M');
  assert.throws(() => lowerValue(node, map([1n, 2n], [1n, 3n]), 'p'), (e) => /duplicate map key/.test(e.message));
});

test('variants lower to their declared index', () => {
  const node = resolve({ variant: ['Idle', 'Running', 'Done'], name: 'Status' });
  assert.equal(lowerValue(node, variant('Done'), 'p'), 2);
  assert.throws(() => lowerValue(node, variant('Nope'), 'p'), (e) => /not one of/.test(e.message));
});

test('a variant carrying a payload is refused rather than silently truncated', () => {
  const node = resolve({ variant: ['A'], name: 'V' });
  const withPayload = { __t: 'variant', tag: 'A', value: 1n };
  assert.throws(() => lowerValue(node, withPayload, 'p'), (e) => /payload-free/.test(e.message));
});

test('records must match the declared fields exactly', () => {
  const node = resolve({ record: { a: 'uint256', b: 'bool' }, name: 'R' });
  assert.deepEqual(lowerValue(node, rec({ a: 1n, b: true }), 'p'), { a: 1n, b: true });
  assert.throws(() => lowerValue(node, rec({ a: 1n }), 'p'), (e) => /missing declared field "b"/.test(e.message));
  assert.throws(
    () => lowerValue(node, rec({ a: 1n, b: true, c: 1n }), 'p'),
    (e) => /does not declare/.test(e.message),
  );
});

test('a set of structs is refused, because it has no canonical order', () => {
  assert.throws(
    () => resolve({ set: { record: { a: 'uint256' }, name: 'R' } }),
    (e) => /canonical order/.test(e.message),
  );
});

const MODEL_CONFIG = {
  spec: 's.qnt',
  driver: { path: 'd.sol', contract: 'D' },
  state: {
    count: 'uint256',
    status: { variant: ['Idle', 'Done'], name: 'Status' },
    seen: { set: 'uint256' },
  },
  actions: { go: { by: 'uint256' }, stop: {} },
};

test('the schema hash is structural: renaming a struct does not change it', () => {
  const a = buildModel('m', MODEL_CONFIG, {});
  const renamed = {
    ...MODEL_CONFIG,
    state: { ...MODEL_CONFIG.state, status: { variant: ['Idle', 'Done'], name: 'Phase' } },
  };
  const b = buildModel('m', renamed, {});
  assert.equal(a.schemaHash, b.schemaHash);
  assert.equal(a.canonical, '(uint8,(bool,uint256),(uint256,uint8,uint256[]))[]');
});

test('the schema hash changes when a field is added, retyped or reordered', () => {
  const base = buildModel('m', MODEL_CONFIG, {}).schemaHash;

  const added = buildModel('m', { ...MODEL_CONFIG, state: { ...MODEL_CONFIG.state, extra: 'bool' } }, {});
  assert.notEqual(added.schemaHash, base);

  const retyped = buildModel('m', { ...MODEL_CONFIG, state: { ...MODEL_CONFIG.state, count: 'uint64' } }, {});
  assert.notEqual(retyped.schemaHash, base);

  const reordered = buildModel(
    'm',
    { ...MODEL_CONFIG, state: { status: MODEL_CONFIG.state.status, count: 'uint256', seen: { set: 'uint256' } } },
    {},
  );
  assert.notEqual(reordered.schemaHash, base);
});

test('a pick reused across actions with two types is rejected', () => {
  const bad = { ...MODEL_CONFIG, actions: { go: { by: 'uint256' }, stop: { by: 'bool' } } };
  assert.throws(() => buildModel('m', bad, {}), (e) => /must have one type/.test(e.message));
});

test('ignoreState entries need a reason, and cannot also be compared', () => {
  assert.throws(
    () => buildModel('m', { ...MODEL_CONFIG, ignoreState: { z: '' } }, {}),
    (e) => /needs a reason/.test(e.message),
  );
  assert.throws(
    () => buildModel('m', { ...MODEL_CONFIG, ignoreState: { count: 'why' } }, {}),
    (e) => /both/.test(e.message),
  );
});

test('an action the config does not declare is rejected with the spec-shape hint', () => {
  const model = buildModel('m', MODEL_CONFIG, {});
  const trace = {
    steps: [
      { index: 0, action: 'step', isInitial: true, picks: {}, state: {} },
      { index: 1, action: 'step', isInitial: false, picks: {}, state: {} },
    ],
  };
  assert.throws(
    () => indexActions(model, trace, 'out0'),
    (e) => e instanceof GenError && /bare named action/.test(e.message),
  );
});

test('an encoded step round-trips through the ABI', async () => {
  const { encodeTrace } = await import('../src/lower.mjs');
  const model = buildModel('m', MODEL_CONFIG, {});
  const trace = {
    steps: [
      {
        index: 0,
        action: 'step',
        isInitial: true,
        actionIndex: 0,
        picks: {},
        state: { count: 0n, status: variant('Idle'), seen: set() },
      },
      {
        index: 1,
        action: 'go',
        isInitial: false,
        actionIndex: 0,
        picks: { by: { present: true, value: 5n } },
        state: { count: 5n, status: variant('Done'), seen: set(5n) },
      },
    ],
  };
  const blob = encodeTrace(model, trace);
  const [steps] = decodeAbiParameters([stepArrayAbi(model).abi], blob);

  assert.equal(steps.length, 2);
  assert.equal(steps[1].action, 0);
  assert.equal(steps[1].picks.hasBy, true);
  assert.equal(steps[1].picks.by, 5n);
  assert.equal(steps[1].post.count, 5n);
  assert.equal(steps[1].post.status, 1);
  assert.deepEqual(steps[1].post.seen, [5n]);
  // A pick not drawn this step is zero-filled and flagged absent, so the
  // replay can tell "not drawn" from "drawn as zero".
  assert.equal(steps[0].picks.hasBy, false);
  assert.equal(steps[0].picks.by, 0n);
});
