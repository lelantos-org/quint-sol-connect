/**
 * String and path helpers shared by the pipeline, the emitters and the gate.
 */

import path from 'node:path';

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const lower1 = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export const pascal = (s) => s.replace(/(^|[_-])(\w)/g, (_, __, c) => c.toUpperCase());
export const pad3 = (n) => String(n).padStart(3, '0');

// Fixture paths are written into a Solidity string literal and into `meta.itf`,
// both of which are read back by `vm.readFile`. `path.join` uses the host
// separator, so on Windows those become backslashes - which Solidity reads as
// escapes. Every path that leaves this process for a generated file is posix.
export const posix = (p) => p.split(path.sep).join('/');
