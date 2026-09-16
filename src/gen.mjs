/**
 * The generate pipeline: quint -> ITF -> lowered blob -> fixtures + Solidity.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keccak256, toHex } from 'viem';

import { decodeTrace } from './itf.mjs';
import { encodeTrace } from './lower.mjs';
import { emitSpecLibrary, emitSpecReplay, emitTraces } from './emit/solidity.mjs';
import { generateTraces, resolveQuint, quintVersion, typecheck } from './quint.mjs';
import { formatSolidity } from './format.mjs';
import { cap, pad3, posix } from './util.mjs';

const require_ = createRequire(import.meta.url);
export const TOOL_VERSION = require_('../package.json').version;

/**
 * Version of the fixture encoding, as opposed to the package.
 *
 * Fixtures used to record the package version and `check` failed on any
 * mismatch, so every patch release forced every consumer to regenerate every
 * fixture even when nothing about the bytes had changed. This moves only when
 * the blob or the `meta` keys `QuintTrace.sol` reads change, and it must be
 * bumped together with `FORMAT_VERSION` there. A change to the emitted Solidity
 * is caught separately, by the content hash each generated file carries.
 */
export const FIXTURE_FORMAT_VERSION = 2;

/** The command a generated file names for regenerating itself. */
export const regenCommand = (model) => `quint-sol-connect gen ${model.name}`;

/**
 * Hash of the spec that produced a fixture.
 *
 * The schema hash covers the *config* - the state shape and the action names -
 * and nothing else. Editing the model itself changes neither, so without this
 * a spec can be rewritten and `check` still reports ok while the committed
 * traces describe the previous version. That is the one drift the whole design
 * exists to catch, and `quint-diff` catching it does not help: it needs quint,
 * which is exactly what `check` does without.
 *
 * Only the named file is hashed. A spec that `import`s another module gets no
 * coverage of the imported file, which is a real limit rather than an oversight
 * - resolving Quint's import graph here would mean parsing it.
 */
export function hashSpec(root, specPath) {
  return keccak256(toHex(fs.readFileSync(path.resolve(root, specPath))));
}

export class GenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GenError';
  }
}

/**
 * Map decoded traces onto the configured action enum.
 *
 * This is where a spec that `--mbt` cannot describe gets rejected. Quint labels
 * the initial state with the name of the top-level transition rather than an
 * action the user wrote, and it does the same for any branch of `step` that is
 * not a bare named action. Seeing that name after step 0 means the spec inlined
 * a guard into `step`, so the trace cannot say what actually happened.
 *
 * @returns {{ indices: number[], counts: Map<string, number> }} one enum index
 *   per step (step 0 is never dispatched and gets 0), and per-action step counts
 */
export function indexActions(model, trace, file) {
  const byName = new Map(model.actions.map((a) => [a.name, a.index]));
  const counts = new Map(model.actions.map((a) => [a.name, 0]));

  const indices = trace.steps.map((step) => {
    if (step.isInitial) return 0; // never dispatched; the replay skips step 0
    const idx = byName.get(step.action);
    if (idx === undefined) {
      throw new GenError(
        `${file}: step ${step.index} reports action "${step.action}", which the config does not ` +
          `declare. Known actions: ${[...byName.keys()].join(', ')}.\n` +
          'If that name is the module\'s top-level transition, `step` has a branch that is not a ' +
          'bare named action. Rewrite it as `any { a, b, c }` over named actions and move each ' +
          'guard inside its action, so --mbt can record which one ran.',
      );
    }
    counts.set(step.action, counts.get(step.action) + 1);
    return idx;
  });
  return { indices, counts };
}

/**
 * Strip the parts of an ITF trace that change on every run.
 *
 * Quint stamps `#meta.description` with a formatted local date and
 * `#meta.timestamp` with epoch millis. Both are noise here: the trace is
 * identified by its seed and its index, which live in the fixture's own meta.
 */
export function stableItf(raw) {
  const meta = { ...(raw['#meta'] ?? {}) };
  delete meta.timestamp;
  meta.description = 'Created by Quint; regenerate with `quint-sol-connect gen`';
  return { ...raw, '#meta': meta };
}

/** The one ITF companion a spec commits. */
export const EXEMPLAR_ITF = 'exemplar.itf.json';
/** Where `gen --itf <n>` puts triage companions. Git-ignored, never committed. */
export const ITF_SCRATCH_DIR = '.itf';

/**
 * The trace whose ITF is worth keeping: the one that exercised every action at
 * least once, and the most of whichever action it exercised least.
 *
 * The sample exists to be read as an example of what the model does, so the
 * example wanted is the one that did the most different things - not trace 0,
 * which is merely the first.
 */
