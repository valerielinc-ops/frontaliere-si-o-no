/**
 * Empty TI sector hubs must route, not dead-end (#5203).
 *
 * The owner decided on 2026-07-16 that TI sector hubs carry no minimum
 * inventory threshold: a sector with zero Ticino listings stays live and
 * indexed. Three of them are genuinely empty — `camerieri`, `sicurezza` and
 * `agricoltura` have no matching TI jobs in the corpus at all, which a broad
 * keyword sweep confirms is real market absence and not a matcher gap.
 *
 * A page that is indexed, high-intent and empty has to give the visitor
 * somewhere to go. The cross-canton rail is that somewhere, and it used to be
 * suppressed by the same `count >= 3` gate that (correctly) hides it for thin
 * 1-2 job hubs. This pins the resulting three-band behaviour:
 *
 *   count === 0        → rail SHOWN  (nothing else on the page to offer)
 *   1 <= count <= 2    → rail HIDDEN (original gate: too weak a signal)
 *   count >= 3         → rail SHOWN  (original behaviour)
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  buildSectorLandingHtml,
  MAX_EMBEDDED_JOBS,
} from '../build-plugins/jobSectorPagesPlugin';
import {
  SECTOR_HUB_KEYS,
  loadSectorProseData,
  type SectorCountableJob,
} from '../build-plugins/jobSectorLanding';
import type { JobBoardLocale } from '../build-plugins/jobBoardSeo';

const ROOT_DIR = resolve(__dirname, '..');
const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];

/** The sectors the #5203 monitor flagged as genuinely empty in Ticino. */
const GENUINELY_EMPTY_TI_SECTORS = ['camerieri', 'sicurezza', 'agricoltura'] as const;

const RAIL_CLASS = 's-xcanton-rail';

function render(sector: (typeof SECTOR_HUB_KEYS)[number], locale: JobBoardLocale, count: number, jobs: SectorCountableJob[] = []): string {
  return buildSectorLandingHtml({
    sector,
    locale,
    matchingJobs: jobs,
    count,
    year: 2026,
    dateStamp: '2026-08-06',
    sectorProseData: loadSectorProseData(ROOT_DIR),
  });
}

function makeJob(i: number): SectorCountableJob {
  return {
    id: `j${i}`,
    slug: `job-${i}`,
    title: `Offerta ${i}`,
    company: 'Test SA',
    location: 'Lugano',
    description: 'x '.repeat(120),
  } as SectorCountableJob;
}

describe('empty TI sector hub keeps the cross-canton rail', () => {
  for (const sector of GENUINELY_EMPTY_TI_SECTORS) {
    for (const locale of LOCALES) {
      it(`${sector} / ${locale}: count=0 renders the cross-canton rail`, () => {
        const html = render(sector, locale, 0);
        expect(html).toContain(RAIL_CLASS);
      });
    }
  }

  it('every sector renders the rail at count=0', () => {
    // The gate is sector-agnostic: any hub that empties out later must
    // inherit the same routing rather than silently dead-ending.
    for (const sector of SECTOR_HUB_KEYS) {
      const html = render(sector, 'it', 0);
      expect(html, `${sector} lost its cross-canton rail at count=0`).toContain(RAIL_CLASS);
    }
  });
});

describe('the original thin-inventory gate is preserved', () => {
  for (const count of [1, 2]) {
    it(`count=${count} still hides the rail`, () => {
      const jobs = Array.from({ length: count }, (_, i) => makeJob(i));
      const html = render('camerieri', 'it', count, jobs);
      expect(html).not.toContain(RAIL_CLASS);
    });
  }

  for (const count of [3, 10, 999]) {
    it(`count=${count} still shows the rail`, () => {
      const jobs = Array.from({ length: Math.min(count, MAX_EMBEDDED_JOBS) }, (_, i) => makeJob(i));
      const html = render('camerieri', 'it', count, jobs);
      expect(html).toContain(RAIL_CLASS);
    });
  }
});

describe('the empty page still carries its own content', () => {
  it('count=0 keeps the no-results message and the sibling rail', () => {
    const html = render('camerieri', 'it', 0);
    // The empty state must read as "nothing right now", not as a broken page.
    expect(html).toMatch(/Nessuna offerta al momento/i);
    // Sibling sector rail is the other internal-link surface on the page.
    expect(html).toContain('s-sib-rail');
  });
});
