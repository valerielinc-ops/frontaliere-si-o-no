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
 * Two families share that vocabulary, and they are kept in two separate sets
 * on purpose — see {@link buildTopicIndexPath}: the 112 topic HUBS, and the 8
 * bare topic INDEXES one level above them (issue #5436).
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
 * Minimum articles for an indexable topic hub. Moved into the engine's
 * `topicTaxonomy.ts` (#5414) so the archive pages' "Argomenti" nav — engine
 * code, forbidden from importing `build-plugins/**` by the confinement test —
 * filters on the SAME floor this plugin renders bridges under. Re-exported
 * here so every existing importer keeps resolving unchanged.
 */
export { TOPIC_HUB_MIN_ARTICLES } from '../packages/articles/engine/topicTaxonomy';

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

/**
 * The section's own sitemap file, one per section rather than one shared
 * `sitemap-topics.xml` for both.
 *
 * The split is not cosmetic: it is what makes «announce what someone actually
 * wrote» expressible. Each section's hub pages are written by ONE producer in
 * ONE run — the full build when that section is emitted, the fast publish
 * (`renderTopicClusterHubPages`) otherwise — and that run is the only actor
 * that knows which URLs it wrote. A single shared file would have to be
 * rewritten by a producer that renders one section and can only GUESS at the
 * other's current page count; guessing is exactly what put 36 phantom
 * `page-N` URLs in the live `sitemap-topics.xml` (measured 2026-08-07: the
 * apex file came from a full build, the pages from a fast publish, two corpus
 * snapshots apart — `accordi-e-politica` announced 16 pages against 9 written,
 * `pensioni-avs-lpp` wrote 11 against 4 announced).
 *
 * With one file per section each producer overwrites only its own claim, and
 * a section nobody has produced simply has no file — which is the honest
 * shape of "nothing to announce" (#5290).
 */
export function topicSitemapFileName(section: TopicHubSection): string {
  return `sitemap-topics-${section}.xml`;
}

/** Apex pathname of {@link topicSitemapFileName} — the EDGE_PUSHED_FILES key. */
export function topicSitemapPathname(section: TopicHubSection): string {
  return `/${topicSitemapFileName(section)}`;
}

/**
 * The section's bare topic-index path — `/{section}/{argomenti|topics|themen|
 * sujets}/`, the level ABOVE every topic hub (issue #5436).
 *
 * It exists because the level below it does. Both archives link 14 topic hubs
 * each, every child answered 200 and this parent answered 404 on both sections
 * and on the served shard origin: a three-level URL path with a hole in the
 * middle, which for a crawler is a different signal from "this level does not
 * exist" and for a reader shortening the URL by hand is a dead end.
 *
 * DELIBERATELY NOT IN {@link TOPIC_HUB_CANONICAL_PATHS}. That set is the hub
 * family, and {@link isTopicClusterHubPath} answers "is this a topic hub" —
 * `tests/topic-cluster-hubs.test.ts` pins this very path as `false` there.
 * Folding the index in would make `resolveTopicClusterHubCanonical` claim a
 * hub canonical for a page that is not a hub, and would silently widen the
 * 112-path assertion that guards the URL space. Two families, two sets, one
 * shared vocabulary.
 */
export function buildTopicIndexPath(locale: TopicHubLocale, section: TopicHubSection): string {
  return `${LOCALE_PREFIX[locale]}/${sectionIndexSlug(section, locale)}/${TOPIC_HUB_SEGMENT[locale]}/`;
}

/** The 8 bare topic-index paths (2 sections × 4 locales). Built once, like the hubs'. */
export const TOPIC_INDEX_CANONICAL_PATHS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const locale of TOPIC_HUB_LOCALES) {
    for (const section of TOPIC_HUB_SECTIONS) {
      set.add(buildTopicIndexPath(locale, section));
    }
  }
  return set;
})();

/** Topic-index path → its section. Built with the paths, same as the hubs' map. */
const SECTION_BY_INDEX_PATH: ReadonlyMap<string, TopicHubSection> = (() => {
  const map = new Map<string, TopicHubSection>();
  for (const locale of TOPIC_HUB_LOCALES) {
    for (const section of TOPIC_HUB_SECTIONS) {
      map.set(buildTopicIndexPath(locale, section), section);
    }
  }
  return map;
})();

/**
 * Is this the bare topic-index of a section? O(1) against a module-load Set,
 * the constraint every helper in this file works under (the router bundles it
 * into the SPA and `tests/search-console-compat.test.ts` calls it over 150k+
 * paths).
 *
 * No pagination stripping, unlike {@link isTopicClusterHubPath}: the index
 * lists the taxonomy, which is curated and fixed at 14 entries, so it has one
 * page and never had another. `/…/argomenti/page-2/` has never been live and
 * must keep resolving as what it is — an unknown URL — rather than being
 * folded onto a page that would then have to explain it.
 */
export function isTopicIndexPath(pathname: string): boolean {
  return TOPIC_INDEX_CANONICAL_PATHS.has(ensureTrailingSlash(pathname));
}

/** Which article section a topic-index URL belongs to, or `null` if it is not one. */
export function resolveTopicIndexSection(pathname: string): TopicHubSection | null {
  return SECTION_BY_INDEX_PATH.get(ensureTrailingSlash(pathname)) ?? null;
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
