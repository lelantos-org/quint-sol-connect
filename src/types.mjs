/**
 * Config type descriptors resolved into (a) a viem ABI parameter, (b) a
 * Solidity type name, and (c) any struct/enum declarations that need emitting.
 *
 * The config carries the types rather than the Quint source because Quint's
 * type system is richer than Solidity's in the directions that matter here
 * (unbounded ints, unordered sets, maps with arbitrary keys). Someone has to
 * choose the width and the ordering; v1 makes that choice explicit.
 */

import { pascal } from './util.mjs';

export class TypeError_ extends Error {
  constructor(message, path) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'TypeError';
    this.path = path;
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Words solc 0.8.36 will not accept as a struct member or enum tag - checked
 * against the compiler, not transcribed from the docs. A config name that is one of
 * these used to go straight into the generated library and fail there, as a
 * parser error pointing at generated code rather than at the config entry.
 */
const SOLIDITY_RESERVED = new Set(
  (
    'abstract after alias anonymous apply as assembly auto break byte bytes calldata case catch constant ' +
    'constructor continue contract copyof default define delete do else emit enum event external ' +
    'fallback false final for function if immutable implements import in indexed inline interface internal ' +
    'is let library macro mapping match memory modifier mutable new null of override partial payable pragma ' +
    'private promise public pure receive reference relocatable return returns sealed sizeof static ' +
    'storage string struct supports switch this throw true try type typedef typeof unchecked unicode using ' +
    'var view virtual while address bool int uint fixed ufixed wei gwei ether seconds minutes hours days weeks ' +
    'years super hex'
  ).split(' '),
);
const SIZED = /^(u?int\d+|bytes\d+|u?fixed\d+x\d+)$/;

/** Reject a name the generated Solidity could not declare. */
export function assertIdentifier(name, what, path) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new TypeError_(`${what} ${JSON.stringify(name)} is not a valid Solidity identifier`, path);
  }
  if (SOLIDITY_RESERVED.has(name) || SIZED.test(name)) {
    throw new TypeError_(`${what} "${name}" is a Solidity keyword or type name`, path);
  }
}

/** Two fields of one struct with the same name do not compile. */
function assertUniqueFields(fields, owner, path) {
  const seen = new Set();
  for (const f of fields) {
    if (seen.has(f.name)) throw new TypeError_(`${owner} has two fields named "${f.name}"`, path);
    seen.add(f.name);
  }
}

const UINT = /^uint(\d+)$/;
const INT = /^int(\d+)$/;

/**
 * A registry of named structs and enums collected while resolving types.
 * Names are unique within one spec; a redeclaration with a different shape is
 * an error rather than a silent overwrite.
 */
export class Decls {
  constructor() {
    this.structs = new Map(); // name -> { name, fields: [{name, node}] }
    this.enums = new Map(); // name -> { name, variants: [string] }
  }

  struct(name, fields) {
    if (this.enums.has(name)) throw new TypeError_(`"${name}" is declared as both an enum and a struct`);
    const existing = this.structs.get(name);
    const shape = fields.map((f) => `${f.name}:${f.node.solType}`).join(',');
    if (existing) {
      const prev = existing.fields.map((f) => `${f.name}:${f.node.solType}`).join(',');
      if (prev !== shape) {
        throw new TypeError_(`struct "${name}" declared twice with different shapes: {${prev}} vs {${shape}}`);
      }
      return existing;
    }
    const decl = { name, fields };
    this.structs.set(name, decl);
    return decl;
  }

  enum_(name, variants) {
    if (this.structs.has(name)) throw new TypeError_(`"${name}" is declared as both a struct and an enum`);
    const existing = this.enums.get(name);
    if (existing) {
      if (existing.variants.join(',') !== variants.join(',')) {
        throw new TypeError_(
          `enum "${name}" declared twice with different variants: [${existing.variants}] vs [${variants}]`,
        );
      }
      return existing;
    }
    const decl = { name, variants };
    this.enums.set(name, decl);
    return decl;
  }
}

/**
 * Resolve a config type descriptor.
 *
 * @param {unknown} desc the descriptor
 * @param {Decls} decls registry to collect struct/enum declarations into
 * @param {{ path: string, hint: string, lib?: string }} ctx
 */
