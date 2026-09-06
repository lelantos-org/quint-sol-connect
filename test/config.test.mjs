import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, buildModel, buildModels, ConfigError, DEFAULTS } from '../src/config.mjs';
import { TypeError_ } from '../src/types.mjs';
import { checkModel } from '../src/check.mjs';
import { fixtureMeta, DEMO_SPEC_TEXT } from './helpers/fixtureTree.mjs';

const tmp = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcs-test-'));
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(dir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const SPEC = {
  spec: 'demo.qnt',
  driver: { path: 'test/Demo.t.sol', contract: 'DemoDriver' },
  state: { count: 'uint256' },
  actions: { increment: { by: 'uint256' }, finish: {} },
};

const model = (raw = {}, config = {}) => buildModel('demo', { ...SPEC, ...raw }, config);

// --- loading ---------------------------------------------------------------

test('loads quint-sol-connect.config.mjs from the root', async () => {
  const dir = tmp({ 'quint-sol-connect.config.mjs': 'export default { specs: { a: 1 } };\n' });
  const { config, file } = await loadConfig(dir);
  assert.deepEqual(config, { specs: { a: 1 } });
  assert.equal(file, path.join(dir, 'quint-sol-connect.config.mjs'));
});

test('loads a JSON config', async () => {
  const dir = tmp({ 'quint-sol-connect.config.json': '{"specs":{"a":1}}' });
  const { config } = await loadConfig(dir);
  assert.deepEqual(config, { specs: { a: 1 } });
});

// A config whose own import is broken raises ERR_MODULE_NOT_FOUND naming the
// config as the *importer*. Treating that as "the file is absent" reported a
// typo'd import as a missing config, which sends the reader to the wrong file.
test('a config that exists but fails to import reports its own error', async () => {
  const dir = tmp({
    'quint-sol-connect.config.mjs': "import { x } from './nope.mjs';\nexport default { specs: {} };\n",
  });
  await assert.rejects(loadConfig(dir), (e) => {
    assert.ok(!(e instanceof ConfigError), 'must not be reported as a missing config');
    assert.match(e.message, /nope\.mjs/);
    return true;
  });
});

test('an explicit --config that does not exist says so by name', async () => {
  const dir = tmp({});
  await assert.rejects(loadConfig(dir, 'nowhere.mjs'), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /"nowhere\.mjs" does not exist/);
    return true;
  });
});

test('no config at all names the file to create', async () => {
  await assert.rejects(loadConfig(tmp({})), (e) => e instanceof ConfigError && /quint-sol-connect\.config\.mjs/.test(e.message));
});

// --- model building --------------------------------------------------------

test('defaults fill in, and a spec entry overrides the top level', () => {
  const m = model({}, { pragma: '^0.8.20' });
  assert.equal(m.pragma, '^0.8.20');
  assert.equal(m.fixtureOut, DEFAULTS.fixtureOut);
  assert.equal(model({ pragma: '0.8.30' }, { pragma: '^0.8.20' }).pragma, '0.8.30');
});

test('run options merge over the defaults rather than replacing them', () => {
  const m = model({ run: { traces: 3 } });
  assert.equal(m.run.traces, 3);
  assert.equal(m.run.maxSteps, DEFAULTS.run.maxSteps);
});

test('the action enum order follows the config, and pins the wire indices', () => {
  assert.deepEqual(model().actions.map((a) => [a.name, a.index, a.enumName]), [
    ['increment', 0, 'Increment'],
    ['finish', 1, 'Finish'],
  ]);
});

test('the schema hash moves when the state or pick shape does', () => {
  const base = model().schemaHash;
  assert.notEqual(base, model({ state: { count: 'uint128' } }).schemaHash);
  assert.notEqual(base, model({ state: { count: 'uint256', flag: 'bool' } }).schemaHash);
  assert.notEqual(base, model({ actions: { increment: { by: 'address' }, finish: {} } }).schemaHash);
  assert.equal(base, model().schemaHash, 'and is stable for an unchanged config');
});

