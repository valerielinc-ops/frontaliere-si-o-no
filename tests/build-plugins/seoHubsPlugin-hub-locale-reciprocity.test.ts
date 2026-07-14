/**
 * Regression test for issue #3499: `emitHub`/`emitSvizzeraArticlesHub`
 * (build-plugins/seoHubsPlugin.ts) used to push a `sitemap-seo-hubs.xml`
 * `<url>` entry ONLY for the `it` locale, even though EN/DE/FR page-1 HTML is
 * genuinely built and live. That made the EN/DE/FR alternates in the page-1
 * `xhtml:link` group one-sided (referenced but never listed as their own
 * `<loc>`) — exactly the class of defect `sanitizeSitemapHreflangReciprocity`
 * (build-plugins/sitemapAliasPlugin.ts, issue #3474) strips from dist/.
 *
 * Fix: every locale gets its own `<url><loc>` entry at page 1, each carrying
 * the identical 4-member alternate set — a fully reciprocal group that
 * survives the sanitizer intact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitSeoHubs } from '../../build-plugins/seoHubsPlugin';
import { HUB_LOCALES, HUB_SLUGS, svizzeraArticlesArchiveBasePaths } from '../../build-plugins/seoHubsData';
import { BASE_URL } from '../../build-plugins/constants';
import { sanitizeSitemapHreflangReciprocity } from '../../build-plugins/sitemapAliasPlugin';

const ROOT = path.resolve(__dirname, '..', '..');

describe('emitSeoHubs — EN/DE/FR hub locales get reciprocal sitemap entries (#3499)', () => {
  let distDir: string;
  let xml: string;
  let sitemapEntries: string[];

  beforeAll(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-hubs-test-'));
    ({ sitemapEntries } = emitSeoHubs({
      rootDir: ROOT,
      distDir,
      fs,
      np: path,
      entryJs: '/assets/entry.js',
      entryCss: '/assets/entry.css',
      hasSpaBundle: false,
      qw: () => {}, // HTML page bodies are irrelevant to this test
    }));
    xml = fs.readFileSync(path.join(distDir, 'sitemap-seo-hubs.xml'), 'utf-8');
    // emitSeoHubs walks the full repo ROOT and writes every hub page + sitemap;
    // on a heavily-loaded CI shard (full-suite runs measured at ~360s wall) this
    // legitimately exceeds vitest's default 10s hookTimeout, intermittently
    // reddening main on a green diff (observed runs 29348408768, 29351211797).
    // Raise the hook budget so real work under load isn't misread as a failure —
    // the test body assertions are unchanged.
  }, 60000);

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('emits a <loc> for every locale of every main hub kind (jobs/sectors/companies/articles)', () => {
    for (const hubKey of ['jobsAll', 'sectorsAll', 'companiesAll', 'articlesAll'] as const) {
      for (const locale of HUB_LOCALES) {
        expect(xml, `${hubKey}/${locale}`).toContain(`<loc>${BASE_URL}${HUB_SLUGS[locale][hubKey]}</loc>`);
      }
    }
  });

  it('emits a <loc> for every locale of the svizzera article archive', () => {
    const archiveBases = svizzeraArticlesArchiveBasePaths();
    for (const locale of HUB_LOCALES) {
      expect(xml, locale).toContain(`<loc>${BASE_URL}${archiveBases[locale]}</loc>`);
    }
  });

  it('returned sitemapEntries reflects the on-disk file (no drift between return value and write)', () => {
    for (const entry of sitemapEntries) {
      expect(xml).toContain(entry);
    }
  });

  it('the page-1 hub groups this fix touches are fully reciprocal — untouched by the sanitizer', () => {
    // The full sitemap also carries page-N>1 IT-only pagination entries
    // (self-referencing single-hreflang groups), which the sanitizer legitimately
    // strips regardless of this fix — that's pre-existing, correct behaviour for
    // pagination, not a reciprocity defect. Scope this assertion to just the
    // <loc> values this fix made reciprocal: the 4-locale page-1 groups for the
    // main hubs and the svizzera article archive.
    const archiveBases = svizzeraArticlesArchiveBasePaths();
    const fixedLocs = [
      ...(['jobsAll', 'sectorsAll', 'companiesAll', 'articlesAll'] as const).flatMap((hubKey) =>
        HUB_LOCALES.map((locale) => `${BASE_URL}${HUB_SLUGS[locale][hubKey]}`),
      ),
      ...HUB_LOCALES.map((locale) => `${BASE_URL}${archiveBases[locale]}`),
    ];

    const out = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-seo-hubs.xml', xml }]);
    const sanitized = out.has('sitemap-seo-hubs.xml') ? out.get('sitemap-seo-hubs.xml')! : xml;
    const beforeBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    const afterSet = new Set(sanitized.match(/<url>[\s\S]*?<\/url>/g) ?? []);

    for (const loc of fixedLocs) {
      const block = beforeBlocks.find((b) => b.includes(`<loc>${loc}</loc>`));
      expect(block, loc).toBeTruthy();
      expect(afterSet.has(block!), loc).toBe(true);
    }
  });
});
