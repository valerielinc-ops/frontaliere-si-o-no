/** Regression coverage for bounded sector-hub pages and page-weight telemetry. */

import { describe, it, expect } from 'vitest';
import {
  buildSectorLandingHtml,
  sectorHubPageCount,
  SECTOR_PAGE_CARD_CAP,
  SECTOR_PAGE_HARD_BUDGET_BYTES,
  SECTOR_OVERFLOW_LINKS_PER_PAGE,
  summarizeSectorPageWeights,
  SECTOR_PAGE_WEIGHT_TOP_N,
  SECTOR_PAGE_WEIGHT_WARN_BYTES,
} from '../../build-plugins/jobSectorPagesPlugin';
import {
  buildSectorHubPath,
  buildSectorHubPagePath,
  loadSectorProseData,
  type SectorCountableJob,
} from '../../build-plugins/jobSectorLanding';
import type { JobBoardLocale } from '../../build-plugins/jobBoardSeo';
import { parsePath } from '../../services/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];
const HARD_BUDGET_BYTES = SECTOR_PAGE_HARD_BUDGET_BYTES;
const SYNTHETIC_INVENTORY_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

/** Build a synthetic job that exercises the richer card renderer. */
function makeHeavyJob(index: number): SectorCountableJob {
  const longTitleIt = `Infermiera/o specializzata case anziani Lugano turno notte ${index}`;
  const longTitleEn = `Specialised nurse for elderly-care residence in Lugano (night shift) #${index}`;
  const longTitleDe = `Pflegefachperson Altenpflege Lugano Nachtschicht Nummer ${index}`;
  const longTitleFr = `Infirmiere specialisee maison de retraite Lugano (equipe de nuit) numero ${index}`;
  const company = `Casa Anziani Residenza Frontaliere Ticino Spa Numero ${index}`;
  const location = `Lugano-Massagno-Pregassona-Breganzona ${index}`;
  const datePosted = daysAgo(index);
  const slugByLocale: Partial<Record<JobBoardLocale, string>> = {
    it: `infermiera-specializzata-case-anziani-lugano-turno-notte-${index}`,
    en: `specialised-nurse-elderly-care-lugano-night-shift-${index}`,
    de: `pflegefachperson-altenpflege-lugano-nachtschicht-${index}`,
    fr: `infirmiere-specialisee-maison-retraite-lugano-equipe-nuit-${index}`,
  };
  const job = {
    title: longTitleIt,
    titleByLocale: {
      it: longTitleIt,
      en: longTitleEn,
      de: longTitleDe,
      fr: longTitleFr,
    },
    company,
    location,
    addressLocality: location,
    canton: 'TI',
    contract: 'full-time',
    datePosted,
    postedDate: datePosted,
    salaryMin: 65000,
    salaryMax: 95000,
    description: `Casa anziani OSCAM Lugano cerca infermiera/o per turno notte. ${'Mansione '.repeat(20)}`,
    descriptionByLocale: {
      it: `Casa anziani OSCAM Lugano cerca infermiera/o per turno notte. ${'Mansione '.repeat(20)}`,
      en: `Elderly-care home in Lugano seeks a nurse for night shifts. ${'Duty '.repeat(20)}`,
      de: `Altenpflegeheim in Lugano sucht Pflegefachperson fuer Nachtschicht. ${'Aufgabe '.repeat(20)}`,
      fr: `Maison de retraite a Lugano cherche infirmier/e pour equipe de nuit. ${'Tache '.repeat(20)}`,
    },
    slugByLocale,
    slug: slugByLocale.it,
    category: 'health',
    tags: ['infermieri', 'case-anziani', 'oss'],
  };
  return job as unknown as SectorCountableJob;
}

const ROOT_DIR = resolve(__dirname, '..', '..');

function extractJobHrefSlugs(html: string, locale: JobBoardLocale, jobs: readonly SectorCountableJob[]): string[] {
  const expected = new Set(jobs.map((job) => String((job.slugByLocale as Record<string, string>)[locale])));
  const documentUrl = `https://frontaliereticino.ch${buildSectorHubPath(locale, 'case-anziani')}`;
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => new URL(match[1], documentUrl).pathname.split('/').filter(Boolean).at(-1) || '')
    .filter((slug) => expected.has(slug));
}

