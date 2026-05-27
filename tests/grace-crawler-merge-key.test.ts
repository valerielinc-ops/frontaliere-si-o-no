/**
 * Grace La Margna crawler merge-key regression test.
 *
 * hotelcareer.com URLs embed both a company-page id (6 digits, e.g. 120155
 * for Grace La Margna) and a job-specific id (7 digits, e.g. 3694182) in
 * the URL path: `/jobs/{companySlug}-{companyId}/{titleSlug}-{jobId}`.
 *
 * The shared `extractStableJobId` helper falls back to the FIRST 6+ digit
 * run in the URL, which lands on the companyId for every Grace job and
 * collapses all 9 listings onto the same merge key. mergeJobs then merges
 * every new job into the same prev, pulling Sommelier's locale fields
 * onto every job and triggering an 8-of-9 within-slice duplicate-slug
 * archive in cleanup-jobs.
 *
 * Grace's local `jobMatchKey` must prefer the trailing-digit token of the
 * URL's last path segment so each of the 9 listings produces a distinct
 * key.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - .mjs file with implicit exports
import { jobMatchKey } from '../scripts/update-grace-jobs.mjs';

describe('Grace La Margna jobMatchKey', () => {
  it('produces a distinct key per hotelcareer job-id, not the shared company-page id', () => {
    const urls = [
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/sommelier-be-the-master-of-bottles-3694182',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/assistant-outlet-manager-restaurants-are-your-stage-3694115',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/concierge-creator-of-unique-experiences-3694083',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/front-office-trainee-kickstart-your-career-with-us-3694090',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/head-waiter-waitress-be-the-hero-in-the-restaurant-3694112',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/reservation-agent-be-the-master-3694108',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/reservation-supervisor-be-the-master-3694109',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/restaurant-supervisor-restaurant-is-your-stage-3694113',
      'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/assistant-waiter-waitress-be-the-hero-in-the-restaurant-3694114',
    ];
    const keys = urls.map((url) => jobMatchKey({ url }));
    const unique = new Set(keys);
    expect(unique.size).toBe(urls.length);
    expect(keys[0]).toBe('num:3694182');
    expect(keys[1]).toBe('num:3694115');
    // None of the keys should be the company-page id.
    for (const k of keys) expect(k).not.toBe('num:120155');
  });

  it('normalises trailing slashes and query strings before extracting the job id', () => {
    expect(jobMatchKey({ url: 'https://www.hotelcareer.com/jobs/foo-120155/bar-3694182/' })).toBe('num:3694182');
    expect(jobMatchKey({ url: 'https://www.hotelcareer.com/jobs/foo-120155/bar-3694182?intcid=auto' })).toBe('num:3694182');
  });

  it('falls back to extractStableJobId for non-trailing-digit URLs (e.g. PwC UUID)', () => {
    const url = 'https://jobs.pwc.ch/job-vacancies/some-title/0441e237-ebd9-4263-9fe5-e21facbd03ba';
    expect(jobMatchKey({ url })).toBe('uuid:0441e237-ebd9-4263-9fe5-e21facbd03ba');
  });

  it('falls back to the job slug when the URL is empty', () => {
    expect(jobMatchKey({ url: '', slug: 'My-Slug' })).toBe('my-slug');
  });
});