export function resolveType(desc, decls, ctx) {
  const { path, hint } = ctx;

  if (typeof desc === 'string') return resolveScalar(desc, path);

  if (!desc || typeof desc !== 'object') {
    throw new TypeError_(`unrecognised type descriptor ${JSON.stringify(desc)}`, path);
  }

  if (desc.list !== undefined) {
    const inner = resolveType(desc.list, decls, { ...ctx, path: `${path}[]`, hint: `${hint}Item` });
    return arrayOf(inner, 'list');
  }

  if (desc.set !== undefined) {
    const inner = resolveType(desc.set, decls, { ...ctx, path: `${path}{}`, hint: `${hint}Item` });
    if (!inner.sortable) {
      throw new TypeError_(
        `a set of ${inner.solType} cannot be given a canonical order; v1 supports sets of ` +
          'integers, addresses, bytes32, booleans and strings only',
        path,
      );
    }
    return arrayOf(inner, 'set');
  }

  if (desc.map !== undefined) {
    const { key, value } = desc.map;
    if (key === undefined || value === undefined) {
      throw new TypeError_('map descriptor needs both `key` and `value`', path);
    }
    const keyNode = resolveType(key, decls, { ...ctx, path: `${path}.key`, hint: `${hint}Key` });
    if (!keyNode.sortable) {
      throw new TypeError_(
        `a map keyed by ${keyNode.solType} cannot be given a canonical order`,
        path,
      );
    }
    const valueNode = resolveType(value, decls, { ...ctx, path: `${path}.value`, hint: `${hint}Value` });

    // The entry struct flattens the key alongside the value's fields when the
    // value is a record, so the generated Solidity reads as one row rather
    // than a key paired with a nested struct.
    const name = desc.entryName ?? `${pascal(hint)}Entry`;
    assertIdentifier(name, 'map entry struct name', path);
    const fields =
      valueNode.kind === 'struct'
        ? [{ name: 'key', node: keyNode }, ...valueNode.fields]
        : [
            { name: 'key', node: keyNode },
            { name: 'value', node: valueNode },
          ];
    // The key is flattened in beside the record's own fields, so a record with
    // a field of its own called `key` would declare it twice.
    assertUniqueFields(fields, `map entry "${name}" (the key plus the value record's fields)`, path);
    const decl = decls.struct(name, fields);
    const entry = structNode(decl);
    return { ...arrayOf(entry, 'map'), keyNode, valueNode };
  }

  if (desc.record !== undefined || desc.tuple !== undefined) {
    const spec = desc.record ?? desc.tuple;
    const from = desc.record !== undefined ? 'record' : 'tuple';
    const name = desc.name ?? pascal(hint);
    // Field names become struct members, so they have to be written down.
    // `Object.entries` on an array would name them "0", "1", ...
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError_(
        `${from} descriptor needs an object of named fields, e.g. { ${from}: { amount: 'uint256', ok: 'bool' } }` +
          (from === 'tuple' ? '; tuple elements are matched by position, in the order the keys are written' : ''),
        path,
      );
    }
    assertIdentifier(name, `${from} struct name`, path);
    const fields = Object.entries(spec).map(([fname, fdesc]) => {
      assertIdentifier(fname, `${from} field`, `${path}.${fname}`);
      return {
        name: fname,
        node: resolveType(fdesc, decls, { ...ctx, path: `${path}.${fname}`, hint: `${pascal(hint)}${pascal(fname)}` }),
      };
    });
    if (fields.length === 0) throw new TypeError_(`${from} "${name}" has no fields`, path);
    const decl = decls.struct(name, fields);
    return { ...structNode(decl), from };
  }

  if (desc.variant !== undefined) {
    const variants = desc.variant;
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new TypeError_('variant descriptor needs a non-empty array of tag names', path);
    }
    if (variants.length > 256) throw new TypeError_('a variant lowers to a uint8 and cannot have more than 256 tags', path);
    if (new Set(variants).size !== variants.length) throw new TypeError_('variant tags must be unique', path);
    const name = desc.name ?? pascal(hint);
    assertIdentifier(name, 'variant enum name', path);
    for (const v of variants) assertIdentifier(v, 'variant tag', path);
    const decl = decls.enum_(name, variants);
    return {
      kind: 'enum',
      decl,
      solType: name,
      userDefined: true,
      abiType: { type: 'uint8' },
      canonical: 'uint8',
      // The tags are part of the signature even though the wire type is a bare
      // `uint8`: reordering them repoints every value a fixture already holds.
      signature: `uint8{${variants.join(',')}}`,
      sortable: true,
      variants,
    };
  }

  throw new TypeError_(`unrecognised type descriptor ${JSON.stringify(desc)}`, path);
}

