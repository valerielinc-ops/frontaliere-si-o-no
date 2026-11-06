/**
 * sitemapTransitWindow — tells «the sitemap is a few minutes behind because the
 * corpus just published» apart from «the sitemap is genuinely incoherent».
 *
 * WHY THIS EXISTS (issue #5298)
 * ─────────────────────────────
 * `tests/blog-slugs-sitemap-sync.test.ts` compares two artifacts that are
 * committed to `main` by DIFFERENT producers, at different moments:
 *
 *   - the slug registry (`packages/articles/content/router{Blog,Swiss}Data.ts`
 *     + `{blog,swiss}-articles-data.ts`), and
 *   - the sitemaps under `public/`.
 *
 * Two commit shapes write them, and neither writes both completely:
 *
 *   `feat(article): …`   adds the article to the registry and (sometimes)
 *                        to `sitemap-news.xml`, but NEVER touches
 *                        `sitemap-blog.xml` / `sitemap-blog-ch.xml`.
 *                        Measured on 208c3aab (2026-08-07T05:35Z): registry +
 *                        bodies + meta, and not one sitemap.
 *
 *   `🗺️ Sync article …`  runs `sync-articles-sitemaps.yml`, which mirrors
 *                        nanako's `content/` over the registry AND pulls the
 *                        published sitemaps over HTTP. The two sources are
 *                        read at different instants, so the commit can be
 *                        internally inconsistent in EITHER direction.
 *                        Measured on 10c8c817 (2026-08-07T07:10Z): it REMOVED
 *                        two just-published articles from routerSwissData.ts
 *                        (+1 −2) while ADDING 242 lines to sitemap-news.xml —
 *                        producing, in one commit, sitemap URLs that no
 *                        SWISS_SLUG resolves to.
 *
 * Between those commits `main` is transiently inconsistent, so the gate went
 * red on every branch with no fault of the PR — and the sign of the error
 * INVERTED over the day at constant code, which is the signature of a race.
 *
 * WHAT THIS IS NOT
 * ────────────────
 * Not a loosening of the gate and not a flaky-marker. The defects it protects
 * against (#3012 slug renamed without regenerating the sitemap, #3116/#3120
 * cross-registry swiss slugs) are real, and they all concern articles that are
 * DAYS to MONTHS old. This module narrows the assertion in exactly one place:
 * the leading edge, where the two producers cannot be in phase.
 *
 * THE CRITERION
 * ─────────────
 * Each side carries its own clock, at the same precision:
 *
 *   - registry:  `date: '2026-08-07T04:42:27.683Z'` in *-articles-data.ts;
 *   - sitemaps:  `<lastmod>` (full ISO for generated articles) and, in
 *                sitemap-news.xml, `<news:publication_date>`.
 *
 * So each side has a FRONTIER: the newest article it knows about. A
 * discrepancy is «in transit» only when the item sits at or beyond the OTHER
 * side's frontier — that is, when the other side demonstrably had not caught
 * up yet. Anything behind that frontier is a real desync and still fails.
 *
 * IN_TRANSIT_WINDOW_MS is the slack on that comparison, and it is needed
 * because arrival order is NOT publication order: the corpus generates
 * articles in parallel, so a later-published article can land in the registry
 * FIRST. Measured on the real inversion that produced the #5298 report:
 * `rimborsi-730-sostituti-imposta` (published 04:42:27Z) was still absent from
 * a registry whose frontier already stood at 05:27:14Z — an inversion of 45
 * minutes. Three hours is four times that, and three orders of magnitude below
 * the age of any genuine desync ever observed (the stale entries in #3116
 * survived days; a renamed slug is older still).
 *
 * MAX_PRODUCER_SKEW_MS is the backstop that keeps the window from becoming an
 * escape hatch. If the sitemap sync dies, the sitemap frontier freezes while
 * the registry keeps advancing, and every new article would sit beyond the
 * frozen frontier — tolerated forever, gate blind. The skew assertion fails
 * before that: 48h is 4x the worst gap observed between two `🗺️ Sync` commits
 * (12.8h, 2026-08-06 10:31Z → 23:20Z) and 4x the interval the cron alone
 * guarantees (`23 5,17 * * *` → 12h), so it can only fire on a sync that has
 * actually stopped.
 */

export type ArticleLocale = 'it' | 'en' | 'de' | 'fr';

/** Slack on the frontier comparison — covers out-of-order corpus arrival. */
export const IN_TRANSIT_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Beyond this lag between the two producers the sync is dead, not late. */
export const MAX_PRODUCER_SKEW_MS = 48 * 60 * 60 * 1000;

export interface SitemapEntry {
  /** The `<loc>` of this `<url>` block, if any. */
  loc?: string;
  /** hreflang → href, from the block's `<xhtml:link>` elements. */
  hreflang: Partial<Record<ArticleLocale, string>>;
  /**
   * The block's own publication clock. `<news:publication_date>` wins over
   * `<lastmod>`: in sitemap-news.xml every `<lastmod>` carries the same
   * build DAY (measured: 23 blocks, one distinct value) and so cannot date an
   * individual entry, while `<news:publication_date>` is per-article and
   * millisecond-precise.
   */
  timestamp?: string;
}

/**
 * Split a sitemap into its `<url>` blocks, keeping each block's URLs together
 * with its own timestamp. The whole-file regexes the gate already uses cannot
 * do this: they flatten every `<loc>` and every hreflang href into two sets,
 * which is enough to answer "is this URL present" but loses the association
 * needed to ask "and how old is the entry that carries it".
 */
