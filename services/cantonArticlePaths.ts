/**
 * Canton article section paths (piano «sezioni articoli per cantone», S2).
 *
 * The 24 canton sections × 4 locales are served by the CORPUS: prerendered
 * HTML on R2, answered by the Worker (`serveCorpusSection` in
 * infra/cloudflare-worker/locale-router.js). Landing, archive and article
 * paths are also recognized by the SPA; the corpus still owns the initial
 * HTML and the live/inactive decision.
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

const ARCHIVE_ALL_SLUG: Record<(typeof LOCALES)[number], string> = {
  it: 'tutti',
  en: 'all',
  de: 'alle',
  fr: 'tous',
};

export type CantonArticlePathKind = 'landing' | 'archive' | 'article' | 'topic';

export interface CantonArticlePathMatch {
  section: `canton-${string}`;
  locale: (typeof LOCALES)[number];
  kind: CantonArticlePathKind;
  /** Article slug, or the topic-hub path tail when kind === 'topic'. */
  slug?: string;
  /** One-based page number for `/tutti/page-N/`; page 1 is omitted. */
  page?: number;
}

/** Parse a canton section path against the closed generated section core. */
export function parseCantonArticlePath(pathname: string): CantonArticlePathMatch | null {
  const clean = pathname.split(/[?#]/, 1)[0].replace(/\.html$/, '').replace(/\/$/, '').toLowerCase();
  const parts = clean.split('/').filter(Boolean);
  let locale: (typeof LOCALES)[number] = 'it';
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') {
    locale = parts.shift() as (typeof LOCALES)[number];
  }
  const indexSlug = parts.shift();
  if (!indexSlug) return null;
  const entry = Object.values(CANTON_ARTICLE_SECTION_CORE).find((candidate) => candidate.indexSlug[locale] === indexSlug);
  if (!entry) return null;
  const section = entry.section as `canton-${string}`;
  if (parts.length === 0) return { section, locale, kind: 'landing' };

  const first = parts[0];
  if (first === ARCHIVE_ALL_SLUG[locale]) {
    if (parts.length === 1) return { section, locale, kind: 'archive' };
    const pageMatch = /^(?:page|pagina|seite)-(\d+)$/.exec(parts[1]);
    if (pageMatch && parts.length === 2) {
      const page = Number(pageMatch[1]);
      if (Number.isInteger(page) && page > 0) {
        return { section, locale, kind: 'archive', ...(page > 1 ? { page } : {}) };
      }
    }
    return null;
  }

  // Topic hubs remain corpus-owned static overlays in this site PR.
  if (entry.topicHubs && Object.values(entry.topicHubs).some((byLocale) => byLocale[locale] === first)) {
    return { section, locale, kind: 'topic', slug: parts.join('/') };
  }
  if (parts.length === 1 && first) return { section, locale, kind: 'article', slug: first };
  return null;
}

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
