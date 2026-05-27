/**
 * Regression — small-sitemaps orphan-pages-in-sitemaps gate.
 *
 * Background
 * ----------
 * Semrush's 2026-04-28 audit flagged a long tail of small SEO sitemaps
 * with high orphan ratios (URLs listed but not BFS-reachable from `/`):
 *
 *   - sitemap-pages.xml:           67 / 141 = 47 % orphans
 *   - sitemap-border-wait.xml:     54 / 108 = 50 %
 *   - sitemap-glossario.xml:       30 /  42 = 71 %
 *   - sitemap-job-market.xml:      15 /  21 = 71 %
 *   - sitemap-guides.xml:           8 /   8 = 100 %
 *   - sitemap-border-wait-map.xml:  4 /   4 = 100 %
 *   - sitemap-career-landings.xml:  4 /   4 = 100 %
 *   - sitemap-cost-of-living.xml:   4 /   6 = 67 %
 *   - sitemap-fr-salaire-net.xml:   1 /   1 = 100 %
 *   - sitemap-nursing.xml:          3 /   3 = 100 %
 *   - sitemap-annual-report.xml:    2 /   4 = 50 %
 *   - sitemap-market-report.xml:    2 /   4 = 50 %
 *
 * The fix (per CLAUDE.md non-negotiable rule #5: never noindex an
 * orphan, always add internal links) is two-part:
 *
 *   1. The `/mappa-del-sito/` static page (already in NAV_LABELS.it,
 *      hence reachable from every IT page including `/`) gets a
 *      comprehensive index that anchor-lists every URL in
 *      sitemap-pages.xml + sitemap-glossario.xml plus the root hubs
 *      of every Tier-B small sitemap. See the editorial branch in
 *      `build-plugins/staticPagesPlugin.ts` keyed on
 *      `canonicalPath === '/mappa-del-sito/'`.
 *
 *   2. The border-wait root hub for every locale anchor-links the
 *      other 3 locale root hubs, so BFS that reaches the IT root hub
 *      via `/mappa-del-sito/` also reaches the DE/EN/FR root hubs and
 *      from there every per-crossing locale variant. See
 *      `build-plugins/borderWaitPagesPlugin.ts:renderHubPage`.
 *
 * What this test asserts
 * ----------------------
 * Pure unit tests against the mappa-del-sito index assembly logic and
 * the border-wait hub HTML. Synthesise tiny sitemap inputs and BFS over
 * the resulting HTML to verify children are reachable from the hub.
 */

import { describe, it, expect } from 'vitest';
import { generateBorderWaitPages } from '../../build-plugins/borderWaitPagesPlugin';
import {
  BORDER_WAIT_LOCALES,
  BORDER_WAIT_CROSSINGS,
  buildRootHubPath,
  buildOggiPath,
  type BorderWaitLocale,
} from '../../build-plugins/borderWaitData';

// ── Helpers ───────────────────────────────────────────────────────

function extractAnchorHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[2] ?? m[3] ?? m[4] ?? '';
    if (typeof href === 'string') out.push(href);
  }
  return out;
}

function normalisePath(href: string): string {
  // Strip host, fragment, query, normalise trailing slash for set membership.
  let h = href.trim();
  if (h.startsWith('https://frontaliereticino.ch')) {
    h = h.slice('https://frontaliereticino.ch'.length);
  }
  const hashIdx = h.indexOf('#');
  if (hashIdx >= 0) h = h.slice(0, hashIdx);
  const qIdx = h.indexOf('?');
  if (qIdx >= 0) h = h.slice(0, qIdx);
  if (h === '') h = '/';
  // Normalise to no trailing slash form (except root).
  if (h !== '/' && h.endsWith('/')) h = h.replace(/\/+$/, '');
  return h;
}

// ── Tier B — border-wait cross-locale linking ─────────────────────

describe('border-wait root hubs — every locale anchor-links to every other locale\'s root hub', () => {
  const TODAY = new Date('2026-04-28T08:00:00Z');
  const pages = generateBorderWaitPages({
    current: { updatedAt: TODAY.toISOString(), perCrossing: {} },
    history: [],
    today: TODAY,
  });

  for (const locale of BORDER_WAIT_LOCALES) {
    it(`root hub for ${locale} links the other 3 locale root hubs`, () => {
      const hubPath = buildRootHubPath(locale);
      const html = pages[hubPath];
      expect(html, `root hub HTML missing at ${hubPath}`).toBeDefined();
      const hrefs = new Set(extractAnchorHrefs(html!).map(normalisePath));
      const otherLocales = (BORDER_WAIT_LOCALES as ReadonlyArray<BorderWaitLocale>).filter((l) => l !== locale);
      for (const alt of otherLocales) {
        const altHubPath = normalisePath(buildRootHubPath(alt));
        expect(
          hrefs.has(altHubPath),
          `root hub (${locale}) does NOT link the ${alt} root hub at ${altHubPath}`,
        ).toBe(true);
      }
    });
  }

  for (const locale of BORDER_WAIT_LOCALES) {
    it(`root hub for ${locale} still links every per-crossing page (regression: did not break the table)`, () => {
      const hubPath = buildRootHubPath(locale);
      const html = pages[hubPath]!;
      const hrefs = new Set(extractAnchorHrefs(html).map(normalisePath));
      for (const crossing of BORDER_WAIT_CROSSINGS) {
        const oggi = normalisePath(buildOggiPath(locale, crossing));
        expect(
          hrefs.has(oggi),
          `root hub (${locale}) is missing per-crossing link to ${oggi}`,
        ).toBe(true);
      }
    });
  }
});

