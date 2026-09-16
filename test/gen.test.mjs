import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModel } from '../src/config.mjs';
import { generateSpec, GenError } from '../src/gen.mjs';
import { checkModel } from '../src/check.mjs';
import { contentHash } from '../src/emit/solidity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_ITF = path.join(REPO, 'examples/counter/fixtures/counter/exemplar.itf.json');

/**
 * A stand-in for the quint CLI: `typecheck` succeeds, `run` writes the committed
 * example ITF once per requested trace, and every invocation is logged so a
 * test can assert quint was never reached.
 */
const FAKE_QUINT = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_QUINT_LOG, args.join(' ') + '\\n');
if (args[0] === '--version') { console.log('0.32.0'); process.exit(0); }
if (args[0] === 'typecheck') process.exit(0);
const opt = (k) => args.find((a) => a.startsWith('--' + k + '='))?.split('=')[1];
const out = opt('out-itf');
for (let i = 0; i < Number(opt('n-traces')); i++) {
  fs.copyFileSync(process.env.FAKE_QUINT_ITF, path.join(path.dirname(out), 'out' + i + '.itf.json'));
}
`;

const COUNTER = {
  spec: 'spec/counter.qnt',
  module: 'counter',
  run: { traces: 2, maxSteps: 12, maxSamples: 5000, seed: '0x1', invariant: 'allInvariants' },
  driver: { path: 'test/CounterReplay.t.sol', contract: 'CounterReplay' },
  solidityOut: 'test/generated',
  fixtureOut: 'fixtures',
  state: {
    count: 'uint256',
    status: { variant: ['Idle', 'Running', 'Done'], name: 'Status' },
    seen: { set: 'uint256' },
    entries: {
      map: { key: 'uint256', value: { record: { hits: 'uint256', flagged: 'bool' }, name: 'Entry' } },
      entryName: 'EntriesEntry',
    },
  },
  actions: { increment: { by: 'uint256' }, touch: { key: 'uint256' }, finish: {} },
};

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qcs-gen-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'spec'));
  fs.copyFileSync(path.join(REPO, 'examples/counter/spec/counter.qnt'), path.join(root, 'spec/counter.qnt'));

  const script = path.join(root, 'fake-quint.mjs');
  fs.writeFileSync(script, FAKE_QUINT);
  const log = path.join(root, 'quint.log');
  fs.writeFileSync(log, '');
  process.env.FAKE_QUINT_LOG = log;
  process.env.FAKE_QUINT_ITF = EXAMPLE_ITF;

  const gen = (raw = COUNTER, opts = {}) =>
    generateSpec(buildModel('counter', raw, {}), {
      root,
      quintBin: { command: process.execPath, prefix: [script] },
      quintVer: '0.32.0',
      runtimeImport: 'quint-sol-connect',
      format: false,
      ...opts,
    });
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const quintCalls = () => read('quint.log').split('\n').filter(Boolean);
  const snapshot = (dir) =>
    Object.fromEntries(
      fs.readdirSync(path.join(root, dir), { recursive: true })
        .filter((f) => fs.statSync(path.join(root, dir, f)).isFile())
        .map((f) => [f, read(path.join(dir, f))]),
    );
  return { root, gen, read, quintCalls, snapshot };
}

test('gen writes fixtures and Solidity that check then accepts', () => {
  const { root, gen, read } = project();
  const summary = gen();
  assert.equal(summary.fixtures.length, 2);
  for (const f of ['fixtures/counter/trace-000.json', 'fixtures/counter/trace-001.json', 'fixtures/counter/exemplar.itf.json']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  assert.match(contentHash(read('test/generated/CounterSpec.sol')), /^0x[0-9a-f]{64}$/);
  assert.match(read('test/generated/CounterTraces.t.sol'), /import \{ CounterReplay \} from "\.\.\/CounterReplay\.t\.sol";/);

  // The two halves have to agree on what "current" means, so this is the test
  // that would notice one of them changing alone.
  assert.deepEqual(checkModel(buildModel('counter', COUNTER, {}), root).problems, []);
});

test('a lowering error leaves the committed fixtures and Solidity as they were', () => {
  const { gen, snapshot } = project();
  gen();
  const before = { fixtures: snapshot('fixtures'), sol: snapshot('test/generated') };

  // `count` holds integers; declaring it a bool fails while lowering trace 0,
  // after quint has run and every trace has decoded.
  const broken = { ...COUNTER, state: { ...COUNTER.state, count: 'bool' } };
  assert.throws(() => gen(broken), /expected a boolean/);

  assert.deepEqual(snapshot('fixtures'), before.fixtures);
  assert.deepEqual(snapshot('test/generated'), before.sol);
});

test('a spec with no driver fails before quint runs', () => {
  const { gen, quintCalls } = project();
  assert.throws(() => gen({ ...COUNTER, driver: undefined }), (e) => e instanceof GenError && /needs `driver/.test(e.message));
  assert.deepEqual(quintCalls(), []);
});

for (const [label, opts, pattern] of [
  ['--out without --sol-out', { outOverride: 'scratch/fx' }, /would rewrite the committed per-trace contract/],
  ['--sol-out without --out', { solOutOverride: 'scratch/sol' }, /would write the scratch fixtures over the committed ones/],
]) {
  test(`${label} is refused before quint runs`, () => {
    const { gen, quintCalls } = project();
    assert.throws(() => gen(COUNTER, opts), (e) => e instanceof GenError && pattern.test(e.message));
    assert.deepEqual(quintCalls(), []);
  });
}

test('a scratch run leaves the committed tree alone', () => {
  const { root, gen, snapshot, read } = project();
  gen();
  const before = { fixtures: snapshot('fixtures'), sol: snapshot('test/generated') };

  gen(COUNTER, { fresh: true, outOverride: 'scratch/fx', solOutOverride: 'scratch/sol' });

  assert.deepEqual(snapshot('fixtures'), before.fixtures);
  assert.deepEqual(snapshot('test/generated'), before.sol);
  assert.deepEqual(fs.readdirSync(path.join(root, 'scratch/sol')), ['CounterFreshTraces.t.sol']);
  assert.match(read('scratch/sol/CounterFreshTraces.t.sol'), /_replay\("scratch\/fx\/counter\/trace-000\.json"\)/);
});

test('--itf writes a non-exemplar companion to the scratch directory only', () => {
  const { root, gen } = project();
  const { exemplar } = gen(COUNTER, { itfIndices: 'all' });
  const other = exemplar === 0 ? 1 : 0;
  assert.ok(fs.existsSync(path.join(root, `fixtures/counter/.itf/trace-00${other}.itf.json`)));
  assert.ok(!fs.existsSync(path.join(root, `fixtures/counter/trace-00${other}.itf.json`)));
});
