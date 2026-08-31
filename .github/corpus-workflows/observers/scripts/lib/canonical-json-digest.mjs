import { createHash } from 'node:crypto';

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value).sort(compareCodePoint).map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw new TypeError('Document contains a non-canonical value');
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digestDocument(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
