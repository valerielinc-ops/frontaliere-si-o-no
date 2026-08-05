/**
 * Locale-variant `<loc>` backfill for the seeded sitemaps (issue #5110).
 *
 * The defect
 * ----------
 * `staticPagesPlugin` renders a full EN/DE/FR page for every hreflang
 * alternate declared by the seeded sitemaps (`public/sitemap-pages.xml`,
 * `sitemap-blog.xml`, `sitemap-blog-ch.xml`, `sitemap-glossario.xml`,
 * `sitemap-news.xml`) — translated metadata, translated JSON-LD, and a
 * complete reciprocal hreflang mesh in the HTML `<head>`. Those pages are live
 * and indexable, but **not one of them was ever listed as its own
 * `<url><loc>`** in any sitemap.
 *
 * Google's sitemap-hreflang method requires every alternate URL referenced by
 * an `xhtml:link` annotation to appear as its own `<url><loc>` entry AND to
 * annotate the referring URL back. `sanitizeSitemapHreflangReciprocity`
 * (`build-plugins/sitemapAliasPlugin.ts`, #3474) enforces exactly that rule on
 * the emitted dist copies — correctly. With the alternates unlisted, it had no
 * choice but to strip them: `sitemap-pages.xml` went from 1480 annotations in
 * the committed source to 190 served (measured live, 2026-08-05), and the 38
 * surviving groups were precisely the handful whose locale variants had been
 * added to `public/sitemap-pages.xml` **by hand** (the three locale homepages,
 * #3517, plus eight section hubs). A hand-maintained exception list, not a rule.
 *
 * The fix is upstream of the sanitizer, never in it: list what the build
 * actually emits. Measured across the five seeded sitemaps, that is 12,039
 * distinct locale URLs (12,015 of them listed nowhere), every sampled one of
 * which answers HTTP 200 and carries no `noindex`.
 *
 * The clique rule (why a partial backfill would fix nothing)
 * ---------------------------------------------------------
 * Reciprocity is transitive across a whole hreflang group, not pairwise. For
 * `/en/x/` to keep its annotations, every href in its group must itself be a
 * listed `<loc>` that points back — including `/de/x/` and `/fr/x/`. So listing
 * two variants out of three leaves ALL of them non-reciprocal: the group still
 * names the missing one, the sanitizer still strips the lot, and the only
 * change is two more orphan `<loc>` entries. This module therefore backfills a
 * group **atomically** — every non-IT locale of a source passes the emit gate,
 * or none of that source's variants are emitted at all.
 *
 * Purity
 * ------
 * Everything here is pure (no I/O, no clock) so `tests/sitemap-locale-variant-
 * locs.test.ts` can drive it with the real committed sitemaps and assert the
 * post-sanitizer annotation counts directly.
 */

import { BASE_URL } from '../constants';
import {
  HREFLANG_LOCALES,
  renderSitemapHreflangTags,
  type HreflangLocale,
  type HreflangPaths,
} from './hreflang';
import { SITEMAP_SHARD_CAP, padShardIndex } from '../../scripts/lib/sitemap-limits.mjs';

/**
 * Filename stem of the backfill cohort. Always numbered
 * (`sitemap-locale-variants-001.xml`), even when a single shard suffices, so a
 * later cohort that outgrows one file never renames the URL crawlers already
 * know.
 */
export const LOCALE_VARIANT_SITEMAP_PREFIX = 'sitemap-locale-variants';

/** One `xhtml:link` annotation parsed off a `<url>` block. */
export interface SitemapAnnotation {
  readonly lang: string;
  readonly href: string;
}

/** A `<url>` block from a seeded sitemap, with whatever it declares. */
export interface AnnotatedSitemapUrl {
  readonly loc: string;
  readonly annotations: readonly SitemapAnnotation[];
  readonly lastmod?: string;
  readonly priority?: string;
}

/** A locale-variant page that needs its own `<url>` entry. */
export interface LocaleVariantEntry {
  readonly url: string;
  readonly paths: HreflangPaths;
  readonly lastmod?: string;
  readonly priority?: string;
}

/** Why a candidate variant was not backfilled — surfaced for build logging. */
export type LocaleVariantSkipReason =
  | 'incomplete-group'
  | 'foreign-host'
  | 'missing-trailing-slash'
  | 'already-listed'
  | 'not-emitted'
  | 'conflicting-group';

export interface CollectLocaleVariantsResult {
  readonly entries: readonly LocaleVariantEntry[];
  readonly skipped: ReadonlyMap<LocaleVariantSkipReason, number>;
}

const URL_BLOCK_RX = /<url>[\s\S]*?<\/url>/g;
const LOC_RX = /<loc>\s*([^<]+?)\s*<\/loc>/;
const LASTMOD_RX = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/;
const PRIORITY_RX = /<priority>\s*([^<]+?)\s*<\/priority>/;
const XHTML_LINK_RX = /<xhtml:link\b[^>]*?\/>/g;

