/**
 * The watchdog must be able to tell a drifted `/tutti/` archive from a current
 * one — issue #5432, Punto 4.
 *
 * ─── The failure this exists to catch ────────────────────────────────────
 * #5422 gave every archive page an "Argomenti" nav so the topic-hub tier stops
 * being unreachable from `/`. The code merged; the pages did not follow. An
 * archive is re-rendered only as a side effect of publishing an article INTO
 * ITS SECTION, and `svizzera` had not published since 2026-08-08T21:38Z — 64
 * minutes before the merge — so it kept serving the previous renderer for
 * twelve hours. `audit:max-bfs-depth` reported `sitemap-topics-svizzera.xml
 * 120/120 unreachable`; nothing said why. The watchdog that runs twice a day
 * was green the whole time, because it asked for HTTP 200, a card grid, and
 * staleness relative to the CORPUS — and a section that stops publishing is
 * fresh by that last test for ever.
 *
 * ─── Why the fixtures are two real pages, and why BOTH carry the marker ──
 * The first attempt at this guard was a presence check on the topics nav's
 * class, `<nav class="s-4nYHgH"`. It does not discriminate: the flat page
 * ladder — which the OLD renderer already emitted — carries the same scoped
 * class (`articleHubPagesPlugin.ts` emits it at both call sites, and
 * `public/assets/seo-static.css` defines it once for both). The `DRIFTED`
 * fixture below is the ladder verbatim from
 * `nanakokyobashi-rgb/frontaliere-articolisvizzera-it@d4580b04`,
 * `articoli-svizzera/tutti/index.html` — the last push before the section was
 * unblocked, the page the issue measured at zero topic anchors. It contains
 * the marker. A probe built on that string reports the broken page healthy,
 * which is worse than no probe: it is a green light with a name.
 *
 * So the marker check is pinned here as a NEGATIVE — `markerIsNotDiscriminating`
 * asserts both fixtures carry it — and the real assertion is the href-for-href
 * comparison against what `sitemap-topics-<section>.xml` announces, which is
 * the same source of truth `tests/article-hub-topics-nav.test.ts` pins the
 * renderer's own output against.
 */

import fs from 'node:fs';
import np from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  archiveTopicAnchorProblems,
  topicHubBasePath,
  topicHubPage1Paths,
} from '../scripts/lib/archive-topic-anchors.mjs';

const ROOT = np.resolve(__dirname, '..');
const PROBE_SRC = fs.readFileSync(
  np.join(ROOT, 'scripts', 'check-article-hub-landings.mjs'),
  'utf-8',
);

