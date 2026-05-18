/**
 * Phase 2 (P1.3) — `CityHubKey: string` migration.
 *
 * Verifies that per-canton city-hub URLs (e.g. `/cerca-lavoro-zurigo/zurich/`)
 * now route to `{ jobBoardCanton, jobBoardCity }` via the data-driven
 * `isKnownCityHub` allowlist (sourced from `data/canton-municipalities.json`).
 *
 * **TI invariance** — the 5 legacy TI city URLs continue to resolve
 * exactly as before; their behaviour is also covered by the broader
 * suite in `tests/city-jobs-hub.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { parsePath } from '@/services/router';

describe('Phase 2 — per-canton city routing', () => {
  it('/cerca-lavoro-zurigo/zurich/ → jobBoardCanton=ZH, jobBoardCity=zurich', () => {
    const parsed = parsePath('/cerca-lavoro-zurigo/zurich/');
    expect(parsed.route.activeTab).toBe('job-board');
    expect(parsed.route.jobBoardCanton).toBe('ZH');
    expect(parsed.route.jobBoardCity).toBe('zurich');
    expect(parsed.route.jobSlug).toBeUndefined();
    expect(parsed.notFoundPath).toBeUndefined();
  });

  it('/cerca-lavoro-ginevra/geneve/ → jobBoardCanton=GE, jobBoardCity=geneve', () => {
    const parsed = parsePath('/cerca-lavoro-ginevra/geneve/');
    expect(parsed.route.activeTab).toBe('job-board');
    expect(parsed.route.jobBoardCanton).toBe('GE');
    expect(parsed.route.jobBoardCity).toBe('geneve');
    expect(parsed.route.jobSlug).toBeUndefined();
  });

  it('/cerca-lavoro-ticino/lugano/ → jobBoardCanton=TI, jobBoardCity=lugano (TI invariance)', () => {
    const parsed = parsePath('/cerca-lavoro-ticino/lugano/');
    expect(parsed.route.activeTab).toBe('job-board');
    expect(parsed.route.jobBoardCanton).toBe('TI');
    expect(parsed.route.jobBoardCity).toBe('lugano');
  });

  it('/cerca-lavoro-ticino/mendrisio/ keeps editorial slug for TI legacy compat', () => {
    const parsed = parsePath('/cerca-lavoro-ticino/mendrisio/');
    expect(parsed.route.jobBoardCity).toBe('mendrisio');
    // TI legacy branch also sets the editorial jobSlug ('ricerca-mendrisio').
    expect(parsed.route.jobSlug).toBe('ricerca-mendrisio');
  });

  it('per-canton non-city second segment falls through as jobSlug', () => {
    const parsed = parsePath('/cerca-lavoro-zurigo/software-engineer-some-company/');
    expect(parsed.route.activeTab).toBe('job-board');
    expect(parsed.route.jobBoardCanton).toBe('ZH');
    expect(parsed.route.jobBoardCity).toBeUndefined();
    expect(parsed.route.jobSlug).toBe('software-engineer-some-company');
  });

  it('aggregator /cerca-lavoro-svizzera/ resolves to _AGGREGATE_ canton', () => {
    const parsed = parsePath('/cerca-lavoro-svizzera/');
    expect(parsed.route.activeTab).toBe('job-board');
    expect(parsed.route.jobBoardCanton).toBe('_AGGREGATE_');
  });

  // Half-canton URL groups (BL+BS → BASILEA, AI+AR → APPENZELLO). Router
  // resolves the section to the virtual group code, but jobs are still
  // keyed by real BFS codes (BS, BL, …) in canton-municipalities.json.
  // `isKnownCityHub` must expand the group to its members before lookup,
  // otherwise SPA clicks on canton-index city links land on
  // "Annuncio non trovato" while new-tab opens work (the static city
  // page exists in dist/). Regression for 2026-05-18.
  it('/cerca-lavoro-basilea/basel/ → jobBoardCanton=BASILEA, jobBoardCity=basel (BS member)', () => {
    const parsed = parsePath('/cerca-lavoro-basilea/basel/');
    expect(parsed.route.jobBoardCanton).toBe('BASILEA');
    expect(parsed.route.jobBoardCity).toBe('basel');
    expect(parsed.route.jobSlug).toBeUndefined();
  });

  it('/cerca-lavoro-basilea/muttenz/ → jobBoardCanton=BASILEA, jobBoardCity=muttenz (BL member)', () => {
    const parsed = parsePath('/cerca-lavoro-basilea/muttenz/');
    expect(parsed.route.jobBoardCanton).toBe('BASILEA');
    expect(parsed.route.jobBoardCity).toBe('muttenz');
    expect(parsed.route.jobSlug).toBeUndefined();
  });

  it('/cerca-lavoro-appenzello/appenzell/ → jobBoardCanton=APPENZELLO, jobBoardCity=appenzell', () => {
    const parsed = parsePath('/cerca-lavoro-appenzello/appenzell/');
    expect(parsed.route.jobBoardCanton).toBe('APPENZELLO');
    expect(parsed.route.jobBoardCity).toBe('appenzell');
    expect(parsed.route.jobSlug).toBeUndefined();
  });
});
