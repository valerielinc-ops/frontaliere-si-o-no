/**
 * Canton article section paths (piano «sezioni articoli per cantone», S2).
 *
 * The 24 canton sections × 4 locales are served by the CORPUS: prerendered
 * HTML on R2, answered by the Worker (`serveCorpusSection` in
 * infra/cloudflare-worker/locale-router.js). The SPA has no view for them, so
 * the router must leave their static HTML on screen (`staticOverlay`) instead
 * of falling through to `notFoundPath`, which hides `main.seo-static-content`
 * and shows NotFoundSuggestions.
 *
 * The prefix set is the CLOSED one from the generated section core (every
 * canton, active or not); whether a section is live is decided at runtime by
 * the corpus registry, which this bundle cannot know. So the claim is gated on
 * the document itself: only a page the corpus served carries the route-owner
 * meta. A canton URL whose section is not live yet answers 404, and the 404
 * page restores the path on the HOMEPAGE document — no meta there, so the
 * router keeps answering exactly what it answered before (notFoundPath).
 */
import { CANTON_ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';
import {
  ROUTE_OWNER_CORPUS,
  ROUTE_OWNER_META_NAME,
} from '../packages/articles/engine/shared/corpusRouteOwner.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

/** `/articoli-ticino`, `/en/ticino-articles`, … — 96 prefixes, no trailing slash. */
const CANTON_ARTICLE_PREFIXES: readonly string[] = Object.values(CANTON_ARTICLE_SECTION_CORE).flatMap(
  (entry) =>
    LOCALES.map((locale) =>
      locale === 'it' ? `/${entry.indexSlug.it}` : `/${locale}/${entry.indexSlug[locale]}`,
    ),
);

/**
 * True for a path inside a canton article section: the section root, its
 * `.html` flat form, or anything below it. Case-insensitive like `parsePath`,
 * prefix-exact so `/articoli-ticino-altro/` is not a section path.
 */
export function isCantonArticlePath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return CANTON_ARTICLE_PREFIXES.some(
    (prefix) => path === prefix || path === `${prefix}.html` || path.startsWith(`${prefix}/`),
  );
}

interface MetaReader {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * True when the document the SPA booted on declares itself corpus-owned
 * (`<meta name="ft-route-owner" content="corpus">`). False outside a browser.
 */
export function documentOwnedByCorpus(doc: MetaReader | undefined = globalThis.document): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  const meta = doc.querySelector(`meta[name="${ROUTE_OWNER_META_NAME}"]`);
  return meta?.getAttribute('content') === ROUTE_OWNER_CORPUS;
}
