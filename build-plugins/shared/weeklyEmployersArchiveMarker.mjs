// weeklyEmployersArchiveMarker.mjs
//
// Historical weekly-employers pages deliberately remain reachable while
// moving out of the indexable 12-week window. Keep their declaration explicit
// so the Bing full-tree crawler can distinguish that policy from an accidental
// noindex page without inferring intent from a URL alone.
//
// Uppercase so the marker survives HTML minification. Plain `.mjs` keeps the
// value importable by both the TypeScript build plugin and Node crawler.
export const WEEKLY_EMPLOYERS_ARCHIVE_NOINDEX_MARKER = '<!--WEEKLY_EMPLOYERS_ARCHIVE_NOINDEX-->';
