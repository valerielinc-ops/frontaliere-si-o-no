/**
 * Regression test for issue #3499: jobsSeoPagesPlugin.ts (build-plugins/jobsSeoPagesPlugin.ts)
 * pushed a sitemap `<url>` entry into `sitemap-jobs.xml` / `sitemap-jobs-expired.xml`
 * for the `it` locale ONLY, in 11 separate arrays (company hub, per-canton company hub,
 * per-canton company x city hub, per-canton + TI-legacy sector hub, per-canton + TI-legacy
 * category hub x2, keyword landing, search leader, editorial, city hub, pagination, expired
 * soft-landing) — even though EN/DE/FR HTML for the same pages is genuinely built and live
 * (write loop confirmed for each array at its own site in jobsSeoPagesPlugin.ts). That left
 * every EN/DE/FR alternate one-sided: referenced via `xhtml:link` but never listed as its own
 * `<loc>`, so `sanitizeSitemapHreflangReciprocity` (build-plugins/sitemapAliasPlugin.ts, #3474)
 * stripped the alternates from dist/ with no `public/` compensation — exactly what #3499 named.
 *
 * jobsSeoPagesPlugin.ts is a multi-thousand-line Vite plugin whose 11 arrays are gated on
 * canton/company/category job-count thresholds — fixturing a full `data/jobs.json` +
 * `closeBundle()` run to reach every array (as tests/jobs-sitemap-filters.test.ts's own docblock
 * notes for this same file) is high-risk/low-value versus exercising the real, already-pure
 * `sanitizeSitemapHreflangReciprocity` against XML shaped exactly like each array's current
 * (fixed) template. That proves two things per array: (1) the fixed shape — one `<url>` per
 * locale, sharing one IT-anchored `alternateLinks`/`xDefault` block — survives the sanitizer
 * fully intact; (2) the pre-fix shape — a lone IT `<url>` whose alternates point at non-existent
 * en/de/fr `<loc>` entries — loses its OWN alternates too (not just the missing entries), which
 * is the concrete mechanism behind "exit the IndexNow batch".
 *
 * Paths mirror the real per-array templates (line refs as of this fix; verified against
 * build-plugins/jobsSeoPagesPlugin.ts, build-plugins/shared/cantonSection.ts,
 * build-plugins/shared/cantonResolvers.mjs, data/canton-url-slugs.json). A couple of the
 * less-critical arrays (editorial/city-hub/pagination) use representative-shaped paths rather
 * than byte-verified production slugs — irrelevant to sanitizer correctness, which only cares
 * that hrefs/locs line up self-consistently within a group.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSitemapHreflangReciprocity } from '../../build-plugins/sitemapAliasPlugin';

const BASE_URL = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];
type LocalePaths = Record<Locale, string>;

/** Mirrors the shared per-group template used by every fixed array (e.g. jobsSeoPagesPlugin.ts:8819+). */
function buildFixedGroupBlocks(paths: LocalePaths): string[] {
  const alternateLinks = LOCALES.map(
    (l) => `  <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${paths[l]}" />`,
  ).join('\n');
  const xDefault = `  <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${paths.it}" />`;
  return LOCALES.map(
    (l) =>
      `<url>\n  <loc>${BASE_URL}${paths[l]}</loc>\n${alternateLinks}\n${xDefault}\n  <lastmod>2026-07-01</lastmod>\n  <changefreq>weekly</changefreq>\n  <priority>0.6</priority>\n</url>`,
  );
}

/** Mirrors the pre-fix bug shape: a lone IT `<url>` whose alternates reference en/de/fr hrefs that were never pushed as their own `<loc>`. */
function buildBuggyItOnlyBlock(paths: LocalePaths): string {
  const alternateLinks = LOCALES.map(
    (l) => `  <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${paths[l]}" />`,
  ).join('\n');
  const xDefault = `  <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${paths.it}" />`;
  return `<url>\n  <loc>${BASE_URL}${paths.it}</loc>\n${alternateLinks}\n${xDefault}\n  <lastmod>2026-07-01</lastmod>\n  <changefreq>weekly</changefreq>\n  <priority>0.6</priority>\n</url>`;
}

