// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  classifyAplusListings,
  parseAplusListings,
} from '../scripts/lib/a-plus-plus-job-parser.mjs';

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
