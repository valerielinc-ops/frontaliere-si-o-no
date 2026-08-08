/**
 * "Argomenti" nav on the `/tutti/` archives + flat page ladder on the topic
 * hubs (issue #5414, Parte A).
 *
 * Run 31259344953 measured the whole topic-hub tier 100% unreachable from `/`
 * (sitemap-topics-frontaliere.xml 412/412, sitemap-topics-svizzera.xml
 * 120/120) and the three non-IT svizzera archives unreachable (21 URLs of
 * sitemap-articles-archive.xml). The fix is three sets of internal links, and
 * each is asserted here IN CONTENT — remove a block and the test goes red,
 * not just "does not crash":
 *
 *  1. every archive page links the ELIGIBLE topic hubs of its own
 *     section+locale (page-1 → BFS depth 2 behind the depth-1 archive);
 *  2. every archive page cross-links the sibling section's archive in the
 *     same locale (swiss en/de/fr archives → depth 2);
 *  3. every topic-hub page carries a flat ladder linking EVERY page-N
 *     (page-N → one hop from page 1, instead of a prev/next chain).
 *
 * The anchors must come from the SAME source of truth that decides which
 * topic pages exist: the engine's `computeEligibleTopicKeys` is pinned against
 * the plugin's own `computeSectionTopics` split, and the emitted hrefs are
 * pinned href-for-href against the `<loc>` set `renderTopicClusterHubPages`
 * announces in its own section sitemap — the file the BFS audit reads.
 */

import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';

// Importing seoHubsPlugin pulls in articlesSiteShellBootstrap (side effect),
// which the engine's renderers need.
import { renderArticleHubPages } from '../build-plugins/seoHubsPlugin';
import {
  archiveTopicHubLinks,
  computeEligibleTopicKeys,
} from '../packages/articles/engine/articleHubPagesPlugin';
import { TOPIC_CLUSTERS } from '../packages/articles/engine/topicTaxonomy';
import {
  computeSectionTopics,
  renderTopicClusterHubPages,
  __renderTopicPaginationForTest as renderTopicPagination,
} from '../build-plugins/topicClusterHubsPlugin';
import {
  buildTopicHubPath,
  TOPIC_HUB_LOCALES,
  TOPIC_HUB_MIN_ARTICLES,
  type TopicHubLocale,
} from '../build-plugins/topicClusterHubsData';

const rootDir = np.resolve(__dirname, '..');
const available =
  fs.existsSync(np.join(rootDir, 'services/locales/blog-meta-it.ts')) &&
  fs.existsSync(np.join(rootDir, 'services/locales/blog-meta-ch-it.ts'));

const TOPICS_NAV_LABEL: Record<TopicHubLocale, string> = {
  it: 'Argomenti',
  en: 'Topics',
  de: 'Themen',
  fr: 'Sujets',
};

/** The archive pages' twin cross-link targets, restated from independent data. */
const FRONTALIERE_ARCHIVE: Record<TopicHubLocale, string> = {
  it: '/articoli-frontaliere/tutti/',
  en: '/en/cross-border-articles/all/',
  de: '/de/grenzgaenger-artikel/alle/',
  fr: '/fr/articles-frontalier/tous/',
};
const SVIZZERA_ARCHIVE: Record<TopicHubLocale, string> = {
  it: '/articoli-svizzera/tutti/',
  en: '/en/swiss-articles/all/',
  de: '/de/schweiz-artikel/alle/',
  fr: '/fr/articles-suisse/tous/',
};

/** Extract the hrefs inside the "Argomenti" nav block of one rendered page. */
function topicsNavHrefs(html: string, locale: TopicHubLocale): string[] {
  const navRx = new RegExp(
    `<nav class="s-4nYHgH" aria-label="${TOPICS_NAV_LABEL[locale]}">([\\s\\S]*?)</nav>`,
  );
  const m = html.match(navRx);
  if (!m) return [];
  return [...m[1].matchAll(/<a href="([^"]+)" class="hp">/g)].map((a) => a[1]);
}

describe('topic-hub flat page ladder (renderPagination)', () => {
  it('emits a ladder entry for EVERY page with totalPages=7: 6 anchors + the current page marked', () => {
    const html = renderTopicPagination('it', 'frontaliere', 'fiscalita', 1, 7);
    const hrefs = [...html.matchAll(/<a href="([^"]+)" class="hp">/g)].map((m) => m[1]);
    // Pages 2..7 as anchors; page 1 (current) as the aria-current strong.
    expect(hrefs).toEqual(
      [2, 3, 4, 5, 6, 7].map((p) => buildTopicHubPath('it', 'frontaliere', 'fiscalita', p)),
    );
    expect(html).toContain('<strong class="hc" aria-current="page">1</strong>');
    // All 7 pages are represented in the ladder.
    expect(hrefs.length + 1).toBe(7);
  });

  it('from a middle page every OTHER page is one hop away', () => {
    const html = renderTopicPagination('en', 'svizzera', 'salari-stipendi', 4, 7);
    const hrefs = [...html.matchAll(/<a href="([^"]+)" class="hp">/g)].map((m) => m[1]);
    for (const p of [1, 2, 3, 5, 6, 7]) {
      expect(hrefs).toContain(buildTopicHubPath('en', 'svizzera', 'salari-stipendi', p));
    }
    expect(html).toContain('<strong class="hc" aria-current="page">4</strong>');
  });

  it('has NO small-total shortcut: a 4-page hub still gets the full ladder', () => {
    // The /tutti/ archive ladder may skip totals ≤ 5 because its compact nav
    // links first/last/current±1; this compact nav links prev/next ONLY, so
    // without the ladder page-4 of a 4-page hub sits 3 hops from page 1.
    const html = renderTopicPagination('fr', 'frontaliere', 'trasporti', 1, 4);
    const hrefs = [...html.matchAll(/<a href="([^"]+)" class="hp">/g)].map((m) => m[1]);
    expect(hrefs).toEqual(
      [2, 3, 4].map((p) => buildTopicHubPath('fr', 'frontaliere', 'trasporti', p)),
    );
  });

  it('keeps the compact prev/next nav and emits nothing for a single page', () => {
    const html = renderTopicPagination('de', 'svizzera', 'pensioni', 2, 3);
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    expect(renderTopicPagination('de', 'svizzera', 'pensioni', 1, 1)).toBe('');
  });
});

