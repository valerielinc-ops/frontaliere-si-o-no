import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import fiscalDataset from '@/data/fiscal-municipalities.json';
import {
  isFiscalMunicipalityPath,
  fiscalPathFor,
  FISCAL_ABOVE_FLOOR,
  FISCAL_BELOW_FLOOR,
} from '@/build-plugins/fiscalMunicipalityData';
import {
  computeRegimes,
  renderAboveFloorPage,
  renderBridgePage,
  patchSitemapIndex,
} from '@/build-plugins/fiscalMunicipalityPagesPlugin';
import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';
import { CORRIDOR_PROVINCES, disambiguateHomonymSlugs } from '@/scripts/build-fiscal-municipalities.mjs';
import { TICINO_VITA_CORRIDOR_PROVINCES } from '@/build-plugins/shared/borderMunicipalityCorridors';

const DIST = '/tmp/__fiscal_dist_does_not_exist__';

describe('fiscal-municipalities dataset (#4483)', () => {
  it('declares its source and year and a non-empty above-floor set', () => {
    expect(fiscalDataset.source).toMatch(/MEF/i);
    expect(fiscalDataset.year).toBe(2024);
    expect(fiscalDataset.aboveFloor.length).toBeGreaterThan(20);
    expect(fiscalDataset.belowFloor.length).toBeGreaterThan(0);
  });

  it('every above-floor comune has a real addizionale, a valid slug and sits in the 20 km band', () => {
    // Data-driven against the live CORRIDOR_PROVINCES export (issue #4893
    // widened it from ['CO','VA','VB'] to all 11 border provinces) — never
    // hardcode the province list here, or this test silently stops covering
    // the real corridor the moment the builder's scope changes again.
    for (const m of FISCAL_ABOVE_FLOOR) {
      expect(m.slug).toMatch(/^[a-z0-9-]+$/);
      expect(m.population).toBeGreaterThanOrEqual(5000);
      expect(m.distanceKm).toBeLessThanOrEqual(20);
      expect(CORRIDOR_PROVINCES).toContain(m.province);
      expect(Number.isFinite(m.irpefAddizionale)).toBe(true);
    }
  });

  it('covers more than the original Ticino-only (CO/VA/VB) corridor (issue #4893)', () => {
    // Guards against a regression back to the pre-#4893 3-province cut: the
    // live dataset must have at least one above-floor comune from a
    // province outside the original CO/VA/VB set.
    const original = new Set(['CO', 'VA', 'VB']);
    const widened = FISCAL_ABOVE_FLOOR.filter((m) => !original.has(m.province));
    expect(widened.length).toBeGreaterThan(0);
  });
});

describe('fiscal scenario engine (#4484)', () => {
  it('old regime keeps more net than the new regime and the addizionale scales with the rate', () => {
    const low = computeRegimes(0.5);
    const high = computeRegimes(0.8);
    // Old (Swiss-only) net > new (concurrent Italian) net — the accordo effect.
    expect(low.oldNetMonthlyEUR).toBeGreaterThan(low.newNetMonthlyEUR);
    expect(low.diffMonthlyEUR).toBeGreaterThan(0);
    // A higher municipal surtax means a bigger addizionale line.
    expect(high.addizionaleAnnualEUR).toBeGreaterThan(low.addizionaleAnnualEUR);
    expect(low.addizionaleAnnualEUR).toBeGreaterThan(0);
  });
});

describe('fiscal above-floor page render (#4484)', () => {
  const como = FISCAL_ABOVE_FLOOR.find((m) => m.slug === 'como')!;

  it('renders an indexable page with the fiscal H1, a numeric scenario and >50 words', () => {
    const { html, wordCount, urlPath } = renderAboveFloorPage({
      municipality: como,
      locale: 'it',
      dateStamp: '2026-07-19',
      distDir: DIST,
    });
    expect(urlPath).toBe('/tasse-frontalieri-comune/como/');
    expect(wordCount).toBeGreaterThan(50);
    expect(html).toContain('vecchio vs nuovo regime');
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?index,follow/);
    // A real EUR figure from the numeric scenario must appear (anti-thin):
    // a euro sign plus a thousands-grouped amount (e.g. "60.280 €").
    expect(html).toContain('€');
    expect(html).toMatch(/\d{2}\.\d{3}/);
    // Cross-link to the "vivere a" page (distinct intent, anti-cannibalization).
    expect(html).toContain('/vivere-in-ticino/comuni-di-frontiera/como/');
  });

  it('has a fiscal title distinct from the "vivere a" page title', () => {
    const { html } = renderAboveFloorPage({
      municipality: como,
      locale: 'it',
      dateStamp: '2026-07-19',
      distDir: DIST,
    });
    // fiscal intent ("Tasse ...") — never the "vivere da frontaliere" wording.
    expect(html).toContain('Tasse frontaliere Como');
    expect(html).not.toContain('vivere da frontaliere e lavorare in Ticino');
  });
});

