// Shared by the shard publisher and locale-router Worker. Keep this module
// runtime-neutral: Wrangler bundles it, and Node uses the identical mapping.
const utf8Encoder = new TextEncoder();
export const SECTION_TREE_FANOUT_SECTIONS = Object.freeze(['ticino', 'zurigo', 'berna']);

export function sectionUsesHashFanout(section) {
  return SECTION_TREE_FANOUT_SECTIONS.includes(section);
}

export function sectionTreeLayout(section) {
  return sectionUsesHashFanout(section) ? `${section}-hash-v1` : 'canonical';
}

export function sectionTreeLayoutAllowed(section, layout) {
  const staticLayout = sectionTreeLayout(section);
  if (staticLayout !== 'canonical') return layout === staticLayout;
  return layout === 'canonical' || layout === `${section}-hash-v1`;
}

export function sectionTreeBucket(entry) {
  let hash = 0x811c9dc5;
  for (const byte of utf8Encoder.encode(entry)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash >>> 24) & 0xff).toString(16).padStart(2, '0');
}

// Kept as a compatibility alias for existing Ticino consumers and persisted
// test fixtures. The physical hash is shared by every section using hash-v1.
export function ticinoTreeBucket(entry) {
  return sectionTreeBucket(entry);
}

export function legacyTicinoTreeBucket(entry) {
  return Array.from(entry).slice(0, 2).join('').toLowerCase() || '__';
}
