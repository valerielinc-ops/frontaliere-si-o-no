// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  classifyPizzarottiListings,
  parsePizzarottiListings,
} from '../scripts/lib/pizzarotti-job-parser.mjs';

describe('Pizzarotti listing classification', () => {
  it('reports a non-empty source filtered to zero Swiss listings', () => {
    const result = classifyPizzarottiListings([
      { href: '/jobs/parma', title: 'Site manager', location: 'Parma' },
      { href: '/jobs/calabria', title: 'Construction manager', location: 'Calabria' },
    ]);

    expect(result.discovered).toBe(2);
    expect(result.listings).toEqual([]);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
  });

  it('does not turn a parser-empty source into filtered-empty evidence', () => {
    const result = classifyPizzarottiListings([]);

    expect(result.discovered).toBe(0);
    expect(result.lastFetchOutcome).toBeNull();
  });

  it('keeps Swiss cards after parsing the InRecruiting listing markup', () => {
    const listings = parsePizzarottiListings(`
      <div class="vacancy__render">
        <div class="vacancy__title"><h3><a href="/jobs/lugano">Site manager</a></h3></div>
        <span class="subtitle__informations" title="Sede">Lugano, Svizzera</span>
      </div>
      <div class="vacancy__render">
        <div class="vacancy__title"><h3><a href="/jobs/parma">Site manager</a></h3></div>
        <span class="subtitle__informations" title="Sede">Parma</span>
      </div>
    `);
    const result = classifyPizzarottiListings(listings);

    expect(result.discovered).toBe(2);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].title).toBe('Site manager');
    expect(result.lastFetchOutcome).toBe('ok');
  });
});
