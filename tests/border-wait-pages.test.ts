/**
 * Tests for border-wait SEO pages (F8).
 *
 * Covers:
 *  - Slug tables + path builders for all 4 locales × (root + regional hubs + crossings)
 *  - Route enumeration (BORDER_WAIT_ROUTES = locales × (1 + regions + crossings), derived
 *    from the live registries — see borderWaitData.ts, expanded post-#4889 from 26 to 134
 *    crossings across 17 regions)
 *  - Page generation: ≥50 words per page (MIN_INDEXABLE_WORDS), JSON-LD
 *    present & parseable, canonical self-referent, webcam section renders
 *    conditionally, related-links block present
 *  - isBorderWaitPath + parseBorderWaitPath router helpers
 *  - Degradation (no history → no archives, leaf pages still render)
 *  - Internal linking: leaf page has link to /prezzi-diesel/{zone}/oggi/
 *    (F8 ↔ F6 bidirectional link)
 */

import { describe, expect, it } from 'vitest';
import {
  BORDER_WAIT_CROSSINGS,
  BORDER_WAIT_LOCALES,
  BORDER_WAIT_REGIONS,
  BORDER_WAIT_ROUTES,
  BORDER_WAIT_SECTION,
  BORDER_WAIT_TODAY_SLUG,
  TOP_5_CROSSINGS,
  buildArchivePath,
  buildOggiPath,
  buildRegionalHubPath,
  buildRootHubPath,
  isBorderWaitArchivePath,
  isBorderWaitPath,
  parseBorderWaitPath,
} from '../build-plugins/borderWaitData';
import {
  generateBorderWaitArchives,
  generateBorderWaitPages,
  type BorderWaitCurrent,
  type BorderWaitHistoryDay,
} from '../build-plugins/borderWaitPagesPlugin';
import { countHtmlBodyWords, MIN_INDEXABLE_WORDS } from '../build-plugins/constants';

const MINIMAL_CURRENT: BorderWaitCurrent = {
  updatedAt: '2026-04-21T06:00:00.000Z',
  perCrossing: {
    'chiasso-brogeda': {
      waitTimeMinutes: 18,
      source: 'tomtom',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'red',
    },
    // HERE live-routing reading — must render the 'here' source badge, NOT the
    // 'static' historical-data fallback (regression: 'here' was missing from the
    // WaitSource union/switch and fell through to "Dati statistici").
    'chiasso-centro': {
      waitTimeMinutes: 8,
      source: 'here',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'yellow',
    },
    gaggiolo: {
      waitTimeMinutes: 22,
      source: 'tomtom',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'red',
    },
    'ponte-tresa': {
      waitTimeMinutes: 4,
      source: 'google-maps',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'green',
    },
    // Webcam-sourced reading (live image analysis) — must render the
    // 'webcam' source badge, NOT the 'static' historical-data fallback.
    'san-pietro': {
      waitTimeMinutes: 6,
      source: 'webcam',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'green',
    },
  },
};

// ── Slug / path tests ─────────────────────────────────────────────

