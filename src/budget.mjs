/**
 * Fixture byte budgeting.
 *
 * Bytes are the binding constraint on how many specs a repository can carry:
 * a trace set costs `traces x steps x state`, and the state is compared in full
 * on every step. Runtime is not the constraint - the three Lelantos specs replay
 * in ~65 ms - so a cap on bytes is the only cap that does anything.
 *
 * The cap alone would be obstructive. What makes it actionable is knowing which
 * variable is spending the budget, which is why `attribute` exists: a spec that
 * is 80% one 64-slot array should say so, rather than leaving the reader to
 * guess between "fewer traces" and "fewer steps".
 */

import { decodeAbiParameters } from 'viem';

import { stepArrayAbi } from './lower.mjs';

/** ABI head+tail size, in bytes, of one already-decoded value. */
function sizeOf(node, value) {
  switch (node.kind) {
    case 'uint':
    case 'int':
    case 'bool':
    case 'address':
    case 'bytes32':
    case 'enum':
      return 32;
    case 'string': {
      const len = Buffer.byteLength(String(value ?? ''), 'utf8');
      return 64 + 32 * Math.ceil(len / 32); // offset + length + padded body
    }
    case 'struct':
      return node.fields.reduce((n, f) => n + sizeOf(f.node, value?.[f.name]), 0);
    case 'array': {
      const items = Array.isArray(value) ? value : [];
      const body = items.reduce((n, v) => n + sizeOf(node.inner, v), 0);
      return 64 + body; // offset + length + elements
    }
    default:
      return 32;
  }
}

/**
 * Per-state-variable byte attribution, averaged over the steps of one trace.
 *
 * @returns {{ rows: Array<{name:string,bytesPerStep:number,pct:number}>,
 *             perStep:number, fixedOverhead:number, picksOverhead:number }}
 */
export function attribute(model, blobHex) {
  const { abi } = stepArrayAbi(model);
  const [steps] = decodeAbiParameters([abi], blobHex);
  if (steps.length === 0) return { rows: [], perStep: 0, fixedOverhead: 0, picksOverhead: 0 };

  const totals = new Map(model.state.map((s) => [s.name, 0]));
  for (const step of steps) {
    for (const s of model.state) totals.set(s.name, totals.get(s.name) + sizeOf(s.node, step.post[s.name]));
  }

  // A pick's slot is present on every step whatever action ran: one `bool` plus
  // the value. That makes the *number of pick names* a budget line item, which
  // is not obvious and is usually the cheapest thing to cut.
  const picksOverhead = model.picks.reduce((n, p) => n + 32 + sizeOf(p.node, undefined), 0);
  const fixedOverhead = 32 + 32 + 32; // element offset, action tag, post-state offset

  const rows = [...totals]
    .map(([name, total]) => ({ name, bytesPerStep: total / steps.length }))
    .sort((a, b) => b.bytesPerStep - a.bytesPerStep);

  const perStep =
    fixedOverhead + picksOverhead + rows.reduce((n, r) => n + r.bytesPerStep, 0);
  for (const r of rows) r.pct = perStep === 0 ? 0 : (100 * r.bytesPerStep) / perStep;

  return { rows, perStep, fixedOverhead, picksOverhead };
}

export const humanBytes = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/**
 * The lines `check` prints when a spec is near or over its allocation. Kept here
 * rather than in `check.mjs` so the wording lives next to the arithmetic it
 * describes.
 */
export function explain(model, bytes, cap, attribution) {
  const lines = [
    `${humanBytes(bytes)} of ${humanBytes(cap)}` +
      `${model.budget?.maxBytes ? ' (named allocation)' : ' (default)'}`,
  ];
  if (attribution && attribution.rows.length) {
    const { rows, perStep, picksOverhead } = attribution;
    lines.push(`  ~${Math.round(perStep)} B/step encoded, largest contributors:`);
    for (const r of rows.slice(0, 3)) {
      lines.push(`    ${r.name}: ${Math.round(r.bytesPerStep)} B (${r.pct.toFixed(0)}%)`);
    }
    if (picksOverhead) {
      lines.push(
        `    ${model.picks.length} nondet pick name(s): ${picksOverhead} B ` +
          `(${((100 * picksOverhead) / perStep).toFixed(0)}%) - paid on every step ` +
          'whichever action ran',
      );
    }
  }
  return lines;
}
