import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractCityFromUrl,
  extractTitleFromUrl,
  parseJobPage,
} from '../scripts/update-manor-jobs.mjs';

const BIEL_URL =
  'https://positions.manor.ch/job/Biel-Mitarbeiterin-Visual-Merchandising-80/1364490355/';
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

  it('keeps the legacy itemprop title fallback for older templates', () => {
    const page = '<div itemprop="title">Senior Verkäufer*in 60%</div>';

    expect(parseJobPage(page, BIEL_URL).title).toBe('Senior Verkäufer*in 60%');
  });

  it('does not reintroduce the persisted short-title record that blocked the deploy gate', () => {
    const slice = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), 'data/jobs/by-crawler/manor.json'),
        'utf8',
      ),
    );
    const job = slice.jobs.find((entry: { url?: string }) => entry.url === BIEL_URL);

    expect(job).toMatchObject({
      title: 'Mitarbeiter*in Visual Merchandising 80%',
      location: 'Biel',
      titleByLocale: { it: 'Mitarbeiter*in Visual Merchandising 80%' },
    });
    expect(job.previousSlugs).toContain(
      'manor-mitarbeiter-in-visual-merchandising-80-biel-mitarbeiterin-visual-merchandising',
    );
  });
});
