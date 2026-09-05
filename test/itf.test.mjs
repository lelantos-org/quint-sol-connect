import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeValue, decodeTrace, ItfError, MBT_ACTION, MBT_PICKS } from '../src/itf.mjs';

test('decodes each ITF value shape', () => {
  assert.equal(decodeValue({ '#bigint': '-42' }), -42n);
  assert.equal(decodeValue(true), true);
  assert.equal(decodeValue('hello'), 'hello');
  assert.deepEqual(decodeValue([{ '#bigint': '1' }]), { __t: 'list', items: [1n] });
  assert.deepEqual(decodeValue({ '#tup': [] }), { __t: 'tup', items: [] });
  assert.deepEqual(decodeValue({ '#set': [{ '#bigint': '2' }] }), { __t: 'set', items: [2n] });
  assert.deepEqual(decodeValue({ '#map': [[{ '#bigint': '1' }, true]] }), {
    __t: 'map',
    entries: [[1n, true]],
  });
  assert.deepEqual(decodeValue({ a: { '#bigint': '1' } }), { __t: 'rec', fields: { a: 1n } });
  assert.deepEqual(decodeValue({ tag: 'Idle', value: { '#tup': [] } }), {
    __t: 'variant',
    tag: 'Idle',
    value: { __t: 'tup', items: [] },
  });
});

test('a bare JSON number is rejected rather than silently rounded', () => {
  assert.throws(() => decodeValue(3, 'x.y'), (e) => e instanceof ItfError && /x\.y/.test(e.message));
});

test('unserializable values name the variable and suggest a way out', () => {
  assert.throws(
    () => decodeValue({ '#unserializable': 'Int' }, 'states[0].big'),
    (e) => /ignoreState/.test(e.message) && /states\[0\]\.big/.test(e.message),
  );
});

test('record decoding drops #-prefixed keys', () => {
  assert.deepEqual(decodeValue({ '#meta': { index: 3 }, a: true }), {
    __t: 'rec',
    fields: { a: true },
  });
});

const state = (action, picks, vars) => ({
  [MBT_ACTION]: action,
  [MBT_PICKS]: picks,
  ...vars,
});
const some = (v) => ({ tag: 'Some', value: v });
const none = { tag: 'None', value: { '#tup': [] } };

test('decodeTrace marks state 0 initial and splits picks from variables', () => {
  const raw = {
    vars: ['count'],
    states: [
      state('step', { by: none }, { count: { '#bigint': '0' } }),
      state('increment', { by: some({ '#bigint': '7' }) }, { count: { '#bigint': '7' } }),
    ],
  };
  const t = decodeTrace(raw);
  assert.deepEqual(t.vars, ['count']);
  assert.equal(t.steps[0].isInitial, true);
  assert.equal(t.steps[1].isInitial, false);
  assert.equal(t.steps[1].action, 'increment');
  assert.deepEqual(t.steps[1].picks.by, { present: true, value: 7n });
  assert.deepEqual(t.steps[0].picks.by, { present: false });
  assert.equal(t.steps[1].state.count, 7n);
});

test('a trace without --mbt metadata is rejected by name', () => {
  assert.throws(
    () => decodeTrace({ states: [{ count: { '#bigint': '0' } }] }),
    (e) => /--mbt/.test(e.message),
  );
});

test('states that disagree about which variables exist are rejected', () => {
  const raw = {
    states: [
      state('step', {}, { a: { '#bigint': '0' } }),
      state('go', {}, { b: { '#bigint': '1' } }),
    ],
  };
  assert.throws(() => decodeTrace(raw), (e) => /declares variables/.test(e.message));
});

test('a non-option nondet pick is rejected', () => {
  const raw = { states: [state('step', { by: { '#bigint': '1' } }, { a: true })] };
  assert.throws(() => decodeTrace(raw), (e) => /option/.test(e.message));
});
