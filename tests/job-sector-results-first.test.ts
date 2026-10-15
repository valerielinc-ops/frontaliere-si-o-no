import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { buildSectorLandingHtml } from '../build-plugins/jobSectorPagesPlugin';
import {
  buildSectorHubSeo,
  loadSectorProseData,
  type SectorCountableJob,
} from '../build-plugins/jobSectorLanding';
import type { JobBoardLocale } from '../build-plugins/jobBoardSeo';

const ROOT = resolve(__dirname, '..');
const LOCALES: readonly JobBoardLocale[] = ['it', 'en', 'de', 'fr'];

function makeJob(position: number): SectorCountableJob {
  const titleByLocale = Object.fromEntries(
    LOCALES.map((locale) => [locale, `Result ${position} ${locale}`]),
  );
  return {
    title: `Result ${position} it`,
    titleByLocale,
    company: `Company ${position}`,
    location: 'Lugano',
    canton: 'TI',
    slug: `result-${position}`,
    slugByLocale: Object.fromEntries(
      LOCALES.map((locale) => [locale, `result-${position}-${locale}`]),
    ),
  } as SectorCountableJob;
}

describe('sector category landings — results-first ordering', () => {
  const sectorProseData = loadSectorProseData(ROOT);

  it.each(LOCALES)('%s renders three jobs before the collapsed category context', (locale) => {
    const html = buildSectorLandingHtml({
      sector: 'infermieri',
      locale,
      matchingJobs: [1, 2, 3, 4].map(makeJob),
      count: 4,
      year: 2026,
      dateStamp: '2026-09-01',
      sectorProseData,
    });
    const body = html.slice(html.indexOf('<main'));
    const first = body.indexOf(`Result 1 ${locale}`);
    const third = body.indexOf(`Result 3 ${locale}`);
    const context = body.indexOf('data-sector-summary');
    const fourth = body.indexOf(`Result 4 ${locale}`);

    expect(first).toBeGreaterThanOrEqual(0);
    expect(third).toBeGreaterThan(first);
    expect(context).toBeGreaterThan(third);
    expect(fourth).toBeGreaterThan(context);
    expect(body).toContain(buildSectorHubSeo(locale, 'infermieri', 4, 2026).intro);
  });
});