function resolveScalar(name, path) {
  const node = scalarNode(name, path);
  return { ...node, signature: node.canonical };
}

function scalarNode(name, path) {
  if (name === 'bool') {
    return { kind: 'bool', solType: 'bool', abiType: { type: 'bool' }, canonical: 'bool', sortable: true };
  }
  if (name === 'string') {
    return {
      kind: 'string',
      solType: 'string',
      abiType: { type: 'string' },
      canonical: 'string',
      sortable: true,
    };
  }
  if (name === 'address') {
    return {
      kind: 'address',
      solType: 'address',
      abiType: { type: 'address' },
      canonical: 'address',
      sortable: true,
    };
  }
  if (name === 'bytes32') {
    return {
      kind: 'bytes32',
      solType: 'bytes32',
      abiType: { type: 'bytes32' },
      canonical: 'bytes32',
      sortable: true,
    };
  }
  const u = UINT.exec(name);
  if (u) {
    const bits = Number(u[1]);
    assertWidth(bits, name, path);
    return {
      kind: 'uint',
      bits,
      solType: name,
      abiType: { type: name },
      canonical: name,
      sortable: true,
    };
  }
  const i = INT.exec(name);
  if (i) {
    const bits = Number(i[1]);
    assertWidth(bits, name, path);
    return {
      kind: 'int',
      bits,
      solType: name,
      abiType: { type: name },
      canonical: name,
      sortable: true,
    };
  }
  throw new TypeError_(
    `unknown Solidity type "${name}"; v1 supports uintN, intN, bool, address, bytes32, string ` +
      'plus the {list}, {set}, {map}, {record}, {tuple} and {variant} forms',
    path,
  );
}

function assertWidth(bits, name, path) {
  if (bits % 8 !== 0 || bits < 8 || bits > 256) {
    throw new TypeError_(`"${name}" is not a valid Solidity width`, path);
  }
}

function structNode(decl) {
  return {
    kind: 'struct',
    decl,
    fields: decl.fields,
    solType: decl.name,
    userDefined: true,
    abiType: { type: 'tuple', components: decl.fields.map((f) => ({ name: f.name, ...f.node.abiType })) },
    canonical: `(${decl.fields.map((f) => f.node.canonical).join(',')})`,
    signature: `(${decl.fields.map((f) => `${f.node.signature} ${f.name}`).join(',')})`,
    sortable: false,
  };
}

function arrayOf(inner, origin) {
  return {
    kind: 'array',
    origin,
    inner,
    solType: `${inner.solType}[]`,
    abiType:
      inner.abiType.type === 'tuple'
        ? { type: 'tuple[]', components: inner.abiType.components }
        : { type: `${inner.abiType.type}[]` },
    canonical: `${inner.canonical}[]`,
    // A set and a list encode identically but differ in whether the generator
    // sorted them, which decides what the driver's `_project` must return.
    signature: origin === 'list' ? `${inner.signature}[]` : `${origin}(${inner.signature})`,
    sortable: false,
  };
}

/**
 * The Solidity type as written *outside* the library that declares it.
 * Generated structs and enums live inside `library <Spec>Spec`, so a reference
 * from the replay contract or the driver needs the library prefix, while the
 * declarations themselves do not.
 */
export function qualified(node, lib) {
  if (node.kind === 'array') return `${qualified(node.inner, lib)}[]`;
  return node.userDefined ? `${lib}.${node.solType}` : node.solType;
}
