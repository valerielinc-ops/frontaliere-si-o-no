import { describe, it, expect } from 'vitest';
import { isFustJob } from '../scripts/update-fust-jobs.mjs';
import { isCoopJob } from '../scripts/update-coop-jobs.mjs';

// Regression coverage for #5975: isFustJob/isCoopJob used to accept a job on
// companyKey alone (OR'd with a permissive company/host check), so every job
// the dedicated crawler scraped — regardless of real employer — passed. Both
// matchers now require the scraped `company` text (authoritative, since it
// comes from the JSON-LD detail page) as the necessary condition whenever
// it is present; companyKey is only a fallback when company is missing.

describe('isFustJob — #5975 Coop-group subsidiary contamination', () => {
  it('rejects a Jumbo job even when companyKey was mistakenly stamped fust', () => {
    expect(
      isFustJob({
        company: 'Jumbo, Division der Coop Genossenschaft',
        companyKey: 'fust',
        url: 'https://jobs.coopjobs.ch/offene-stellen/verkaufsberater-in-deco/d3d8352d-da29-40dc-ac28-348871cc9c25',
      })
    ).toBe(false);
  });

  it('rejects an Interdiscount job even when companyKey was mistakenly stamped fust', () => {
    expect(
      isFustJob({
        company: 'Interdiscount',
        companyKey: 'fust',
        url: 'https://jobs.coopjobs.ch/offene-stellen/verkaufsberater-in/3e58ee7a-754f-46ba-8030-cc55a391648d',
      })
    ).toBe(false);
  });

  it('rejects plain Coop Genossenschaft jobs', () => {
    expect(isFustJob({ company: 'Coop Genossenschaft', companyKey: 'fust' })).toBe(false);
  });

  it('accepts a real Fust job', () => {
    expect(isFustJob({ company: 'Fust', companyKey: 'fust' })).toBe(true);
  });

  it('falls back to companyKey only when company is missing', () => {
    expect(isFustJob({ companyKey: 'fust' })).toBe(true);
    expect(isFustJob({ companyKey: 'jumbo' })).toBe(false);
  });
});

describe('isCoopJob — #5975 Coop-group subsidiary contamination', () => {
  it('rejects a Fust job even when companyKey was mistakenly stamped coop-ticino', () => {
    expect(isCoopJob({ company: 'Fust', companyKey: 'coop-ticino' })).toBe(false);
  });

  it('rejects a Jumbo job on the shared coopjobs.ch host', () => {
    expect(
      isCoopJob({
        company: 'Jumbo, Division der Coop Genossenschaft',
        companyKey: 'coop-ticino',
        url: 'https://jobs.coopjobs.ch/offene-stellen/verkaufsberater-in-deco/d3d8352d-da29-40dc-ac28-348871cc9c25',
      })
    ).toBe(false);
  });

  it('rejects an Interdiscount job on the shared coopjobs.ch host', () => {
    expect(
      isCoopJob({
        company: 'Interdiscount',
        companyKey: 'coop-ticino',
        url: 'https://jobs.coopjobs.ch/offene-stellen/verkaufsberater-in/3e58ee7a-754f-46ba-8030-cc55a391648d',
      })
    ).toBe(false);
  });

  it('accepts Coop\'s own internal divisions', () => {
    expect(isCoopJob({ company: 'Coop', companyKey: 'coop-ticino' })).toBe(true);
    expect(isCoopJob({ company: 'Coop City', companyKey: 'coop-ticino' })).toBe(true);
    expect(isCoopJob({ company: 'Coop Genossenschaft', companyKey: 'coop-ticino' })).toBe(true);
  });

  it('falls back to companyKey only when company is missing', () => {
    expect(isCoopJob({ companyKey: 'coop-ticino' })).toBe(true);
    expect(isCoopJob({ companyKey: 'fust' })).toBe(false);
  });
});
