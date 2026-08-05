/**
 * Regression tests for the locale-variant `<loc>` backfill (issue #5110).
 *
 * The bug: `staticPagesPlugin` renders a full EN/DE/FR page for every hreflang
 * alternate the seeded sitemaps declare, but never listed one of them as its
 * own `<url><loc>`. Google's sitemap-hreflang method ignores an annotation
 * whose target is not a listed, back-annotating `<loc>`, so
 * `sanitizeSitemapHreflangReciprocity` (correctly) stripped them: measured on
 * the live site 2026-08-05, `sitemap-pages.xml` served 190 of the 1480
 * alternates its committed source carries, and ~12k live, indexable locale
 * pages appeared in no sitemap at all.
 *
 * The invariant these tests pin is end-to-end and file-driven, not a unit
 * mock: take the REAL committed `public/sitemap-*.xml`, run the real backfill,
 * feed the result to the REAL sanitizer, and assert it finds nothing left to
 * strip. Without the backfill the same assertion fails on every seeded file.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAnnotatedSitemapUrls,
  collectLocaleVariantEntries,
  renderLocaleVariantSitemaps,
  pruneAlreadyListedLocaleVariants,
  isLocaleVariantSitemapFile,
  LOCALE_VARIANT_SITEMAP_PREFIX,
  type AnnotatedSitemapUrl,
} from '../build-plugins/shared/localeVariantSitemap';
import {
  sanitizeSitemapHreflangReciprocity,
  type SitemapXmlFile,
} from '../build-plugins/sitemapAliasPlugin';
import { SITEMAP_SHARD_CAP } from '../scripts/lib/sitemap-limits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://frontaliereticino.ch';

/** The sitemaps committed under public/ whose annotations name locale pages. */
const SEEDED_SITEMAPS = [
  'sitemap-pages.xml',
  'sitemap-blog.xml',
  'sitemap-glossario.xml',
  'sitemap-blog-ch.xml',
  'sitemap-news.xml',
];

const readSeeded = (file: string): string =>
  fs.readFileSync(path.join(ROOT, 'public', file), 'utf-8');

const countAnnotations = (xml: string) => [...xml.matchAll(/<xhtml:link\b/g)].length;
const countLocs = (xml: string) => [...xml.matchAll(/<loc>/g)].length;

/** Build a source group the way a seeded sitemap declares one. */
const source = (
  loc: string,
  paths: { it: string; en: string; de: string; fr: string },
  extra: Partial<AnnotatedSitemapUrl> = {},
): AnnotatedSitemapUrl => ({
  loc,
  annotations: [
    { lang: 'it', href: paths.it },
    { lang: 'en', href: paths.en },
    { lang: 'de', href: paths.de },
    { lang: 'fr', href: paths.fr },
    { lang: 'x-default', href: paths.it },
  ],
  ...extra,
});

const GROUP = {
  it: `${BASE}/calcola-stipendio/`,
  en: `${BASE}/en/calculate-salary/`,
  de: `${BASE}/de/gehalt-berechnen/`,
  fr: `${BASE}/fr/calculer-salaire/`,
};