// A step's action is a `uint8` however many actions there are, so none of these
// changes the ABI type string. Each one repoints every tag a committed fixture
// already holds, which is exactly what the hash exists to catch.
test('the schema hash moves when actions are renamed, reordered or dropped', () => {
  const base = model().schemaHash;
  const withActions = (actions) => model({ actions }).schemaHash;
  assert.notEqual(base, withActions({ finish: {}, increment: { by: 'uint256' } }), 'reordered');
  assert.notEqual(base, withActions({ increment: { by: 'uint256' }, reset: {} }), 'renamed');
  assert.notEqual(base, withActions({ increment: { by: 'uint256' } }), 'dropped');
});

// Reordering state variables reorders the ABI tuple, so a fixture encoded
// under the old order decodes into the wrong fields. It must not hash the same.
test('reordering state variables changes the schema hash', () => {
  const a = model({ state: { count: 'uint256', other: 'uint128' } });
  const b = model({ state: { other: 'uint128', count: 'uint256' } });
  assert.notEqual(a.schemaHash, b.schemaHash);
});

test('a pick shared across actions records both owners', () => {
  const m = model({ actions: { a: { key: 'uint256' }, b: { key: 'uint256' } } });
  assert.deepEqual(m.picks.map((p) => [p.name, p.requiredBy]), [['key', ['a', 'b']]]);
});

test('a pick with two types across actions is rejected', () => {
  assert.throws(
    () => model({ actions: { a: { key: 'uint256' }, b: { key: 'address' } } }),
    (e) => e instanceof ConfigError && /"key" is uint256 in one action and address/.test(e.message),
  );
});

for (const [label, raw, pattern] of [
  ['no spec path', { spec: undefined }, /no `spec` path/],
  ['no state map', { state: undefined }, /no `state` map/],
  ['no actions map', { actions: undefined }, /no `actions` map/],
  ['empty state', { state: {} }, /declares no state variables/],
  ['empty actions', { actions: {} }, /declares no actions/],
]) {
  test(`rejects a spec with ${label}`, () => {
    assert.throws(() => model(raw), (e) => e instanceof ConfigError && pattern.test(e.message));
  });
}

test('more actions than the uint8 wire tag can hold is rejected', () => {
  const actions = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`a${i}`, {}]));
  assert.throws(() => model({ actions }), (e) => e instanceof ConfigError && /more than 256 actions/.test(e.message));
});

test('ignoreState needs a reason, and cannot name a compared variable', () => {
  assert.throws(
    () => model({ ignoreState: { clock: '' } }),
    (e) => e instanceof ConfigError && /needs a reason string/.test(e.message),
  );
  assert.throws(
    () => model({ ignoreState: { count: 'because' } }),
    (e) => e instanceof ConfigError && /in both `state` and `ignoreState`/.test(e.message),
  );
});

test('a bad type descriptor names the config path that carries it', () => {
  assert.throws(
    () => model({ state: { count: 'uint255' } }),
    (e) => e instanceof TypeError_ && /demo\.state\.count/.test(e.message),
  );
});

test('buildModels honours declaration order and rejects an unknown name', () => {
  const config = { specs: { one: SPEC, two: SPEC } };
  assert.deepEqual(buildModels(config).map((m) => m.name), ['one', 'two']);
  assert.deepEqual(buildModels(config, ['two']).map((m) => m.name), ['two']);
  assert.throws(
    () => buildModels(config, ['three']),
    (e) => e instanceof ConfigError && /known specs: one, two/.test(e.message),
  );
  assert.throws(() => buildModels({}), (e) => e instanceof ConfigError && /no `specs` map/.test(e.message));
});

// --- the drift gate --------------------------------------------------------

