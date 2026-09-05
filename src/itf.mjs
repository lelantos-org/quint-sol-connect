/**
 * ITF (Informal Trace Format) decoding.
 *
 * Spec: https://apalache-mc.org/docs/adr/015adr-trace.html
 *
 * Decoded values carry an explicit `__t` tag rather than being coerced to the
 * nearest JS shape, because several ITF constructs collide once decoded: a
 * record and a decoded map entry are both plain objects, and a list and a
 * tuple are both arrays. Lowering needs to tell them apart to pick a Solidity
 * type, so the distinction is preserved here instead of guessed later.
 */

/** Thrown for ITF this tool cannot lower. Carries the path for a usable message. */
export class ItfError extends Error {
  constructor(message, path) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'ItfError';
    this.path = path;
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Decode one ITF value.
 * @param {unknown} v raw JSON value
 * @param {string} path dotted path, for error messages
 */
export function decodeValue(v, path = '') {
  if (typeof v === 'boolean' || typeof v === 'string') return v;

  if (typeof v === 'number') {
    // ITF requires integers to be tagged `#bigint`; a bare JSON number here
    // means the producer emitted something we would silently round.
    throw new ItfError(`bare JSON number ${v}; expected {"#bigint": "..."}`, path);
  }

  if (Array.isArray(v)) {
    return { __t: 'list', items: v.map((x, i) => decodeValue(x, `${path}[${i}]`)) };
  }

  if (v === null || typeof v !== 'object') {
    throw new ItfError(`unsupported ITF value ${JSON.stringify(v)}`, path);
  }

  if (has(v, '#bigint')) return BigInt(v['#bigint']);
  if (has(v, '#tup')) {
    return { __t: 'tup', items: v['#tup'].map((x, i) => decodeValue(x, `${path}.#tup[${i}]`)) };
  }
  if (has(v, '#set')) {
    return { __t: 'set', items: v['#set'].map((x, i) => decodeValue(x, `${path}.#set[${i}]`)) };
  }
  if (has(v, '#map')) {
    return {
      __t: 'map',
      entries: v['#map'].map((pair, i) => {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new ItfError('malformed #map entry; expected a [key, value] pair', `${path}.#map[${i}]`);
        }
        return [
          decodeValue(pair[0], `${path}.#map[${i}].key`),
          decodeValue(pair[1], `${path}.#map[${i}].value`),
        ];
      }),
    };
  }
  if (has(v, '#unserializable')) {
    throw new ItfError(
      `value is unserializable (${v['#unserializable']}). Quint could not render it: ` +
        'narrow the expression to a finite domain, or list the variable under `ignoreState`',
      path,
    );
  }
  if (has(v, 'tag') && has(v, 'value')) {
    return { __t: 'variant', tag: v.tag, value: decodeValue(v.value, `${path}.value`) };
  }

  const fields = {};
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('#')) continue; // `#meta` and friends are not fields
    fields[k] = decodeValue(x, path ? `${path}.${k}` : k);
  }
  return { __t: 'rec', fields };
}

/** True for a `{tag: "None"|"Some"}` option, which is how `--mbt` reports nondet picks. */
export function isOption(v) {
  return Boolean(v) && v.__t === 'variant' && (v.tag === 'None' || v.tag === 'Some');
}

/** An empty tuple, which is how Quint renders a variant with no payload. */
export function isUnit(v) {
  return Boolean(v) && v.__t === 'tup' && v.items.length === 0;
}

export const MBT_ACTION = 'mbt::actionTaken';
export const MBT_PICKS = 'mbt::nondetPicks';

/**
 * Decode a whole ITF trace into ordered steps.
 *
 * State 0 is the post-`init` state. Quint labels its `mbt::actionTaken` with
 * the name of the top-level transition ("step"), not with an action the user
 * wrote, so it is reported as `isInitial` and callers must not dispatch it.
 *
 * @returns {{ vars: string[], steps: Array<object> }}
 */
export function decodeTrace(raw, { file = '<trace>' } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.states)) {
    throw new ItfError(`${file}: not an ITF trace (no "states" array)`);
  }

  const steps = raw.states.map((state, index) => {
    if (!has(state, MBT_ACTION)) {
      throw new ItfError(
        `${file}: state ${index} has no "${MBT_ACTION}". Traces must be generated with --mbt`,
      );
    }
    const action = state[MBT_ACTION];

    const picks = {};
    for (const [name, pick] of Object.entries(state[MBT_PICKS] ?? {})) {
      const decoded = decodeValue(pick, `states[${index}].${MBT_PICKS}.${name}`);
      if (!isOption(decoded)) {
        throw new ItfError(
          `${file}: nondet pick "${name}" is not an option; expected {tag: "Some"|"None"}`,
        );
      }
      picks[name] =
        decoded.tag === 'Some' ? { present: true, value: decoded.value } : { present: false };
    }

    const vars = {};
    for (const [k, v] of Object.entries(state)) {
      if (k === MBT_ACTION || k === MBT_PICKS || k.startsWith('#')) continue;
      vars[k] = decodeValue(v, `states[${index}].${k}`);
    }

    return { index, action, isInitial: index === 0, picks, state: vars };
  });

  // The top-level `vars` array is informational only: Quint repeats the two
  // mbt entries in it, so it is not a reliable key set. The state objects are
  // the source of truth, and every state must agree on which variables exist.
  const varNames = steps.length ? Object.keys(steps[0].state).sort() : [];
  for (const s of steps) {
    const names = Object.keys(s.state).sort();
    if (names.join(' ') !== varNames.join(' ')) {
      throw new ItfError(
        `${file}: state ${s.index} declares variables [${names}] but state 0 declares [${varNames}]`,
      );
    }
  }

  return { vars: varNames, steps };
}
