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

// A page carrying `<meta name="robots" content="noindex…">`. Quote-flexible
// (dist-shrink may strip attribute quotes): `name=robots content=noindex` is
// DOM-equivalent to `name="robots" content="noindex"`.
export const isNoindexHtml = (html: string): boolean =>
  /<meta\s+name=["']?robots["']?[^>]*content=["']?[^"'>]*noindex/i.test(html);

// A page that "real indexable content page" dist-samplers MUST skip: either a
// thin canonical-bridge stub (bridge.css, above) OR a full-content but noindex
// relocation copy. The latter is the IT canton-drift orphan recovery emitted by
// cfHot404BridgePlugin (#2661/#2676): it copies the slug's canonical page HTML
// VERBATIM (no bridge.css link → invisible to isBridgePageHtml) and forces
// `<meta name="robots" content="noindex,follow">`. Because the copy keeps the
// SOURCE canton's hreflang/canonical, it fails a canton-round-trip assertion
// when sampled under the orphan's own (different) canton dir. Both kinds are
// noindex archived/redirect stubs, not real indexable job pages.
export const isArchivedStubHtml = (html: string): boolean =>
  isBridgePageHtml(html) || isNoindexHtml(html);

// The `rel=canonical` href of a page, or '' if absent. Two-step (find the
// canonical <link> tag, then its href) so attribute order rel/href doesn't
// matter; quote-flexible because dist-shrink may strip attribute quotes.
export const canonicalHref = (html: string): string => {
  const tag = html.match(/<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i);
  if (!tag) return '';
  const href = tag[0].match(/\bhref=["']?([^"'\s>]+)/i);
  return href ? href[1] : '';
};

// A relocation/drift copy a canton-round-trip sampler MUST skip even if it
// somehow escaped the noindex marker (isArchivedStubHtml): its rel=canonical
// points OUTSIDE the section dir it lives under (e.g. a /cerca-lavoro-zurigo/
// <slug>/ copy whose canonical is /cerca-lavoro-ticino/<slug>/ — a #2661/#2676
// IT canton-drift orphan that legitimately carries the SOURCE canton's
// hreflang). A genuine section page is self-canonical under its own section, so
// its canonical href contains `/<sectionPath>/`. Belt-and-suspenders next to
// isNoindexHtml: the copy is *meant* to be noindex, but a build that emits it
// index,follow (validate-dist flake #2679) would otherwise be sampled and fail
// the round-trip assertion for hreflang it isn't supposed to declare.
export const isCrossSectionCanonical = (html: string, sectionPath: string): boolean => {
  const href = canonicalHref(html);
  if (!href) return false; // no canonical → don't over-skip a real page
  return !href.includes(`/${sectionPath}/`);
};
