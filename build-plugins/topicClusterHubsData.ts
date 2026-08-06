/**
 * Paths and path-recognition for the article topic hubs (issue #5001).
 *
 * Split out from the emitting plugin because three very different consumers
 * need the same URL vocabulary and only one of them may touch the filesystem:
 *
 *   - `build-plugins/topicClusterHubsPlugin.ts` — writes the pages;
 *   - `services/router.ts` — must return `staticOverlay: true` for these
 *     paths or React hydration replaces the static hub with the generic
 *     "Pagina non trovata" view (the failure the CHF/EUR branch documents);
 *   - `build-plugins/searchConsoleCompat.ts` — self-maps them, per
 *     AGENTS.md § Static SEO Pages.
 *
 * The last two are bundled into the SPA / run over 150k paths in tests, so
 * this module imports nothing but pure data — no `node:fs`, no plugin code.
 *
 * The URL space is FIXED (2 sections × 4 locales × the curated taxonomy = 112
 * canonical paths) because the taxonomy is curated rather than derived. That
 * is what lets {@link TOPIC_HUB_CANONICAL_PATHS} be a `Set` computed once at
 * module load instead of a per-call rebuild — the constraint
 * `tests/search-console-compat.test.ts` puts on every self-map — and it is
 * also why every one of these URLs resolves on every build: a topic that
 * falls under the article floor emits a `noindex,follow` bridge at the same
 * path rather than disappearing.
 */

import {
  TOPIC_CLUSTERS,
  TOPIC_HUB_SEGMENT,
  TOPIC_LOCALES,
  type TopicLocale,
} from '../packages/articles/engine/topicTaxonomy';
import { ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/articleSectionCore.mjs';

export type TopicHubLocale = TopicLocale;
export type TopicHubSection = 'frontaliere' | 'svizzera';

export const TOPIC_HUB_LOCALES = TOPIC_LOCALES;
export const TOPIC_HUB_SECTIONS: readonly TopicHubSection[] = ['frontaliere', 'svizzera'];

/**
 * Articles listed per hub page. Matches the section archive's own page size so
 * a reader paging through a topic sees the same rhythm as the full archive.
 */
export const TOPIC_HUB_PAGE_SIZE = 24;

/**
 * Minimum articles for a topic hub to be indexable in a given (section,
 * locale). Below it the page is still emitted — as a `noindex,follow` bridge —
 * so the URL never 404s, but it does not enter the sitemap.
 *
 * 8 is the same floor the cluster measurement used: it is the point below
 * which a hub is a list too short to be worth a crawl of its own, while still
 * being low enough that real but small topics (energy/fuel on the svizzera
 * section: 8 articles) keep a live hub.
 */
export const TOPIC_HUB_MIN_ARTICLES = 8;

const LOCALE_PREFIX: Record<TopicHubLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

function sectionIndexSlug(section: TopicHubSection, locale: TopicHubLocale): string {
  return (ARTICLE_SECTION_CORE as Record<string, { indexSlug: Record<string, string> }>)[section]
    .indexSlug[locale];
}

/** Canonical path of a topic hub. `page` 1 is the bare path, as elsewhere on the site. */
export function buildTopicHubPath(
  locale: TopicHubLocale,
  section: TopicHubSection,
  topicKey: string,
  page = 1,
): string {
  const topic = TOPIC_CLUSTERS.find((t) => t.key === topicKey);
  if (!topic) throw new Error(`[topic-hubs] unknown topic key: ${topicKey}`);
  const base = `${LOCALE_PREFIX[locale]}/${sectionIndexSlug(section, locale)}/${TOPIC_HUB_SEGMENT[locale]}/${topic.slug[locale]}/`;
  return page <= 1 ? base : `${base.slice(0, -1)}/page-${page}/`;
}

/** Every canonical (page-1) topic-hub path. Built once — see the module header. */
export const TOPIC_HUB_CANONICAL_PATHS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const locale of TOPIC_HUB_LOCALES) {
    for (const section of TOPIC_HUB_SECTIONS) {
      for (const topic of TOPIC_CLUSTERS) {
        set.add(buildTopicHubPath(locale, section, topic.key));
      }
    }
  }
  return set;
})();

/** Canonical path → which article section it belongs to. Built with the paths. */
const SECTION_BY_CANONICAL_PATH: ReadonlyMap<string, TopicHubSection> = (() => {
  const map = new Map<string, TopicHubSection>();
  for (const locale of TOPIC_HUB_LOCALES) {
    for (const section of TOPIC_HUB_SECTIONS) {
      for (const topic of TOPIC_CLUSTERS) {
        map.set(buildTopicHubPath(locale, section, topic.key), section);
      }
    }
  }
  return map;
})();

/** `/…/page-7/` → `/…/`; anything else unchanged. */
function stripPagination(pathname: string): string {
  return pathname.replace(/page-\d+\/$/, '');
}

function ensureTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

/**
 * Is this a topic-hub URL (any page)? Used by the router for `staticOverlay`
 * and by searchConsoleCompat for the family self-map.
 *
 * Pagination is accepted for ANY page number, not only the ones emitted this
 * build: the article count of a topic moves as the corpus grows, so
 * `/…/page-9/` may have been live and indexed when the topic was larger. Such
 * a URL resolves to the hub's page 1, which always exists — the same recovery
 * shape the profession/canton family uses.
 */
export function isTopicClusterHubPath(pathname: string): boolean {
  const normalized = stripPagination(ensureTrailingSlash(pathname));
  return TOPIC_HUB_CANONICAL_PATHS.has(normalized);
}

/**
 * Canonical (page-1) path for any topic-hub URL, or `null` when it is not one.
 * A paginated URL maps to page 1 rather than to itself: that is the page
 * guaranteed to exist for every topic on every build.
 */
export function resolveTopicClusterHubCanonical(pathname: string): string | null {
  const withSlash = ensureTrailingSlash(pathname);
  const normalized = stripPagination(withSlash);
  return TOPIC_HUB_CANONICAL_PATHS.has(normalized) ? normalized : null;
}

/** Which article section a topic-hub URL belongs to, or `null` if it is not one. */
export function resolveTopicClusterHubSection(pathname: string): TopicHubSection | null {
  const normalized = stripPagination(ensureTrailingSlash(pathname));
  return SECTION_BY_CANONICAL_PATH.get(normalized) ?? null;
}