/**
 * Verbatim from the live `sitemap-topics-svizzera.xml`: two topic hubs with
 * their page-N ladder, one `en` hub, and one hub of the OTHER section — the
 * three things the prefix filter has to separate. The document is one file per
 * section covering all four locales, so the filter is the only thing standing
 * between "this locale's expectation" and "everyone's".
 */
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://frontaliereticino.ch/articoli-svizzera/argomenti/tasse-e-imposte/</loc></url>
<url><loc>https://frontaliereticino.ch/articoli-svizzera/argomenti/tasse-e-imposte/page-2/</loc></url>
<url><loc>https://frontaliereticino.ch/articoli-svizzera/argomenti/tasse-e-imposte/page-3/</loc></url>
<url><loc>https://frontaliereticino.ch/articoli-svizzera/argomenti/permesso-g/</loc></url>
<url><loc>https://frontaliereticino.ch/articoli-svizzera/argomenti/permesso-g/page-2/</loc></url>
<url><loc>https://frontaliereticino.ch/en/swiss-articles/topics/taxes-and-duties/</loc></url>
<url><loc>https://frontaliereticino.ch/articoli-frontaliere/argomenti/tasse-e-imposte/</loc></url>
</urlset>`;

const IT_SVIZZERA_PREFIX = '/articoli-svizzera';

/**
 * The flat page ladder, verbatim from the drifted page. Note the marker and
 * note that every anchor is a `/page-N/` of the archive itself: not one topic
 * hub is linked, which is exactly the 120/120-unreachable state.
 */
const LADDER_NAV = '<nav class="s-4nYHgH" aria-label="Sfoglia tutto l\'archivio per pagina">'
  + '<details class="s-Ery2Xe"><summary class="s-goeAUL">Sfoglia tutto l\'archivio per pagina (7)'
  + '</summary><div class="s-6_t7LY"><strong class="hc" aria-current="page">1</strong>'
  + '<a href="/articoli-svizzera/tutti/page-2/" class="hp">2</a>'
  + '<a href="/articoli-svizzera/tutti/page-3/" class="hp">3</a>'
  + '</div></details></nav>';

/** The nav #5422 added, verbatim from the page as served today. */
const TOPICS_NAV = '<nav class="s-4nYHgH" aria-label="Argomenti"><details class="s-Ery2Xe">'
  + '<summary class="s-goeAUL">Argomenti (2)</summary><div class="s-6_t7LY">'
  + '<a href="/articoli-svizzera/argomenti/tasse-e-imposte/" class="hp">Tasse e imposte</a>'
  + '<a href="/articoli-svizzera/argomenti/permesso-g/" class="hp">Permesso G</a></div></details>'
  + '<p class="s-Sn0UIv">Vedi anche <a class="s-7DS5hj" href="/articoli-frontaliere/tutti/">'
  + 'Articoli per frontalieri</a></p></nav>';

const DRIFTED_ARCHIVE_HTML = `<main>${LADDER_NAV}</main>`;
const CURRENT_ARCHIVE_HTML = `<main>${LADDER_NAV}${TOPICS_NAV}</main>`;

describe('the expectation read off the section sitemap', () => {
  it('keeps page 1 of this route only — not page-N, not another locale or section', () => {
    expect(topicHubPage1Paths(SITEMAP_XML, IT_SVIZZERA_PREFIX)).toEqual([
      '/articoli-svizzera/argomenti/permesso-g/',
      '/articoli-svizzera/argomenti/tasse-e-imposte/',
    ]);
  });

  it('slices the same document for a non-IT locale of the same section', () => {
    expect(topicHubPage1Paths(SITEMAP_XML, '/en/swiss-articles')).toEqual([
      '/en/swiss-articles/topics/taxes-and-duties/',
    ]);
  });

  it('derives the topic base path instead of restating the locale segment', () => {
    // `argomenti`/`topics`/`themen`/`sujets` is engine data (TOPIC_HUB_SEGMENT).
    // Restating it here would put a second copy in a file no mirror carries.
    const it = topicHubPage1Paths(SITEMAP_XML, IT_SVIZZERA_PREFIX);
    const en = topicHubPage1Paths(SITEMAP_XML, '/en/swiss-articles');
    expect(topicHubBasePath(it)).toBe('/articoli-svizzera/argomenti/');
    expect(topicHubBasePath(en)).toBe('/en/swiss-articles/topics/');
  });
});

describe('drifted vs current archive', () => {
  const expected = topicHubPage1Paths(SITEMAP_XML, IT_SVIZZERA_PREFIX);

  it('the class marker does NOT discriminate — both pages carry it', () => {
    // The reason this guard is a href comparison and not a string search. If
    // this ever becomes false the marker is no longer shared and a simpler
    // probe would be possible; until then, reintroducing one is a regression.
    expect(DRIFTED_ARCHIVE_HTML).toContain('<nav class="s-4nYHgH"');
    expect(CURRENT_ARCHIVE_HTML).toContain('<nav class="s-4nYHgH"');
  });

  it('flags the page the issue measured, and says how many hubs it lost', () => {
    const problems = archiveTopicAnchorProblems(DRIFTED_ARCHIVE_HTML, expected);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2/2 announced topic-hub anchors missing');
    expect(problems[0]).toContain('/articoli-svizzera/argomenti/permesso-g/');
    expect(problems[0]).toContain('#5432');
  });

  it('clears the page as served after the renderer reached it', () => {
    expect(archiveTopicAnchorProblems(CURRENT_ARCHIVE_HTML, expected)).toEqual([]);
  });

  it('is not fooled by the ladder: /page-N/ anchors are not topic hubs', () => {
    // The ladder links `/articoli-svizzera/tutti/page-2/`, which does not sit
    // under the topic base, so it can neither satisfy nor pollute the check.
    const laddersOnly = archiveTopicAnchorProblems(DRIFTED_ARCHIVE_HTML, expected);
    expect(laddersOnly[0]).not.toContain('does not announce');
  });

  it('accepts the legacy no-slash href — this asks about reach, not canonicals', () => {
    const legacy = CURRENT_ARCHIVE_HTML.replaceAll(
      '/articoli-svizzera/argomenti/permesso-g/"',
      '/articoli-svizzera/argomenti/permesso-g"',
    );
    expect(archiveTopicAnchorProblems(legacy, expected)).toEqual([]);
  });

  it('reports an anchor to a hub the sitemap never announced', () => {
    const dangling = CURRENT_ARCHIVE_HTML.replace(
      '</div></details>',
      '<a href="/articoli-svizzera/argomenti/retired-topic/" class="hp">Retired</a></div></details>',
    );
    const problems = archiveTopicAnchorProblems(dangling, expected);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not announce');
    expect(problems[0]).toContain('retired-topic');
  });

  it('REFUSES an empty expectation instead of passing everything', () => {
    // A comparison against nothing clears every input. That is how the twelve
    // hours of silence happened in the first place; it must not be reachable
    // by accident from a sitemap that moved.
    expect(() => archiveTopicAnchorProblems(CURRENT_ARCHIVE_HTML, [])).toThrow(/vacuous/);
  });
});

describe('the probe is wired to this comparison', () => {
  it('runs it on the archive HTML, not on the landing', () => {
    expect(PROBE_SRC).toMatch(/archiveTopicAnchorProblems\(archiveHtml,/);
  });

  it('carries no class-hash marker of its own', () => {
    // Two producers emit these pages and neither is on this repo's build path;
    // a scoped class is not a contract either of them owes this probe.
    expect(PROBE_SRC).not.toMatch(/class="s-/);
  });

  it('fetches a topics sitemap for every section it knows about', () => {
    for (const sitemap of ['sitemap-topics-frontaliere.xml', 'sitemap-topics-svizzera.xml']) {
      expect(PROBE_SRC).toContain(sitemap);
    }
    // Fetched from the SITE origin: it is the site deploy that publishes the
    // sitemap while the corpus publishes the archive, and that separation is
    // what makes a disagreement between them mean something.
    expect(PROBE_SRC).toMatch(/\$\{SITE_ORIGIN\}\/\$\{api\.topicsSitemap\}/);
  });

  it('exits before probing when a route has no expectation', () => {
    expect(PROBE_SRC).toMatch(/expected\.length === 0/);
    expect(PROBE_SRC).toContain('would check nothing for that archive');
  });
});
