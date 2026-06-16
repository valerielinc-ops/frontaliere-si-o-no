// Shared marker for dist-sampling SEO tests.
//
// A "bridge" page is the lightweight canonical-bridge HTML emitted by
// buildCanonicalBridgePage (cfHot404BridgePlugin, cantonOrphanRedirectsPlugin,
// legacy redirect emitters). It links the dedicated `bridge.css` stylesheet
// (BRIDGE_CSS_FILENAME in build-plugins/constants.ts) and carries NO hreflang
// alternates and NO JobPosting schema — it is a noindex archived/redirect stub,
// not a real content page.
//
// Dist-sampling tests that pick "any slug with an index.html" under a canton
// job-detail dir and then assert real-job-page invariants (hreflang round-trip,
// canton routing, listing grids) MUST skip bridges: the cf-hot-404 recovery set
// legitimately emits bridges under those same dirs, and as that set grows it
// will otherwise be sampled and fail the assertion (cf. validate-dist break when
// the bridge cap was raised 12k→40k). Marker kept in ONE place so the sampler
// tests can never silently drift apart.
//
// Match the <link> stylesheet tag specifically (BRIDGE_CSS_LINK in constants.ts:
// `<link rel="stylesheet" href="/assets/bridge.css">`), not a bare substring —
// a bare includes('bridge.css') would false-positive on any job description text
// or JSON-LD field that happens to contain the literal string, under-counting
// real pages and potentially masking a canton-boundary leak.
export const isBridgePageHtml = (html: string): boolean =>
  /<link[^>]+href="[^"]*bridge\.css[^"]*"/.test(html);
