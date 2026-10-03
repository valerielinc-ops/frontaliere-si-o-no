// @vitest-environment node

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyAplusListings,
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
  });

  it('publishes a filtered-empty discovery through the empty merge path', () => {
    const discovery = { discovered: 1, listings: [], lastFetchOutcome: 'filtered_empty' };
    const jobs = discovery.listings;

    expect(APLUS_UPDATER).toContain(
      "if (jobs.length === 0 && discovery.lastFetchOutcome !== 'filtered_empty') {",
    );
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
