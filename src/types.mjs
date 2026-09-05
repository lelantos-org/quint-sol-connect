/**
 * Config type descriptors resolved into (a) a viem ABI parameter, (b) a
 * Solidity type name, and (c) any struct/enum declarations that need emitting.
 *
 * The config carries the types rather than the Quint source because Quint's
 * type system is richer than Solidity's in the directions that matter here
 * (unbounded ints, unordered sets, maps with arbitrary keys). Someone has to
 * choose the width and the ordering; v1 makes that choice explicit.
 */

export class TypeError_ extends Error {
  constructor(message, path) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'TypeError';
    this.path = path;
  }
}

const pascal = (s) => s.replace(/(^|[_-])(\w)/g, (_, __, c) => c.toUpperCase());

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
    const fields =
      valueNode.kind === 'struct'
        ? [{ name: 'key', node: keyNode }, ...valueNode.fields]
        : [
            { name: 'key', node: keyNode },
            { name: 'value', node: valueNode },
          ];
    const decl = decls.struct(name, fields);
    const entry = structNode(decl);
    return { ...arrayOf(entry, 'map'), keyNode, valueNode };
  }

  if (desc.record !== undefined || desc.tuple !== undefined) {
    const spec = desc.record ?? desc.tuple;
    const from = desc.record !== undefined ? 'record' : 'tuple';
    const name = desc.name ?? pascal(hint);
    const fields = Object.entries(spec).map(([fname, fdesc]) => ({
      name: fname,
      node: resolveType(fdesc, decls, { ...ctx, path: `${path}.${fname}`, hint: `${pascal(hint)}${pascal(fname)}` }),
    }));
    if (fields.length === 0) throw new TypeError_(`${from} "${name}" has no fields`, path);
    const decl = decls.struct(name, fields);
    return { ...structNode(decl), from };
  }

  if (desc.variant !== undefined) {
    const variants = desc.variant;
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new TypeError_('variant descriptor needs a non-empty array of tag names', path);
    }
    const name = desc.name ?? pascal(hint);
    const decl = decls.enum_(name, variants);
    return {
      kind: 'enum',
      decl,
      solType: name,
      userDefined: true,
      abiType: { type: 'uint8' },
      canonical: 'uint8',
      sortable: true,
      variants,
    };
  }

  throw new TypeError_(`unrecognised type descriptor ${JSON.stringify(desc)}`, path);
}

function resolveScalar(name, path) {
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