describe('SEO — job-sector landing page weight gate', () => {
  const sectorProseData = loadSectorProseData(ROOT_DIR);
  const heavyJobs: SectorCountableJob[] = Array.from(
    { length: SYNTHETIC_INVENTORY_SIZE },
    (_, index) => makeHeavyJob(index + 1),
  );
  const pageCount = sectorHubPageCount(heavyJobs.length);

  it('keeps every generated sector page under 260 KiB with fixed card and overflow caps', () => {
    expect(HARD_BUDGET_BYTES).toBe(260 * 1024);
    expect(pageCount).toBe(5);
    // Case-anzians is the richest journey surface; nurses and engineers cover
    // the other role-journey and plain sector templates without rebuilding the
    // same 1000-job fixture hundreds of times.
    for (const sector of ['case-anziani', 'infermieri', 'ingegneri'] as const) {
      for (const locale of LOCALES) {
        for (let page = 1; page <= pageCount; page += 1) {
          const path = buildSectorHubPagePath(locale, sector, page);
          const html = buildSectorLandingHtml({
            sector,
            locale,
            matchingJobs: heavyJobs,
            count: heavyJobs.length,
            year: 2026,
            dateStamp: '2026-04-28',
            sectorProseData,
            entryJs: 'index-DEADBEEF.js',
            entryCss: 'index-DEADBEEF.css',
            page,
            pageCount,
          });
          const bytes = Buffer.byteLength(html, 'utf-8');
          expect(bytes, `${path} HTML is ${(bytes / 1024).toFixed(1)} KiB`).toBeLessThan(HARD_BUDGET_BYTES);
          expect(html).toContain(`data-sector-page="${page}"`);
          expect((html.match(/<article class="jc-card/g) || []).length).toBe(page === 1 ? SECTOR_PAGE_CARD_CAP : 0);
          expect((html.match(/data-sector-overflow-list=/g) || []).length).toBe(1);
          const overflowLinks = html.match(/<ul data-sector-overflow-list="\d+"[\s\S]*?<\/ul>/)?.[0] || '';
          const expectedOverflowRows = Math.min(
            SECTOR_OVERFLOW_LINKS_PER_PAGE,
            Math.max(0, heavyJobs.length - SECTOR_PAGE_CARD_CAP - (page - 1) * SECTOR_OVERFLOW_LINKS_PER_PAGE),
          );
          expect((overflowLinks.match(/<li class="break-inside-avoid/g) || []).length)
            .toBe(expectedOverflowRows);
        }
      }
    }
  });

  it('links the full inventory exactly once across the base and continuation windows', () => {
    for (const locale of LOCALES) {
      const pages = Array.from({ length: pageCount }, (_, index) => index + 1).map((page) =>
        buildSectorLandingHtml({
          sector: 'case-anziani',
          locale,
          matchingJobs: heavyJobs,
          count: heavyJobs.length,
          year: 2026,
          dateStamp: '2026-04-28',
          sectorProseData,
          page,
          pageCount,
        }),
      );
      const jobHrefSlugs = pages.flatMap((html) => extractJobHrefSlugs(html, locale, heavyJobs));
      const expectedSlugs = heavyJobs.map((job) => String((job.slugByLocale as Record<string, string>)[locale]));

      expect(jobHrefSlugs, locale).toHaveLength(heavyJobs.length);
      expect(new Set(jobHrefSlugs).size, locale).toBe(heavyJobs.length);
      expect(new Set(jobHrefSlugs), locale).toEqual(new Set(expectedSlugs));
      if (locale === 'it') {
        expect(pages[0]).toContain(`Offerte 1–${SECTOR_PAGE_CARD_CAP + SECTOR_OVERFLOW_LINKS_PER_PAGE} su ${heavyJobs.length} totali.`);
        expect(pages[1]).toContain(`Offerte ${SECTOR_PAGE_CARD_CAP + SECTOR_OVERFLOW_LINKS_PER_PAGE + 1}–${SECTOR_PAGE_CARD_CAP + 2 * SECTOR_OVERFLOW_LINKS_PER_PAGE} su ${heavyJobs.length} totali.`);
      }
    }
  });

  it('uses page-specific canonical, reciprocal hreflang, x-default and breadcrumbs', () => {
    const page = 2;
    const pageHtml = LOCALES.map((locale) => ({
      locale,
      html: buildSectorLandingHtml({
        sector: 'ingegneri',
        locale,
        matchingJobs: heavyJobs,
        count: heavyJobs.length,
        year: 2026,
        dateStamp: '2026-04-28',
        sectorProseData,
        page,
        pageCount,
      }),
    }));
    const alternatePaths = LOCALES.map((locale) => `https://frontaliereticino.ch${buildSectorHubPagePath(locale, 'ingegneri', page)}`);

    for (const { locale, html } of pageHtml) {
      const canonical = `https://frontaliereticino.ch${buildSectorHubPagePath(locale, 'ingegneri', page)}`;
      expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
      expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="https://frontaliereticino.ch${buildSectorHubPagePath('it', 'ingegneri', page)}">`);
      expect(html).toContain(`href="${buildSectorHubPath(locale, 'ingegneri')}" class="s-bcl"`);
      for (const alternatePath of alternatePaths) expect(html).toContain(alternatePath);

      const breadcrumbScript = html.match(/<script type="application\/ld\+json">(\{[^<]+\})<\/script>/)?.[1];
      expect(breadcrumbScript).toBeTruthy();
      const breadcrumb = JSON.parse(breadcrumbScript!) as { itemListElement: Array<{ item: string }> };
      expect(breadcrumb.itemListElement.at(-1)?.item).toBe(canonical);
      expect(breadcrumb.itemListElement.at(-2)?.item).toBe(`https://frontaliereticino.ch${buildSectorHubPath(locale, 'ingegneri')}`);
    }
    expect(buildSectorHubPagePath('en', 'ingegneri', 2)).toBe('/en/find-jobs-ticino/engineers/page-2/');
    expect(parsePath(buildSectorHubPagePath('en', 'ingegneri', 2)).route).toMatchObject({
      activeTab: 'job-board',
      jobBoardCanton: 'TI',
      jobBoardSector: 'ingegneri',
      staticOverlay: true,
    });

    const structuredData = [...pageHtml[0].html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]) as Record<string, unknown>);
    const collection = structuredData.find((value) => value['@type'] === 'CollectionPage');
    const itemList = structuredData.find((value) => value['@type'] === 'ItemList');
    expect(collection?.numberOfItems).toBe(heavyJobs.length);
    expect(itemList?.numberOfItems).toBe(SECTOR_OVERFLOW_LINKS_PER_PAGE);
    const listedItems = itemList?.itemListElement as Array<{ position: number }>;
    expect(listedItems[0].position).toBe(SECTOR_PAGE_CARD_CAP + SECTOR_OVERFLOW_LINKS_PER_PAGE + 1);
    expect(listedItems.at(-1)?.position).toBe(SECTOR_PAGE_CARD_CAP + 2 * SECTOR_OVERFLOW_LINKS_PER_PAGE);
  });

  it('links each page directly to the base and every other page in its ladder', () => {
    const ladderPageCount = sectorHubPageCount(SYNTHETIC_INVENTORY_SIZE);
    for (let page = 1; page <= ladderPageCount; page += 1) {
      const html = buildSectorLandingHtml({
        sector: 'case-anziani',
        locale: 'it',
        matchingJobs: heavyJobs,
        count: heavyJobs.length,
        year: 2026,
        dateStamp: '2026-04-28',
        sectorProseData,
        page,
        pageCount: ladderPageCount,
      });
      const nav = html.match(/<nav data-sector-page-navigation="1"[\s\S]*?<\/nav>/)?.[0] || '';
      const linkedPages = [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
      const expectedPages = Array.from({ length: ladderPageCount }, (_, index) => index + 1)
        .filter((target) => target !== page)
        .map((target) => buildSectorHubPagePath('it', 'case-anziani', target));
      expect(linkedPages).toEqual(expectedPages);
    }
  });

  it('keeps full-inventory metrics on continuation pages', () => {
    const html = buildSectorLandingHtml({
      sector: 'case-anziani',
      locale: 'it',
      matchingJobs: heavyJobs,
      count: heavyJobs.length,
      year: 2026,
      dateStamp: '2026-04-28',
      sectorProseData,
      companyCount: 71,
      cityCount: 42,
      freshCount: 13,
      siblingCounts: { infermieri: 51, oss: 12 },
      page: 2,
      pageCount,
    });
    expect(html).toContain('data-sector-inventory-count="1000"');
    expect(html).toContain('>71<');
    expect(html).toContain('>42<');
    expect(html).toContain('>+13<');
    expect(html).toContain('href="/cerca-lavoro-ticino/infermieri/"');
    expect(html).toContain('href="/cerca-lavoro-ticino/operatori-socio-sanitari/"');
  });
  it('keeps a larger inventory bounded by continuation pages', () => {
    const manyJobs: SectorCountableJob[] = Array.from(
      { length: 500 },
      (_, i) => makeHeavyJob(i + 1),
    );
    const largePageCount = sectorHubPageCount(manyJobs.length);
    expect(largePageCount).toBe(3);
    for (let page = 1; page <= largePageCount; page += 1) {
      const html = buildSectorLandingHtml({
        sector: 'case-anziani',
        locale: 'en',
        matchingJobs: manyJobs,
        count: manyJobs.length,
        year: 2026,
        dateStamp: '2026-04-28',
        sectorProseData,
        entryJs: 'index-DEADBEEF.js',
        entryCss: 'index-DEADBEEF.css',
        page,
        pageCount: largePageCount,
      });
      expect(Buffer.byteLength(html, 'utf-8')).toBeLessThan(HARD_BUDGET_BYTES);
      expect((html.match(/<article class="jc-card/g) || []).length)
        .toBe(page === 1 ? SECTOR_PAGE_CARD_CAP : 0);
      const visibleItems = page === 1
        ? SECTOR_PAGE_CARD_CAP + SECTOR_OVERFLOW_LINKS_PER_PAGE
        : Math.min(SECTOR_OVERFLOW_LINKS_PER_PAGE, manyJobs.length - SECTOR_PAGE_CARD_CAP - (page - 1) * SECTOR_OVERFLOW_LINKS_PER_PAGE);
      expect(html).toContain(`"numberOfItems":${visibleItems}`);
    }
  });

  it('summarises page weights: top N heaviest and the count over the threshold, without throwing', () => {
    const kb = 1024;
    const weights = [
      { path: '/a/', bytes: 100 * kb },
      { path: '/b/', bytes: 300 * kb },
      { path: '/c/', bytes: 261 * kb },
      { path: '/d/', bytes: 260 * kb },
      { path: '/e/', bytes: 270 * kb },
      { path: '/f/', bytes: 10 * kb },
      { path: '/g/', bytes: 280 * kb },
    ];
    const summary = summarizeSectorPageWeights(weights);
    expect(summary.total).toBe(7);
    // Strictly above 260 KB: /d/ sits exactly on the threshold and is not over.
    expect(summary.overCount).toBe(4);
    expect(summary.top.map((w) => w.path)).toEqual(['/b/', '/g/', '/e/', '/c/', '/d/']);
    expect(summary.top).toHaveLength(SECTOR_PAGE_WEIGHT_TOP_N);
    expect(summarizeSectorPageWeights([])).toEqual({ overCount: 0, total: 0, top: [] });
  });

  it('keeps the byte-size guards fail-closed in both plugins', () => {
    const sectorSource = readFileSync(
      resolve(ROOT_DIR, 'build-plugins/jobSectorPagesPlugin.ts'),
      'utf8',
    );
    expect(sectorSource).toContain('SECTOR_PAGE_WEIGHT_WARN_BYTES');
    expect(sectorSource).toMatch(/if\s*\(htmlBytes\s*>\s*SECTOR_PAGE_WEIGHT_WARN_BYTES\)[\s\S]{0,300}throw new Error/);

    const relatedSource = readFileSync(
      resolve(ROOT_DIR, 'build-plugins/relatedSearchClustersPlugin.ts'),
      'utf8',
    );
    expect(relatedSource).toContain('JOB_BOARD_LANDING_GUARD_BYTES');
    expect(relatedSource).toMatch(/if\s*\(patchedBytes\s*>\s*JOB_BOARD_LANDING_GUARD_BYTES\)[\s\S]{0,300}throw new Error/);
  });
});
