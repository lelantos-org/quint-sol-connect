/**
 * Lowering: decoded ITF values plus resolved types produce ABI-encodable data.
 *
 * Two things happen here that deliberately do not happen in Solidity:
 *
 *  - Range checking. A Quint `int` is unbounded; a `uint64` is not. A value
 *    that does not fit is a modelling error, and it is far cheaper to say so
 *    by name here than to watch it wrap on-chain.
 *  - Canonical ordering. Quint sets and maps are unordered, Solidity arrays
 *    are not. Sorting here means the model and the implementation are compared
 *    in one fixed order, which is the difference between a real divergence and
 *    a phantom one.
 */

import { encodeAbiParameters } from 'viem';
import { isUnit } from './itf.mjs';

export class LowerError extends Error {
  constructor(message, path) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'LowerError';
    this.path = path;
  }
}

const bad = (msg, path) => {
  throw new LowerError(msg, path);
};

const hex = (v, bytes) => `0x${v.toString(16).padStart(bytes * 2, '0')}`;

/** Lower one decoded ITF value against a resolved type node. */
export function lowerValue(node, v, path) {
  switch (node.kind) {
    case 'uint': {
      const n = asBigInt(v, path);
      if (n < 0n) bad(`${n} is negative but the declared type is ${node.solType}`, path);
      if (n >= 1n << BigInt(node.bits)) bad(`${n} does not fit in ${node.solType}`, path);
      return n;
    }
    case 'int': {
      const n = asBigInt(v, path);
      const lim = 1n << BigInt(node.bits - 1);
      if (n < -lim || n >= lim) bad(`${n} does not fit in ${node.solType}`, path);
      return n;
    }
    case 'bool':
      if (typeof v !== 'boolean') bad(`expected a boolean, got ${describe(v)}`, path);
      return v;
    case 'string':
      if (typeof v !== 'string') bad(`expected a string, got ${describe(v)}`, path);
      return v;
    case 'bytes32':
      return asFixedHex(v, 32, path);
    case 'address':
      return asFixedHex(v, 20, path);
    case 'enum': {
      if (!v || v.__t !== 'variant') bad(`expected a variant, got ${describe(v)}`, path);
      if (!isUnit(v.value)) {
        bad(
          `variant "${v.tag}" carries a payload; v1 lowers payload-free sums to enums only`,
          path,
        );
      }
      const i = node.variants.indexOf(v.tag);
      if (i < 0) bad(`variant "${v.tag}" is not one of [${node.variants.join(', ')}]`, path);
      return i;
    }
    case 'struct': {
      const byName = structFields(node, v, path);
      const out = {};
      for (const f of node.fields) out[f.name] = lowerValue(f.node, byName(f.name), `${path}.${f.name}`);
      return out;
    }
    case 'array':
      return lowerArray(node, v, path);
    default:
      return bad(`no lowering for type kind "${node.kind}"`, path);
  }
}

function lowerArray(node, v, path) {
  if (node.origin === 'list') {
    if (!v || v.__t !== 'list') bad(`expected a list, got ${describe(v)}`, path);
    return v.items.map((x, i) => lowerValue(node.inner, x, `${path}[${i}]`));
  }

  if (node.origin === 'set') {
    if (!v || v.__t !== 'set') bad(`expected a set, got ${describe(v)}`, path);
    const lowered = v.items.map((x, i) => lowerValue(node.inner, x, `${path}{${i}}`));
    return sortCanonically(lowered, node.inner, path);
  }

  // map: flatten each entry into the generated entry struct, then order by key
  if (!v || v.__t !== 'map') bad(`expected a map, got ${describe(v)}`, path);
  const rows = v.entries.map(([k, val], i) => {
    const at = `${path}[${i}]`;
    const key = lowerValue(node.keyNode, k, `${at}.key`);
    if (node.valueNode.kind === 'struct') {
      const byName = structFields(node.valueNode, val, `${at}.value`);
      const row = { key };
      for (const f of node.valueNode.fields) {
        row[f.name] = lowerValue(f.node, byName(f.name), `${at}.value.${f.name}`);
      }
      return row;
    }
    return { key, value: lowerValue(node.valueNode, val, `${at}.value`) };
  });

  const keys = rows.map((r) => r.key);
  const order = sortIndices(keys, node.keyNode, path);
  for (let i = 1; i < order.length; i++) {
    if (compare(keys[order[i - 1]], keys[order[i]], node.keyNode) === 0) {
      bad(`duplicate map key ${keys[order[i]]}`, path);
    }
  }
  return order.map((i) => rows[i]);
}