describe.runIf(available)('archive "Argomenti" nav — same truth as the topic sitemaps', () => {
  it(
    'engine eligibility equals the plugin split that decides hub vs bridge, both sections',
    () => {
      for (const section of ['frontaliere', 'svizzera'] as const) {
        const engineSet = computeEligibleTopicKeys(fs, np, rootDir, section);
        const { byTopic } = computeSectionTopics(rootDir, section);
        const pluginSet = new Set(
          TOPIC_CLUSTERS.filter(
            (t) => (byTopic.get(t.key)?.length ?? 0) >= TOPIC_HUB_MIN_ARTICLES,
          ).map((t) => t.key),
        );
        expect([...engineSet].sort(), section).toEqual([...pluginSet].sort());
        // A corpus where nothing is eligible would render an anchor-less nav
        // and prove nothing — the real corpus must keep this test honest.
        expect(engineSet.size, `${section}: no eligible topic`).toBeGreaterThan(0);
      }
    },
    240_000,
  );

  it(
    'every archive page links exactly the page-1 URLs the topic sitemap announces (svizzera)',
    async () => {
      const archiveDir = fs.mkdtempSync(np.join(os.tmpdir(), 'topics-nav-archive-'));
      const hubsDir = fs.mkdtempSync(np.join(os.tmpdir(), 'topics-nav-hubs-'));
      try {
        const archive = await renderArticleHubPages({
          rootDir,
          distDir: archiveDir,
          section: 'svizzera',
        });
        const hubs = await renderTopicClusterHubPages({
          rootDir,
          distDir: hubsDir,
          section: 'svizzera',
        });
        expect(hubs.sitemapPath).not.toBeNull();
        const xml = fs.readFileSync(np.join(hubsDir, hubs.sitemapPath!), 'utf-8');
        const announced = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
          m[1].replace('https://frontaliereticino.ch', ''),
        );

        for (const locale of TOPIC_HUB_LOCALES) {
          // Page-1 canonicals the sitemap announces for THIS locale.
          const expected = announced
            .filter((p) => !/\/page-\d+\/$/.test(p))
            .filter((p) =>
              locale === 'it' ? !/^\/(en|de|fr)\//.test(p) : p.startsWith(`/${locale}/`),
            )
            .sort();
          expect(expected.length, `${locale}: sitemap page-1 set empty`).toBeGreaterThan(0);

          // EVERY page of the archive carries the nav — page 1 and page-N.
          const pages = archive.pathsByLocale[locale];
          expect(pages.length).toBeGreaterThan(1);
          for (const rel of [pages[0], pages[pages.length - 1]]) {
            const html = fs.readFileSync(np.join(archiveDir, rel), 'utf-8');
            const hrefs = topicsNavHrefs(html, locale).sort();
            expect(hrefs, `${rel}: nav hrefs ≠ sitemap page-1 <loc> set`).toEqual(expected);
            // Cross-link to the sibling (frontaliere) archive, same locale —
            // the depth-2 path for /en/swiss-articles/all/ & co. runs the
            // other way, but reciprocity is what keeps both at depth 2.
            expect(html, `${rel}: missing twin cross-link`).toContain(
              `href="${FRONTALIERE_ARCHIVE[locale]}"`,
            );
          }
        }
      } finally {
        fs.rmSync(archiveDir, { recursive: true, force: true });
        fs.rmSync(hubsDir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it(
    'frontaliere archives cross-link the svizzera archive in the same locale — the 21-URL fix',
    async () => {
      const distDir = fs.mkdtempSync(np.join(os.tmpdir(), 'topics-nav-front-'));
      try {
        const archive = await renderArticleHubPages({
          rootDir,
          distDir,
          section: 'frontaliere',
        });
        const eligible = computeEligibleTopicKeys(fs, np, rootDir, 'frontaliere');
        for (const locale of TOPIC_HUB_LOCALES) {
          const rel = archive.pathsByLocale[locale][0]; // page 1
          const html = fs.readFileSync(np.join(distDir, rel), 'utf-8');
          // (ii) the cross-link that puts /en/swiss-articles/all/ (21
          // unreachable URLs of sitemap-articles-archive.xml) at depth 2.
          expect(html, `${rel}: missing svizzera cross-link`).toContain(
            `href="${SVIZZERA_ARCHIVE[locale]}"`,
          );
          // (i) the topic anchors, href-for-href what the shared helper
          // derives from the taxonomy for the eligible set.
          const hrefs = topicsNavHrefs(html, locale);
          expect(hrefs).toEqual(
            archiveTopicHubLinks('frontaliere', locale, eligible).map((l) => l.href),
          );
          // …and each equals the plugin's own path builder for that topic.
          const eligibleOrdered = TOPIC_CLUSTERS.filter((t) => eligible.has(t.key));
          expect(hrefs).toEqual(
            eligibleOrdered.map((t) => buildTopicHubPath(locale, 'frontaliere', t.key)),
          );
          expect(hrefs.length).toBeGreaterThan(0);
        }
      } finally {
        fs.rmSync(distDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
