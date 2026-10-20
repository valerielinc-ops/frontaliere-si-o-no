/**
 * Explicit per-name overrides for crossings whose display name collides with
 * another crossing's slug under the general rule below (issue #4890): the
 * general rule strips parenthetical content, and 'Widnau-Lustenau
 * (Wiesenrain)' / 'Widnau-Lustenau (Schmitterbrücke)' both reduce to
 * "widnau-lustenau". 'Wiesenrain' keeps the unchanged slug (it is the first
 * of the two in data/borderCrossings.ts); 'Schmitterbrücke' gets this
 * override instead. Both crossings now have a public /traffico-dogane/ page
 * (#4545 wired 'widnau-lustenau-schmitterbrucke' into the registry) — and
 * 'Wiesenrain' keeping the unchanged slug is exactly what made that safe:
 * no already-indexed URL moved. Do NOT change the general rule itself — these
 * explicit overrides preserve the existing indexed URL and add stable slugs for
 * the five newly registered Basel-France crossings.
 *
 * Anti-collision regression coverage lives in
 * tests/border-crossing-slug-collision.test.ts — add a new override here
 * (never edit the general rule) and it enforces every slug, including the
 * new one, stays unique dataset-wide.
 */
const CROSSING_SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  'Widnau-Lustenau (Schmitterbrücke)': 'widnau-lustenau-schmitterbrucke',
  'Basel–Saint-Louis (A35)': 'basel-saint-louis-a35',
  'Basel–Bourgfelden (Burgfelderstrasse)': 'basel-bourgfelden-burgfelderstrasse',
  'Basel–Saint-Louis (Elsässerstrasse)': 'basel-saint-louis-elsasserstrasse',
  'Basel–Saint-Louis (Flughafenstrasse)': 'basel-saint-louis-flughafenstrasse',
  'Basel–Huningue (Kohlenstrasse)': 'basel-huningue-kohlenstrasse',
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
