// @vitest-environment node

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyPizzarottiListings,
  isPizzarottiClassifiableLocation,
  parsePizzarottiListings,
} from '../scripts/lib/pizzarotti-job-parser.mjs';

const PIZZAROTTI_UPDATER = fs.readFileSync(
  new URL('../scripts/update-pizzarotti-jobs.mjs', import.meta.url),
  'utf8',
);

describe('Pizzarotti listing classification', () => {
  it('reports a non-empty source filtered to zero Swiss listings', () => {
    const result = classifyPizzarottiListings([
      { href: '/jobs/unknown', title: 'Site manager', location: 'A newly added place' },
      { href: '/jobs/calabria', title: 'Construction manager', location: 'Calabria' },
    ]);

    expect(result.discovered).toBe(2);
    expect(result.listings).toEqual([]);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.unclassifiedLocationCount).toBe(1);
    expect(result.authoritativeEmptySnapshot).toBe(false);
  });

  it('does not turn a parser-empty source into filtered-empty evidence', () => {
    const result = classifyPizzarottiListings([]);

    expect(result.discovered).toBe(0);
    expect(result.lastFetchOutcome).toBeNull();
    expect(result.authoritativeEmptySnapshot).toBe(false);
  });

  it('proves a filtered-empty source only when every foreign location is explicit', () => {
    const result = classifyPizzarottiListings([
      { href: '/jobs/parma', title: 'Site manager', location: 'Parma, Italia' },
      { href: '/jobs/marseille', title: 'Construction manager', location: 'Marseille, France' },
    ]);

    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.unclassifiedLocationCount).toBe(0);
    expect(result.authoritativeEmptySnapshot).toBe(true);
    expect(isPizzarottiClassifiableLocation('')).toBe(false);
    expect(isPizzarottiClassifiableLocation('Parma, Italia')).toBe(true);
  });

  it('proves the current bare Italian InRecruiting locations are foreign', () => {
    const result = classifyPizzarottiListings([
      { href: '/jobs/parma', title: 'Site manager', location: 'Parma' },
      { href: '/jobs/ponte-taro', title: 'Construction manager', location: 'Ponte Taro' },
      { href: '/jobs/baragiano', title: 'Project manager', location: 'Baragiano' },
    ]);

    expect(result.discovered).toBe(3);
    expect(result.listings).toEqual([]);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.unclassifiedLocationCount).toBe(0);
    expect(result.authoritativeEmptySnapshot).toBe(true);
  });

  it('does not prove an empty target slice when a location is unknown', () => {
    const result = classifyPizzarottiListings([
      { href: '/jobs/unknown', title: 'Unknown role', location: 'A newly added place' },
    ]);

    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.unclassifiedLocationCount).toBe(1);
    expect(result.authoritativeEmptySnapshot).toBe(false);
  });

  it('lets a parsed-but-geographically-filtered empty snapshot pass the shrink guard', () => {
    expect(PIZZAROTTI_UPDATER).toContain('fetchPizzarottiListings(summaryCounts)');
    expect(PIZZAROTTI_UPDATER).toContain("summaryCounts.lastFetchOutcome = 'selector_miss';");
    expect(PIZZAROTTI_UPDATER).toContain(
      "skipShrinkGuard: discovery.lastFetchOutcome === 'filtered_empty',",
    );
    expect(PIZZAROTTI_UPDATER).toContain(
      'authoritativeEmptySnapshot: discovery.authoritativeEmptySnapshot === true,',
    );
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
