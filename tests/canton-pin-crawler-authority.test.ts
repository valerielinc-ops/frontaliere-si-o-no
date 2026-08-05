/**
 * Canton PIN ledger must not outrank the job's own canton (#4838, #4947).
 *
 * The pin ledger (`data/job-canton-pins.json`) exists to keep an already-indexed
 * `/cerca-lavoro-<canton>/<slug>/` URL from drifting between builds. It is a
 * tie-break signal — the best available value when the record carries no canton
 * of its own — but it used to win outright whenever `inferAnyCanton(city)` came
 * back empty, which is the normal outcome for any locality BFS does not list as
 * a municipality (a hamlet, a resort, a "Remote" placeholder).
 *
 * Bürgenstock Hotels AG is the reported instance: the crawler records canton NW
 * on all 39 postings (Obbürgen, a village inside the municipality of Stansstad),
 * BFS cannot resolve "Obbürgen", so a stale TI pin overwrote NW on every single
 * build and — because a contradicted pin was never rewritten — could never heal.
 * 28 of 39 jobs shipped `canton="TI"`: wrong URL section, wrong
 * `addressRegion` in the JobPosting (AGENTS.md Non-Negotiable #3), and Ticino
 * search pages padded with jobs that are not in Ticino.
 *
 * Measured across `data/jobs/by-crawler/` at the time of the fix: 1,188 jobs
 * across 100+ employers were relabelled this way, plus 455 where inference
 * already beat the pin but the stale value stayed in the ledger.
 *
 * These tests pin the precedence rule directly (pure function, no dataset), so
 * they fail on the pre-fix code regardless of what the live data happens to
 * contain.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveCantonAgainstPin,
  cantonFallbackLocality,
  realignCantonOnlyLocality,
  normalizeParsedJobsForSlice,
} from '../scripts/assemble-jobs-dataset.mjs';
// @ts-expect-error — plain .mjs lib, no type declarations
import { inferAnyCanton } from '../scripts/lib/target-swiss-locations.mjs';

/** Test fixtures must never carry absolute dates (AGENTS.md → test fixtures). */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('resolveCantonAgainstPin — the job outranks the ledger', () => {
  it('BFS cannot resolve "Obbürgen", so the pre-fix code froze it to the stale pin', () => {
    // Guards the premise: if BFS ever learns Obbürgen this test still holds,
    // but the bug it describes would have a second, independent fix path.
    expect(inferAnyCanton('Obbürgen')).toBeFalsy();
  });

  it('keeps the crawler canton and REWRITES a contradicting pin (#4838)', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: 'NW',
      inferredCanton: null, // Obbürgen — not a BFS municipality
      pinnedCanton: 'TI',
    });
    expect(d.canton).toBe('NW');
    expect(d.pin).toBe('NW'); // the ledger heals instead of re-losing the fix
    expect(d.outcome).toBe('pin-corrected');
  });

  it('persists the correction when inference beats the pin (was counted, never written)', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: 'BE',
      inferredCanton: 'BE',
      pinnedCanton: 'TI',
    });
    expect(d.canton).toBe('BE');
    expect(d.pin).toBe('BE');
    expect(d.outcome).toBe('pin-corrected');
  });

  it('still freezes a canton-LESS job to the pin (URL-stability guarantee kept)', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: '',
      inferredCanton: null,
      pinnedCanton: 'TI',
    });
    expect(d.canton).toBe('TI');
    expect(d.pin).toBe('TI');
    expect(d.outcome).toBe('pin-frozen');
  });

  it('is a no-op when job and pin agree', () => {
    const d = resolveCantonAgainstPin({ jobCanton: 'ZH', inferredCanton: 'ZH', pinnedCanton: 'ZH' });
    expect(d.canton).toBe('ZH');
    expect(d.outcome).toBe('pin-agrees');
  });

  it('only creates a pin for a non-empty canton backed by a confident inference', () => {
    expect(resolveCantonAgainstPin({ jobCanton: 'VD', inferredCanton: 'VD', pinnedCanton: undefined }))
      .toMatchObject({ canton: 'VD', pin: 'VD', outcome: 'pin-added' });
    // No confident city signal → do not seed the ledger with an unverified value.
    expect(resolveCantonAgainstPin({ jobCanton: 'VD', inferredCanton: null, pinnedCanton: undefined }))
      .toMatchObject({ canton: 'VD', pin: '', outcome: 'unpinned' });
    // Empty canton → pinning "" would freeze the job mis-placed forever.
    expect(resolveCantonAgainstPin({ jobCanton: '', inferredCanton: 'GE', pinnedCanton: undefined }))
      .toMatchObject({ pin: '', outcome: 'unpinned' });
  });

  it('normalises case so a lowercase crawler canton is not read as a contradiction', () => {
    expect(resolveCantonAgainstPin({ jobCanton: 'nw', inferredCanton: null, pinnedCanton: 'NW' }))
      .toMatchObject({ canton: 'NW', outcome: 'pin-agrees' });
  });
});

