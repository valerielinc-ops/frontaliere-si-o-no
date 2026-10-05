// @vitest-environment node

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyAplusListings,
  isAplusClassifiableLocation,
  isAplusEmptyListingPage,
  parseAplusListings,
} from '../scripts/lib/a-plus-plus-job-parser.mjs';

const APLUS_UPDATER = fs.readFileSync(
  new URL('../scripts/update-a-plus-plus-group-jobs.mjs', import.meta.url),
  'utf8',
);

describe('A++ listing classification', () => {
  it('reports a non-empty source filtered to zero Swiss listings', () => {
    const result = classifyAplusListings([
      { href: '/jobs/milan', title: 'Architect', location: 'Milano' },
      { href: '/jobs/paris', title: 'Designer', location: 'Paris' },
    ]);

    expect(result.discovered).toBe(2);
    expect(result.listings).toEqual([]);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.unclassifiedLocationCount).toBe(0);
    expect(result.authoritativeEmptySnapshot).toBe(true);
  });

  it('reports a source-proven company-wide empty board as ok', () => {
    const html = '<main><div class="vacancy__empty">No vacancies available</div></main>';
    const listings = parseAplusListings(html);
    const result = classifyAplusListings(listings, {
      sourceEmpty: isAplusEmptyListingPage(html, listings),
    });

    expect(result.discovered).toBe(0);
    expect(result.listings).toEqual([]);
    expect(result.authoritativeEmptySnapshot).toBe(true);
    expect(result.lastFetchOutcome).toBe('ok');
  });

  it('keeps an unproven parser-empty result fail-closed', () => {
    const result = classifyAplusListings([]);

    expect(result.authoritativeEmptySnapshot).toBe(false);
    expect(result.lastFetchOutcome).toBeNull();
  });

  it('does not prove an empty target slice when a location is unknown', () => {
    const result = classifyAplusListings([
      { href: '/jobs/unknown', title: 'Unknown role', location: 'A newly added place' },
    ]);

    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.unclassifiedLocationCount).toBe(1);
    expect(result.authoritativeEmptySnapshot).toBe(false);
    expect(isAplusClassifiableLocation('')).toBe(false);
  });

  it('keeps a missing location out of the Swiss slice and fail-closes', () => {
    const result = classifyAplusListings([{ location: '' }]);

    expect(result.listings).toEqual([]);
    expect(result.unclassifiedLocationCount).toBe(1);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.authoritativeEmptySnapshot).toBe(false);
  });

  it('lets an explicit foreign country override a Swiss city name', () => {
    const result = classifyAplusListings([{ location: 'Lugano, Germany' }]);

    expect(result.listings).toEqual([]);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.authoritativeEmptySnapshot).toBe(true);
  });

  it('publishes a filtered-empty discovery through the empty merge path', () => {
    expect(APLUS_UPDATER).toContain('fetchListings(summaryCounts)');
    expect(APLUS_UPDATER).toContain("summaryCounts.lastFetchOutcome = 'selector_miss';");
    const discovery = { discovered: 1, listings: [], lastFetchOutcome: 'filtered_empty' };
    const jobs = discovery.listings;

    expect(APLUS_UPDATER).toContain('const verifiedEmpty = discovery.authoritativeEmptySnapshot || discovery.lastFetchOutcome === \'filtered_empty\';');
    expect(APLUS_UPDATER).toContain('skipShrinkGuard: verifiedEmpty,');
    expect(jobs).toEqual([]);
    expect(discovery.lastFetchOutcome).toBe('filtered_empty');

    const publishPath = APLUS_UPDATER.slice(APLUS_UPDATER.indexOf('const result = mergeJobs(jobs);'));
    expect(publishPath).toContain('writeSummaryCrawlerSlice');
    expect(publishPath).toContain('lastFetchOutcome: summaryCounts.lastFetchOutcome');
    expect(publishPath).toContain('await assembleJobsDataset();');
  });

  it('keeps a Swiss card after parsing the InRecruiting listing markup', () => {
    const listings = parseAplusListings(`
      <div class="vacancy__render">
        <div class="vacancy__title"><h3><a href="/jobs/massagno">Architect</a></h3></div>
        <span class="subtitle__informations" title="Location">Massagno, Switzerland</span>
      </div>
    `);
    const result = classifyAplusListings(listings);

    expect(result.discovered).toBe(1);
    expect(result.listings).toHaveLength(1);
    expect(result.lastFetchOutcome).toBe('ok');
  });
});
