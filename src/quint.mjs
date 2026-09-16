/**
 * Driving the Quint CLI.
 *
 * Quint is a dependency of this package rather than something the user has to
 * install: `npm ci` here puts it in `node_modules/.bin`, and the lockfile pins
 * the version that produced any committed fixture. `PATH` is a fallback for
 * consumers who would rather manage it themselves.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

export class QuintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuintError';
  }
}

/**
 * The quint CLI to run, as `{ command, prefix }`: `command` is spawned with
 * `prefix` in front of quint's own arguments.
 *
 * The bundled copy is found through node's module resolution rather than at a
 * fixed `node_modules/.bin` path under this package. A consumer's `npm install`
 * hoists quint to *their* top-level `node_modules`, so the fixed path missed it
 * and the lookup fell through to whatever `quint` was on PATH - possibly a
 * different version from the one pinned here, which changes the traces a seed
 * produces.
 *
 * @param {string|null} override `quintBin` from the config
 * @param {() => string|null} [bundled] test seam; returns the bundled CLI script
 */
export function resolveQuint(override, bundled = bundledQuintScript) {
  if (override) {
    if (!fs.existsSync(override)) throw new QuintError(`quintBin "${override}" does not exist`);
    return { command: override, prefix: [] };
  }
  const script = bundled();
  // Run the script with this node, rather than through a `.bin` shim, so it
  // works the same on Windows and needs nothing on PATH.
  if (script) return { command: process.execPath, prefix: [script] };

  const probe = spawnSync('quint', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return { command: 'quint', prefix: [] };

  throw new QuintError(
    'quint not found. It ships as a dependency of this package (@informalsystems/quint): ' +
      'reinstall it, or set `quintBin` in the config',
  );
}

function bundledQuintScript() {
  try {
    const pkgJson = require_.resolve('@informalsystems/quint/package.json');
    const { bin } = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const rel = typeof bin === 'string' ? bin : bin?.quint;
    if (!rel) return null;
    const script = path.resolve(path.dirname(pkgJson), rel);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/** Printable form of a resolved quint, for error messages. */
const shown = (bin) => (bin.prefix.length ? `quint (${bin.prefix[0]})` : bin.command);

export function quintVersion(bin) {
  const r = spawnSync(bin.command, [...bin.prefix, '--version'], { encoding: 'utf8' });
  if (r.error) throw new QuintError(`failed to run ${shown(bin)}: ${r.error.message}`);
  if (r.status !== 0) throw new QuintError(`\`${shown(bin)} --version\` failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function run(bin, args, cwd) {
  const r = spawnSync(bin.command, [...bin.prefix, ...args], { cwd, encoding: 'utf8' });
  if (r.error) throw new QuintError(`failed to run ${shown(bin)}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new QuintError(
      `\`quint ${args.join(' ')}\` exited ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`,
    );
  }
  return r.stdout ?? '';
}

/** `quint typecheck` over one spec. */
export function typecheck(bin, specPath, cwd) {
  return run(bin, ['typecheck', specPath], cwd);
}

/**
 * Generate ITF traces with `--mbt`.
 *
 * `--mbt` is what adds `mbt::actionTaken` and `mbt::nondetPicks` to every
 * state; without it a trace records what the variables became but not which
 * action got them there, which is exactly the part a driver needs.
 *
 * @returns {{ files: string[], stdout: string }} absolute paths, trace order
 */
export function generateTraces(bin, { cwd, specPath, outDir, traces, maxSteps, maxSamples, seed, invariant, mainModule, backend }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    'run',
    specPath,
    '--mbt',
    `--n-traces=${traces}`,
    `--max-steps=${maxSteps}`,
    `--max-samples=${maxSamples}`,
    `--out-itf=${path.join(outDir, 'out.itf.json')}`,
  ];
  if (seed !== null && seed !== undefined) args.push(`--seed=${seed}`);
  if (invariant) args.push(`--invariant=${invariant}`);
  if (mainModule) args.push(`--main=${mainModule}`);
  // Quint's default evaluator is Rust, whose integers are i64. Any spec built
  // on token magnitudes overflows that - `amountOut * price` at 18 decimals is
  // past i64 before it is divided back down - and quint reports it as a runtime
  // error rather than wrapping. The TypeScript backend uses bigints.
  if (backend) args.push(`--backend=${backend}`);

  const stdout = run(bin, args, cwd);

  // Quint names the output `out.itf.json` for a single trace and
  // `out0.itf.json`, `out1.itf.json`, ... for several.
  const entries = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.itf.json'))
    .sort(byTraceIndex);

  if (entries.length === 0) {
    throw new QuintError(
      `quint produced no traces in ${outDir}. Its output was:\n${stdout}\n` +
        'A spec whose `step` is never enabled generates nothing; check the action guards.',
    );
  }
  return { files: entries.map((f) => path.join(outDir, f)), stdout };
}

function byTraceIndex(a, b) {
  const n = (s) => {
    const m = /^out(\d*)\.itf\.json$/.exec(s);
    return m ? (m[1] === '' ? 0 : Number(m[1])) : Number.MAX_SAFE_INTEGER;
  };
  return n(a) - n(b) || a.localeCompare(b);
}
