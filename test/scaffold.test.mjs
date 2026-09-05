import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModel } from '../src/config.mjs';
import { emitDriverStub } from '../src/emit/scaffold.mjs';

const model = (driverPath, solidityOut) =>
  buildModel(
    'latch',
    {
      spec: 'spec/latch.qnt',
      driver: { path: driverPath, contract: 'LatchReplay' },
      solidityOut,
      state: { armed: 'bool' },
      actions: { arm: {}, pull: { n: 'uint256' } },
    },
    {},
  );

const importsOf = (src) => src.split('\n').filter((l) => l.startsWith('import'));

// Solidity resolves a relative import against the importing file, not the
// project root. Emitting the config's `solidityOut` verbatim produced
// `import ... from "test/generated/LatchSpec.sol"`, which does not compile.
test('imports are relative to the driver, not to the project root', () => {
  assert.deepEqual(importsOf(emitDriverStub(model('test/LatchReplay.t.sol', 'test/generated'), 'q')), [
    'import { LatchSpec } from "./generated/LatchSpec.sol";',
    'import { LatchSpecReplay } from "./generated/LatchSpecReplay.sol";',
  ]);
});

test('imports climb out of the driver directory when they have to', () => {
  const src = emitDriverStub(model('test/quint/LatchReplay.t.sol', 'generated/sol'), 'q');
  assert.deepEqual(importsOf(src), [
    'import { LatchSpec } from "../../generated/sol/LatchSpec.sol";',
    'import { LatchSpecReplay } from "../../generated/sol/LatchSpecReplay.sol";',
  ]);
});

test('the stub reverts on every branch rather than returning defaults', () => {
  const src = emitDriverStub(model('test/LatchReplay.t.sol', 'test/generated'), 'q');
  // One per action, plus setUp and _project. An unfilled branch must fail
  // loudly; a stub that returned zeros would compare clean against a fresh
  // contract and look like a passing suite.
  assert.equal((src.match(/revert\("TODO/g) ?? []).length, 4);
  assert.match(src, /abstract contract LatchReplay is LatchSpecReplay/);
});
