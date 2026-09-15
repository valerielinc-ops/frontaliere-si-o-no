import { describe, expect, it } from 'vitest';
import {
  extractCityFromUrl,
  extractTitleFromUrl,
  parseJobPage,
  stripSiteTitleSuffix,
} from '../scripts/update-manor-jobs.mjs';
import { normalizeKey } from '../scripts/lib/dedicated-crawler-common.mjs';

const BIEL_JOB_ID = '1364490355';
const BIEL_URL = `https://positions.manor.ch/job/Biel-Mitarbeiterin-Visual-Merchandising-80/${BIEL_JOB_ID}/`;
const BIEL_PREVIOUS_SLUG =
  'manor-mitarbeiter-in-visual-merchandising-80-biel-mitarbeiterin-visual-merchandising';
const BIEL_REGRESSION_FIXTURE = {
  page: `
    <meta property="og:title" content="Mitarbeiter*in Visual Merchandising 80%" />
    <meta itemprop="streetAddress" content="Biel" />
  `,
  titleByLocale: { it: 'Collaboratore/trice*in Visual Merchandising 80%' },
  previousSlugs: [BIEL_PREVIOUS_SLUG],
};
const RICKENBACH_URL =
  'https://positions.manor.ch/job/Rickenbach-b_-Wil-Mitarbeiterin-Verkauf-Fashion-40/1364892555/';

describe('Manor jobs2web URL and title parsing', () => {
  it('keeps title words out of the city prefix used by the URL fallback', () => {
    expect(extractCityFromUrl(BIEL_URL)).toEqual({ city: 'Biel', segments: 1 });
    expect(extractTitleFromUrl(BIEL_URL)).toBe('Mitarbeiterin Visual Merchandising 80');
  });

  it('keeps the documented Manor locality alias without reopening fuzzy prefix matching', () => {
    expect(extractCityFromUrl(RICKENBACH_URL)).toEqual({
      city: 'Rickenbach b. Wil',
      segments: 3,
    });
    expect(extractTitleFromUrl(RICKENBACH_URL)).toBe('Mitarbeiterin Verkauf Fashion 40');
  });

  it('uses the canonical og:title when the current template has no itemprop title', () => {
    const page = `
      <meta property="og:title" content="Mitarbeiter*in Visual Merchandising 80%" />
      <div class="jobTitle"><span>80</span></div>
    `;

    expect(parseJobPage(page, BIEL_URL).title).toBe(
      'Mitarbeiter*in Visual Merchandising 80%',
    );
  });

  it('removes the site suffix while preserving the role title', () => {
    expect(stripSiteTitleSuffix('Verkäufer*in 60% | Manor')).toBe('Verkäufer*in 60%');
    expect(stripSiteTitleSuffix('Verkäufer*in 60% - Manor AG')).toBe('Verkäufer*in 60%');
    expect(stripSiteTitleSuffix('Empfangsmitarbeiter/in 50% | Ferienvertretung 100%')).toBe('Empfangsmitarbeiter/in 50% | Ferienvertretung 100%');
    expect(stripSiteTitleSuffix('Mitarbeiter*in Verkauf - 60%')).toBe('Mitarbeiter*in Verkauf - 60%');
  });

  it('strips only the site suffix from a title that also has an internal pipe', () => {
    expect(stripSiteTitleSuffix('Empfangsmitarbeiter/in 50% | Ferienvertretung 100% | Manor')).toBe(
      'Empfangsmitarbeiter/in 50% | Ferienvertretung 100%',
    );
  });

  it('strips the site suffix from canonical og:title before falling back', () => {
    const page = '<meta property="og:title" content="Senior Verkäufer*in 60% | Manor" />';

    expect(parseJobPage(page, BIEL_URL).title).toBe('Senior Verkäufer*in 60%');
  });

  it('keeps the legacy itemprop title fallback for older templates', () => {
    const page = '<div itemprop="title">Senior Verkäufer*in 60%</div>';

    expect(parseJobPage(page, BIEL_URL).title).toBe('Senior Verkäufer*in 60%');
  });

  it('does not reintroduce the persisted short-title record that blocked the deploy gate', () => {
    // This is the exact page/URL fixture from #8232. The live Manor listing
    // may expire the posting, but the parser regression must remain testable.
    const parsed = parseJobPage(BIEL_REGRESSION_FIXTURE.page, BIEL_URL);
    const { city } = extractCityFromUrl(BIEL_URL);
    const job = {
      title: parsed.title,
      location: city,
      titleByLocale: BIEL_REGRESSION_FIXTURE.titleByLocale,
      slug: normalizeKey(`manor ${parsed.title} ${city}`),
      previousSlugs: BIEL_REGRESSION_FIXTURE.previousSlugs,
    };

    expect(job).toMatchObject({
      title: 'Mitarbeiter*in Visual Merchandising 80%',
      location: 'Biel',
      titleByLocale: { it: 'Collaboratore/trice*in Visual Merchandising 80%' },
    });
    expect([job.slug, ...(job.previousSlugs || [])]).toContain(
      BIEL_PREVIOUS_SLUG,
    );
  });
});