describe('borderWaitData — slug tables + path builders', () => {
  it('exports exactly 134 crossings, all unique (post-#4889 expansion from 26)', () => {
    expect(BORDER_WAIT_CROSSINGS).toHaveLength(134);
    expect(new Set(BORDER_WAIT_CROSSINGS).size).toBe(134);
  });

  it('TOP_5_CROSSINGS is a strict subset of 5 crossings', () => {
    expect(TOP_5_CROSSINGS).toHaveLength(5);
    for (const c of TOP_5_CROSSINGS) {
      expect(BORDER_WAIT_CROSSINGS).toContain(c);
    }
  });

  it('builds canonical paths with trailing slash in every locale', () => {
    for (const loc of BORDER_WAIT_LOCALES) {
      const p = buildOggiPath(loc, 'chiasso-brogeda');
      expect(p.endsWith('/')).toBe(true);
      expect(p.startsWith('/')).toBe(true);
      expect(p).toContain(BORDER_WAIT_SECTION[loc]);
      expect(p).toContain(BORDER_WAIT_TODAY_SLUG[loc]);
      expect(p).toContain('chiasso-brogeda');
    }
  });

  it('Italian URLs have no locale prefix, others have /{lang}/', () => {
    expect(buildOggiPath('it', 'chiasso-brogeda')).toMatch(/^\/traffico-dogane\//);
    expect(buildOggiPath('en', 'chiasso-brogeda')).toMatch(/^\/en\/border-wait\//);
    expect(buildOggiPath('de', 'chiasso-brogeda')).toMatch(/^\/de\/wartezeit-grenze\//);
    expect(buildOggiPath('fr', 'chiasso-brogeda')).toMatch(/^\/fr\/temps-attente-douane\//);
  });

  it('root + regional + crossing routes total 608 (4 locales × (1 + 17 regions + 134 crossings))', () => {
    const expected = BORDER_WAIT_LOCALES.length * (1 + BORDER_WAIT_REGIONS.length + BORDER_WAIT_CROSSINGS.length);
    expect(BORDER_WAIT_ROUTES).toHaveLength(expected);
    expect(expected).toBe(608);
    expect(new Set(BORDER_WAIT_ROUTES).size).toBe(expected);
  });

  it('archive path uses YYYY-MM slug', () => {
    expect(buildArchivePath('it', 'chiasso-brogeda', '2026-04')).toBe(
      '/traffico-dogane/chiasso-brogeda/2026-04/',
    );
    expect(buildArchivePath('en', 'chiasso-brogeda', '2026-04')).toBe(
      '/en/border-wait/chiasso-brogeda/2026-04/',
    );
  });

  it('regional hub and root path have no trailing crossing segment', () => {
    expect(buildRootHubPath('it')).toBe('/traffico-dogane/');
    expect(buildRegionalHubPath('it', 'ticino-como')).toBe('/traffico-dogane/ticino-como/');
  });
});

describe('borderWaitData — router helpers', () => {
  it('isBorderWaitPath matches canonical routes (with or without trailing slash)', () => {
    expect(isBorderWaitPath('/traffico-dogane/chiasso-brogeda/oggi/')).toBe(true);
    expect(isBorderWaitPath('/traffico-dogane/chiasso-brogeda/oggi')).toBe(true);
    expect(isBorderWaitPath('/en/border-wait/gaggiolo/today/')).toBe(true);
    expect(isBorderWaitPath('/fr/temps-attente-douane/')).toBe(true);
  });

  it('isBorderWaitPath matches monthly archives by shape', () => {
    expect(isBorderWaitPath('/traffico-dogane/chiasso-brogeda/2026-03/')).toBe(true);
    expect(isBorderWaitPath('/en/border-wait/gaggiolo/2026-02/')).toBe(true);
    expect(isBorderWaitArchivePath('/traffico-dogane/chiasso-brogeda/2026-03/')).toBe(true);
  });

  it('isBorderWaitPath rejects unrelated paths', () => {
    expect(isBorderWaitPath('/prezzi-diesel/chiasso/oggi/')).toBe(false);
    expect(isBorderWaitPath('/traffico-dogane/nonexistent-crossing/oggi/')).toBe(false);
    expect(isBorderWaitPath('/traffico-dogane/chiasso-brogeda/notamonth/')).toBe(false);
  });

  it('parseBorderWaitPath extracts locale, crossing, region, archive', () => {
    expect(parseBorderWaitPath('/traffico-dogane/')).toEqual({ locale: 'it', isRoot: true });
    expect(parseBorderWaitPath('/traffico-dogane/ticino-como/')).toEqual({
      locale: 'it',
      region: 'ticino-como',
      isRegional: true,
    });
    expect(parseBorderWaitPath('/en/border-wait/chiasso-brogeda/today/')).toEqual({
      locale: 'en',
      crossing: 'chiasso-brogeda',
      isToday: true,
    });
    expect(parseBorderWaitPath('/de/wartezeit-grenze/gaggiolo/2026-03/')).toEqual({
      locale: 'de',
      crossing: 'gaggiolo',
      monthKey: '2026-03',
      isArchive: true,
    });
    expect(parseBorderWaitPath('/anything-else/')).toBeNull();
  });
});

// ── Page-generator tests ──────────────────────────────────────────

describe('borderWaitPagesPlugin — page generation', () => {
  const today = new Date('2026-04-21T06:00:00.000Z');
  const pages = generateBorderWaitPages({ current: MINIMAL_CURRENT, history: [], today });

  it('generates a page for every canonical route', () => {
    for (const route of BORDER_WAIT_ROUTES) {
      expect(pages[route]).toBeDefined();
      expect(pages[route].length).toBeGreaterThan(500);
    }
  });

  it('every generated page clears the 50-word indexable gate', () => {
    for (const [route, html] of Object.entries(pages)) {
      const words = countHtmlBodyWords(html);
      expect(
        words,
        `route ${route} has only ${words} body words (< ${MIN_INDEXABLE_WORDS})`,
      ).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
    }
  });

  it('leaf pages have a self-referencing canonical and 4 hreflang alternates', () => {
    const path = buildOggiPath('it', 'chiasso-brogeda');
    const html = pages[path];
    expect(html).toMatch(new RegExp(`<link\\s+rel=["']?canonical["']?\\s+href=["']?https://frontaliereticino\\.ch${path}["']?>`));
    for (const loc of BORDER_WAIT_LOCALES) {
      expect(html).toMatch(new RegExp(`\\bhreflang=["']?${loc}["']?`));
    }
  });

  it('leaf pages emit valid JSON-LD (WebPage + FAQPage + BreadcrumbList + Place)', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    const ldBlocks = Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g));
    expect(ldBlocks.length).toBeGreaterThanOrEqual(3);
    const types: string[] = [];
    for (const m of ldBlocks) {
      const obj = JSON.parse(m[1]);
      types.push(obj['@type']);
    }
    expect(types).toContain('WebPage');
    expect(types).toContain('FAQPage');
    expect(types).toContain('BreadcrumbList');
  });

  it('Brogeda leaf page renders the webcam <figure> + attribution + loading="lazy"', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('<figure');
    expect(html).toMatch(/\bloading=["']?lazy["']?/);
    expect(html).toMatch(/\brel=["']?nofollow noopener["']?/);
    expect(html).toContain('data-webcam-refresh=');
    expect(html).toContain('data-webcam-base-url=');
    expect(html).toMatch(/\bwidth=["']?640["']?/);
    expect(html).toMatch(/\bheight=["']?360["']?/);
  });

  it('a crossing WITHOUT configured webcams renders graceful fallback notice (no <figure>)', () => {
    // 'crociale-dei-mulini' has no webcam entry in data/borderCrossings.ts
    const html = pages[buildOggiPath('it', 'crociale-dei-mulini')];
    // No <figure> and no refresh JS, but a visible notice is shown
    expect(html).not.toContain('data-webcam-refresh');
    expect(html).not.toContain('<figure');
    expect(html).toContain('Webcam non disponibile per questo valico');
  });

  it('leaf page shows the source-badge label according to the snapshot source', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('TomTom');
  });

  it('a webcam-sourced reading renders the webcam source badge, not the static fallback', () => {
    const html = pages[buildOggiPath('it', 'san-pietro')];
    // The webcam-derived wait is live, so the snapshot badge must read the
    // webcam estimate label and NOT degrade to the "Dati statistici" copy.
    expect(html).toContain('Stima da webcam (analisi immagine live)');
    expect(html).not.toContain('Dati statistici — tempo reale non disponibile');
  });

  it('a HERE live-routing reading renders the HERE badge, not the static fallback', () => {
    const html = pages[buildOggiPath('it', 'chiasso-centro')];
    expect(html).toContain('Stima percorso live (HERE)');
    expect(html).not.toContain('Dati statistici — tempo reale non disponibile');
  });

  it('the webcam source label is translated in every locale', () => {
    expect(pages[buildOggiPath('en', 'san-pietro')]).toContain('Webcam estimate (live image analysis)');
    expect(pages[buildOggiPath('de', 'san-pietro')]).toContain('Webcam-Schätzung (Live-Bildanalyse)');
    expect(pages[buildOggiPath('fr', 'san-pietro')]).toContain("Estimation par webcam (analyse d'image en direct)");
  });

  it('Brogeda leaf page contains bidirectional link to /prezzi-diesel/chiasso/oggi/', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('/prezzi-diesel/chiasso/oggi/');
  });

  it('English leaf page links to the English fuel-daily sibling', () => {
    const html = pages[buildOggiPath('en', 'chiasso-brogeda')];
    expect(html).toContain('/en/diesel-price-switzerland/chiasso/today/');
  });

  it('hub page lists every crossing in the region', () => {
    const comoHub = pages[buildRegionalHubPath('it', 'ticino-como')];
    expect(comoHub).toContain('Chiasso Brogeda');
    expect(comoHub).toContain('Chiasso Centro');
    // Check the table (before the related-links block) does NOT list Varese crossings
    const endOfTable = comoHub.indexOf('seoRelatedLinks');
    expect(endOfTable).toBeGreaterThan(0);
    const mainBody = comoHub.slice(0, endOfTable);
    // Only Como crossings appear in the table
    expect(mainBody).not.toContain('/traffico-dogane/gaggiolo/oggi/');
    expect(mainBody).not.toContain('/traffico-dogane/san-pietro/oggi/');
    expect(mainBody).not.toContain('/traffico-dogane/ponte-tresa/oggi/');
  });

  it('root hub page lists every registered crossing', () => {
    const root = pages[buildRootHubPath('it')];
    for (const c of BORDER_WAIT_CROSSINGS) {
      expect(root).toContain(buildOggiPath('it', c));
    }
  });

  it('a crossing without live data shows the static fallback banner', () => {
    // 'crociale-dei-mulini' is not in MINIMAL_CURRENT.perCrossing
    const html = pages[buildOggiPath('it', 'crociale-dei-mulini')];
    expect(html).toContain('Dati statistici');
  });

  it('leaf pages without history show the "storico in accumulo" notice', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('Storico in accumulo');
  });

  it('every locale has a root hub, every regional hub, and every crossing leaf', () => {
    for (const loc of BORDER_WAIT_LOCALES) {
      expect(pages[buildRootHubPath(loc)]).toBeDefined();
      for (const r of BORDER_WAIT_REGIONS) {
        expect(pages[buildRegionalHubPath(loc, r)]).toBeDefined();
      }
      for (const c of BORDER_WAIT_CROSSINGS) {
        expect(pages[buildOggiPath(loc, c)]).toBeDefined();
      }
    }
  });
});

// ── Archive tests ─────────────────────────────────────────────────

describe('borderWaitPagesPlugin — archives', () => {
  it('does not emit archives when history is empty', () => {
    const archives = generateBorderWaitArchives({ history: [], today: new Date('2026-05-02') });
    expect(Object.keys(archives)).toHaveLength(0);
  });

  it('emits archives only for past months (not current or future)', () => {
    const history: BorderWaitHistoryDay[] = [
      // March has data, should be archived when current month is April
      {
        date: '2026-03-15',
        perCrossing: {
          'chiasso-brogeda': Array.from({ length: 24 }, (_, h) => ({
            min: 0,
            avg: h === 7 ? 25 : 5,
            max: 40,
            samples: 3,
          })),
        },
      },
      // April has data → current month → must NOT produce archive yet
      {
        date: '2026-04-10',
        perCrossing: {
          'chiasso-brogeda': Array.from({ length: 24 }, (_, h) => ({
            min: 0,
            avg: h === 7 ? 30 : 4,
            max: 40,
            samples: 3,
          })),
        },
      },
    ];
    const today = new Date('2026-04-21T06:00:00.000Z');
    const archives = generateBorderWaitArchives({ history, today });
    // March → 4 locales × 5 top crossings = 20 pages
    expect(Object.keys(archives).length).toBe(4 * TOP_5_CROSSINGS.length);
    expect(archives['/traffico-dogane/chiasso-brogeda/2026-03/']).toBeDefined();
    expect(archives['/traffico-dogane/chiasso-brogeda/2026-04/']).toBeUndefined();
  });
});