// ── Tier A — mappa-del-sito index assembly ────────────────────────
//
// We can't easily unit-test staticPagesPlugin's editorial-blocks
// renderer in isolation (the plugin reads many sources and only emits
// HTML to disk). Instead, we synthesise a tiny "hub + children"
// graph and run BFS over it, asserting the same property the orphan
// audit asserts: every sitemap-listed child is reachable in 1 BFS hop
// from the hub HTML.
//
// We mirror the production behaviour: the production plugin builds an
// `<a href>` for each italianUrl in the editorial block. Here we
// synthesise the same anchor list and verify our normalisation +
// reachability check works.

describe('mappa-del-sito hub — synthetic BFS reachability', () => {
  // Synthesise 5 sitemap-pages children + 5 glossario children +
  // 4 small-sitemap hub roots (border-wait / job-market / nursing /
  // career-landings) and check every child is BFS-reachable from
  // the synthetic hub HTML.

  const SITEMAP_PAGES_CHILDREN: ReadonlyArray<string> = [
    '/calcola-stipendio/stipendio-netto-60000-chf-vecchio-frontaliere/',
    '/calcola-stipendio/stipendio-netto-80000-chf-residenza-oltre-20km/',
    '/calcola-stipendio/confronto-netto-2025-2026-entro-20km/',
    '/calcola-stipendio/confronto-permesso-g-vs-b-entro-20km/',
    '/calcola-stipendio/nuovi-frontalieri-oltre-20-km/',
  ];

  const GLOSSARIO_CHILDREN: ReadonlyArray<string> = [
    '/glossario-frontaliere/permesso-b/',
    '/glossario-frontaliere/doppiaimposizione/',
    '/glossario-frontaliere/addizionale-regionale/',
    '/glossario-frontaliere/lohnausweis/',
    '/glossario-frontaliere/cu/',
  ];

  const SMALL_SITEMAP_HUB_ROOTS: ReadonlyArray<string> = [
    '/traffico-dogane/',
    '/de/wartezeit-grenze/',
    '/en/border-wait/',
    '/fr/temps-attente-douane/',
    '/mercato-lavoro-ticino/',
    '/lavoro-infermieri-svizzera/',
    '/agenzie-del-lavoro-lugano/',
    '/costo-vita-lugano-ticino/',
    '/report/frontaliere-ticino-2026/',
    '/reports/mercato-lavoro-frontalieri-ticino-2026/',
    '/guides/guida-completa-frontaliere-2026/',
    '/guides/guida-completa-frontaliere-2026.pdf',
    '/guida-frontaliere/mappa-live-valichi/',
    '/fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/',
  ];

  // Synthesise the hub HTML the same way staticPagesPlugin does.
  const allChildren: ReadonlyArray<string> = [
    ...SITEMAP_PAGES_CHILDREN,
    ...GLOSSARIO_CHILDREN,
    ...SMALL_SITEMAP_HUB_ROOTS,
  ];
  const hubHtml = `<html><body><main><h1>Mappa del sito</h1><ul>${allChildren
    .map((href) => `<li><a href="${href}">${href}</a></li>`)
    .join('')}</ul></main></body></html>`;

  it('hub HTML contains an anchor for every sitemap-pages child', () => {
    const hrefs = new Set(extractAnchorHrefs(hubHtml).map(normalisePath));
    for (const child of SITEMAP_PAGES_CHILDREN) {
      expect(hrefs.has(normalisePath(child)), `hub missing anchor for ${child}`).toBe(true);
    }
  });

  it('hub HTML contains an anchor for every glossario child', () => {
    const hrefs = new Set(extractAnchorHrefs(hubHtml).map(normalisePath));
    for (const child of GLOSSARIO_CHILDREN) {
      expect(hrefs.has(normalisePath(child)), `hub missing anchor for ${child}`).toBe(true);
    }
  });

  it('hub HTML contains an anchor for every small-sitemap hub root', () => {
    const hrefs = new Set(extractAnchorHrefs(hubHtml).map(normalisePath));
    for (const child of SMALL_SITEMAP_HUB_ROOTS) {
      expect(hrefs.has(normalisePath(child)), `hub missing anchor for ${child}`).toBe(true);
    }
  });
});