describe('fiscal page "vivere a" cross-link is gated on the Ticino corridor (issue #4893)', () => {
  it('renders the "vivere a" card for an above-floor comune inside the Ticino corridor', () => {
    const inCorridor = FISCAL_ABOVE_FLOOR.find((m) => TICINO_VITA_CORRIDOR_PROVINCES.has(m.province));
    expect(inCorridor, 'expected at least one above-floor comune inside CO/VA/VB').toBeTruthy();
    const { html } = renderAboveFloorPage({
      municipality: inCorridor!,
      locale: 'it',
      dateStamp: '2026-07-19',
      distDir: DIST,
    });
    expect(html).toContain(`/vivere-in-ticino/comuni-di-frontiera/${inCorridor!.slug}/`);
  });

  it('omits the "vivere a" card (never a broken link) for an above-floor comune outside the Ticino corridor', () => {
    const outsideCorridor = FISCAL_ABOVE_FLOOR.find((m) => !TICINO_VITA_CORRIDOR_PROVINCES.has(m.province));
    expect(
      outsideCorridor,
      'expected at least one above-floor comune outside CO/VA/VB (issue #4893 widened the corridor)',
    ).toBeTruthy();
    const { html, wordCount } = renderAboveFloorPage({
      municipality: outsideCorridor!,
      locale: 'it',
      dateStamp: '2026-07-19',
      distDir: DIST,
    });
    expect(html).not.toContain('/vivere-in-ticino/comuni-di-frontiera/');
    // The page must still be a real, indexable page (no thin-content regression
    // just because a card was dropped).
    expect(wordCount).toBeGreaterThan(50);
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?index,follow/);
  });

  it('the bridge page for a below-floor comune outside the Ticino corridor also omits the "vivere a" link', () => {
    const outsideCorridor = FISCAL_BELOW_FLOOR.find((m) => !TICINO_VITA_CORRIDOR_PROVINCES.has(m.province));
    expect(outsideCorridor).toBeTruthy();
    const html = renderBridgePage({ municipality: outsideCorridor!, locale: 'it', distDir: DIST });
    expect(html).not.toContain('/vivere-in-ticino/comuni-di-frontiera/');
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?noindex,follow/);
  });
});

describe('disambiguateHomonymSlugs — synthetic homonym collision across provinces (issue #4893)', () => {
  it('appends the province code to every member of a colliding slug group, deterministically', () => {
    // Synthetic: the live 518-comune dataset has zero name collisions today
    // (verified separately in tests/fiscal-municipalities-dataset.test.ts),
    // but Italy has many repeated comune names across provinces — this must
    // not silently collapse two comuni onto the same URL if the data ever
    // does collide.
    const records = [
      { name: 'Casale', slug: 'casale', province: 'CO', population: 6000 },
      { name: 'Casale', slug: 'casale', province: 'SO', population: 5500 },
      { name: 'Como', slug: 'como', province: 'CO', population: 84000 },
    ];
    disambiguateHomonymSlugs(records);
    const slugs = records.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(records[0].slug).toBe('casale-co');
    expect(records[1].slug).toBe('casale-so');
    // Non-colliding record is left untouched.
    expect(records[2].slug).toBe('como');
  });

  it('still yields unique slugs when the colliding comuni share a province', () => {
    // The province suffix alone cannot separate these: both would become
    // 'casale-co'. Without the seen-set counter the duplicate survives, and
    // survives *silently* — WRITE_COLLISION_MODE defaults to 'report', so the
    // build stays green while one comune's page overwrites the other's.
    const records = [
      { name: 'Casale', slug: 'casale', province: 'CO', population: 6000 },
      { name: 'Casale', slug: 'casale', province: 'CO', population: 5500 },
      { name: 'Casale', slug: 'casale', province: 'SO', population: 5200 },
    ];
    disambiguateHomonymSlugs(records);
    const slugs = records.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toEqual(['casale-co', 'casale-co-2', 'casale-so']);
  });

  it('never hands a disambiguated slug to a comune that already owns it', () => {
    // 'casale-co' is a legitimate standalone slug here. The two colliding
    // 'casale' rows must route around it rather than overwrite it.
    const records = [
      { name: 'Casale', slug: 'casale', province: 'CO', population: 6000 },
      { name: 'Casale', slug: 'casale', province: 'CO', population: 5500 },
      { name: 'Casale Co', slug: 'casale-co', province: 'VA', population: 7000 },
    ];
    disambiguateHomonymSlugs(records);
    const slugs = records.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // The pre-existing owner keeps its slug untouched.
    expect(records[2].slug).toBe('casale-co');
  });
});