/**
 * Parse every `<url>` block of a sitemap document into its `<loc>`, its
 * hreflang annotations and the `<lastmod>`/`<priority>` we want to carry over
 * to the locale variants.
 *
 * Deliberately separate from `staticPagesPlugin`'s own sitemap parse: that one
 * feeds HTML emission and derives fields (normalised paths, SEO-map keys) this
 * one has no use for, while this one needs `<lastmod>` and blocks with zero
 * annotations (they still contribute to the "already listed" set) which that
 * one discards.
 */
export function parseAnnotatedSitemapUrls(xml: string): AnnotatedSitemapUrl[] {
  const out: AnnotatedSitemapUrl[] = [];
  for (const blockMatch of xml.matchAll(URL_BLOCK_RX)) {
    const block = blockMatch[0];
    const loc = block.match(LOC_RX)?.[1];
    if (!loc) continue;
    const annotations: SitemapAnnotation[] = [];
    for (const el of block.matchAll(XHTML_LINK_RX)) {
      const lang = el[0].match(/hreflang="([^"]+)"/)?.[1];
      const href = el[0].match(/href="([^"]+)"/)?.[1];
      if (lang && href) annotations.push({ lang, href });
    }
    out.push({
      loc,
      annotations,
      lastmod: block.match(LASTMOD_RX)?.[1],
      priority: block.match(PRIORITY_RX)?.[1],
    });
  }
  return out;
}

/** Dist-relative path of an absolute site URL, trailing slash stripped. */
function toPathNoSlash(url: string): string {
  const raw = url.slice(BASE_URL.length) || '/';
  return raw === '/' ? '/' : raw.replace(/\/+$/, '');
}

/** Order-independent identity of an hreflang group. */
function signatureOf(paths: HreflangPaths): string {
  return HREFLANG_LOCALES.map((l) => `${l}|${paths[l]}`).join(' ');
}

/**
 * Build the `<url>` entries that make every locale variant of the seeded
 * sitemaps a listed, reciprocal `<loc>`.
 *
 * @param sources  every `<url>` block of every seeded sitemap, parsed.
 * @param isEmitted ground truth for "this build renders HTML for that path",
 *   keyed by dist-relative path WITHOUT a trailing slash. Must be the build's
 *   own emit bookkeeping, never `fs.existsSync`: on a per-locale shard build
 *   (`BUILD_LOCALE`) the collector drops the other locales' writes, so the
 *   files are legitimately absent from this shard's `dist/` while the pages are
 *   very much live in production (served from that locale's own shard repo).
 */
export function collectLocaleVariantEntries(
  sources: readonly AnnotatedSitemapUrl[],
  isEmitted: (pathNoSlash: string) => boolean,
): CollectLocaleVariantsResult {
  const listedLocs = new Set<string>(sources.map((s) => s.loc));
  const skipped = new Map<LocaleVariantSkipReason, number>();
  const note = (reason: LocaleVariantSkipReason, n = 1) =>
    skipped.set(reason, (skipped.get(reason) ?? 0) + n);

  /** url → entry, plus the signature we first accepted for it. */
  const byUrl = new Map<string, LocaleVariantEntry>();
  const conflicted = new Set<string>();

  for (const source of sources) {
    if (source.annotations.length === 0) continue;

    // ── The group must name all four locales, on our own host, each with the
    //    site's mandatory trailing slash. Anything else cannot yield a
    //    reciprocal clique, so it is reported rather than half-emitted.
    const byLang = new Map<string, string>();
    for (const a of source.annotations) byLang.set(a.lang, a.href);

    const paths: Partial<Record<HreflangLocale, string>> = {};
    let usable = true;
    for (const locale of HREFLANG_LOCALES) {
      const href = byLang.get(locale);
      if (!href) {
        usable = false;
        note('incomplete-group');
        break;
      }
      if (href !== BASE_URL && !href.startsWith(`${BASE_URL}/`)) {
        usable = false;
        note('foreign-host');
        break;
      }
      if (!href.endsWith('/')) {
        // The site forces a trailing slash on every URL (`buildPath()` /
        // `joinPath()`, and the `trailing-slash-301` zone rule redirects the
        // slashless form). Listing the slashless variant would either 301 out
        // of the sitemap or, if listed verbatim, publish a non-canonical
        // duplicate. Surface it instead of propagating it.
        usable = false;
        note('missing-trailing-slash');
        break;
      }
      paths[locale] = href;
    }
    if (!usable) continue;
    const completePaths = paths as HreflangPaths;

    // ── Candidate non-IT variants for this source. ──
    const candidates: HreflangLocale[] = [];
    let cliqueComplete = true;
    for (const locale of HREFLANG_LOCALES) {
      if (locale === 'it') continue;
      const href = completePaths[locale];
      if (href === source.loc) continue; // degenerate self-alias, nothing to add
      if (listedLocs.has(href)) {
        // Already owns a <url> block in a seeded sitemap — re-listing it here
        // would be a second, competing entry for the same URL.
        note('already-listed');
        continue;
      }
      if (!isEmitted(toPathNoSlash(href))) {
        note('not-emitted');
        cliqueComplete = false;
        break;
      }
      candidates.push(locale);
    }
    // Atomic: a partially-listed group stays non-reciprocal for every one of
    // its members, so a partial backfill would add orphan <loc> entries and
    // recover no annotations at all. See the clique rule in the file header.
    if (!cliqueComplete) continue;

    const signature = signatureOf(completePaths);
    for (const locale of candidates) {
      const url = completePaths[locale];
      if (conflicted.has(url)) continue;
      const existing = byUrl.get(url);
      if (existing) {
        // Two different IT pages claiming the same locale URL with different
        // groups. Trusting either would let one page's alternates satisfy the
        // other's reciprocity check — the same failure mode the sanitizer's
        // own cross-file collision guard exists to prevent. Drop both.
        if (signatureOf(existing.paths) !== signature) {
          byUrl.delete(url);
          conflicted.add(url);
          note('conflicting-group');
        }
        continue;
      }
      byUrl.set(url, {
        url,
        paths: completePaths,
        lastmod: source.lastmod,
        priority: source.priority,
      });
    }
  }

  // Deterministic output: identical input must produce a byte-identical file
  // across builds, or the content-hash manifest churns every deploy.
  const entries = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  return { entries, skipped };
}