/**
 * Records address fields by name; tuples address them by declaration order.
 * Returns an accessor so the caller iterates the *declared* fields, which is
 * what makes a missing field an error instead of a silently absent one.
 */
function structFields(node, v, path) {
  if (v && v.__t === 'rec') {
    const known = new Set(node.fields.map((f) => f.name));
    for (const k of Object.keys(v.fields)) {
      if (!known.has(k)) {
        bad(
          `record has field "${k}" which the config does not declare; ` +
            `declared fields are [${[...known].join(', ')}]`,
          path,
        );
      }
    }
    return (name) => {
      if (!(name in v.fields)) bad(`record is missing declared field "${name}"`, path);
      return v.fields[name];
    };
  }
  if (v && v.__t === 'tup') {
    if (v.items.length !== node.fields.length) {
      bad(`tuple has ${v.items.length} elements but the config declares ${node.fields.length}`, path);
    }
    const index = new Map(node.fields.map((f, i) => [f.name, i]));
    return (name) => v.items[index.get(name)];
  }
  return bad(`expected a record or tuple, got ${describe(v)}`, path);
}

function asBigInt(v, path) {
  if (typeof v === 'bigint') return v;
  return bad(`expected an integer, got ${describe(v)}`, path);
}

function asFixedHex(v, bytes, path) {
  if (typeof v === 'bigint') {
    if (v < 0n) bad(`${v} is negative`, path);
    if (v >= 1n << BigInt(bytes * 8)) bad(`${v} does not fit in bytes${bytes}`, path);
    return hex(v, bytes);
  }
  if (typeof v === 'string') {
    const s = v.startsWith('0x') || v.startsWith('0X') ? v : `0x${v}`;
    if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(s)) {
      bad(`"${v}" is not a ${bytes}-byte hex string`, path);
    }
    return s.toLowerCase();
  }
  return bad(`expected an integer or hex string, got ${describe(v)}`, path);
}

function describe(v) {
  if (v === undefined) return 'nothing';
  if (typeof v === 'bigint') return `the integer ${v}`;
  if (v && v.__t) return `a ${v.__t}`;
  return JSON.stringify(v);
}

function compare(a, b, node) {
  switch (node.kind) {
    case 'uint':
    case 'int':
      return a < b ? -1 : a > b ? 1 : 0;
    case 'enum':
      return a - b;
    case 'bool':
      return a === b ? 0 : a ? 1 : -1;
    default:
      // address, bytes32 and string all compare as strings; the first two are
      // fixed-width lowercase hex, so lexicographic order is numeric order.
      return a < b ? -1 : a > b ? 1 : 0;
  }
}

function sortIndices(values, node, path) {
  return values
    .map((_, i) => i)
    .sort((x, y) => {
      const c = compare(values[x], values[y], node);
      return c !== 0 ? c : x - y;
    });
}

function sortCanonically(values, node, path) {
  return sortIndices(values, node, path).map((i) => values[i]);
}

/**
 * Solidity forbids an empty struct, so a spec where no action draws a nondet
 * pick gets a single filler field in its `Picks`. The ABI tuple has to declare
 * the same field: without it the encoder writes one word per step fewer than
 * `abi.decode` reads, and every trace decodes as garbage rather than failing.
 */
export const PICKS_FILLER = 'unused';

/**
 * Build the ABI parameter describing `Step[]`, plus the canonical type string
 * the generated Solidity hashes into `SCHEMA_HASH`.
 */
