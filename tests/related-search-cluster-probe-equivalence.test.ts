// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TokenIndex,
  buildClusterContext,
  isClusterBelowFloor,
  renderClusterPage,
} from '../build-plugins/relatedSearchClustersPlugin';
import type {
  CandidateEntry,
  EnrichedEntry,
  RawJob,
} from '../build-plugins/relatedSearchClustersData';
import { SPA_ENTRY_CSS_FILENAME, SPA_ENTRY_JS_FILENAME } from '../build-plugins/shared/spaEntryFilenames';

const tmpDirs: string[] = [];

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-probe-'));
  tmpDirs.push(dir);
  const assetsDir = join(dir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, SPA_ENTRY_JS_FILENAME), 'console.log(1)', 'utf8');
  writeFileSync(join(assetsDir, SPA_ENTRY_CSS_FILENAME), 'body{}', 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JOBS: RawJob[] = [
  { id: 'alpha-beta', title: 'Alpha Beta', company: 'A', location: 'Lugano', canton: 'TI' },
  { id: 'alpha-gamma', title: 'Alpha Gamma', company: 'B', location: 'Lugano', canton: 'TI' },
  { id: 'beta-gamma', title: 'Beta Gamma', company: 'C', location: 'Lugano', canton: 'TI' },
];

const CANDIDATES: CandidateEntry[] = [
  {
    slug: 'ricerca-alpha-beta-gamma-lugano',
    locale: 'it',
    jobCount: 3,
    sampleTerms: ['alpha beta gamma Lugano'],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-alpha-beta-lugano',
    locale: 'it',
    jobCount: 2,
    sampleTerms: ['alpha beta Lugano'],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-ghost-lugano',
    locale: 'it',
    jobCount: 1,
    sampleTerms: ['ghost Lugano'],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-empty',
    locale: 'it',
    jobCount: 1,
    sampleTerms: [],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-alpha-beta-delta-lugano',
    locale: 'it',
    jobCount: 1,
    sampleTerms: ['alpha beta delta Lugano'],
    editorialCollision: null,
  },
];

const ENRICHED: Record<string, EnrichedEntry> = {
  'it::ricerca-ghost-lugano': {
    slug: 'ricerca-ghost-lugano',
    locale: 'it',
    keyword: 'ghost',
    city: 'Lugano',
    intro: 'Questa descrizione reale della ricerca aiuta chi vuole confrontare ruoli, aziende e condizioni di lavoro nel territorio svizzero. Riassume il tipo di posizione, la sede, gli aspetti da verificare prima della candidatura, le domande da porre al datore di lavoro e i criteri utili per valutare un percorso professionale come frontaliere. Il testo offre contesto autonomo e non è un segnaposto generato dal prompt.',
    faqs: [],
  },
};

function fullContext(candidate: CandidateEntry): ReturnType<typeof buildClusterContext> {
  return buildClusterContext(candidate, new TokenIndex(JOBS), JOBS);
}

function probedContext(candidate: CandidateEntry): ReturnType<typeof buildClusterContext> {
  const index = new TokenIndex(JOBS);
  const probe = buildClusterContext(candidate, index, JOBS, {
    maxJobs: 3,
    stopWhenAtLeast: 3,
  });
  if (!probe) return null;

  const enriched = ENRICHED[`${candidate.locale}::${candidate.slug}`];
  // A probe that did not reach the cap has enumerated the complete result. If
  // it reached the cap, the shared floor predicate says this is not a bridge;
  // rebuild only that case to recover the exact n=30 ordering/content.
  if (probe.matchingJobs.length < 3 || isClusterBelowFloor(probe, enriched)) return probe;
  return buildClusterContext(candidate, index, JOBS);
}

function pageDigest(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

function renderSet(
  contexts: ReadonlyArray<NonNullable<ReturnType<typeof fullContext>>>,
): Map<string, string> {
  const distDir = makeDist();
  return new Map(contexts.map((ctx) => {
    const enriched = ENRICHED[`${ctx.candidate.locale}::${ctx.candidate.slug}`];
    const page = renderClusterPage({
      distDir,
      dateStamp: '2026-10-06',
      ctx,
      enriched,
      hreflang: [],
      related: [],
    });
    return [page.urlPath, pageDigest(page.html)];
  }));
}

describe('related-search cluster floor probe', () => {
  it('keeps the emitted URL set and rendered HTML byte-equivalent', () => {
    const baseline = CANDIDATES.map(fullContext).filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== null);
    const optimized = CANDIDATES.map(probedContext).filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== null);

    expect(optimized.map((ctx) => [ctx.candidate.slug, ctx.matchingJobs.map((job) => job.id)])).toEqual(
      baseline.map((ctx) => [ctx.candidate.slug, ctx.matchingJobs.map((job) => job.id)]),
    );

    const baselinePages = renderSet(baseline);
    const optimizedPages = renderSet(optimized);
    expect([...optimizedPages.keys()].sort()).toEqual([...baselinePages.keys()].sort());
    for (const [url, digest] of baselinePages) expect(optimizedPages.get(url)).toBe(digest);
    expect(baselinePages.size).toBeGreaterThan(0);
  });

  it('retains a zero-match enriched page and a below-floor bridge', () => {
    const enriched = probedContext(CANDIDATES[2]);
    const bridge = probedContext(CANDIDATES[1]);
    expect(enriched?.matchingJobs).toHaveLength(0);
    expect(bridge?.matchingJobs).toHaveLength(1);
    expect(isClusterBelowFloor(enriched!, ENRICHED['it::ricerca-ghost-lugano'])).toBe(false);
    expect(isClusterBelowFloor(bridge!, undefined)).toBe(true);
  });
});

describe('TokenIndex floor probe API', () => {
  it('can stop after the first three valid OR matches', () => {
    const index = new TokenIndex(JOBS);
    index.seedPostings('it', [
      { token: 'alpha', list: [0, 1] },
      { token: 'beta', list: [0, 2] },
      { token: 'gamma', list: [1, 2] },
    ]);
    expect(index.matchingOccupationJobs('it', ['alpha', 'beta', 'gamma'], 3, 2, [], {
      stopWhenAtLeast: 3,
    })).toHaveLength(3);
  });
});
