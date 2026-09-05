import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';

import { buildModel } from '../src/config.mjs';
import { stepArrayAbi, encodeTrace, LowerError } from '../src/lower.mjs';
import { emitSpecLibrary, emitSpecReplay, emitTraces } from '../src/emit/solidity.mjs';
import { emitDriverStub } from '../src/emit/scaffold.mjs';

const model = (raw) =>
  buildModel('demo', { spec: 'demo.qnt', driver: { path: 'test/Demo.t.sol', contract: 'DemoDriver' }, ...raw }, {});

const WITH_PICKS = model({
  state: { count: 'uint256', flag: 'bool' },
  actions: { increment: { by: 'uint256' }, touch: { key: 'address' }, finish: {} },
});

const NO_PICKS = model({
  state: { count: 'uint256' },
  actions: { increment: {}, finish: {} },
});

/**
 * Fields of one emitted struct, in declaration order. The generated structs are
 * flat and carry no interior comments, so a regex is enough and keeps the test
 * reading the same text a compiler would.
 */
function solStructFields(src, name) {
  const m = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(src);
  assert.ok(m, `emitted library has no \`struct ${name}\``);
  return [...m[1].matchAll(/^\s*([\w[\]. ]+?)\s+(\w+);/gm)].map((x) => x[2]);
}

// --- the ABI and the Solidity must describe the same bytes -----------------
//
// These two are produced by different files from the same model, and nothing
// but agreement between them makes `abi.decode` in the replay loop correct. A
// field on one side and not the other decodes every trace as garbage rather
// than failing, so it is asserted directly rather than left to a Foundry run.

for (const [label, m] of [['with picks', WITH_PICKS], ['without picks', NO_PICKS]]) {
  test(`${label}: emitted Picks struct matches the ABI picks tuple`, () => {
    const abi = stepArrayAbi(m).abi.components.find((c) => c.name === 'picks');
    const emitted = solStructFields(emitSpecLibrary(m, 'gen'), 'Picks');
    assert.deepEqual(emitted, abi.components.map((c) => c.name));
    assert.ok(emitted.length > 0, 'Solidity forbids an empty struct');
  });

  test(`${label}: emitted State struct matches the ABI post tuple`, () => {
    const abi = stepArrayAbi(m).abi.components.find((c) => c.name === 'post');
    assert.deepEqual(
      solStructFields(emitSpecLibrary(m, 'gen'), 'State'),
      abi.components.map((c) => c.name),
    );
  });

  test(`${label}: an encoded trace round-trips through the same ABI`, () => {
    const trace = {
      steps: [
        { index: 0, actionIndex: 0, picks: {}, state: stateFor(m) },
        { index: 1, actionIndex: 1, picks: picksFor(m), state: stateFor(m) },
      ],
    };
    const blob = encodeTrace(m, trace);
    const [steps] = decodeAbiParameters([stepArrayAbi(m).abi], blob);
    assert.equal(steps.length, 2);
    assert.equal(steps[1].action, 1);
  });
}

const stateFor = (m) => Object.fromEntries(m.state.map((s) => [s.name, s.node.kind === 'bool' ? false : 0n]));
const picksFor = (m) =>
  Object.fromEntries(
    m.picks.map((p) => [
      p.name,
      { present: true, value: p.node.kind === 'address' ? 0n : 0n },
    ]),
  );

test('encodeTrace refuses a trace that indexActions has not run over', () => {
  const trace = { steps: [{ index: 0, action: 'init', picks: {}, state: stateFor(NO_PICKS) }] };
  assert.throws(() => encodeTrace(NO_PICKS, trace), (e) => e instanceof LowerError && /indexActions/.test(e.message));
});

// --- library ---------------------------------------------------------------

test('the library commits to the model schema hash', () => {
  const src = emitSpecLibrary(WITH_PICKS, 'gen');
  assert.match(src, new RegExp(`SCHEMA_HASH = ${WITH_PICKS.schemaHash};`));
  assert.match(src, new RegExp(`CANONICAL_TYPE = "${WITH_PICKS.canonical.replace(/[[\]()]/g, '\\$&')}"`));
});

test('the Action enum takes its order from the config', () => {
  assert.match(emitSpecLibrary(WITH_PICKS, 'gen'), /enum Action \{ Increment, Touch, Finish \}/);
});

