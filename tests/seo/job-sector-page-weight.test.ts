/**
 * Regression gate for the 260 KB `audit:page-weight` budget on sector
 * landing pages (e.g. `/cerca-lavoro-ticino/case-anziani/index.html`).
 *
 * Before the fix, popular sectors emitted only the first 30 cards even when
 * the page announced a larger inventory.
 * Each card carries a logo (often a deterministic initials data URI of
 * ~600 bytes), Tailwind class strings, inline SVG icons, and chip markup —
 * roughly 1.5 KB per card. The fix renders the complete matching set and
 * keeps a build-time assertion in `jobSectorPagesPlugin.ts` aligned with the
 * site's 260 KB page-weight gate.
 *
 * This test exercises the pure HTML builder (`buildSectorLandingHtml`)
 * directly with a worst-case synthetic input: every sector × every locale,
 * fed exactly 100 jobs whose strings are sized to the
 * heaviest realistic profile (long titles, long company names, long
 * locations, distinct slugs, salary set so the salary chip renders).
 *
 * Asserts every emitted page lands strictly under 260 KB, matching the
 * current global audit budget.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSectorLandingHtml,
} from '../../build-plugins/jobSectorPagesPlugin';
import {
  SECTOR_HUB_KEYS,
  buildSectorHubPath,
  loadSectorProseData,
  type SectorCountableJob,
} from '../../build-plugins/jobSectorLanding';
import type { JobBoardLocale } from '../../build-plugins/jobBoardSeo';
import { resolve } from 'node:path';

const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];

const HARD_BUDGET_BYTES = 260 * 1024;
const REPRESENTATIVE_FULL_LIST = 100;

/**
 * Build a single synthetic job sized to the heaviest realistic profile a
 * crawler would emit. The Tailwind classes + inline SVGs + initials data
 * URI dominate per-card size; long string fields add another ~150 bytes
 * each. This represents a worst-case but valid input.
 */
function makeHeavyJob(index: number): SectorCountableJob {
  // Long title with all 4 locale variants populated — keeps every locale
  // path-independent (no fallback to the IT title that might be shorter).
  const longTitleIt = `Infermiera/o specializzata case anziani Lugano turno notte ${index}`;
  const longTitleEn = `Specialised nurse for elderly-care residence in Lugano (night shift) #${index}`;
  const longTitleDe = `Pflegefachperson Altenpflege Lugano Nachtschicht Nummer ${index}`;
  const longTitleFr = `Infirmiere specialisee maison de retraite Lugano (equipe de nuit) numero ${index}`;
  const company = `Casa Anziani Residenza Frontaliere Ticino Spa Numero ${index}`;
  const location = `Lugano-Massagno-Pregassona-Breganzona ${index}`;
  // Generate a distinct slug per locale so the JSON-LD ItemList carries
  // distinct URLs (matching the real production output where every job
  // has a localized slug).
  const slugByLocale: Partial<Record<JobBoardLocale, string>> = {
    it: `infermiera-specializzata-case-anziani-lugano-turno-notte-${index}`,
    en: `specialised-nurse-elderly-care-lugano-night-shift-${index}`,
    de: `pflegefachperson-altenpflege-lugano-nachtschicht-${index}`,
    fr: `infirmiere-specialisee-maison-retraite-lugano-equipe-nuit-${index}`,
  };
  // Cast through `unknown` because `SectorCountableJob` (the type used by
  // the helper) does not list every field a real job carries. The renderer
  // reads `canton`, `contract`, `salaryMin/Max` via the broader `JobCardJob`
  // shape downstream, and we want our synthetic input to exercise all of
  // those code paths so the byte count reflects production.
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
    // Date in the recent past so the "new" badge fires (its SVG adds bytes).
    datePosted: new Date(Date.now() - index * 86400000).toISOString(),
    postedDate: new Date(Date.now() - index * 86400000).toISOString(),
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

describe('SEO — job-sector landing page weight gate', () => {
  const sectorProseData = loadSectorProseData(ROOT_DIR);

  // Generate the heaviest realistic input once and reuse across iterations.
  const heavyJobs: SectorCountableJob[] = Array.from(
    { length: REPRESENTATIVE_FULL_LIST },
    (_, i) => makeHeavyJob(i + 1),
  );

  // Exercise EVERY (sector, locale) pair so a regression in any one of
  // the 40 emitted pages surfaces by name.
  for (const sector of SECTOR_HUB_KEYS) {
    for (const locale of LOCALES) {
      const path = buildSectorHubPath(locale, sector);
      it(`${path} stays strictly under ${HARD_BUDGET_BYTES / 1024} KB with ${REPRESENTATIVE_FULL_LIST} embedded jobs`, () => {
        const html = buildSectorLandingHtml({
          sector,
          locale,
          matchingJobs: heavyJobs,
          // High count keeps the SEO copy in its longest branch (with
          // numeric prefix in the H1 + FAQ answer).
          count: 999,
          year: 2026,
          dateStamp: '2026-04-28',
          sectorProseData,
          // Simulate a present SPA bundle so the <link>/<script> tags
          // are emitted (they add ~150 bytes — closer to production).
          entryJs: 'index-DEADBEEF.js',
          entryCss: 'index-DEADBEEF.css',
        });
        const bytes = Buffer.byteLength(html, 'utf-8');
        expect(
          bytes,
          `${path} HTML is ${(bytes / 1024).toFixed(1)} KB — exceeds ${HARD_BUDGET_BYTES / 1024} KB budget`,
        ).toBeLessThan(HARD_BUDGET_BYTES);
      });
    }
  }

  it('renders every item passed to the complete-list builder', () => {
    // This is the regression that matters: the headline/count may be larger
    // than the first visible sample, but the builder must not truncate the
    // input before producing cards or ItemList JSON-LD.
    const fiftyJobs: SectorCountableJob[] = Array.from(
      { length: 50 },
      (_, i) => makeHeavyJob(i + 1),
    );
    const html = buildSectorLandingHtml({
      sector: 'case-anziani',
      locale: 'it',
      matchingJobs: fiftyJobs,
      count: 999,
      year: 2026,
      dateStamp: '2026-04-28',
      sectorProseData,
      entryJs: 'index-DEADBEEF.js',
      entryCss: 'index-DEADBEEF.css',
    });
    expect((html.match(/<article class="jc-card/g) || []).length).toBe(50);
    expect(html).toContain('"numberOfItems":50');
  });
});
