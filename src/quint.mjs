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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

export class QuintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuintError';
  }
}

/** Locate the quint binary: bundled first, then PATH. */
export function resolveQuint(override) {
  if (override) {
    if (!fs.existsSync(override)) throw new QuintError(`quintBin "${override}" does not exist`);
    return override;
  }
  const bundled = path.join(PKG_ROOT, 'node_modules', '.bin', 'quint');
  if (fs.existsSync(bundled)) return bundled;

  const probe = spawnSync('quint', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'quint';

  throw new QuintError(
    'quint not found. It ships as a dependency of this package: run `npm ci` in ' +
      `${PKG_ROOT}, or install @informalsystems/quint and put it on PATH`,
  );
}

export function quintVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) throw new QuintError(`\`${bin} --version\` failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function run(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  if (r.error) throw new QuintError(`failed to run ${bin}: ${r.error.message}`);
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
export function generateTraces(bin, { cwd, specPath, outDir, traces, maxSteps, maxSamples, seed, invariant, mainModule }) {
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
