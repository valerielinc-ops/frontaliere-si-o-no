// @vitest-environment node

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyPizzarottiListings,
  isPizzarottiClassifiableLocation,
  parsePizzarottiListings,
  parsePizzarottiJobDetail,
  resolvePizzarottiDetailUrl,
  resolvePizzarottiLocation,
} from '../scripts/lib/pizzarotti-job-parser.mjs';

const PIZZAROTTI_UPDATER = fs.readFileSync(
  new URL('../scripts/update-pizzarotti-jobs.mjs', import.meta.url),
  'utf8',
);

describe('Pizzarotti listing classification', () => {
  it('resolves relative InRecruiting detail links before fetching them', () => {
    const baseUrl = 'https://inrecruiting.intervieweb.it/app.php?module=iframeAnnunci';

    expect(resolvePizzarottiDetailUrl('/impresapizzarotti/job/123', baseUrl)).toBe(
      'https://inrecruiting.intervieweb.it/impresapizzarotti/job/123',
    );
    expect(resolvePizzarottiDetailUrl(
      'https://inrecruiting.intervieweb.it/impresapizzarotti/job/123',
      baseUrl,
    )).toBe('https://inrecruiting.intervieweb.it/impresapizzarotti/job/123');
    expect(PIZZAROTTI_UPDATER).toContain(
      'resolvePizzarottiDetailUrl(listing.href, LISTING_BASE_URL)',
    );
    expect(PIZZAROTTI_UPDATER).toContain(
      'const sourceUrl = resolvePizzarottiDetailUrl(detail.shareUrl || listing.href, LISTING_BASE_URL);',
    );
  });

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

  it('recovers a missing Sede from the Pizzarotti teaser without treating an Italian province code as Swiss', () => {
    const listings = parsePizzarottiListings(`
      <div class="vacancy__render">
        <div class="vacancy__title"><h3><a href="/jobs/aspp-ctg">ASPP - CTG</a></h3></div>
        <div class="vacancy__description">L'Impresa Pizzarotti ricerca un* ASPP con sede a Campomorone (GE). Il ruolo prevede le seguenti attività.</div>
      </div>
    `);

    expect(listings[0].location).toBe('Campomorone');
    const result = classifyPizzarottiListings(listings);

    expect(result.listings).toEqual([]);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.unclassifiedLocationCount).toBe(0);
    expect(result.authoritativeEmptySnapshot).toBe(true);
  });

  it('preserves periods inside Swiss teaser locations', () => {
    const listings = parsePizzarottiListings(`
      <div class="vacancy__render">
        <div class="vacancy__title"><h3><a href="/jobs/st-gallen">Site manager</a></h3></div>
        <div class="vacancy__description">Impresa Pizzarotti ricerca un* Site manager con sede a St. Gallen (SG). Il ruolo prevede le seguenti attività.</div>
      </div>
    `);

    expect(listings[0].location).toBe('St. Gallen');
    const result = classifyPizzarottiListings(listings);

    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].location).toBe('St. Gallen');
    expect(result.lastFetchOutcome).toBe('ok');
  });

  it('preserves the St. abbreviation when the teaser omits the region code', () => {
    const listings = parsePizzarottiListings(`
      <div class="vacancy__render">
        <div class="vacancy__title"><h3><a href="/jobs/st-gallen-no-region">Site manager</a></h3></div>
        <div class="vacancy__description">Impresa Pizzarotti ricerca un* Site manager con sede a St. Gallen. Il ruolo prevede le seguenti attività.</div>
      </div>
    `);

    expect(listings[0].location).toBe('St. Gallen');
    const result = classifyPizzarottiListings(listings);

    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].location).toBe('St. Gallen');
    expect(result.lastFetchOutcome).toBe('ok');
  });

  it('uses the explicit detail workplace when a listing card has no location', () => {
    const listings = parsePizzarottiListings(`
      <div class="vacancy__render">
        <div class="vacancy__title"><h3><a href="/jobs/detail-location">Site manager</a></h3></div>
        <div class="vacancy__description">Impresa Pizzarotti ricerca un* Site manager per un nuovo progetto infrastrutturale.</div>
      </div>
    `);
    const detail = parsePizzarottiJobDetail(`
      <div id="description__vacancy-title">Site manager</div>
      <div id="description__subtitle">
        <span class="subtitle__informations" title="Azienda">Impresa Pizzarotti &amp; C. S.p.A.</span>
        <span class="subtitle__informations" title="Sede">Italia</span>
        <span class="subtitle__informations" title="Professione/Funzione">Direzione Cantiere</span>
      </div>
      <div id="description__body">
        <h3 class="body__headings">Altre informazioni</h3>
        <div class="body__text"><p>Luogo di lavoro: Lugano (TI).</p></div>
      </div>
    `);

    expect(listings[0].location).toBe('');
    expect(detail.location).toBe('Lugano (TI)');

    const resolved = { ...listings[0], location: resolvePizzarottiLocation(listings[0], detail) };
    const result = classifyPizzarottiListings([resolved]);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].location).toBe('Lugano (TI)');
    expect(result.unclassifiedLocationCount).toBe(0);
  });

  it('keeps a more specific listing location when a detail subtitle only names the country', () => {
    const resolved = resolvePizzarottiLocation(
      { location: 'Campomorone (GE)' },
      { location: 'Italia' },
    );

    expect(resolved).toBe('Campomorone (GE)');
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
