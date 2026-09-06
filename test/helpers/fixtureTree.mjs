/**
 * A fixture tree that `checkModel` considers clean.
 *
 * Shared because three test files were each building one by hand, which meant
 * every field added to a fixture's `meta` broke all three at once - the exact
 * cost that made this worth extracting. Everything a fixture must carry to pass
 * `check` lives here, so a new field is added in one place.
 *
 * The spec file is written for real: `check` hashes it off disk to detect a
 * model edited without a regeneration, so a tree with no spec file is not a
 * clean tree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildModel } from '../../src/config.mjs';
import { TOOL_VERSION, EXEMPLAR_ITF, hashSpec } from '../../src/gen.mjs';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const DEMO_SPEC_TEXT = 'module demo { var n: int action init = n\' = 0 }\n';

/**
 * @param {object}   o
 * @param {object}   o.spec        the config entry; `spec`, `state`, `actions` required
 * @param {string}   [o.name]      spec name, default 'demo'
 * @param {object}   [o.config]    the surrounding config object
 * @param {object}   [o.meta]      fields merged over the generated meta, to break it deliberately
 * @param {string}   [o.blob]      the steps blob, default a short one
 * @param {boolean}  [o.exemplar]  mark the fixture as the exemplar and write its ITF
 * @param {string}   [o.extraItf]  an additional, stale ITF companion
 * @param {string}   [o.specText]  contents of the spec file
 */
export function fixtureTree({
  spec,
  name = 'demo',
  config = {},
  meta: metaOverride = {},
  blob = `0x${'ab'.repeat(8)}`,
  exemplar = true,
  extraItf = null,
  specText = DEMO_SPEC_TEXT,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qcs-${name}-`));
  const model = buildModel(name, spec, config);

  const specAbs = path.join(root, spec.spec);
  fs.mkdirSync(path.dirname(specAbs), { recursive: true });
  fs.writeFileSync(specAbs, specText);

  const dir = path.join(root, model.fixtureOut, name);
  fs.mkdirSync(dir, { recursive: true });

  const meta = { ...fixtureMeta(model, root, name), ...metaOverride };
  if (!exemplar) {
    delete meta.exemplar;
    delete meta.itf;
  }
  // An explicit `undefined` means "this fixture predates the field", which is a
  // different tree from one where the field merely takes its default.
  for (const [k, v] of Object.entries(metaOverride)) if (v === undefined) delete meta[k];

  fs.writeFileSync(path.join(dir, 'trace-000.json'), JSON.stringify({ meta, steps: blob }));
  if (exemplar) fs.writeFileSync(path.join(dir, EXEMPLAR_ITF), '{}');
  if (extraItf) fs.writeFileSync(path.join(dir, extraItf), '{}');

  const gen = path.join(root, model.solidityOut);
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(
    path.join(gen, `${model.lib}.sol`),
    `library ${model.lib} { bytes32 internal constant SCHEMA_HASH = ${model.schemaHash}; }`,
  );
  fs.writeFileSync(path.join(gen, `${cap(name)}SpecReplay.sol`), '');
  // `check` also verifies every fixture is replayed by a test, so the stub has
  // to name the fixture path the way the generator would.
  fs.writeFileSync(
    path.join(gen, `${cap(name)}Traces.t.sol`),
    `function test_quint_${name}_000() public { _replay("${model.fixtureOut}/${name}/trace-000.json"); }`,
  );

  return { model, root, dir, specAbs };
}

/**
 * Everything `check` compares in a fixture's `meta`, for a model it considers
 * current. Exported because the drift tests build their trees a different way -
 * a map of files, so each perturbs exactly one - and must still agree with this
 * on what a clean fixture looks like.
 */
export function fixtureMeta(model, root, name = model.name) {
  return {
    spec: model.specPath,
    specHash: hashSpec(root, model.specPath),
    module: model.module ?? '',
    quintVersion: '0.32.0',
    backend: model.run.backend ?? 'rust',
    toolVersion: TOOL_VERSION,
    seed: String(model.run.seed ?? ''),
    traces: model.run.traces,
    maxSteps: model.run.maxSteps,
    maxSamples: model.run.maxSamples,
    invariant: model.run.invariant ?? '',
    traceIndex: 0,
    steps: 3,
    actions: model.actions.map((a) => a.name),
    schemaHash: model.schemaHash,
    testName: `test_quint_${name}_000`,
    exemplar: true,
    itf: `${model.fixtureOut}/${name}/exemplar.itf.json`,
  };
}
