import { describe, expect, it } from 'vitest';
import { JOB_SEO_LOCALES, pickSearchLandingFallbackJobs } from '../build-plugins/jobsSeoPagesPlugin';

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
