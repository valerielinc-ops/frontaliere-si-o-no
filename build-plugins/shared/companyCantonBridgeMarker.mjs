// companyCantonBridgeMarker.mjs
//
// The per-canton company bridge is a live, self-canonical noindex/follow
// page.  Keep its declaration explicit so the full-tree crawler can exempt
// only the emitter's intentional bridge, rather than guessing from a URL or
// from the presence of noindex alone.
//
// Uppercase so the marker survives HTML minification.  Plain `.mjs` keeps the
// marker importable by scripts/seo/bing-site-explorer-crawl.mjs as well as by
// the TypeScript build plugin.
export const COMPANY_CANTON_NOINDEX_BRIDGE_MARKER = '<!--COMPANY_CANTON_NOINDEX_BRIDGE-->';