describe('collectLocaleVariantEntries — fixtures', () => {
  it('backfills every non-IT variant of an emitted group, each with the full 4-locale + x-default set', () => {
    const { entries } = collectLocaleVariantEntries([source(GROUP.it, GROUP)], () => true);
    expect(entries.map((e) => e.url)).toEqual([GROUP.de, GROUP.en, GROUP.fr]);
    for (const entry of entries) {
      expect(entry.paths).toEqual(GROUP);
    }
  });

  it('never re-lists the IT canonical itself (it already owns a <url> block)', () => {
    const { entries } = collectLocaleVariantEntries([source(GROUP.it, GROUP)], () => true);
    expect(entries.map((e) => e.url)).not.toContain(GROUP.it);
  });

  it('emits a group ATOMICALLY — one unrendered locale suppresses the whole clique', () => {
    // Reciprocity is transitive across the group: if /fr/ is never emitted,
    // /en/ and /de/ still name it, so all three stay non-reciprocal. Listing
    // two of the three would add orphan <loc> entries and recover nothing.
    const { entries, skipped } = collectLocaleVariantEntries(
      [source(GROUP.it, GROUP)],
      (p) => p !== '/fr/calculer-salaire',
    );
    expect(entries).toEqual([]);
    expect(skipped.get('not-emitted')).toBe(1);
  });

  it('skips a locale URL that already owns a <url> block in a seeded sitemap', () => {
    const sources = [
      source(GROUP.it, GROUP),
      // The locale homepage pattern (#3517): /en/ listed as its own entry.
      source(GROUP.en, GROUP),
    ];
    const { entries, skipped } = collectLocaleVariantEntries(sources, () => true);
    expect(entries.map((e) => e.url)).toEqual([GROUP.de, GROUP.fr]);
    expect(skipped.get('already-listed')).toBeGreaterThan(0);
  });

  it('refuses an alternate without the mandatory trailing slash instead of publishing a 301 URL', () => {
    const slashless = { ...GROUP, en: `${BASE}/en/calculate-salary` };
    const { entries, skipped } = collectLocaleVariantEntries(
      [source(GROUP.it, slashless)],
      () => true,
    );
    expect(entries).toEqual([]);
    expect(skipped.get('missing-trailing-slash')).toBe(1);
  });

  it('drops a locale URL claimed by two different groups rather than trusting either', () => {
    const other = {
      it: `${BASE}/altro/`,
      en: GROUP.en, // same EN URL, different group
      de: `${BASE}/de/anderes/`,
      fr: `${BASE}/fr/autre/`,
    };
    const { entries, skipped } = collectLocaleVariantEntries(
      [source(GROUP.it, GROUP), source(other.it, other)],
      () => true,
    );
    expect(entries.map((e) => e.url)).not.toContain(GROUP.en);
    expect(skipped.get('conflicting-group')).toBe(1);
    // The non-conflicting members of both groups still land.
    expect(entries.map((e) => e.url)).toContain(GROUP.de);
    expect(entries.map((e) => e.url)).toContain(other.de);
  });

  it('ignores an incomplete group (fewer than 4 locales)', () => {
    const { entries, skipped } = collectLocaleVariantEntries(
      [{ loc: GROUP.it, annotations: [{ lang: 'it', href: GROUP.it }, { lang: 'en', href: GROUP.en }] }],
      () => true,
    );
    expect(entries).toEqual([]);
    expect(skipped.get('incomplete-group')).toBe(1);
  });

  it('is deterministic — same input, byte-identical output', () => {
    const run = () =>
      renderLocaleVariantSitemaps(
        collectLocaleVariantEntries([source(GROUP.it, GROUP)], () => true).entries,
      );
    expect(run()).toEqual(run());
  });

  it('carries the source lastmod through and never invents a build-time date', () => {
    const { entries } = collectLocaleVariantEntries(
      [source(GROUP.it, GROUP, { lastmod: '2019-01-02', priority: '0.8' })],
      () => true,
    );
    const [xml] = renderLocaleVariantSitemaps(entries).map((s) => s.xml);
    expect(xml).toContain('<lastmod>2019-01-02</lastmod>');
    expect(xml).toContain('<priority>0.8</priority>');
    // No second, build-time date snuck in alongside it.
    expect([...xml.matchAll(/<lastmod>/g)]).toHaveLength(entries.length);
  });

  it('omits lastmod entirely when the source has none', () => {
    const { entries } = collectLocaleVariantEntries([source(GROUP.it, GROUP)], () => true);
    const [xml] = renderLocaleVariantSitemaps(entries).map((s) => s.xml);
    expect(xml).not.toContain('<lastmod>');
  });
});

describe('renderLocaleVariantSitemaps — sharding', () => {
  it('emits a single, already-numbered shard below the cap', () => {
    const shards = renderLocaleVariantSitemaps(
      collectLocaleVariantEntries([source(GROUP.it, GROUP)], () => true).entries,
    );
    expect(shards).toHaveLength(1);
    expect(shards[0].file).toBe(`${LOCALE_VARIANT_SITEMAP_PREFIX}-001.xml`);
    expect(isLocaleVariantSitemapFile(shards[0].file)).toBe(true);
  });

  it('splits at the shared cap so no file can breach the sitemaps.org 50k limit', () => {
    const many = Array.from({ length: SITEMAP_SHARD_CAP + 1 }, (_, i) => ({
      url: `${BASE}/en/p-${i}/`,
      paths: {
        it: `${BASE}/p-${i}/`,
        en: `${BASE}/en/p-${i}/`,
        de: `${BASE}/de/p-${i}/`,
        fr: `${BASE}/fr/p-${i}/`,
      },
    }));
    const shards = renderLocaleVariantSitemaps(many);
    expect(shards).toHaveLength(2);
    expect(shards.map((s) => s.file)).toEqual([
      `${LOCALE_VARIANT_SITEMAP_PREFIX}-001.xml`,
      `${LOCALE_VARIANT_SITEMAP_PREFIX}-002.xml`,
    ]);
    expect(countLocs(shards[0].xml)).toBe(SITEMAP_SHARD_CAP);
    expect(countLocs(shards[1].xml)).toBe(1);
  });

  it('emits nothing at all when there is nothing to backfill', () => {
    expect(renderLocaleVariantSitemaps([])).toEqual([]);
  });
});