function wrapUrlset(blocks: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${blocks.join('\n')}\n</urlset>`;
}

function parseUrlBlocks(xml: string): string[] {
  return xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
}

function hasAnyAlternate(block: string): boolean {
  return /<xhtml:link\b/.test(block);
}

interface FixedArrayCase {
  name: string;
  sourceRef: string;
  paths: LocalePaths;
}

// One representative reciprocal group per fixed array (jobsSeoPagesPlugin.ts, #3499).
const FIXED_ARRAY_CASES: FixedArrayCase[] = [
  {
    name: 'companyEntries (top-level TI company hub)',
    sourceRef: 'jobsSeoPagesPlugin.ts:8807 companyEntries',
    paths: {
      it: '/cerca-lavoro-ticino/azienda-acme-test-sa/',
      en: '/en/find-jobs-ticino/company-acme-test-sa/',
      de: '/de/jobs-im-tessin/unternehmen-acme-test-sa/',
      fr: '/fr/trouver-emploi-tessin/entreprise-acme-test-sa/',
    },
  },
  {
    name: 'companyCantonSitemapEntries (per-canton company hub, ZH)',
    sourceRef: 'jobsSeoPagesPlugin.ts:7405 companyCantonSitemapEntries',
    paths: {
      it: '/cerca-lavoro-zurigo/azienda-acme-test-sa/',
      en: '/en/find-jobs-zurich/company-acme-test-sa/',
      de: '/de/jobs-in-zurich/unternehmen-acme-test-sa/',
      fr: '/fr/trouver-emploi-zurich/entreprise-acme-test-sa/',
    },
  },
  {
    name: 'companyCitySitemapEntries (per-canton company x city hub, ZH/Zürich)',
    sourceRef: 'jobsSeoPagesPlugin.ts:7632 companyCitySitemapEntries',
    paths: {
      it: '/cerca-lavoro-zurigo/azienda-acme-test-sa-zurich/',
      en: '/en/find-jobs-zurich/company-acme-test-sa-zurich/',
      de: '/de/jobs-in-zurich/unternehmen-acme-test-sa-zurich/',
      fr: '/fr/trouver-emploi-zurich/entreprise-acme-test-sa-zurich/',
    },
  },
  {
    name: 'sectorHubSitemapEntries (per-canton sector hub, ZH/infermieri)',
    sourceRef: 'jobsSeoPagesPlugin.ts:7181 sectorHubSitemapEntries',
    paths: {
      it: '/cerca-lavoro-zurigo/infermieri/',
      en: '/en/find-jobs-zurich/infermieri/',
      de: '/de/jobs-in-zurich/infermieri/',
      fr: '/fr/trouver-emploi-zurich/infermieri/',
    },
  },
  {
    name: 'categorySitemapEntries (canton-aware, ZH/health)',
    sourceRef: 'jobsSeoPagesPlugin.ts:6990 categorySitemapEntries (non-TI block)',
    paths: {
      it: '/cerca-lavoro-zurigo/categoria-sanita/',
      en: '/en/find-jobs-zurich/category-health/',
      de: '/de/jobs-in-zurich/kategorie-gesundheit/',
      fr: '/fr/trouver-emploi-zurich/categorie-sante/',
    },
  },
  {
    name: 'categorySitemapEntries (TI-legacy, other)',
    sourceRef: 'jobsSeoPagesPlugin.ts:6843 categorySitemapEntries (TI-legacy block)',
    paths: {
      it: '/cerca-lavoro-ticino/categoria-altro/',
      en: '/en/find-jobs-ticino/category-other/',
      de: '/de/jobs-im-tessin/kategorie-sonstiges/',
      fr: '/fr/trouver-emploi-tessin/categorie-autre/',
    },
  },
  {
    name: 'keywordSitemapEntries (custom keyword landing)',
    sourceRef: 'jobsSeoPagesPlugin.ts:7840 keywordSitemapEntries',
    paths: {
      it: '/ricerca/lavoro-zurigo-test-kw/',
      en: '/en/search/lavoro-zurigo-test-kw/',
      de: '/de/suche/lavoro-zurigo-test-kw/',
      fr: '/fr/recherche/lavoro-zurigo-test-kw/',
    },
  },
  {
    name: 'searchSitemapEntries (search-leader landing)',
    sourceRef: 'jobsSeoPagesPlugin.ts:8040 search-leader render loop',
    paths: {
      it: '/ricerca/zurigo-frontaliere-test/',
      en: '/en/search/zurigo-frontaliere-test/',
      de: '/de/suche/zurigo-frontaliere-test/',
      fr: '/fr/recherche/zurigo-frontaliere-test/',
    },
  },
  {
    name: 'editorialSitemapEntries (editorial hub, representative shape)',
    sourceRef: 'jobsSeoPagesPlugin.ts pushEditorialSitemapEntry',
    paths: {
      it: '/cerca-lavoro-ticino/lavoro-frontalieri-ticino/',
      en: '/en/find-jobs-ticino/cross-border-jobs-ticino/',
      de: '/de/jobs-im-tessin/grenzgaenger-jobs-tessin/',
      fr: '/fr/trouver-emploi-tessin/emploi-frontalier-tessin/',
    },
  },
  {
    name: 'cityHubSitemapEntries (per-canton city hub, representative shape)',
    sourceRef: 'jobsSeoPagesPlugin.ts:6274 cityHubSitemapEntries',
    paths: {
      it: '/cerca-lavoro-zurigo/zurich/',
      en: '/en/find-jobs-zurich/zurich/',
      de: '/de/jobs-in-zurich/zurich/',
      fr: '/fr/trouver-emploi-zurich/zurich/',
    },
  },
  {
    name: 'paginationSitemapEntries (hub page-N, representative shape)',
    sourceRef: 'jobsSeoPagesPlugin.ts paginationSitemapEntries',
    paths: {
      it: '/cerca-lavoro-zurigo/pagina-2/',
      en: '/en/find-jobs-zurich/page-2/',
      de: '/de/jobs-in-zurich/seite-2/',
      fr: '/fr/trouver-emploi-zurich/page-2/',
    },
  },
  {
    name: 'expiredSitemapEntries (orphan soft-landing cluster, TI-legacy)',
    sourceRef: 'jobsSeoPagesPlugin.ts:~11803 expiredSitemapEntries',
    paths: {
      it: '/cerca-lavoro-ticino/test-orphan-cluster-3499/',
      en: '/en/find-jobs-ticino/test-orphan-cluster-3499/',
      de: '/de/jobs-im-tessin/test-orphan-cluster-3499/',
      fr: '/fr/trouver-emploi-tessin/test-orphan-cluster-3499/',
    },
  },
  {
    name: 'landingEntry (TI-legacy section root, live at all 4 locales — confirmed via prod curl, not a false positive)',
    sourceRef: 'jobsSeoPagesPlugin.ts landingEntry',
    paths: {
      it: '/cerca-lavoro-ticino/',
      en: '/en/find-jobs-ticino/',
      de: '/de/jobs-im-tessin/',
      fr: '/fr/trouver-emploi-tessin/',
    },
  },
];

describe('jobsSeoPagesPlugin sitemap arrays — EN/DE/FR reciprocity survives sanitizeSitemapHreflangReciprocity (#3499)', () => {
  for (const { name, sourceRef, paths } of FIXED_ARRAY_CASES) {
    it(`${name}: fixed per-locale push keeps all 4 blocks + alternates intact`, () => {
      const fileName = 'sitemap-jobs.xml';
      const blocks = buildFixedGroupBlocks(paths);
      const xml = wrapUrlset(blocks);

      const before = parseUrlBlocks(xml);
      expect(before, sourceRef).toHaveLength(4);

      const out = sanitizeSitemapHreflangReciprocity([{ file: fileName, xml }]);
      const sanitized = out.has(fileName) ? out.get(fileName)! : xml;
      const after = parseUrlBlocks(sanitized);

      expect(after, `${sourceRef}: block count changed`).toHaveLength(4);
      for (const block of before) {
        expect(sanitized, `${sourceRef}: block stripped/altered:\n${block}`).toContain(block);
      }
      for (const l of LOCALES) {
        expect(sanitized, `${sourceRef}: missing ${l} <loc>`).toContain(`<loc>${BASE_URL}${paths[l]}</loc>`);
      }
    });

    it(`${name}: pre-fix IT-only push would have lost its OWN alternates too (bug reproduction)`, () => {
      const fileName = 'sitemap-jobs.xml';
      const buggyBlock = buildBuggyItOnlyBlock(paths);
      const xml = wrapUrlset([buggyBlock]);

      expect(hasAnyAlternate(buggyBlock), sourceRef).toBe(true);

      const out = sanitizeSitemapHreflangReciprocity([{ file: fileName, xml }]);
      expect(out.has(fileName), `${sourceRef}: sanitizer should have stripped the lone IT block's alternates`).toBe(
        true,
      );
      const sanitized = out.get(fileName)!;
      const after = parseUrlBlocks(sanitized);
      expect(after, sourceRef).toHaveLength(1);
      expect(hasAnyAlternate(after[0]), `${sourceRef}: IT block kept dangling alternates to non-existent en/de/fr locs`).toBe(
        false,
      );
      expect(sanitized, sourceRef).toContain(`<loc>${BASE_URL}${paths.it}</loc>`);
    });
  }
});
