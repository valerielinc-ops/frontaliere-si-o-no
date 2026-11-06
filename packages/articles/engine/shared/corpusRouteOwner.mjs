/**
 * Route-ownership marker of the pages the CORPUS serves for the site (canton
 * article sections, piano «sezioni articoli per cantone»).
 *
 * Those pages are prerendered by the corpus with this engine, uploaded to R2
 * and served by the Worker; the site has no React view for them, so the SPA
 * must stay in `staticOverlay` on top of their HTML. The router claims a canton
 * section path ONLY when the document it boots on carries this meta: an URL
 * whose section is not live yet answers the Pages 404, whose SPA fallback
 * restores the path on the HOMEPAGE document — and that one must keep showing
 * NotFoundSuggestions, exactly as before the canton sections existed.
 *
 * Pure module, no imports: read by `services/cantonArticlePaths.ts` (site) and
 * by the corpus renderer that writes `<head>` (mirrored with engine/).
 */

/** `name` attribute of the ownership meta. */
export const ROUTE_OWNER_META_NAME = 'ft-route-owner';

/** `content` value declaring a corpus-owned page. */
export const ROUTE_OWNER_CORPUS = 'corpus';

/** The exact tag a corpus-owned page must carry in `<head>`. */
export const CORPUS_ROUTE_OWNER_META_TAG = `<meta name="${ROUTE_OWNER_META_NAME}" content="${ROUTE_OWNER_CORPUS}">`;