// `check` hashes the spec off disk, so `root` decides part of the meta and the
// fixture cannot be built until the tree exists. Hence the two-step: lay the
// files down, then rewrite the fixture with a meta that knows where they are.
const fixture = (m, root, over = {}) =>
  JSON.stringify({ meta: { ...fixtureMeta(m, root, 'demo'), ...over }, steps: '0xdeadbeef' });

/** A tree `checkModel` considers clean, so each test perturbs exactly one thing. */
function clean(over = {}, metaOver = {}) {
  const m = model({ fixtureOut: 'fx', solidityOut: 'gen' });
  const files = {
    'demo.qnt': DEMO_SPEC_TEXT,
    'fx/demo/trace-000.json': '{}',
    'fx/demo/exemplar.itf.json': '{}',
    'gen/DemoSpec.sol': `bytes32 internal constant SCHEMA_HASH = ${m.schemaHash};`,
    'gen/DemoSpecReplay.sol': '',
    'gen/DemoTraces.t.sol': 'function test_quint_demo_000() public { _replay("fx/demo/trace-000.json"); }',
    ...over,
  };
  for (const k of Object.keys(files)) if (files[k] === null) delete files[k];
  const root = tmp(files);
  // Only now can the fixture be written: its meta carries the spec's hash.
  if (files['fx/demo/trace-000.json'] === '{}') {
    fs.writeFileSync(path.join(root, 'fx/demo/trace-000.json'), fixture(m, root, metaOver));
  }
  return { m, root };
}

test('a consistent tree has no problems', () => {
  const { m, root } = clean();
  const { problems, fixtures } = checkModel(m, root);
  assert.deepEqual(problems, []);
  assert.equal(fixtures, 1);
});

test('a fixture generated for another schema is named', () => {
  const { m, root } = clean({}, { schemaHash: `0x${'11'.repeat(32)}` });
  const { problems } = checkModel(m, root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 of 1 fixtures carry schema hash 0x1111/);
});

test('a fixture generated by another tool version is named', () => {
  const { m, root } = clean({}, { toolVersion: '0.0.1' });
  assert.match(checkModel(m, root).problems.join('\n'), /generated by quint-sol-connect 0\.0\.1/);
});

test('a missing ITF companion is named', () => {
  const { m, root } = clean({ 'fx/demo/exemplar.itf.json': null });
  assert.match(checkModel(m, root).problems.join('\n'), /it is the exemplar but its ITF .* is missing/);
});

test('a generated library whose SCHEMA_HASH disagrees with the config is named', () => {
  const { m, root } = clean({ 'gen/DemoSpec.sol': `bytes32 internal constant SCHEMA_HASH = 0x${'22'.repeat(32)};` });
  assert.match(checkModel(m, root).problems.join('\n'), /SCHEMA_HASH 0x2222.* but the config yields/);
});

// The generated tests name fixtures as literal paths and `vm.readFile` them.
// Without this the divergence only surfaces inside `forge test`, as a file
// error rather than a drift error.
test('a test replaying a fixture that is not on disk is named', () => {
  const { m, root } = clean({
    'gen/DemoTraces.t.sol': '_replay("fx/demo/trace-000.json"); _replay("fx/demo/trace-009.json");',
  });
  assert.match(checkModel(m, root).problems.join('\n'), /replays 1 fixture\(s\) that do not exist: fx\/demo\/trace-009\.json/);
});

test('a fixture with no test to replay it is named', () => {
  const { m, root } = clean({ 'gen/DemoTraces.t.sol': '// no tests' });
  assert.match(checkModel(m, root).problems.join('\n'), /1 fixture\(s\) have no test/);
});

test('an absent fixture directory says which command makes one', () => {
  const { m, root } = clean({ 'fx/demo/trace-000.json': null, 'fx/demo/exemplar.itf.json': null });
  assert.match(checkModel(m, root).problems.join('\n'), /no fixtures at .* run `quint-sol-connect gen demo`/);
});

/** The same model `clean` builds, for constructing fixtures that disagree with it. */
const m0 = () => model({ fixtureOut: 'fx', solidityOut: 'gen' });
