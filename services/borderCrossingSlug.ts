/**
 * Explicit per-name overrides for crossings whose display name collides with
 * another crossing's slug under the general rule below (issue #4890): the
 * general rule strips parenthetical content, and 'Widnau-Lustenau
 * (Wiesenrain)' / 'Widnau-Lustenau (Schmitterbrücke)' both reduce to
 * "widnau-lustenau". 'Wiesenrain' keeps the unchanged slug (it is the first
 * of the two in data/borderCrossings.ts); 'Schmitterbrücke' gets this
 * override instead. Neither crossing has a public /traffico-dogane/ page, so
 * no redirect is needed — do NOT change the general rule itself, 5 other
 * crossings (incl. the primary Chiasso Centro one) have indexed URLs that
 * depend on parens being stripped.
 *
 * Anti-collision regression coverage lives in
 * tests/border-crossing-slug-collision.test.ts — add a new override here
 * (never edit the general rule) and it enforces every slug, including the
 * new one, stays unique dataset-wide.
 */
const CROSSING_SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  'Widnau-Lustenau (Schmitterbrücke)': 'widnau-lustenau-schmitterbrucke',
};

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
  const override = CROSSING_SLUG_OVERRIDES[name];
  if (override) {
    return override;
  }
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