export function parseSitemapEntries(xml: string): SitemapEntry[] {
  return xml.split('<url>').slice(1).map((block): SitemapEntry => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    const hreflang: Partial<Record<ArticleLocale, string>> = {};
    for (const m of block.matchAll(/hreflang="(it|en|de|fr)"\s+href="([^"]+)"/g)) {
      hreflang[m[1] as ArticleLocale] = m[2].trim();
    }
    const publicationDate = block.match(/<news:publication_date>([^<]+)</)?.[1]?.trim();
    const lastmod = block.match(/<lastmod>([^<]+)</)?.[1]?.trim();
    return { loc, hreflang, timestamp: publicationDate ?? lastmod };
  });
}

/**
 * Newest parseable instant in `values` — the producer's frontier. Returns
 * undefined when nothing parses, which every caller must treat as "cannot
 * decide", never as "tolerate".
 */
export function frontierOf(values: Iterable<string | undefined>): string | undefined {
  let best: number | undefined;
  let bestRaw: string | undefined;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) continue;
    if (best === undefined || t > best) { best = t; bestRaw = v; }
  }
  return bestRaw;
}

/**
 * True when `itemTimestamp` sits at or beyond `opposingFrontier` (minus the
 * slack) — i.e. the other producer demonstrably had not reached this item yet.
 *
 * FAIL CLOSED: an item with no timestamp, or an opposing side with no
 * frontier, is never in transit. A discrepancy we cannot date is a
 * discrepancy we must report.
 */
export function isInTransit(
  itemTimestamp: string | undefined,
  opposingFrontier: string | undefined,
  windowMs: number = IN_TRANSIT_WINDOW_MS,
): boolean {
  if (!itemTimestamp || !opposingFrontier) return false;
  const item = Date.parse(itemTimestamp);
  const frontier = Date.parse(opposingFrontier);
  if (Number.isNaN(item) || Number.isNaN(frontier)) return false;
  return item > frontier - windowMs;
}

/** Signed lag, in ms, of `behind` relative to `ahead`. NaN when undecidable. */
export function skewMs(ahead: string | undefined, behind: string | undefined): number {
  if (!ahead || !behind) return Number.NaN;
  return Date.parse(ahead) - Date.parse(behind);
}

/** Human-readable hours, for assertion messages. */
export function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

export interface Partition {
  /** Real discrepancies — the gate asserts this is empty. */
  reported: string[];
  /** Excused by the transit window — logged, not asserted. */
  inTransit: string[];
}

/**
 * Registry → sitemap. Every localized slug must have its URL in the sitemap;
 * one published beyond the sitemap's own frontier is still on its way there.
 */
export function partitionMissingSlugs(opts: {
  slugs: Record<string, Record<string, string>>;
  /** article id → publication date, from the section's *-articles-data.ts. */
  dates: ReadonlyMap<string, string>;
  urlBase: Record<string, string>;
  locUrls: ReadonlySet<string>;
  hreflangUrls: ReadonlyMap<string, Set<string>>;
  /** Newest entry of this section in this sitemap. */
  sitemapFrontier: string | undefined;
  /** Article ids dropped from this sitemap on purpose (canonical overrides). */
  skipIds?: ReadonlySet<string>;
  windowMs?: number;
}): Partition {
  const { slugs, dates, urlBase, locUrls, hreflangUrls, sitemapFrontier, skipIds, windowMs } = opts;
  const reported: string[] = [];
  const inTransit: string[] = [];
  for (const [articleId, slugMap] of Object.entries(slugs)) {
    if (skipIds?.has(articleId)) continue;
    for (const [locale, slug] of Object.entries(slugMap)) {
      const base = urlBase[locale];
      if (!base) continue;
      const url = `${base}${slug}/`;
      const present = locale === 'it' ? locUrls.has(url) : hreflangUrls.get(locale)?.has(url);
      if (present) continue;
      const published = dates.get(articleId);
      if (isInTransit(published, sitemapFrontier, windowMs)) {
        inTransit.push(`${articleId} [${locale}]: ${url} (published ${published})`);
      } else {
        reported.push(`${articleId} [${locale}]: ${url} (published ${published ?? 'unknown'})`);
      }
    }
  }
  return { reported, inTransit };
}

/**
 * Sitemap → registry. Every URL must resolve to a current slug; a `<url>`
 * block whose own clock is beyond the registry's frontier describes an article
 * the registry snapshot had not received yet.
 */
export function partitionStaleUrls(opts: {
  entries: readonly SitemapEntry[];
  validSlugs: Record<string, Set<string>>;
  /** locale → regexp capturing the slug out of that locale's hub URL. */
  patterns: Record<string, RegExp>;
  /** Newest publication date in the section's registry. */
  registryFrontier: string | undefined;
  windowMs?: number;
}): Partition {
  const { entries, validSlugs, patterns, registryFrontier, windowMs } = opts;
  const reported: string[] = [];
  const inTransit: string[] = [];
  for (const entry of entries) {
    const candidates: Array<[string, string | undefined, boolean]> = [
      ['it', entry.loc, true],
      ...Object.entries(entry.hreflang).map(
        ([locale, href]) => [locale, href, false] as [string, string | undefined, boolean],
      ),
    ];
    for (const [locale, url, isLoc] of candidates) {
      if (!url) continue;
      const pattern = patterns[locale];
      if (!pattern) continue;
      const match = url.match(pattern);
      if (!match || validSlugs[locale]?.has(match[1])) continue;
      const label = isLoc ? `[${locale}] <loc>: ${url}` : `[${locale}] hreflang href: ${url}`;
      if (isInTransit(entry.timestamp, registryFrontier, windowMs)) {
        inTransit.push(`${label} (published ${entry.timestamp})`);
      } else {
        reported.push(`${label} (published ${entry.timestamp ?? 'unknown'})`);
      }
    }
  }
  return { reported, inTransit };
}
