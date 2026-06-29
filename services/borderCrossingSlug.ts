/**
 * Canonical slug for a border crossing's display name.
 *
 * Single source of truth for the app layer (services + components) so the
 * URL/data-key slug is identical everywhere — e.g. the keys in
 * `data/border-wait-current.json` and the SPA lookups never drift apart.
 *
 * Mirrors the build/runtime writer
 * `functions/src/borderCrossingsData.js#slugifyCrossingName` (which produces the
 * snapshot/Firestore keys); the two cannot share a module across the bundler
 * boundary, so they are kept byte-equivalent by hand.
 */
export function slugifyCrossingName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
