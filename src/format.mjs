/**
 * Formatting generated Solidity with the consumer's own `forge fmt`.
 *
 * Emitting text that a project's format check then rejects makes every consumer
 * choose between a failing CI job and an exclusion rule. Matching `forge fmt`'s
 * line-breaking by hand is not the fix: the rules depend on the project's
 * `line_length` and on the forge version, so the guess would be wrong somewhere.
 *
 * Running the formatter instead means the output matches whatever `[fmt]` config
 * the consumer actually has. A forge upgrade that reformats is then visible as a
 * diff in the regeneration gate, the same way `.gas-snapshot` moves.
 */

import { spawnSync } from 'node:child_process';

/**
 * @returns {{ formatted: boolean, reason?: string }}
 */
export function formatSolidity(root, files) {
  if (files.length === 0) return { formatted: false, reason: 'nothing to format' };

  const probe = spawnSync('forge', ['--version'], { cwd: root, encoding: 'utf8' });
  if (probe.status !== 0) {
    return { formatted: false, reason: 'forge not on PATH; generated Solidity is left unformatted' };
  }

  const r = spawnSync('forge', ['fmt', ...files], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    return {
      formatted: false,
      reason: `\`forge fmt\` exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  return { formatted: true };
}