describe('pruneAlreadyListedLocaleVariants', () => {
  const backfill = renderLocaleVariantSitemaps(
    collectLocaleVariantEntries([source(GROUP.it, GROUP)], () => true).entries,
  )[0];

  it('yields a URL another sitemap already claims', () => {
    const other: SitemapXmlFile = {
      file: 'sitemap-salary-hub.xml',
      xml: `<urlset>\n  <url>\n    <loc>${GROUP.en}</loc>\n  </url>\n</urlset>\n`,
    };
    const out = pruneAlreadyListedLocaleVariants([other, backfill]);
    const pruned = out.get(backfill.file)!;
    expect(pruned).not.toContain(`<loc>${GROUP.en}</loc>`);
    expect(pruned).toContain(`<loc>${GROUP.de}</loc>`);
    expect(pruned).toContain(`<loc>${GROUP.fr}</loc>`);
  });

  it('leaves the cohort untouched when nothing else claims its URLs', () => {
    const other: SitemapXmlFile = {
      file: 'sitemap-salary-hub.xml',
      xml: `<urlset>\n  <url>\n    <loc>${BASE}/unrelated/</loc>\n  </url>\n</urlset>\n`,
    };
    expect(pruneAlreadyListedLocaleVariants([other, backfill]).size).toBe(0);
  });

  it('does not treat one backfill shard as an owner of another shard s URLs', () => {
    const twin: SitemapXmlFile = { file: `${LOCALE_VARIANT_SITEMAP_PREFIX}-002.xml`, xml: backfill.xml };
    expect(pruneAlreadyListedLocaleVariants([backfill, twin]).size).toBe(0);
  });
});

