// Shared by the shard publisher and locale-router Worker. Keep this module
// runtime-neutral: Wrangler bundles it, and Node uses the identical mapping.
const utf8Encoder = new TextEncoder();

export function ticinoTreeBucket(entry) {
  let hash = 0x811c9dc5;
  for (const byte of utf8Encoder.encode(entry)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash >>> 24) & 0xff).toString(16).padStart(2, '0');
}

export function legacyTicinoTreeBucket(entry) {
  return Array.from(entry).slice(0, 2).join('').toLowerCase() || '__';
}