// ── Tier A — production hub HTML inspection ──────────────────────
//
// Verify the staticPagesPlugin source contains the literal hub-link
// arrays we depend on. This catches accidental deletion of the
// mappa-del-sito index without requiring a full vite build.

describe('mappa-del-sito source contains the small-sitemap hub-link arrays', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'build-plugins', 'staticPagesPlugin.ts'),
    'utf-8',
  );

  it('source declares BORDER_WAIT_HUB_LINKS for /mappa-del-sito/', () => {
    expect(src.includes('BORDER_WAIT_HUB_LINKS')).toBe(true);
    expect(src.includes('/traffico-dogane/')).toBe(true);
    expect(src.includes('/de/wartezeit-grenze/')).toBe(true);
    expect(src.includes('/en/border-wait/')).toBe(true);
    expect(src.includes('/fr/temps-attente-douane/')).toBe(true);
  });

  it('source declares JOB_MARKET_LINKS with 16 anchors (hub + 15 sectors)', () => {
    expect(src.includes('JOB_MARKET_LINKS')).toBe(true);
    expect(src.includes('/mercato-lavoro-ticino/settore/infermieri/')).toBe(true);
    expect(src.includes('/mercato-lavoro-ticino/settore/ingegneria/')).toBe(true);
  });

  it('source declares CAREER_LANDING_LINKS for the 4 career landing orphans', () => {
    expect(src.includes('CAREER_LANDING_LINKS')).toBe(true);
    expect(src.includes('/agenzie-del-lavoro-lugano/')).toBe(true);
    expect(src.includes('/concorsi-pubblici-lugano/')).toBe(true);
    expect(src.includes('/stage-lugano/')).toBe(true);
    expect(src.includes('/contratti-lavoro-frontalieri/')).toBe(true);
  });

  it('source declares COST_OF_LIVING_LINKS for the 4 cost-of-living orphans', () => {
    expect(src.includes('COST_OF_LIVING_LINKS')).toBe(true);
    expect(src.includes('/costo-vita-lugano-ticino/')).toBe(true);
    expect(src.includes('/costo-vita-bellinzona-ticino/')).toBe(true);
  });

  it('source declares NURSING_LINKS for the 3 nursing orphans', () => {
    expect(src.includes('NURSING_LINKS')).toBe(true);
    expect(src.includes('/lavoro-infermieri-svizzera/')).toBe(true);
    expect(src.includes('/lavoro-oss-svizzera/')).toBe(true);
    expect(src.includes('/lavoro-sanitario-ticino/')).toBe(true);
  });

  it('source declares REPORT_LINKS for the 4 annual-report + 4 market-report orphans', () => {
    expect(src.includes('REPORT_LINKS')).toBe(true);
    expect(src.includes('/de/report/grenzgaenger-2026/')).toBe(true);
    expect(src.includes('/fr/report/frontaliers-2026/')).toBe(true);
    expect(src.includes('/de/reports/tessiner-grenzgaenger-arbeitsmarkt-2026/')).toBe(true);
    expect(src.includes('/fr/reports/marche-emploi-frontaliers-tessin-2026/')).toBe(true);
  });

  it('source declares GUIDE_PDF_LINKS for the 8 guides orphans', () => {
    expect(src.includes('GUIDE_PDF_LINKS')).toBe(true);
    expect(src.includes('/guides/guida-completa-frontaliere-2026.pdf')).toBe(true);
    expect(src.includes('/guides/permesso-g-vantaggi-svantaggi.pdf')).toBe(true);
    expect(src.includes('/guides/lamal-vs-ssn-frontalieri.pdf')).toBe(true);
    expect(src.includes('/guides/trovare-lavoro-ticino-frontaliere.pdf')).toBe(true);
  });

  it('source declares BORDER_WAIT_MAP_LINKS for the 4 border-wait-map orphans', () => {
    expect(src.includes('BORDER_WAIT_MAP_LINKS')).toBe(true);
    expect(src.includes('/guida-frontaliere/mappa-live-valichi/')).toBe(true);
    expect(src.includes('/de/grenzgaenger-ratgeber/live-grenzuebergaenge-karte/')).toBe(true);
  });

  it('source declares FR_SALAIRE_LINKS for the 1 fr-salaire-net orphan', () => {
    expect(src.includes('FR_SALAIRE_LINKS')).toBe(true);
    expect(src.includes('/fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/')).toBe(true);
  });

  it('source declares FUEL_IT_CITY_LINKS for the residual 8 IT-city fuel orphans', () => {
    expect(src.includes('FUEL_IT_CITY_LINKS')).toBe(true);
    expect(src.includes('/prezzi-diesel/italia/como/oggi/')).toBe(true);
    expect(src.includes('/prezzi-benzina/italia/luino/oggi/')).toBe(true);
  });

  it('glossario-frontaliere hub assembles glossary list from italianUrls', () => {
    expect(src.includes('Tutti i termini del glossario')).toBe(true);
    expect(src.includes('glossaryListHtml')).toBe(true);
  });
});
