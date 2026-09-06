/**
 * The generate pipeline: quint -> ITF -> lowered blob -> fixtures + Solidity.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { decodeTrace } from './itf.mjs';
import { encodeTrace } from './lower.mjs';
import { emitSpecLibrary, emitSpecReplay, emitTraces } from './emit/solidity.mjs';
import { generateTraces, resolveQuint, quintVersion, typecheck } from './quint.mjs';
import { formatSolidity } from './format.mjs';

const require_ = createRequire(import.meta.url);
export const TOOL_VERSION = require_('../package.json').version;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pad3 = (n) => String(n).padStart(3, '0');

// Fixture paths are written into a Solidity string literal and into `meta.itf`,
// both of which are read back by `vm.readFile`. `path.join` uses the host
// separator, so on Windows those become backslashes - which Solidity reads as
// escapes. Every path that leaves this process for a generated file is posix.
const posix = (p) => p.split(path.sep).join('/');

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
 */
export function indexActions(model, trace, file) {
  const byName = new Map(model.actions.map((a) => [a.name, a.index]));
  const counts = new Map(model.actions.map((a) => [a.name, 0]));

  for (const step of trace.steps) {
    if (step.isInitial) {
      step.actionIndex = 0; // never dispatched; the replay skips step 0
      continue;
    }
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
    step.actionIndex = idx;
    counts.set(step.action, counts.get(step.action) + 1);
  }
  return counts;
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

/** Generate everything for one model. Returns a summary for reporting. */
export function generateSpec(model, { root, quintBin, quintVer, fresh, outOverride, solOutOverride, runOverride, runtimeImport, cmd, format, itfIndices = null }) {
  const run = { ...model.run, ...(runOverride ?? {}) };
  if (fresh) run.seed = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`;

  typecheck(quintBin, model.specPath, root);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `qcs-${model.name}-`));
  let files;
  try {
    ({ files } = generateTraces(quintBin, {
      cwd: root,
      specPath: model.specPath,
      outDir: tmp,
      traces: run.traces,
      maxSteps: run.maxSteps,
      maxSamples: run.maxSamples,
      seed: run.seed,
      invariant: run.invariant,
      mainModule: model.module,
    }));

    const fixtureDir = posix(
      outOverride ? path.join(outOverride, model.name) : path.join(model.fixtureOut, model.name),
    );
    const absFixtureDir = path.resolve(root, fixtureDir);
    fs.rmSync(absFixtureDir, { recursive: true, force: true });
    fs.mkdirSync(absFixtureDir, { recursive: true });

    const totals = new Map(model.actions.map((a) => [a.name, 0]));
    const fixtures = [];

    // Decode every trace first: the exemplar can only be chosen once all of
    // them are known.
    const decoded = files.map((file, i) => {
      const rawTrace = JSON.parse(fs.readFileSync(file, 'utf8'));
      const trace = decodeTrace(rawTrace, { file: path.basename(file) });
      const counts = indexActions(model, trace, path.basename(file));
      for (const [name, n] of counts) totals.set(name, totals.get(name) + n);
      return { i, rawTrace, trace, counts };
    });

    const exemplar = pickExemplar(decoded, model);

    decoded.forEach(({ i, rawTrace, trace, counts }) => {
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
        fs.writeFileSync(path.join(absFixtureDir, itfName), `${JSON.stringify(stable, null, 2)}\n`);
      }
      // Triage companions go to a scratch subdirectory, not beside the
      // fixtures: they are for reading now, not for committing, and `check`
      // treats any non-exemplar ITF in the fixture directory as stale.
      if (!isExemplar && itfWanted(itfIndices, i)) {
        const scratch = path.join(absFixtureDir, ITF_SCRATCH_DIR);
        fs.mkdirSync(scratch, { recursive: true });
        fs.writeFileSync(
          path.join(scratch, itfName),
          `${JSON.stringify(stableItf(rawTrace), null, 2)}\n`,
        );
      }

      const blob = encodeTrace(model, trace, { file: jsonName });
      const meta = {
        spec: model.specPath,
        module: model.module ?? '',
        quintVersion: quintVer,
        toolVersion: TOOL_VERSION,
        seed: String(run.seed ?? ''),
        traceIndex: i,
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
      fs.writeFileSync(
        path.join(absFixtureDir, jsonName),
        `${JSON.stringify({ meta, steps: blob }, null, 2)}\n`,
      );

      fixtures.push({ testName, path: `${fixtureDir}/${jsonName}`, steps: trace.steps.length });
    });

    // A scratch run (`--fresh --out ... --sol-out ...`) must not touch the
    // committed Solidity: the per-trace tests embed fixture paths, so rewriting
    // them in place would leave the committed suite pointing at a temporary
    // directory. A scratch run therefore emits *only* its own per-trace
    // contract, under a distinct name, and imports the committed types.
    const scratch = Boolean(solOutOverride);
    const solDir = path.resolve(root, solOutOverride ?? model.solidityOut);
    fs.mkdirSync(solDir, { recursive: true });
    const written = [];

    if (!scratch) {
      const libFile = path.join(solDir, `${model.lib}.sol`);
      fs.writeFileSync(libFile, emitSpecLibrary(model, cmd));
      written.push(libFile);

      const replayFile = path.join(solDir, `${cap(model.name)}SpecReplay.sol`);
      fs.writeFileSync(replayFile, emitSpecReplay(model, cmd, { runtimeImport }));
      written.push(replayFile);
    }

    if (!model.driver?.path || !model.driver?.contract) {
      throw new GenError(
        `spec "${model.name}" needs \`driver: { path, contract }\` so the generated per-trace ` +
          'tests know which hand-written driver to extend',
      );
    }
    const driverImport = posix(path.relative(solDir, path.resolve(root, model.driver.path)));
    const contractName = `${cap(model.name)}${scratch ? 'Fresh' : ''}Traces`;
    const tracesFile = path.join(solDir, `${contractName}.t.sol`);
    fs.writeFileSync(
      tracesFile,
      emitTraces(model, cmd, {
        fixtures,
        driverImport: driverImport.startsWith('.') ? driverImport : `./${driverImport}`,
        driverContract: model.driver.contract,
        contractName,
      }),
    );
    written.push(tracesFile);

    const fmt = format === false ? { formatted: false, reason: 'disabled in config' } : formatSolidity(root, written);

    return { model, fixtures, totals, seed: run.seed, fixtureDir, solDir, fmt, scratch, exemplar };
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
