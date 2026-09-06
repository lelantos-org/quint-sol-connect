/**
 * The drift gate.
 *
 * Committed fixtures are only trustworthy while they still describe the config
 * and the Solidity they were generated for. `check` re-derives the schema hash
 * from the config and compares it against every fixture and against the
 * generated library, without running quint at all, so it is cheap enough to sit
 * in the same CI job as everything else.
 */

import fs from 'node:fs';
import path from 'node:path';

import { TOOL_VERSION, EXEMPLAR_ITF, ITF_SCRATCH_DIR, hashSpec } from './gen.mjs';
import { attribute, explain, humanBytes } from './budget.mjs';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const posix = (p) => p.split(path.sep).join('/');

/** Older fixtures carry no `actionCounts`; a floor cannot be checked against them. */
function hasActionCounts(fixtures, fixtureDir) {
  const first = JSON.parse(fs.readFileSync(path.join(fixtureDir, fixtures[0]), 'utf8'));
  return Boolean(first.meta?.actionCounts);
}

export function checkModel(model, root) {
  const problems = [];
  const fixtureDir = path.resolve(root, model.fixtureOut, model.name);

  if (!fs.existsSync(fixtureDir)) {
    problems.push(`no fixtures at ${path.relative(root, fixtureDir)} - run \`quint-sol-connect gen ${model.name}\``);
    // Zeros, not absent fields. The caller sums `bytes` and `cap` across specs
    // to police the global total, and one `undefined` makes that sum NaN - at
    // which point `allocated > total` is false and the ceiling silently stops
    // applying to every *other* spec. A spec that has never been generated is
    // the likeliest way to reach this, so it has to be the safe direction.
    return { problems, warnings: [], fixtures: 0, bytes: 0, cap: model.maxBytes };
  }

  const fixtures = fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.itf.json'))
    .sort();

  if (fixtures.length === 0) {
    problems.push(`${path.relative(root, fixtureDir)} holds no trace fixtures`);
  }

  // Every fixture in a directory was generated together, so a shape or version
  // change hits all of them at once. Reported once with a count, rather than
  // once per file, so the actual problem is not buried in its own repetition.
  const schemaDrift = [];
  const specDrift = [];
  const runDrift = new Map();
  const runMissing = new Set();
  const versionDrift = new Map();

  // The schema hash covers the config's state shape and action names. It does
  // not cover the model itself, nor the parameters of the run that sampled it -
  // and every one of those changes which traces the committed blobs hold. Left
  // uncompared, a spec could be rewritten, or the seed changed, and `check`
  // would still report ok against traces describing the previous version.
  let specHash = null;
  try {
    specHash = hashSpec(root, model.specPath);
  } catch (e) {
    problems.push(`cannot read ${model.specPath} to hash it: ${e.message}`);
  }
  const expectedRun = {
    seed: String(model.run.seed ?? ''),
    traces: model.run.traces,
    maxSteps: model.run.maxSteps,
    maxSamples: model.run.maxSamples,
    invariant: model.run.invariant ?? '',
    backend: model.run.backend ?? 'rust',
  };
  const observed = new Map();
  const exemplars = [];

  for (const f of fixtures) {
    const abs = path.join(fixtureDir, f);
    let fixture;
    try {
      fixture = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      problems.push(`${f}: not valid JSON (${e.message})`);
      continue;
    }
    const meta = fixture.meta ?? {};

    for (const [action, n] of Object.entries(meta.actionCounts ?? {})) {
      observed.set(action, (observed.get(action) ?? 0) + n);
    }

    if (meta.schemaHash !== model.schemaHash) schemaDrift.push(f);
    if (meta.toolVersion !== TOOL_VERSION) {
      versionDrift.set(meta.toolVersion, (versionDrift.get(meta.toolVersion) ?? 0) + 1);
    }
    if (meta.spec !== model.specPath) {
      problems.push(`${f}: generated from ${meta.spec}, config now says ${model.specPath}`);
    }
    // Every fixture in a directory is generated from one spec by one run, so
    // these hold for all of them at once. Collected and reported once, the way
    // the schema and version drift above are.
    if (meta.specHash !== specHash) specDrift.push(meta.specHash ?? null);
    for (const [key, want] of Object.entries(expectedRun)) {
      // A key the fixture does not carry at all predates this check; that is
      // one fact about the fixture, not one per parameter, so it is collected
      // separately rather than reported six times as `undefined`.
      if (!(key in meta)) runMissing.add(key);
      else if (meta[key] !== want) runDrift.set(key, { was: meta[key], now: want });
    }
    if (typeof fixture.steps !== 'string' || !fixture.steps.startsWith('0x')) {
      problems.push(`${f}: "steps" is not a hex blob`);
    }
    if (meta.exemplar) {
      exemplars.push(f);
      const itf = path.resolve(root, meta.itf ?? '');
      if (!meta.itf || !fs.existsSync(itf)) {
        problems.push(`${f}: it is the exemplar but its ITF (${meta.itf}) is missing`);
      }
    }
  }

  // Exactly one ITF companion per spec, under a fixed name.
  if (fixtures.length && exemplars.length !== 1) {
    problems.push(
      exemplars.length === 0
        ? `no fixture is marked \`exemplar\` - regenerate so one ITF companion is kept`
        : `${exemplars.length} fixtures are marked \`exemplar\` (${exemplars.join(', ')}); expected 1`,
    );
  }

  // The inverse check. Without it an ITF written before the exemplar rule
  // lingers forever and quietly spends the byte budget.
  const strayItf = fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.itf.json') && f !== EXEMPLAR_ITF);
  // `<fixtures>/.itf/` is the scratch area `gen --itf` writes to; it is
  // git-ignored and deliberately not counted as stale.
  if (strayItf.length) {
    problems.push(
      `stale ITF companion(s): ${strayItf.join(', ')}. Only ${EXEMPLAR_ITF} is kept now; ` +
        'delete these (`gen --itf <n>` rewrites one on demand for triage)',
    );
  }

  if (schemaDrift.length) {
    problems.push(
      `${schemaDrift.length} of ${fixtures.length} fixtures carry schema hash ` +
        `${JSON.parse(fs.readFileSync(path.join(fixtureDir, schemaDrift[0]), 'utf8')).meta.schemaHash}, ` +
        `but the config now yields ${model.schemaHash}. The state or action shape changed.`,
    );
  }
  if (specDrift.length) {
    // A fixture generated before spec hashing existed carries no hash at all,
    // which is a different statement from "the spec changed": nothing is known
    // either way. Saying the spec changed would be a guess presented as a fact.
    problems.push(
      specDrift[0] === null
        ? `${specDrift.length} fixture(s) carry no spec hash - they predate it, so whether ` +
          `${model.specPath} still describes them is unknown. Regenerate.`
        : `${model.specPath} has changed since these ${specDrift.length} fixture(s) were ` +
          `generated (they record ${String(specDrift[0]).slice(0, 10)}, the file on disk now ` +
          `hashes to ${String(specHash).slice(0, 10)}). The committed traces describe the ` +
          'previous model.',
    );
  }
  if (runMissing.size) {
    problems.push(
      `the fixtures record no ${[...runMissing].map((k) => `run.${k}`).join(', ')} - they predate ` +
        'the check that compares run parameters against the config. Regenerate.',
    );
  }
  for (const [key, { was, now }] of runDrift) {
    problems.push(
      `run.${key} is ${JSON.stringify(now)} in the config but the fixtures were generated with ` +
        `${JSON.stringify(was)}. Every run parameter changes which traces come out, and none of ` +
        'them changes the schema hash.',
    );
  }
  for (const [version, n] of versionDrift) {
    problems.push(
      `${n} fixture(s) were generated by quint-sol-connect ${version}, this is ${TOOL_VERSION}. ` +
        'The tool was bumped without regenerating.',
    );
  }

  // Coverage floors. An action can go from 40 steps to 1 without any test
  // failing - the traces still replay, they just stop exercising it. Declaring
  // a floor turns that silent decay into a failure, which is the same class of
  // problem as a handler that reverts on every call.
  const floors = model.coverage?.minSteps ?? {};
  if (Object.keys(floors).length) {
    const known = new Set(model.actions.map((a) => a.name));
    for (const action of Object.keys(floors)) {
      if (!known.has(action)) {
        problems.push(`coverage.minSteps names "${action}", which is not one of this spec's actions`);
      }
    }

    // `actionCounts` is optional metadata. Without it the floors cannot be
    // evaluated at all - and reporting every action as "ran 0 times" would say
    // something false, when the truth is that nothing was measured.
    if (fixtures.length && !hasActionCounts(fixtures, fixtureDir)) {
      problems.push(
        'coverage floors are declared but the fixtures carry no per-action counts - regenerate',
      );
    } else {
      for (const [action, min] of Object.entries(floors)) {
        if (!known.has(action)) continue;
        const got = observed.get(action) ?? 0;
        if (got < min) {
          problems.push(
            `coverage: \`${action}\` ran ${got} time(s) across the committed traces, floor is ${min}. ` +
              "Raise traces/maxSteps, widen the action's guard, or lower the floor deliberately.",
          );
        }
      }
    }
  }

  // The generated library carries the same hash; if it does not, the Solidity
  // in the tree was generated from a different config than the fixtures were.
  const libFile = path.resolve(root, model.solidityOut, `${model.lib}.sol`);
  if (!fs.existsSync(libFile)) {
    problems.push(`${path.relative(root, libFile)} is missing - run \`quint-sol-connect gen ${model.name}\``);
  } else {
    const src = fs.readFileSync(libFile, 'utf8');
    const m = /SCHEMA_HASH\s*=\s*(0x[0-9a-fA-F]{64});/.exec(src);
    if (!m) problems.push(`${path.relative(root, libFile)}: no SCHEMA_HASH found`);
    else if (m[1].toLowerCase() !== model.schemaHash.toLowerCase()) {
      problems.push(
        `${path.relative(root, libFile)}: SCHEMA_HASH ${m[1]} but the config yields ${model.schemaHash}`,
      );
    }
  }

  const replayFile = path.resolve(root, model.solidityOut, `${cap(model.name)}SpecReplay.sol`);
  if (!fs.existsSync(replayFile)) problems.push(`${path.relative(root, replayFile)} is missing`);

  // The generated tests name their fixtures as literal paths, and `vm.readFile`
  // is the first thing a replay does. A fixture that was deleted or renamed by
  // hand therefore fails inside `forge test`, one test at a time, with a file
  // error rather than a drift error. Cheaper to say it here.
  const tracesFile = path.resolve(root, model.solidityOut, `${cap(model.name)}Traces.t.sol`);
  if (!fs.existsSync(tracesFile)) {
    problems.push(`${path.relative(root, tracesFile)} is missing`);
  } else {
    const src = fs.readFileSync(tracesFile, 'utf8');
    const replayed = [...src.matchAll(/_replay\("([^"]+)"\)/g)].map((m) => m[1]);
    const relDir = posix(path.relative(root, fixtureDir));
    const expected = fixtures.map((f) => `${relDir}/${f}`);

    const missing = replayed.filter((p) => !fs.existsSync(path.resolve(root, p)));
    if (missing.length) {
      problems.push(
        `${path.relative(root, tracesFile)} replays ${missing.length} fixture(s) that do not ` +
          `exist: ${missing.join(', ')}`,
      );
    }
    const orphaned = expected.filter((p) => !replayed.includes(p));
    if (orphaned.length) {
      problems.push(
        `${orphaned.length} fixture(s) have no test in ${path.relative(root, tracesFile)}: ` +
          `${orphaned.join(', ')}`,
      );
    }
  }

  // Byte budget. Enforced here rather than in `gen` for the same reason the
  // coverage floors are: `gen` guards one run, `check` guards the committed
  // artifact, and `check` runs in CI without node's quint dependency.
  const bytes = fixtures.reduce(
    (n, f) => n + fs.statSync(path.join(fixtureDir, f)).size,
    0,
  ) + strayBytes(fixtureDir);
  const capBytes = model.maxBytes;
  const warnings = [];

  if (bytes > capBytes || bytes > capBytes * 0.8) {
    let attribution = null;
    try {
      const first = JSON.parse(fs.readFileSync(path.join(fixtureDir, fixtures[0]), 'utf8'));
      attribution = attribute(model, first.steps);
    } catch {
      // Attribution is a diagnostic, never a reason to fail the check.
    }
    const lines = explain(model, bytes, capBytes, attribution);
    if (bytes > capBytes) problems.push(`over the byte budget: ${lines.join('\n  ')}`);
    // Warn well before the wall, so the commit that legitimately adds an action
    // is not the one that first meets the gate.
    else warnings.push(`approaching the byte budget: ${lines.join('\n  ')}`);
  }

  return { problems, warnings, fixtures: fixtures.length, bytes, cap: capBytes };
}

/** ITF companions count against the budget too - they are committed bytes. */
function strayBytes(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.itf.json'))
    .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
}