/** Render one `<url>` block, reusing the project-wide hreflang rules. */
function renderEntry(entry: LocaleVariantEntry): string {
  const lines = [
    '  <url>',
    `    <loc>${entry.url}</loc>`,
    // Same 4 locales + x-default, same invariants (absolute, canonical host,
    // x-default byte-identical to the IT href) as every other emitter.
    renderSitemapHreflangTags(entry.paths),
  ];
  // `lastmod` is carried over from the IT source block — a real modification
  // date, never a build-time `new Date()` that would rewrite every entry on
  // every deploy and destroy the signal.
  if (entry.lastmod) lines.push(`    <lastmod>${entry.lastmod}</lastmod>`);
  if (entry.priority) lines.push(`    <priority>${entry.priority}</priority>`);
  lines.push('  </url>');
  return lines.join('\n');
}

export interface RenderedSitemapShard {
  readonly file: string;
  readonly xml: string;
}

/**
 * Render the backfill entries into one or more `<urlset>` documents, capped at
 * {@link SITEMAP_SHARD_CAP} URLs each.
 */
export function renderLocaleVariantSitemaps(
  entries: readonly LocaleVariantEntry[],
): RenderedSitemapShard[] {
  if (entries.length === 0) return [];
  const shards: RenderedSitemapShard[] = [];
  const shardCount = Math.ceil(entries.length / SITEMAP_SHARD_CAP);
  for (let i = 0; i < shardCount; i++) {
    const slice = entries.slice(i * SITEMAP_SHARD_CAP, (i + 1) * SITEMAP_SHARD_CAP);
    shards.push({
      file: `${LOCALE_VARIANT_SITEMAP_PREFIX}-${padShardIndex(i + 1)}.xml`,
      xml:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
        `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
        `${slice.map(renderEntry).join('\n')}\n` +
        `</urlset>\n`,
    });
  }
  return shards;
}

/** True for any filename belonging to the backfill cohort. */
export function isLocaleVariantSitemapFile(file: string): boolean {
  return new RegExp(`^${LOCALE_VARIANT_SITEMAP_PREFIX}-\\d{3,}\\.xml$`).test(file);
}

/**
 * Drop from the backfill cohort any `<url>` whose `<loc>` another sitemap
 * already lists.
 *
 * The backfill is written by `staticPagesPlugin`, whose `closeBundle` runs in
 * parallel with the other SEO plugins' — it cannot see which URLs
 * `sitemap-salary-hub.xml` or `sitemap-jobs-*.xml` will end up claiming. Left
 * alone, a URL listed twice with two different annotation groups trips the
 * sanitizer's cross-file collision guard, which then drops the annotations on
 * BOTH copies (measured: 9 such URLs across the salary-hub and jobs-ticino
 * cohorts). Resolving it here — from `sitemapAliasPlugin`, the one pass that
 * runs after every emitter and already holds every dist sitemap — makes the
 * backfill strictly additive: it yields to any file that claims the URL first.
 *
 * Pure: takes every dist sitemap, returns only the backfill files it changed.
 */
export function pruneAlreadyListedLocaleVariants(
  files: readonly { readonly file: string; readonly xml: string }[],
): Map<string, string> {
  const ownedElsewhere = new Set<string>();
  for (const { file, xml } of files) {
    if (isLocaleVariantSitemapFile(file)) continue;
    for (const blockMatch of xml.matchAll(URL_BLOCK_RX)) {
      const loc = blockMatch[0].match(LOC_RX)?.[1];
      if (loc) ownedElsewhere.add(loc);
    }
  }
  if (ownedElsewhere.size === 0) return new Map();

  const out = new Map<string, string>();
  for (const { file, xml } of files) {
    if (!isLocaleVariantSitemapFile(file)) continue;
    const next = xml.replace(/[ \t]*<url>[\s\S]*?<\/url>\n?/g, (block) => {
      const loc = block.match(LOC_RX)?.[1];
      return loc && ownedElsewhere.has(loc) ? '' : block;
    });
    if (next !== xml) out.set(file, next);
  }
  return out;
}