describe('fiscal below-floor bridge + self-map (#4484)', () => {
  const small = FISCAL_BELOW_FLOOR[0];

  it('renders a noindex,follow bridge at the same URL', () => {
    const html = renderBridgePage({ municipality: small, locale: 'it', distDir: DIST });
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?noindex,follow/);
  });

  it('self-maps every emitted fiscal path (above + below, all locales) to itself', () => {
    const samples = [FISCAL_ABOVE_FLOOR[0], FISCAL_BELOW_FLOOR[0]];
    for (const m of samples) {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const p = fiscalPathFor(locale, m.slug);
        expect(isFiscalMunicipalityPath(p)).toBe(true);
        expect(resolveSearchConsoleCompatTarget(p)).toEqual({
          canonicalPath: p,
          kind: 'legacy',
          locale,
        });
      }
    }
  });

  it('does not claim an unrelated municipality path as live', () => {
    expect(isFiscalMunicipalityPath('/tasse-frontalieri-comune/citta-inventata-xyz/')).toBe(false);
  });
});

describe('patchSitemapIndex against the real sitemap.xml format (#4544)', () => {
  let tmpDist: string;

  afterEach(() => {
    if (tmpDist) fs.rmSync(tmpDist, { recursive: true, force: true });
  });

  // Mirrors the exact indentation/element shape emitted into dist/sitemap.xml
  // (copied verbatim from public/sitemap.xml — multi-line <sitemap> blocks,
  // never self-closing) so the regex is exercised against the real format,
  // not an idealized fixture.
  const REAL_SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://frontaliereticino.ch/sitemap-pages.xml</loc>
    <lastmod>2026-03-26</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://frontaliereticino.ch/sitemap-blog.xml</loc>
    <lastmod>2026-07-19</lastmod>
  </sitemap>
</sitemapindex>
`;

  function writeFixture(): string {
    tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-sitemap-'));
    fs.writeFileSync(path.join(tmpDist, 'sitemap.xml'), REAL_SITEMAP_INDEX, 'utf-8');
    return tmpDist;
  }

  it('inserts a new <sitemap> entry on first build without breaking the index', () => {
    const dist = writeFixture();
    patchSitemapIndex(dist, '2026-07-19');
    const out = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf-8');
    expect(out).toMatch(
      /<loc>https:\/\/frontaliereticino\.ch\/sitemap-comuni-fiscale\.xml<\/loc>\s*<lastmod>2026-07-19<\/lastmod>/,
    );
    // Still a single well-formed index (no duplicate/mangled closing tag).
    expect(out.match(/<\/sitemapindex>/g)?.length).toBe(1);
    expect(out.match(/<sitemap>/g)?.length).toBe(3);
  });

  it('updates lastmod in place on a subsequent build instead of duplicating the entry', () => {
    const dist = writeFixture();
    patchSitemapIndex(dist, '2026-07-19');
    patchSitemapIndex(dist, '2026-07-20');
    const out = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf-8');
    expect(out.match(/sitemap-comuni-fiscale\.xml/g)?.length).toBe(1);
    expect(out).toMatch(
      /<loc>https:\/\/frontaliereticino\.ch\/sitemap-comuni-fiscale\.xml<\/loc>\s*<lastmod>2026-07-20<\/lastmod>/,
    );
    expect(out.match(/<sitemap>/g)?.length).toBe(3);
  });
});
