import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveQuint, quintVersion, QuintError } from '../src/quint.mjs';

// Found through module resolution, not a fixed path under this package: npm
// hoists quint to a consumer's top-level node_modules, where the fixed path
// missed it and PATH - with whatever version it held - won.
test('the bundled quint is found through module resolution and run with this node', () => {
  const bin = resolveQuint(null);
  assert.equal(bin.command, process.execPath);
  assert.equal(bin.prefix.length, 1);
  assert.ok(fs.existsSync(bin.prefix[0]));
  assert.match(bin.prefix[0], /@informalsystems[\\/]quint/);
  assert.match(quintVersion(bin), /^\d+\.\d+\.\d+/);
});

test('an explicit quintBin wins, and one that does not exist is named', () => {
  assert.deepEqual(resolveQuint(process.execPath), { command: process.execPath, prefix: [] });
  assert.throws(() => resolveQuint('/nowhere/quint'), (e) => e instanceof QuintError && /does not exist/.test(e.message));
});
