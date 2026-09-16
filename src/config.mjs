/**
 * Config loading and model building.
 *
 * A "model" is everything the emitters and the lowering need for one spec:
 * ordered state variables, the union of nondet picks, the action enum, the
 * struct/enum declarations, and the schema hash that ties a committed fixture
 * to the Solidity it was generated for.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { keccak256, toHex } from 'viem';

import { Decls, resolveType, qualified, assertIdentifier } from './types.mjs';
import { stepArrayAbi } from './lower.mjs';
import { cap, pascal } from './util.mjs';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Declared by every generated library, so a config type cannot take the name. */
const GENERATED_TYPES = ['Action', 'State', 'Picks', 'Step'];

/** Bytes a spec may commit before `check` complains, absent a named allocation. */
export const DEFAULT_MAX_BYTES = 512_000;
/** Ceiling on the sum of every spec's allocation. */
export const DEFAULT_TOTAL_BYTES = 12_000_000;

export const DEFAULTS = {
  solidityOut: 'test/quint/generated',
  fixtureOut: 'test/fixtures/quint',
  pragma: '0.8.36',
  run: {
    traces: 16,
    maxSteps: 20,
    maxSamples: 20000,
    seed: '0x1',
    invariant: null,
    /// null = quint's default (`rust`). Set `'typescript'` for specs whose
    /// arithmetic leaves i64 - the Rust evaluator refuses those outright.
    backend: null,
  },
};

/** Load `quint-sol-connect.config.mjs` (or `.json`) from `root`. */
export async function loadConfig(root, file) {
  const candidates = file
    ? [file]
    : [
        'quint-sol-connect.config.mjs',
        'quint-sol-connect.config.js',
        'quint-sol-connect.config.json',
      ];

  // Existence decides which candidate to load; whatever `import` then throws is
  // the user's own config failing and is reported as-is. Catching
  // ERR_MODULE_NOT_FOUND here instead would swallow a config whose *own*
  // imports are broken - that error names the importer, so it looks identical
  // to the file being absent - and report it as "no config found".
  for (const c of candidates) {
    const abs = path.resolve(root, c);
    if (!fs.existsSync(abs)) continue;
    const mod = await import(pathToFileURL(abs).href, {
      with: abs.endsWith('.json') ? { type: 'json' } : undefined,
    });
    return { config: mod.default ?? mod, file: abs };
  }

  if (file) throw new ConfigError(`config file "${file}" does not exist (looked in ${root})`);
  throw new ConfigError(
    `no config found in ${root}. Create quint-sol-connect.config.mjs with a \`specs\` map ` +
      '(see the README, or run `quint-sol-connect scaffold`)',
  );
}

