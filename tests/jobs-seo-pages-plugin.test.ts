import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_SEO_LOCALES, pickSearchLandingFallbackJobs } from '../build-plugins/jobsSeoPagesPlugin';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('jobsSeoPagesPlugin search landing fallback', () => {
  it('falls back to the first locale with matching jobs instead of assuming italian exists', () => {
    const matchingJobsByLocale = {
      it: [],
      en: [{ slug: 'search-retail-specialist' }],
      de: [],
      fr: [],
    };

    const fallback = pickSearchLandingFallbackJobs(matchingJobsByLocale);

    expect(fallback).toEqual([{ slug: 'search-retail-specialist' }]);
  });

  it('returns italian jobs first when they exist', () => {
    const matchingJobsByLocale = {
      it: [{ slug: 'ricerca-infermiere' }],
      en: [{ slug: 'search-nurse' }],
      de: [],
      fr: [],
    };

    const fallback = pickSearchLandingFallbackJobs(matchingJobsByLocale);

    expect(fallback).toEqual([{ slug: 'ricerca-infermiere' }]);
    expect(JOB_SEO_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });
});

describe('jobsSeoPagesPlugin static payload budget', () => {
  it('does not inline the remote Google Fonts loader on every job detail page', () => {
    const source = readFileSync(resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');

    expect(source).not.toContain('fonts.googleapis.com/css2?family=Manrope');
    expect(source).not.toContain('fonts.gstatic.com');
  });
});