export function stepArrayAbi(model) {
  const picks = {
    type: 'tuple',
    name: 'picks',
    components: model.picks.length
      ? model.picks.flatMap((p) => [
          { name: `has${cap(p.name)}`, type: 'bool' },
          { name: p.name, ...p.node.abiType },
        ])
      : [{ name: PICKS_FILLER, type: 'bool' }],
  };
  const post = {
    type: 'tuple',
    name: 'post',
    components: model.state.map((s) => ({ name: s.name, ...s.node.abiType })),
  };
  const step = {
    type: 'tuple[]',
    name: 'steps',
    components: [{ name: 'action', type: 'uint8' }, picks, post],
  };

  const picksCanon = model.picks.length
    ? `(${model.picks.flatMap((p) => ['bool', p.node.canonical]).join(',')})`
    : '(bool)';
  const postCanon = `(${model.state.map((s) => s.node.canonical).join(',')})`;
  return { abi: step, canonical: `(uint8,${picksCanon},${postCanon})[]` };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lower and ABI-encode one decoded trace. Returns a `0x`-prefixed blob. */
export function encodeTrace(model, trace, { file = '<trace>' } = {}) {
  const { abi } = stepArrayAbi(model);

  assertEveryVarAccountedFor(model, trace, file);

  const steps = trace.steps.map((step) => {
    const where = `${file} step ${step.index} (${step.action})`;

    if (typeof step.actionIndex !== 'number') {
      throw new LowerError(
        `${where}: step carries no actionIndex. \`indexActions\` maps trace action names onto the ` +
          'configured enum and must run before `encodeTrace`',
      );
    }

    const picks = model.picks.length ? {} : { [PICKS_FILLER]: false };
    for (const p of model.picks) {
      const got = step.picks[p.name];
      const present = Boolean(got && got.present);
      picks[`has${cap(p.name)}`] = present;
      picks[p.name] = present
        ? lowerValue(p.node, got.value, `${where} pick ${p.name}`)
        : zeroFor(p.node);
    }

    const post = {};
    for (const s of model.state) {
      if (!(s.name in step.state)) {
        throw new LowerError(`${where}: trace has no state variable "${s.name}"`);
      }
      post[s.name] = lowerValue(s.node, step.state[s.name], `${where} state ${s.name}`);
    }

    return { action: step.actionIndex, picks, post };
  });

  return encodeAbiParameters([abi], [steps]);
}

/**
 * Every variable the trace carries must be either compared or deliberately not
 * compared.
 *
 * The loop below only checks the other direction - that each configured
 * variable is present in the trace. A variable the *spec* declares and the
 * config never mentions was silently dropped: it vanished from `State`, from
 * the comparison, and from the schema hash, so the replay stayed green while
 * asserting nothing about it. That is the failure mode a ghost introduces, and
 * a ghost is exactly the kind of variable someone adds without touching the
 * config.
 *
 * So an omission is an error, and `ignoreState` is how it is resolved - which
 * costs a written reason, because `ignoreState` reasons are validated.
 */
function assertEveryVarAccountedFor(model, trace, file) {
  const first = trace.steps[0];
  if (!first) return;

  const known = new Set(model.state.map((s) => s.name));
  const missing = Object.keys(first.state)
    .filter((name) => !known.has(name) && !(name in model.ignoreState))
    .sort();
  if (missing.length === 0) return;

  throw new LowerError(
    `${file}: the spec declares ${missing.length === 1 ? 'a variable' : 'variables'} the config ` +
      `never mentions: ${missing.join(', ')}. ` +
      'List each one under `state` to compare it against the chain, or under `ignoreState` with ' +
      'a reason if it is a ghost. Left out, it is silently dropped from the comparison and from ' +
      'the schema hash, and the replay passes without asserting anything about it',
  );
}

/**
 * The filler written into a pick slot that was not drawn this step. It is never
 * read: the generated replay gates every pick on its `has` flag, and required
 * picks are rejected before dispatch. It exists because the ABI tuple is fixed
 * width regardless of which action a step took.
 */
function zeroFor(node) {
  switch (node.kind) {
    case 'uint':
    case 'int':
    case 'enum':
      return node.kind === 'enum' ? 0 : 0n;
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'bytes32':
      return hex(0n, 32);
    case 'address':
      return hex(0n, 20);
    case 'array':
      return [];
    case 'struct': {
      const out = {};
      for (const f of node.fields) out[f.name] = zeroFor(f.node);
      return out;
    }
    default:
      throw new LowerError(`no zero value for type kind "${node.kind}"`);
  }
}
