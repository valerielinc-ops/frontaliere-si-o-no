/**
 * Tests for the CHF/EUR exchange SSG vertical (epic #4452).
 *
 * Covers:
 *  - Path builders: trailing slash, locale prefixes, curated amount set size
 *  - isExchangeSsgPath compat self-map (normalized, O(1) Set)
 *  - Snapshot loader validation (plausibility band, malformed input → null)
 *  - Page generation: 84 pages (1 hub + 20 amounts × 4 locales), ≥50 words
 *    each (MIN_INDEXABLE_WORDS), self-canonical, hreflang ×5, FAQ JSON-LD
 *    parseable, internal links (SPA comparator, calculator, hub↔amounts)
 *  - Sitemap XML: IT canonicals only, hreflang alternates, trailing slash
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXCHANGE_AMOUNTS,
  EXCHANGE_LOCALES,
  buildExchangeAmountPath,
  buildExchangeHubPath,
  buildNearestExchangeAmountPath,
  exchangeAmountSlug,
} from '../services/exchangeSsgPaths';
import {
  isExchangeSsgPath,
  loadExchangeSnapshot,
  type ExchangeSnapshot,
} from '../build-plugins/exchangeRateSsgData';
import { generateExchangePages } from '../build-plugins/exchangeRatePagesPlugin';
import { countHtmlBodyWords, MIN_INDEXABLE_WORDS } from '../build-plugins/constants';
import { resolveSearchConsoleCompatTarget } from '../build-plugins/searchConsoleCompat';

const SNAPSHOT: ExchangeSnapshot = {
  updatedAt: '2026-07-18T05:35:00.000Z',
  rateDate: '2026-07-18',
  currentRate: 1.081,
  source: 'test',
  windows: {
    30: { startRate: 1.0823, startDate: '2026-06-18', min: 1.0797, max: 1.0868, avg: 1.0832, changePct: -0.12 },
    90: { startRate: 1.0863, startDate: '2026-04-19', min: 1.0797, max: 1.0961, avg: 1.0876, changePct: -0.49 },
    365: { startRate: 1.0707, startDate: '2025-07-18', min: 1.06, max: 1.1077, avg: 1.0806, changePct: 0.96 },
  },
  sparkline: Array.from({ length: 53 }, (_, i) => ({
    date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`,
    rate: 1.06 + (i % 10) * 0.004,
  })),
  monthly: Array.from({ length: 12 }, (_, i) => ({
    date: `2025-${String(i + 1).padStart(2, '0')}-28`,
    rate: 1.06 + i * 0.003,
  })),
};

describe('exchange SSG paths', () => {
  it('has a curated amount set of 15-25 values (issue #4454)', () => {
    expect(EXCHANGE_AMOUNTS.length).toBeGreaterThanOrEqual(15);
    expect(EXCHANGE_AMOUNTS.length).toBeLessThanOrEqual(25);
  });

  it('builds hub + amount paths with trailing slash for all locales', () => {
    expect(buildExchangeHubPath('it')).toBe('/cambio-franco-euro/');
    expect(buildExchangeHubPath('en')).toBe('/en/chf-eur-exchange/');
    expect(buildExchangeHubPath('de')).toBe('/de/franken-euro-kurs/');
    expect(buildExchangeHubPath('fr')).toBe('/fr/change-franc-euro/');
    for (const locale of EXCHANGE_LOCALES) {
      for (const amount of EXCHANGE_AMOUNTS) {
        const p = buildExchangeAmountPath(locale, amount);
        expect(p.endsWith('/')).toBe(true);
        expect(p).toContain(exchangeAmountSlug(locale, amount));
      }
    }
  });

  it('buildNearestExchangeAmountPath picks the closest curated amount', () => {
    expect(buildNearestExchangeAmountPath('it', 4100)).toBe(buildExchangeAmountPath('it', 4000));
    expect(buildNearestExchangeAmountPath('it', 4150)).toBe(buildExchangeAmountPath('it', 4200));
    expect(buildNearestExchangeAmountPath('en', 99999)).toBe(buildExchangeAmountPath('en', 10000));
    expect(buildNearestExchangeAmountPath('fr', NaN)).toBe(buildExchangeHubPath('fr'));
    expect(buildNearestExchangeAmountPath('de', -5)).toBe(buildExchangeHubPath('de'));
  });

  it('isExchangeSsgPath accepts every emitted path (normalized) and rejects others', () => {
    for (const locale of EXCHANGE_LOCALES) {
      expect(isExchangeSsgPath(buildExchangeHubPath(locale).replace(/\/$/, ''))).toBe(true);
      for (const amount of EXCHANGE_AMOUNTS) {
        expect(isExchangeSsgPath(buildExchangeAmountPath(locale, amount).replace(/\/$/, ''))).toBe(true);
      }
    }
    expect(isExchangeSsgPath('/cambio-franco-euro/999-franchi-in-euro')).toBe(false);
    expect(isExchangeSsgPath('/compara-servizi/cambio-franco-euro')).toBe(false);
  });

  it('searchConsoleCompat self-maps exchange URLs to themselves', () => {
    const res = resolveSearchConsoleCompatTarget('/cambio-franco-euro/4000-franchi-in-euro/');
    expect(res).not.toBeNull();
    expect(res!.canonicalPath).toBe('/cambio-franco-euro/4000-franchi-in-euro/');
    expect(res!.kind).toBe('legacy');
    const hubRes = resolveSearchConsoleCompatTarget('/de/franken-euro-kurs');
    expect(hubRes!.canonicalPath).toBe('/de/franken-euro-kurs/');
    expect(hubRes!.locale).toBe('de');
  });
});

describe('exchange snapshot loader', () => {
  it('loads the committed repo snapshot', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const snap = loadExchangeSnapshot(repoRoot);
    expect(snap).not.toBeNull();
    expect(snap!.currentRate).toBeGreaterThan(0.6);
    expect(snap!.currentRate).toBeLessThan(1.6);
    expect(snap!.sparkline.length).toBeGreaterThanOrEqual(10);
  });

  it('rejects malformed snapshots', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'exch-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const file = path.join(dir, 'data', 'exchange-rate-snapshot.json');
    // Missing file
    expect(loadExchangeSnapshot(dir)).toBeNull();
    // Implausible rate (corrupt dump)
    fs.writeFileSync(file, JSON.stringify({ ...SNAPSHOT, currentRate: 12.5 }));
    expect(loadExchangeSnapshot(dir)).toBeNull();
    // Truncated series
    fs.writeFileSync(file, JSON.stringify({ ...SNAPSHOT, sparkline: [] }));
    expect(loadExchangeSnapshot(dir)).toBeNull();
    // Valid
    fs.writeFileSync(file, JSON.stringify(SNAPSHOT));
    expect(loadExchangeSnapshot(dir)).not.toBeNull();
  });
});

describe('exchange page generation', () => {
  const { pages, itCanonicalPaths } = generateExchangePages({ snapshot: SNAPSHOT });

  it('emits 84 pages: (1 hub + 20 amounts) × 4 locales', () => {
    expect(pages.length).toBe((1 + EXCHANGE_AMOUNTS.length) * EXCHANGE_LOCALES.length);
    expect(pages.length).toBe(84);
    const rels = new Set(pages.map((p) => p.relPath));
    expect(rels.size).toBe(pages.length); // no duplicate paths
  });

  it('every page clears MIN_INDEXABLE_WORDS and is indexable with large image previews', () => {
    for (const page of pages) {
      const words = countHtmlBodyWords(page.html);
      expect(words, `${page.relPath} has only ${words} words`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
      // minifyHtml may strip attribute quotes → match both forms
      // Indexable + Discover-eligible. Asserting the qualifier rather than the
      // bare `index,follow` literal, which the shell no longer emits.
      expect(page.html).toMatch(/max-image-preview:large/);
      expect(page.html).not.toMatch(/content="?noindex/);
    }
  });

  it('every page is self-canonical with trailing slash + 5 hreflang tags', () => {
    for (const page of pages) {
      // minifyHtml may strip attribute quotes → match both forms
      expect(page.html).toMatch(
        new RegExp(`rel="?canonical"? href="?https://frontaliereticino\\.ch${page.relPath.replace(/\//g, '\\/')}"?`),
      );
      const hreflangs = page.html.match(/hreflang="?/g) ?? [];
      expect(hreflangs.length, page.relPath).toBeGreaterThanOrEqual(5);
      expect(page.html).toMatch(/hreflang="?x-default"?/);
    }
  });

  it('every page carries parseable FAQ + BreadcrumbList + WebPage JSON-LD', () => {
    for (const page of pages) {
      const scripts = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(scripts.length, page.relPath).toBeGreaterThanOrEqual(3);
      const types = scripts.map((m) => (JSON.parse(m[1]) as { '@type': string })['@type']);
      expect(types).toContain('FAQPage');
      expect(types).toContain('BreadcrumbList');
      expect(types).toContain('WebPage');
    }
  });

  it('hub pages include ExchangeRateSpecification structured data + history tables', () => {
    const hubs = pages.filter((p) => EXCHANGE_LOCALES.some((l) => p.relPath === buildExchangeHubPath(l)));
    expect(hubs.length).toBe(4);
    for (const hub of hubs) {
      expect(hub.html).toContain('ExchangeRateSpecification');
      // 365-day window min rendered in the history table (locale decimal
      // separator: it/en/de-CH use '.', fr-CH uses ',')
      expect(/1[.,]0797/.test(hub.html), hub.relPath).toBe(true);
    }
  });

  it('amount pages link the hub, the SPA comparator and the prefilled calculator', () => {
    const itAmount = pages.find((p) => p.relPath === buildExchangeAmountPath('it', 4000));
    expect(itAmount).toBeDefined();
    expect(itAmount!.html).toContain('href="/cambio-franco-euro/"');
    expect(itAmount!.html).toContain('href="/compara-servizi/cambio-franco-euro/"');
    expect(itAmount!.html).toContain('href="/calcola-stipendio/?reddito=4000"');
    const enAmount = pages.find((p) => p.relPath === buildExchangeAmountPath('en', 4000));
    expect(enAmount!.html).toContain('href="/en/chf-eur-exchange/"');
    expect(enAmount!.html).toContain('href="/en/service-comparison/chf-eur-exchange-rate/"');
  });

  it('hub links every amount page + the embed widget (backlink magnet)', () => {
    const itHub = pages.find((p) => p.relPath === buildExchangeHubPath('it'))!;
    for (const amount of EXCHANGE_AMOUNTS) {
      expect(itHub.html).toContain(`href="${buildExchangeAmountPath('it', amount)}"`);
    }
    expect(itHub.html).toContain('/embed/currency-widget.html');
  });

  it('referral partner links carry rel="sponsored nofollow noopener"', () => {
    const itHub = pages.find((p) => p.relPath === buildExchangeHubPath('it'))!;
    expect(itHub.html).toContain('rel="sponsored nofollow noopener"');
    expect(itHub.html).toContain('https://wise.prf.hn/l/5mGYVAl/');
    expect(itHub.html).not.toContain('wise.com/invite');
    expect(itHub.html).toContain('cambiavalute.ch');
  });

  it('itCanonicalPaths covers hub + all amounts, IT-only, trailing slash', () => {
    expect(itCanonicalPaths.length).toBe(1 + EXCHANGE_AMOUNTS.length);
    for (const p of itCanonicalPaths) {
      expect(p.startsWith('/cambio-franco-euro/')).toBe(true);
      expect(p.endsWith('/')).toBe(true);
    }
  });
});
