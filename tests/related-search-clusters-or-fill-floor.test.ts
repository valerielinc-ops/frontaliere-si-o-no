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
import { stripSearchQueryBoilerplate } from '@/services/relatedSearchClusters';
import { normalizeSearchText, stemSearchToken } from '@/services/textUtils';

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

/**
 * SPA OR-fallback floor↔scoring consistency (issue #1109, follow-up to PR #1107).
 *
 * The SPA OR-fallback tiers in components/community/JobBoard.tsx derive their
 * relevance floor (`orFallbackMinScore`) from the CONTENT-token count of the
 * boilerplate-STRIPPED query, but used to score the RAW query against the job
 * haystack. That asymmetry let a *manually typed* boilerplate query
 * ("pizzaiolo salary switzerland", entered in the search box rather than via a
 * pre-stripped slug) reach the floor on boilerplate tokens alone — a job whose
 * haystack contains only "salary" + "switzerland" scored 2 ≥ floor 2 with zero
 * real content match. The fix scores the SAME stripped query the floor is
 * computed from. These tests lock that contract by replicating the exact SPA
 * token pipeline (strip → normalize → stem) shared by all three OR-fallback
 * tiers; if a future edit reverts to scoring the raw query, the boilerplate-only
 * haystack would score ≥ floor again and these assertions fail.
 */
describe('SPA OR-fallback floor↔scoring consistency (#1109)', () => {
  // Mirror of the JobBoard tier pipeline: boilerplate-strip the query, then
  // normalize + stem into the tokens scored against the (already stemmed)
  // haystack with a leading-space word-boundary anchor.
  const orFallbackTokens = (query: string): string[] =>
    normalizeSearchText(stripSearchQueryBoilerplate(query.trim()))
      .split(' ')
      .filter(Boolean)
      .map(stemSearchToken);

  const stemHaystack = (text: string): string =>
    ` ${normalizeSearchText(text).split(' ').filter(Boolean).map(stemSearchToken).join(' ')} `;

  const scoreAgainst = (queryTokens: string[], haystack: string): number => {
    const hay = stemHaystack(haystack);
    let score = 0;
    for (const t of queryTokens) if (hay.includes(` ${t}`)) score++;
    return score;
  };

  it('boilerplate-only query strips to its real content token (floor stays 1)', () => {
    // "pizzaiolo salary switzerland" → "pizzaiolo": a single content token, so
    // the floor stays 1 and only the role word is ever scored.
    expect(orFallbackTokens('pizzaiolo salary switzerland')).toEqual(['pizzaiol']);
  });

  it('a haystack matching ONLY boilerplate tokens no longer reaches the floor', () => {
    const queryTokens = orFallbackTokens('pizzaiolo salary switzerland');
    // A job whose haystack carries the boilerplate words (salary + switzerland)
    // but NOT the role word scores 0 — pre-fix it scored 2 (raw tokens), enough
    // to clear the floor with zero content overlap.
    expect(scoreAgainst(queryTokens, 'Salary report Switzerland office')).toBe(0);
    // The on-intent job (carries "pizzaiolo") still scores its one real token.
    expect(scoreAgainst(queryTokens, 'Pizzaiolo per ristorante')).toBe(1);
  });

  it('legitimate multi-content-token manual query is unaffected (no regression)', () => {
    // No boilerplate to strip → both real tokens survive and score normally,
    // so the floor of 2 is reachable exactly as before the fix.
    const queryTokens = orFallbackTokens('responsabile neurologia');
    expect(queryTokens).toEqual(['responsabil', 'neurolog']);
    expect(scoreAgainst(queryTokens, 'Responsabile Neurologia EOC')).toBe(2);
    expect(scoreAgainst(queryTokens, 'Responsabile Vendite')).toBe(1);
  });
});