test('a map value record is not emitted alongside the entry struct that flattens it', () => {
  const m = model({
    state: {
      entries: {
        map: { key: 'uint256', value: { record: { hits: 'uint256' }, name: 'Row' } },
        entryName: 'EntriesEntry',
      },
    },
    actions: { touch: {} },
  });
  const src = emitSpecLibrary(m, 'gen');
  assert.match(src, /struct EntriesEntry \{/);
  assert.doesNotMatch(src, /struct Row \{/, 'the superseded value record is dead code in the output');
  assert.deepEqual(solStructFields(src, 'EntriesEntry'), ['key', 'hits']);
});

test('ignoreState reasons are carried into the library next to State', () => {
  const m = model({
    state: { count: 'uint256' },
    ignoreState: { clock: 'wall time; the contract reads block.timestamp' },
    actions: { increment: {} },
  });
  assert.match(emitSpecLibrary(m, 'gen'), /Not compared: `clock` - wall time/);
});

// --- replay ----------------------------------------------------------------

test('the replay imports console2, which its loop uses', () => {
  const src = emitSpecReplay(WITH_PICKS, 'gen', { runtimeImport: 'quint-sol-connect' });
  assert.match(src, /import \{ console2 \} from "forge-std\/console2.sol";/);
  assert.match(src, /console2\.log/);
  assert.ok(
    src.indexOf('import { console2 }') < src.indexOf('abstract contract'),
    'imports must precede the contract',
  );
});

test('every declared pick is required for the action that declares it', () => {
  const src = emitSpecReplay(WITH_PICKS, 'gen', { runtimeImport: 'quint-sol-connect' });
  assert.match(src, /Action\.Increment\) \{\s*require\(p\.hasBy,/);
  assert.match(src, /Action\.Touch\) \{\s*require\(p\.hasKey,/);
  assert.doesNotMatch(src, /Action\.Finish\) \{/, 'an action with no picks needs no branch');
});

test('a pick-free spec still emits a compilable _requirePicks', () => {
  const src = emitSpecReplay(NO_PICKS, 'gen', { runtimeImport: 'quint-sol-connect' });
  assert.match(src, /no action declares a nondet pick/);
  assert.match(src, /\(a, p\);/, 'unused parameters must be silenced');
  assert.doesNotMatch(src, /require\(p\./);
});

test('state comparisons cover every state variable, through helpers for compound ones', () => {
  const m = model({
    state: { count: 'uint256', seen: { set: 'uint256' } },
    actions: { increment: {} },
  });
  const src = emitSpecReplay(m, 'gen', { runtimeImport: 'quint-sol-connect' });
  assert.match(src, /_mismatches \+= _eqU\("count", model_\.count, chain\.count\);/);
  assert.match(src, /_mismatches \+= _cmpArrUint256\("seen", model_\.seen, chain\.seen\);/);
  assert.match(src, /function _cmpArrUint256\(/);
});

test('enums are compared by name, not by index', () => {
  const m = model({
    state: { status: { variant: ['Idle', 'Done'], name: 'Status' } },
    actions: { finish: {} },
  });
  const src = emitSpecReplay(m, 'gen', { runtimeImport: 'quint-sol-connect' });
  assert.match(src, /_eqStr\("status", DemoSpec\.statusName\(model_\.status\), DemoSpec\.statusName\(chain\.status\)\)/);
});

// --- traces and scaffold ---------------------------------------------------

test('one test per fixture, named by the fixture', () => {
  const fixtures = [
    { testName: 'test_quint_demo_000', path: 'fixtures/demo/trace-000.json', steps: 3 },
    { testName: 'test_quint_demo_001', path: 'fixtures/demo/trace-001.json', steps: 4 },
  ];
  const src = emitTraces(WITH_PICKS, 'gen', {
    fixtures,
    driverImport: './Demo.t.sol',
    driverContract: 'DemoDriver',
    contractName: 'DemoTraces',
  });
  assert.match(src, /contract DemoTraces is DemoDriver \{/);
  for (const f of fixtures) {
    assert.match(src, new RegExp(`function ${f.testName}\\(\\) public \\{\\s*_replay\\("${f.path}"\\);`));
  }
});

test('the driver stub reverts in every branch rather than returning defaults', () => {
  const src = emitDriverStub(WITH_PICKS, 'quint-sol-connect');
  assert.match(src, /abstract contract DemoDriver is DemoSpecReplay \{/);
  assert.match(src, /revert\("TODO: deploy the system under test"\)/);
  assert.match(src, /revert\("TODO: increment\(picks\.by\)"\)/);
  assert.match(src, /revert\("TODO: finish\(\)"\)/);
  assert.match(src, /revert\("TODO: project implementation state"\)/);
  assert.match(src, /require\(msg\.sender == address\(this\), "self-call only"\)/);
});

test('every emitted file carries the regeneration command in its header', () => {
  const cmd = 'quint-sol-connect gen demo';
  for (const src of [
    emitSpecLibrary(WITH_PICKS, cmd),
    emitSpecReplay(WITH_PICKS, cmd, { runtimeImport: 'quint-sol-connect' }),
    emitTraces(WITH_PICKS, cmd, { fixtures: [], driverImport: './x.sol', driverContract: 'D', contractName: 'T' }),
  ]) {
    assert.match(src, /GENERATED by @lelantos-org\/quint-sol-connect from demo.qnt/);
    assert.match(src, new RegExp(`Regenerate with \`${cmd}\``));
  }
});