describe('committed sitemaps — the #5110 invariant, end to end', () => {
  const seeded: SitemapXmlFile[] = SEEDED_SITEMAPS.map((file) => ({ file, xml: readSeeded(file) }));
  const sources = seeded.flatMap((f) => parseAnnotatedSitemapUrls(f.xml));

  it('every alternate in every committed sitemap carries the mandatory trailing slash', () => {
    // The site forces a trailing slash on every URL. A slashless alternate
    // would 301 out of the sitemap and could never match a listed <loc>.
    const slashless: string[] = [];
    for (const s of sources) {
      for (const a of s.annotations) if (!a.href.endsWith('/')) slashless.push(a.href);
    }
    expect(slashless).toEqual([]);
  });

  it('WITHOUT the backfill the sanitizer strips sitemap-pages.xml — the reported defect', () => {
    const stripped = sanitizeSitemapHreflangReciprocity(seeded);
    const pages = stripped.get('sitemap-pages.xml');
    expect(pages, 'sitemap-pages.xml should be rewritten when the alternates are unlisted').toBeDefined();
    const before = countAnnotations(readSeeded('sitemap-pages.xml'));
    expect(countAnnotations(pages!)).toBeLessThan(before);
    // <loc> entries are never added or removed by the sanitizer.
    expect(countLocs(pages!)).toBe(countLocs(readSeeded('sitemap-pages.xml')));
  });

  it('WITH the backfill every SELF-REFERENTIAL group survives in every seeded sitemap', () => {
    // The rule, not a magic number: Google requires a page's hreflang set to
    // include the page itself. A group whose `<loc>` is absent from its own
    // hrefs can never be reciprocal — stripping it is the sanitizer being
    // right. Every group that DOES name itself must now survive intact.
    const { entries } = collectLocaleVariantEntries(sources, () => true);
    expect(entries.length).toBeGreaterThan(10_000);

    const stripped = sanitizeSitemapHreflangReciprocity([
      ...seeded,
      ...renderLocaleVariantSitemaps(entries),
    ]);
    const blocksOf = (xml: string) => [...xml.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]);
    const locOf = (block: string) => block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1] ?? '';
    const hrefsOf = (block: string) =>
      [...block.matchAll(/<xhtml:link\b[^>]*?href="([^"]+)"[^>]*?\/>/g)].map((m) => m[1]);

    const casualties: string[] = [];
    for (const { file, xml } of seeded) {
      const after = stripped.get(file);
      if (!after) continue; // untouched → nothing lost
      const before = blocksOf(xml);
      const now = blocksOf(after);
      expect(now).toHaveLength(before.length); // <loc> entries never added/removed
      for (let i = 0; i < before.length; i++) {
        const lost = hrefsOf(before[i]).length - hrefsOf(now[i]).length;
        if (lost === 0) continue;
        const loc = locOf(before[i]);
        // Only a group that fails to name itself may lose annotations.
        expect(
          hrefsOf(before[i]).includes(loc),
          `${file}: self-referential group for ${loc} lost ${lost} annotation(s)`,
        ).toBe(false);
        casualties.push(loc);
      }
    }

    // The residue is the known duplicate-IT-alias set: /about/, /contact/ and
    // /privacy-policy/ are self-canonical 200 pages whose hreflang "it" points
    // at a DIFFERENT IT URL (/chi-siamo/, /contattaci/, /privacy/). That is a
    // canonicalisation defect on those three aliases, not an hreflang-listing
    // one — tracked separately. Asserted as a ceiling so fixing them (or
    // adding another alias) surfaces here instead of drifting unnoticed.
    expect(casualties.length).toBeLessThanOrEqual(3);
  });

  it('recovers the alternates the defect removed from sitemap-pages.xml', () => {
    const { entries } = collectLocaleVariantEntries(sources, () => true);
    const before = countAnnotations(readSeeded('sitemap-pages.xml'));
    expect(before).toBe(1480);

    const withoutBackfill = sanitizeSitemapHreflangReciprocity(seeded);
    const withBackfill = sanitizeSitemapHreflangReciprocity([
      ...seeded,
      ...renderLocaleVariantSitemaps(entries),
    ]);

    const after = (m: Map<string, string>) => {
      const x = m.get('sitemap-pages.xml');
      return x === undefined ? before : countAnnotations(x);
    };
    // Only the 15 annotations of the three non-self-referential aliases stay
    // stripped; everything the defect took comes back.
    expect(after(withBackfill)).toBeGreaterThanOrEqual(1465);
    expect(after(withBackfill)).toBeGreaterThan(after(withoutBackfill));
  });

  it('WITH the backfill the backfilled entries survive the sanitizer too', () => {
    const { entries } = collectLocaleVariantEntries(sources, () => true);
    const shards = renderLocaleVariantSitemaps(entries);
    const stripped = sanitizeSitemapHreflangReciprocity([...seeded, ...shards]);
    for (const shard of shards) {
      const after = stripped.get(shard.file);
      expect(
        after === undefined || countAnnotations(after) === countAnnotations(shard.xml),
        `${shard.file} lost annotations`,
      ).toBe(true);
    }
  });

  it('backfills the locale variants of every seeded sitemap, not just sitemap-pages.xml', () => {
    const { entries } = collectLocaleVariantEntries(sources, () => true);
    const urls = new Set(entries.map((e) => e.url));
    // One representative locale URL per seeded family, each verified live
    // (HTTP 200, indexable) while listed in no sitemap before this fix.
    expect(urls.has(`${BASE}/en/calculate-salary/`)).toBe(true); // sitemap-pages
    expect([...urls].some((u) => u.startsWith(`${BASE}/en/cross-border-articles/`))).toBe(true); // blog
    expect([...urls].some((u) => u.startsWith(`${BASE}/de/grenzgaenger-glossar/`))).toBe(true); // glossario
    expect([...urls].some((u) => u.startsWith(`${BASE}/fr/articles-suisse/`))).toBe(true); // blog-ch / news
  });

  it('adds only locale-prefixed URLs — never a second entry for an IT canonical', () => {
    const { entries } = collectLocaleVariantEntries(sources, () => true);
    const seededLocs = new Set(sources.map((s) => s.loc));
    for (const e of entries) {
      expect(seededLocs.has(e.url), `${e.url} is already a seeded <loc>`).toBe(false);
      expect(e.url.startsWith(`${BASE}/en/`) || e.url.startsWith(`${BASE}/de/`) || e.url.startsWith(`${BASE}/fr/`)).toBe(true);
      expect(e.url.endsWith('/')).toBe(true);
    }
  });

  it('gates on the emit predicate — an unrendered corpus backfills nothing', () => {
    const { entries } = collectLocaleVariantEntries(sources, () => false);
    expect(entries).toEqual([]);
  });
});