describe('unusable location falls back to the job\'s OWN canton, never to Ticino', () => {
  it('cantonFallbackLocality maps the canton code to its Italian label', () => {
    expect(cantonFallbackLocality({ canton: 'NW' })).toBe('Nidvaldo');
    expect(cantonFallbackLocality({ canton: 'be' })).toBe('Berna');
    // No canton on record → the funnel's primary canton stays the last resort.
    expect(cantonFallbackLocality({})).toBe('Ticino');
    expect(cantonFallbackLocality({ canton: 'ZZ' })).toBe('Ticino');
  });

  it('a prose location on a non-TI job does not relabel it Ticino', () => {
    const jobs = [
      {
        url: 'https://recruitingapp-2850.umantis.com/vacancies/1541/description/1',
        company: 'Bürgenstock Hotels AG',
        canton: 'NW',
        // Body text leaked into the location field by the parser — the case the
        // sanitizer's prose fallback exists for.
        location: 'Location: Obbürgen — home office is not possible for this role',
        crawledAt: daysAgo(2),
        datePosted: daysAgo(9),
      },
      {
        url: 'https://example.ch/jobs/1',
        company: 'Fixture SA',
        canton: '',
        location: 'undefined',
        crawledAt: daysAgo(1),
        datePosted: daysAgo(3),
      },
    ];

    normalizeParsedJobsForSlice(jobs);

    // Pre-fix this was the literal 'Ticino', which inferAnyCanton then resolved
    // to TI — flipping the canton, the URL section and the structured data.
    expect(jobs[0].location).toBe('Nidvaldo');
    expect(inferAnyCanton(jobs[0].location)).toBe('NW');
    expect(jobs[0].addressLocality).toBe('Nidvaldo');
    expect(jobs[0].addressRegion).toBe('NW');

    // A record with no canton at all keeps the historical Ticino default.
    expect(jobs[1].location).toBe('Ticino');
  });
});

describe('realignCantonOnlyLocality — a canton-name locality must name the job\'s canton', () => {
  it('rewrites a "Ticino" locality on a non-TI job to that job\'s canton label', () => {
    expect(realignCantonOnlyLocality('Ticino', 'SO')).toBe('Soletta');
    expect(realignCantonOnlyLocality('Ticino', 'NW')).toBe('Nidvaldo');
  });

  it('leaves a locality that already agrees with the canton alone', () => {
    expect(realignCantonOnlyLocality('Ticino', 'TI')).toBe('Ticino');
  });

  it('never touches a real municipality name', () => {
    expect(realignCantonOnlyLocality('Grenchen', 'SO')).toBe('Grenchen');
    expect(realignCantonOnlyLocality('Lugano', 'TI')).toBe('Lugano');
    // Even when the city sits in a different canton than the record claims:
    // that is a canton-mismatch for the inference/audit layers to adjudicate,
    // not a placeholder to overwrite.
    expect(realignCantonOnlyLocality('Bellinzona', 'SO')).toBe('Bellinzona');
  });

  it('is a no-op without a canton or without a value', () => {
    expect(realignCantonOnlyLocality('Ticino', '')).toBe('Ticino');
    expect(realignCantonOnlyLocality('', 'SO')).toBe('');
    expect(realignCantonOnlyLocality(undefined, 'SO')).toBeUndefined();
  });

  it('repairs the locality inside the slice write funnel (JobPosting jobLocation)', () => {
    // Shape produced by safeLocationToken()'s default fallback on a non-TI
    // crawler: canton correct, locality standing in as the literal "Ticino".
    const jobs = [
      {
        url: 'https://example.ch/jobs/eta-sa-1',
        company: 'ETA SA',
        canton: 'SO',
        location: 'Ticino',
        addressLocality: 'Ticino',
        crawledAt: daysAgo(1),
        datePosted: daysAgo(5),
      },
    ];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].location).toBe('Soletta');
    expect(jobs[0].addressLocality).toBe('Soletta');
    expect(jobs[0].addressRegion).toBe('SO');
    expect(inferAnyCanton(jobs[0].addressLocality)).toBe('SO');
  });
});