export function pickExemplar(decoded, model) {
  const names = model.actions.map((a) => a.name);
  let best = 0;
  let bestScore = -1;
  for (const { i, counts } of decoded) {
    const score = Math.min(...names.map((n) => counts.get(n) ?? 0));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

const itfWanted = (want, i) => want === 'all' || (want instanceof Set && want.has(i));

/**
 * `--out` and `--sol-out` only make sense together.
 *
 * The per-trace contract embeds fixture paths, so `--out` alone rewrote the
 * committed contract to replay a scratch directory, and `--sol-out` alone
 * wrote scratch fixtures - with `--fresh`, random-seed ones - over the
 * committed set. Either is a corrupted tree, so neither is allowed.
 */
export function assertScratchPair({ outOverride, solOutOverride }) {
  if (Boolean(outOverride) === Boolean(solOutOverride)) return;
  throw new GenError(
    outOverride
      ? '--out without --sol-out would rewrite the committed per-trace contract to replay the ' +
          'scratch fixtures. Pass both for a scratch run.'
      : '--sol-out without --out would write the scratch fixtures over the committed ones. ' +
          'Pass both for a scratch run.',
  );
}

/** The driver the per-trace contract extends. Checked before quint runs. */
function assertDriver(model) {
  if (!model.driver?.path || !model.driver?.contract) {
    throw new GenError(
      `spec "${model.name}" needs \`driver: { path, contract }\` so the generated per-trace ` +
        'tests know which hand-written driver to extend',
    );
  }
}

/**
 * Every generated Solidity file for one model, as `{ file, text }` with `file`
 * relative to `root`. Pure: `gen` writes these, and `check` re-derives them to
 * compare against what is committed, so the two cannot disagree about what the
 * output should be.
 *
 * @param {object} o
 * @param {Array<{testName: string, path: string}>} o.fixtures in trace order
 * @param {string} o.solDir     directory relative to root
 * @param {boolean} [o.scratch] emit only the `<Name>FreshTraces` contract
 */
export function emitSolidity(model, { runtimeImport, fixtures, solDir, scratch = false }) {
  assertDriver(model);
  const cmd = regenCommand(model);
  const out = [];
  if (!scratch) {
    out.push({ file: path.join(solDir, `${model.lib}.sol`), text: emitSpecLibrary(model, cmd) });
    out.push({
      file: path.join(solDir, `${cap(model.name)}SpecReplay.sol`),
      text: emitSpecReplay(model, cmd, { runtimeImport }),
    });
  }
  const driverImport = posix(path.relative(solDir, model.driver.path));
  const contractName = `${cap(model.name)}${scratch ? 'Fresh' : ''}Traces`;
  out.push({
    file: path.join(solDir, `${contractName}.t.sol`),
    text: emitTraces(model, cmd, {
      fixtures,
      driverImport: driverImport.startsWith('.') ? driverImport : `./${driverImport}`,
      driverContract: model.driver.contract,
      contractName,
    }),
  });
  return out;
}

/**
 * Generate everything for one model. Returns a summary for reporting.
 *
 * Nothing is written until every trace has decoded, indexed and lowered. The
 * fixture directory is replaced wholesale, and replacing it first meant a
 * lowering error part-way through - a value that does not fit its declared
 * width, say - left the committed fixtures deleted and half rewritten, with the
 * Solidity still describing the old set.
 */
export function generateSpec(
  model,
  { root, quintBin, quintVer, fresh, outOverride, solOutOverride, runOverride, runtimeImport, format, itfIndices = null },
) {
  assertScratchPair({ outOverride, solOutOverride });
  assertDriver(model);

  const run = { ...model.run, ...(runOverride ?? {}) };
  if (fresh) run.seed = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`;

  typecheck(quintBin, model.specPath, root);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `qcs-${model.name}-`));
  try {
    const { files } = generateTraces(quintBin, {
      cwd: root,
      specPath: model.specPath,
      outDir: tmp,
      traces: run.traces,
      maxSteps: run.maxSteps,
      maxSamples: run.maxSamples,
      seed: run.seed,
      invariant: run.invariant,
      mainModule: model.module,
      backend: run.backend,
    });

    const fixtureDir = posix(path.join(outOverride ?? model.fixtureOut, model.name));
    const specHash = hashSpec(root, model.specPath);
    const totals = new Map(model.actions.map((a) => [a.name, 0]));

    // Decode every trace first: the exemplar can only be chosen once all of
    // them are known.
    const decoded = files.map((file, i) => {
      const rawTrace = JSON.parse(fs.readFileSync(file, 'utf8'));
      const trace = decodeTrace(rawTrace, { file: path.basename(file) });
      const { indices, counts } = indexActions(model, trace, path.basename(file));
      for (const [name, n] of counts) totals.set(name, totals.get(name) + n);
      return { i, rawTrace, trace, indices, counts };
    });

    const exemplar = pickExemplar(decoded, model);

    /** Paths relative to the fixture directory -> contents. */
    const fixtureWrites = new Map();
    const fixtures = [];

    for (const { i, rawTrace, trace, indices, counts } of decoded) {
      const jsonName = `trace-${pad3(i)}.json`;
      const testName = `test_quint_${model.name}_${pad3(i)}`;
      const isExemplar = i === exemplar;

      // Only the exemplar's ITF is written, and always under a fixed name.
      //
      // The ITF's jobs - triage, the Trace Viewer, reading a spec change in a
      // pull request - are per-incident rather than per-run, and it is fully
      // derivable from committed inputs: the seed and the run parameters are
      // pinned, and `quint-diff` proves regeneration is byte-identical. A file
      // derivable from committed inputs does not belong in git, and at roughly
      // the size of the blob it doubled the cost of every spec.
      //
      // A fixed filename rather than `trace-007.itf.json` so `.gitignore` needs
      // two static lines, and so a spec change shows as a content diff on one
      // file instead of a rename plus a delete. `gen --itf <n>` writes any
      // other trace's ITF on demand.
      const itfName = isExemplar ? EXEMPLAR_ITF : `trace-${pad3(i)}.itf.json`;
      if (isExemplar) {
        const stable = stableItf(rawTrace);
        stable['#meta'].exemplarOf = jsonName;
        fixtureWrites.set(itfName, `${JSON.stringify(stable, null, 2)}\n`);
      }
      // Triage companions go to a scratch subdirectory, not beside the
      // fixtures: they are for reading now, not for committing, and `check`
      // treats any non-exemplar ITF in the fixture directory as stale.
      if (!isExemplar && itfWanted(itfIndices, i)) {
        fixtureWrites.set(
          path.join(ITF_SCRATCH_DIR, itfName),
          `${JSON.stringify(stableItf(rawTrace), null, 2)}\n`,
        );
      }

      const blob = encodeTrace(model, trace, { file: jsonName, actionIndices: indices });
      const meta = {
        spec: model.specPath,
        // Hash of the spec text. `check` re-reads the file and compares, which
        // is what makes an edited model without a regeneration a failure.
        specHash,
        module: model.module ?? '',
        quintVersion: quintVer,
        // The evaluator matters for reproducibility: the two backends do not
        // draw the same traces from the same seed.
        backend: run.backend ?? 'rust',
        formatVersion: FIXTURE_FORMAT_VERSION,
        seed: String(run.seed ?? ''),
        // The rest of the run parameters, for the same reason as `specHash`:
        // each one changes which traces come out, none of them touches the
        // schema hash, and `check` compares them all. Flat rather than nested
        // because solidity/QuintTrace.sol parses this object by key path.
        traces: run.traces,
        maxSteps: run.maxSteps,
        maxSamples: run.maxSamples,
        invariant: run.invariant ?? '',
        traceIndex: i,
        // The trace's actual length, as opposed to `maxSteps` above.
        steps: trace.steps.length,
        actions: model.actions.map((a) => a.name),
        // Per-action step counts, so `check` can enforce coverage floors
        // without re-running quint. A trace set that quietly stops exercising
        // an action still replays green - it just stops testing that action.
        actionCounts: Object.fromEntries(counts),
        schemaHash: model.schemaHash,
        testName,
        ...(isExemplar ? { exemplar: true, itf: `${fixtureDir}/${itfName}` } : {}),
      };
      fixtureWrites.set(jsonName, `${JSON.stringify({ meta, steps: blob }, null, 2)}\n`);
      fixtures.push({ testName, path: `${fixtureDir}/${jsonName}`, steps: trace.steps.length });
    }

    // A scratch run (`--fresh --out ... --sol-out ...`) must not touch the
    // committed Solidity: the per-trace tests embed fixture paths, so rewriting
    // them in place would leave the committed suite pointing at a temporary
    // directory. A scratch run therefore emits *only* its own per-trace
    // contract, under a distinct name, and imports the committed types.
    const scratch = Boolean(solOutOverride);
    const solDir = solOutOverride ?? model.solidityOut;
    const solidity = emitSolidity(model, { runtimeImport, fixtures, solDir, scratch });

    // Everything is known to be writable content; only now touch the tree.
    const absFixtureDir = path.resolve(root, fixtureDir);
    fs.rmSync(absFixtureDir, { recursive: true, force: true });
    for (const [rel, text] of fixtureWrites) {
      const abs = path.join(absFixtureDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    const written = solidity.map(({ file, text }) => {
      const abs = path.resolve(root, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      return abs;
    });

    const fmt = format === false ? { formatted: false, reason: 'disabled in config' } : formatSolidity(root, written);

    return {
      model,
      fixtures,
      totals,
      seed: run.seed,
      fixtureDir,
      solDir: path.resolve(root, solDir),
      fmt,
      scratch,
      exemplar,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A configured action that no trace ever took is the generalised form of a
 * handler that silently reverts on every call: the suite looks like it covers
 * the action, and nothing ever runs it. Reported loudly for that reason.
 */
export function coverageReport(summary) {
  const lines = [];
  const width = Math.max(...[...summary.totals.keys()].map((k) => k.length), 6);
  lines.push(`  ${'action'.padEnd(width)}  steps`);
  const dead = [];
  for (const [name, n] of summary.totals) {
    lines.push(`  ${name.padEnd(width)}  ${String(n).padStart(5)}${n === 0 ? '   <-- never taken' : ''}`);
    if (n === 0) dead.push(name);
  }
  return { lines, dead };
}

export { resolveQuint, quintVersion };
