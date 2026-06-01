/**
 * Regression gate for the OR-fill relevance floor in the related-search
 * cluster matcher (issue #1053, follow-up to PR #1038).
 *
 * PR #1038 introduced an asymmetric floor so OR-fill no longer floods a
 * multi-content-token query (e.g. "responsabile neurologia") with listings
 * that match only the generic role word ("responsabile") while missing the
 * domain word ("neurologia"). The reviewer flagged that without a CI gate a
 * future change to `fillOrMatches` / `buildClusterContext` could silently
 * bypass the floor with no test failing. These tests close that loop:
 *
 *   1. `TokenIndex.matchingJobs(..., minOrScore)` — the floor mechanic:
 *      minOrScore=2 drops single-token OR matches; minOrScore=1 keeps them.
 *   2. `buildClusterContext` — the floor *derivation*: a multi-content-token
 *      keyword gets minOrScore=2 (off-topic single-token listings suppressed),
 *      while a city-stripped single-content-token keyword keeps minOrScore=1
 *      (legitimate city-drop recovery preserved).
 */

import { describe, expect, it } from 'vitest';
import {
  TokenIndex,
  buildClusterContext,
} from '../build-plugins/relatedSearchClustersPlugin';
import type {
  CandidateEntry,
  RawJob,
} from '../build-plugins/relatedSearchClustersData';

// Synthetic corpus exercising the floor:
//   - and        → matches BOTH "responsabile" and "neurologia" (AND core)
//   - respOnly   → matches ONLY "responsabile" (off-topic for the domain query)
//   - neuroOnly  → matches ONLY "neurologia"
//   - infOnly    → matches ONLY "infermiere" (no city token)
const JOBS: RawJob[] = [
  { id: 'and', title: 'Responsabile Neurologia', company: 'Ente Ospedaliero', location: 'Bellinzona', canton: 'TI' },
  { id: 'respOnly', title: 'Responsabile Vendite', company: 'Coop', location: 'Bellinzona', canton: 'TI' },
  { id: 'neuroOnly', title: 'Caposala Neurologia', company: 'EOC', location: 'Bellinzona', canton: 'TI' },
  { id: 'infOnly', title: 'Infermiere', company: 'Clinica', location: 'Bellinzona', canton: 'TI' },
];

function ids(jobs: ReadonlyArray<RawJob>): string[] {
  return jobs.map((j) => j.id ?? '').sort();
}

function makeCandidate(sampleTerm: string): CandidateEntry {
  return {
    slug: `ricerca-${sampleTerm.replace(/\s+/g, '-')}`,
    locale: 'it',
    jobCount: 1,
    sampleTerms: [sampleTerm],
    editorialCollision: null,
  };
}

describe('OR-fill relevance floor — TokenIndex.matchingJobs', () => {
  it('minOrScore=2 drops single-token OR matches (keeps only the AND core)', () => {
    const index = new TokenIndex(JOBS);
    const matching = index.matchingJobs('it', ['responsabile', 'neurologia'], 30, 2);
    // Only the job matching BOTH tokens survives — the single-token
    // "responsabile"/"neurologia" listings are below the floor.
    expect(ids(matching)).toEqual(['and']);
  });

  it('minOrScore=1 recovers single-token OR matches', () => {
    const index = new TokenIndex(JOBS);
    const matching = index.matchingJobs('it', ['responsabile', 'neurologia'], 30, 1);
    expect(ids(matching)).toEqual(['and', 'neuroOnly', 'respOnly']);
  });
});

describe('OR-fill relevance floor — buildClusterContext derivation', () => {
  it('multi-content-token keyword suppresses off-topic single-token listings', () => {
    const index = new TokenIndex(JOBS);
    const ctx = buildClusterContext(makeCandidate('responsabile neurologia'), index, JOBS);
    expect(ctx).not.toBeNull();
    // keywordTokenCount=2 → minOrScore=2 → "responsabile"-only and
    // "neurologia"-only listings never get OR-filled in.
    expect(ids(ctx!.matchingJobs)).toEqual(['and']);
  });

  it('city-stripped single-content-token keyword preserves city-drop recovery', () => {
    const index = new TokenIndex(JOBS);
    // "Lugano" is a known city → stripped → keyword "infermiere" (1 token) →
    // minOrScore=1, so the "infermiere"-only job is recovered even though no
    // job carries the dropped city token.
    const ctx = buildClusterContext(makeCandidate('infermiere Lugano'), index, JOBS);
    expect(ctx).not.toBeNull();
    expect(ids(ctx!.matchingJobs)).toEqual(['infOnly']);
  });
});
