/**
 * The JobBoard search index is built incrementally over the loaded jobs, and
 * until it covers every job `indexedQueryMatch` reads an empty haystack — so
 * every tier reports ZERO matches for any query. That window is a documented
 * property of the build, not an answer about the corpus.
 *
 * Two contracts are guarded here, both measured on
 * /cerca-lavoro-svizzera/ricerca-offerte-lavoro-assistente-psicologo/:
 *
 *  1. The lazy corpus-fetch tiers must not read that provisional zero as
 *     "nothing found, go fetch more corpus". They did: the cross-locale tier
 *     fired in 4 runs out of 4 and pulled the DE/FR/EN slim indexes — 7,16 MB
 *     over the wire, ~50 MB of JSON parsed — and the results were discarded,
 *     because once the index completed the strict tier had had 8 matches all
 *     along. The guard is `searchIndexPending`, and it has to appear BOTH as an
 *     early return and as an effect dependency: without the dep, a genuinely
 *     empty search would never re-run the effect once the index completed and
 *     the fallback would never fire at all.
 *
 *  2. The builder must be time-budgeted, not fixed-count. At 50 jobs per rAF
 *     frame the wall clock is a function of the frame COUNT, not of the work:
 *     the 14.700-job aggregate board took ~294 frames ≈ 4,9 s before it could
 *     show a first result, however cheap each job became.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../components/community/JobBoard.tsx'),
  'utf8',
);

/** Body of the useEffect whose first statement matches `anchor`. */
function effectBodyAfter(anchor: string): string {
  const at = SRC.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  // Up to the dependency array that closes the effect.
  const end = SRC.indexOf('}, [', at);
  expect(end, `effect close not found after: ${anchor}`).toBeGreaterThan(at);
  const depsEnd = SRC.indexOf(']);', end);
  return SRC.slice(at, depsEnd);
}

describe('search-index gating of the lazy corpus-fetch tiers', () => {
  it('derives one shared pending flag from an active query + a stale index', () => {
    const decl = SRC.match(/const searchIndexPending = [\s\S]{0,200}?;/);
    expect(decl, 'searchIndexPending must be declared').not.toBeNull();
    const text = decl![0];
    expect(text).toContain('deferredSearchQuery.trim()');
    // Identity of the (jobs, locale) pair the committed index was built from —
    // NOT a size comparison. The map is keyed by job object, so an array
    // replaced by one of the same length (job-detail enrichment re-creates one
    // job) or a locale switch leaves every key stale while `size` still
    // matches: a size check calls that "complete" and lets the tiers fire.
    expect(text).toContain('searchIndex.jobs !== sortedJobs');
    expect(text).toContain('searchIndex.locale !== locale');
    expect(text).not.toContain('searchIndex.size');
    // Exactly one definition: the skeleton and the fetch tiers must not drift.
    expect(SRC.match(/const searchIndexPending =/g)).toHaveLength(1);
  });

  it('commits the index together with the (jobs, locale) pair it describes', () => {
    // One state value, so the map and the pair it describes cannot diverge.
    expect(SRC).toContain('setSearchIndex({ map, jobs: sortedJobs, locale })');
    expect(SRC.match(/setSearchIndex\(/g)).toHaveLength(1);
  });

  it('gates the cross-locale tier (DE/FR/EN slim indexes) on it', () => {
    const body = effectBodyAfter('if (crossLocaleFetchAttempted.current) return;');
    expect(body).toContain('if (searchIndexPending) return;');
    expect(body).toContain('searchIndexPending,');
  });

  it('gates the same-locale cross-canton broaden on it', () => {
    const body = effectBodyAfter('if (searchBroadenFetchAttempted.current) return;');
    expect(body).toContain('if (searchIndexPending) return;');
    // Anchored to the neighbouring dep: a bare `searchIndexPending` substring
    // is already satisfied by the early return above, so it would pass with the
    // dependency deleted — and without the dep a genuinely thin search never
    // re-runs the effect once the index lands, so the broaden never fires.
    expect(body).toContain('loadUnscopedPool, searchIndexPending');
  });

  it('keeps the loading skeleton on the same flag', () => {
    expect(SRC).toContain('|| searchIndexPending');
  });
});

describe('search-index builder', () => {
  const BUILDER = effectBodyAfter('const map = new Map<JobListing, string>();');

  it('fills a time budget instead of a fixed job count per frame', () => {
    expect(BUILDER).toContain('FRAME_BUDGET_MS');
    expect(BUILDER).toContain('performance.now() >= deadline');
    // The frame-bound shape that made 14.700 jobs cost ~4,9 s regardless of
    // per-job cost. Its return would silently undo the fix.
    expect(BUILDER).not.toMatch(/CHUNK_SIZE\s*=\s*\d+/);
    // The clock is only sampled every (MASK+1) jobs, so MASK+1 is the per-frame
    // FLOOR. It has to stay under the fixed 50 it replaced, or a slow device
    // blocks a frame for longer than before the "time-sliced" change.
    const mask = /CLOCK_CHECK_MASK = (\d+)/.exec(BUILDER);
    expect(mask, 'CLOCK_CHECK_MASK must be declared').not.toBeNull();
    expect(Number(mask![1]) + 1).toBeLessThan(50);
  });

  it('drops a partial index on cancel instead of publishing it', () => {
    expect(BUILDER).toContain('cancelAnimationFrame');
    expect(BUILDER).toContain('if (cancelled) return;');
    // The old cleanup fast-forwarded the cursor, which made the already-queued
    // frame take the "done" branch and commit a half-built index.
    expect(BUILDER).not.toContain('i = sortedJobs.length;');
  });
});