/** Build the model for one named spec entry. */
export function buildModel(name, raw, config) {
  if (!raw || typeof raw !== 'object') throw new ConfigError(`spec "${name}" is not an object`);
  if (!raw.spec) throw new ConfigError(`spec "${name}" has no \`spec\` path`);
  if (!raw.state || typeof raw.state !== 'object') {
    throw new ConfigError(`spec "${name}" has no \`state\` map`);
  }
  if (!raw.actions || typeof raw.actions !== 'object') {
    throw new ConfigError(`spec "${name}" has no \`actions\` map`);
  }

  const lib = `${pascal(name)}Spec`;
  const decls = new Decls();

  const state = Object.entries(raw.state).map(([varName, desc]) => {
    assertIdentifier(varName, 'state variable', `${name}.state.${varName}`);
    return {
      name: varName,
      node: resolveType(desc, decls, { path: `${name}.state.${varName}`, hint: pascal(varName) }),
    };
  });
  if (state.length === 0) throw new ConfigError(`spec "${name}" declares no state variables`);

  const ignoreState = raw.ignoreState ?? {};
  for (const [varName, why] of Object.entries(ignoreState)) {
    if (typeof why !== 'string' || why.trim() === '') {
      throw new ConfigError(
        `ignoreState.${varName} needs a reason string. It is copied into the generated ` +
          'Solidity so the gap in coverage is visible where the comparison happens',
      );
    }
    if (varName in raw.state) {
      throw new ConfigError(`"${varName}" is in both \`state\` and \`ignoreState\`; pick one`);
    }
  }

  // Picks are declared per action but compared as one fixed-width struct, so a
  // name reused across actions must mean the same thing in each.
  const pickNodes = new Map();
  const pickOwners = new Map();
  const actions = Object.entries(raw.actions).map(([actionName, picksDesc], index) => {
    assertIdentifier(cap(actionName), 'action', `${name}.actions.${actionName}`);
    const names = Object.keys(picksDesc ?? {});
    for (const [pickName, desc] of Object.entries(picksDesc ?? {})) {
      assertIdentifier(pickName, 'nondet pick', `${name}.actions.${actionName}.${pickName}`);
      const node = resolveType(desc, decls, {
        path: `${name}.actions.${actionName}.${pickName}`,
        hint: `${pascal(pickName)}Pick`,
      });
      const prev = pickNodes.get(pickName);
      if (prev && prev.canonical !== node.canonical) {
        throw new ConfigError(
          `nondet pick "${pickName}" is ${prev.canonical} in one action and ${node.canonical} in ` +
            `"${actionName}". Picks share one struct across all actions, so a name must have one type`,
        );
      }
      if (!prev) pickNodes.set(pickName, node);
      pickOwners.set(pickName, [...(pickOwners.get(pickName) ?? []), actionName]);
    }
    return { name: actionName, index, enumName: cap(actionName), picks: names };
  });
  if (actions.length === 0) throw new ConfigError(`spec "${name}" declares no actions`);
  if (actions.length > 256) throw new ConfigError(`spec "${name}" declares more than 256 actions`);
  assertUnique(
    actions.map((a) => a.enumName),
    (dup) => `spec "${name}": two actions both become \`Action.${dup}\` once capitalised`,
  );

  const picks = [...pickNodes.entries()].map(([pickName, node]) => ({
    name: pickName,
    node,
    requiredBy: pickOwners.get(pickName),
  }));
  // Every pick adds a `has<Pick>` flag beside itself, so `x` and `X`, or `x` and
  // `hasX`, would declare one member twice.
  assertUnique(
    picks.flatMap((p) => [`has${cap(p.name)}`, p.name]),
    (dup) => `spec "${name}": nondet picks collide on the generated \`Picks.${dup}\``,
  );

  for (const t of GENERATED_TYPES) {
    if (decls.structs.has(t) || decls.enums.has(t)) {
      throw new ConfigError(
        `spec "${name}": a config type is named "${t}", which the generated library declares itself. ` +
          `Give it another \`name\` (reserved: ${GENERATED_TYPES.join(', ')})`,
      );
    }
  }

  // A spec may take more than the default share of the byte budget, but not
  // silently: an allocation above the default carries a reason, validated the
  // way `ignoreState` reasons are. The failure this prevents is a cap quietly
  // raised to whatever the current output happens to be, which is the same as
  // having no cap.
  const defaultMax = config.budget?.defaultMaxBytes ?? DEFAULT_MAX_BYTES;
  if (raw.budget) {
    const { maxBytes, why } = raw.budget;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new ConfigError(`spec "${name}": budget.maxBytes must be a positive integer`);
    }
    if (maxBytes > defaultMax && (typeof why !== 'string' || why.trim() === '')) {
      throw new ConfigError(
        `spec "${name}": budget.maxBytes of ${maxBytes} exceeds the default ${defaultMax} ` +
          'and needs a `why`. It is printed in the allocation table, so the trade is ' +
          'visible against the other specs rather than absorbed silently',
      );
    }
  }

  const model = {
    name,
    lib,
    maxBytes: raw.budget?.maxBytes ?? defaultMax,
    specPath: raw.spec,
    module: raw.module ?? null,
    driver: raw.driver ?? null,
    run: { ...DEFAULTS.run, ...(raw.run ?? {}) },
    solidityOut: raw.solidityOut ?? config.solidityOut ?? DEFAULTS.solidityOut,
    fixtureOut: raw.fixtureOut ?? config.fixtureOut ?? DEFAULTS.fixtureOut,
    pragma: raw.pragma ?? config.pragma ?? DEFAULTS.pragma,
    decls,
    state,
    ignoreState,
    actions,
    picks,
    /// Optional `{ minSteps: { action: n } }`. Enforced by `check`, not `gen`,
    /// so it guards the committed traces rather than one run.
    coverage: raw.coverage ?? null,
    /// Optional `{ maxBytes, why }`. Absent means the default cap applies.
    budget: raw.budget ?? null,
    qualify: (node) => qualified(node, lib),
  };

  // Canonical string, signature and ABI parameter come from one place, so the
  // hash the Solidity asserts and the encoder that writes the blob cannot drift
  // apart.
  const { canonical, signature } = stepArrayAbi(model);
  model.canonical = canonical;

  // The hash is taken over the *named* signature, not the ABI type string, and
  // the action names ride alongside it. Every one of these leaves `canonical`
  // byte-identical while repointing what a committed fixture's bytes mean:
  // renaming or reordering actions (a step's action is a bare `uint8`),
  // swapping two state variables of one type, reordering an enum's tags, or
  // exchanging two record fields. Hashing only the type string let each of
  // those pass `check` and replay as a divergence in the wrong place.
  model.schemaHash = keccak256(toHex(`${signature}|${actions.map((a) => a.name).join(',')}`));
  return model;
}

function assertUnique(names, message) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) throw new ConfigError(message(n));
    seen.add(n);
  }
}

/** Build every model in a config, in declaration order. */
export function buildModels(config, only = []) {
  if (!config.specs || typeof config.specs !== 'object') {
    throw new ConfigError('config has no `specs` map');
  }
  const names = Object.keys(config.specs);
  const wanted = only.length ? only : names;
  for (const w of wanted) {
    if (!names.includes(w)) {
      throw new ConfigError(`no spec named "${w}" in the config; known specs: ${names.join(', ')}`);
    }
  }
  return wanted.map((n) => buildModel(n, config.specs[n], config));
}
