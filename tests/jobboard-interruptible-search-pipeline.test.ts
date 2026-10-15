import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectJobSearchLocationTokens,
  deriveJobBoardOccupationTerms,
  deriveJobBoardAutocompleteSuggestions,
  offerBoundedRankedCandidate,
  rankedCandidateValues,
  scheduleFrameBudgetedScan,
  type FrameBudgetScheduler,
} from '@/services/jobBoardSearchPipeline';
import { getJobSearchRoleTokens, matchesJobOccupation } from '@/services/jobSearchRelevance';
import { stemSearchToken } from '@/services/textUtils';

class FakeFrameScheduler implements FrameBudgetScheduler {
  clock = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();

  now(): number { return this.clock; }

  request(callback: () => void): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void { this.callbacks.delete(handle); }

  flushOne(): boolean {
    const next = this.callbacks.entries().next();
    if (next.done) return false;
    const [handle, callback] = next.value;
    this.callbacks.delete(handle);
    callback();
    return true;
  }
}

describe('JobBoard frame-budgeted result derivation', () => {
  it('preserves source order while yielding a 12k-record scan every 16 slow visits', () => {
    const scheduler = new FakeFrameScheduler();
    const source = Array.from({ length: 12_000 }, (_, id) => id);
    let visitsThisFrame = 0;
    let maxVisitsInFrame = 0;
    let frames = 0;
    let published: number[] | null = null;

    scheduleFrameBudgetedScan({
      items: source,
      scheduler,
      frameBudgetMs: 8,
      clockCheckEvery: 16,
      createAccumulator: () => [] as number[],
      visit: (accumulator, item) => {
        accumulator.push(item);
        visitsThisFrame += 1;
        scheduler.clock += 1;
      },
      finish: (accumulator) => accumulator,
      onComplete: (result) => { published = result; },
    });

    while (true) {
      visitsThisFrame = 0;
      if (!scheduler.flushOne()) break;
      frames += 1;
      maxVisitsInFrame = Math.max(maxVisitsInFrame, visitsThisFrame);
    }

    expect(published).toEqual(source);
    expect(frames).toBeGreaterThan(1);
    expect(maxVisitsInFrame).toBe(16);
  });

  it('drops a superseded partial result and never publishes it', () => {
    const scheduler = new FakeFrameScheduler();
    let published = false;
    const scan = scheduleFrameBudgetedScan({
      items: Array.from({ length: 1_000 }, (_, id) => id),
      scheduler,
      frameBudgetMs: 8,
      clockCheckEvery: 16,
      createAccumulator: () => [] as number[],
      visit: (accumulator, item) => {
        accumulator.push(item);
        scheduler.clock += 1;
      },
      finish: (accumulator) => accumulator,
      onComplete: () => { published = true; },
    });

    expect(scheduler.flushOne()).toBe(true);
    scan.cancel();
    while (scheduler.flushOne()) { /* drain callbacks, if any */ }
    expect(published).toBe(false);
  });

  it('supports an ordered early stop for the company tier', () => {
    const scheduler = new FakeFrameScheduler();
    let visits = 0;
    let published: number[] | null = null;
    scheduleFrameBudgetedScan({
      items: Array.from({ length: 20_000 }, (_, id) => id),
      scheduler,
      createAccumulator: () => [] as number[],
      visit: (accumulator, item) => {
        visits += 1;
        accumulator.push(item);
        return accumulator.length < 30;
      },
      finish: (accumulator) => accumulator,
      onComplete: (result) => { published = result; },
    });
    while (scheduler.flushOne()) { /* run to completion */ }

    expect(visits).toBe(30);
    expect(published).toEqual(Array.from({ length: 30 }, (_, id) => id));
  });
});

describe('JobBoard fallback ordering fixture', () => {
  it('matches stable score-desc sorting and caps the retained tail', () => {
    const ranked: Array<{ value: string; score: number; sourceIndex: number }> = [];
    const fixture = [
      { value: 'first-low', score: 1 },
      { value: 'first-high', score: 3 },
      { value: 'second-high', score: 3 },
      { value: 'middle', score: 2 },
      { value: 'late-low', score: 1 },
    ];
    fixture.forEach((candidate, sourceIndex) => {
      offerBoundedRankedCandidate(ranked, { ...candidate, sourceIndex }, 4);
    });

    expect(rankedCandidateValues(ranked)).toEqual([
      'first-high',
      'second-high',
      'middle',
      'first-low',
    ]);
  });
});

describe('JobBoard wiring preserves public surfaces while derivation is pending', () => {
  const source = readFileSync(resolve(__dirname, '../components/community/JobBoard.tsx'), 'utf8');

  it('moves every result tier onto the interruptible scan', () => {
    expect(source).toContain('const inCantonDerivation = useInterruptibleDerivation');
    expect(source).toContain('const crossCantonDerivation = useInterruptibleDerivation');
    expect(source).toContain('const crossLocaleDerivation = useInterruptibleDerivation');
    expect(source).toContain('const companyFallbackDerivation = useInterruptibleDerivation');
    expect(source).toContain('const resultDerivationPending =');
    expect(source).toContain('enabled: unseededSearchPipelineEnabled && !searchIndexPending');
  });

  it('keeps URL/SEO, accessible status and ad placement on settled results', () => {
    expect(source).toContain('syncQueryParamsToUrl({ q: deferredSearchQuery.trim() })');
    expect(source).toContain('updateJobBoardListingMetadata(locale, initialFilterCanton || \'TI\', filteredJobs.length)');
    expect(source).toContain('if (resultDerivationPending) return;');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('shouldPlaceInfeedAd(pos, {');
    expect(source).toContain('renderInfeedAd(`main-${idx}`');
  });
});

describe('JobBoard cluster-seed handoff', () => {
  const source = readFileSync(resolve(__dirname, '../components/community/JobBoard.tsx'), 'utf8');

  it('keeps every broaden/fallback fetch and scan dormant while the seed is authoritative', () => {
    // Three search scans: in-canton, cross-canton and cross-locale. The seed is
    // already the build's ranked answer, so none may consume the deliberately
    // empty in-canton derivation as a miss.
    expect(source.match(/enabled: unseededSearchPipelineEnabled/g)).toHaveLength(3);
    // Both network effects (same-locale broaden and DE/FR/EN cross-locale) have
    // the same early return, and the fallback haystack index receives no items.
    expect(source.match(/if \(!unseededSearchPipelineEnabled\) return;/g)).toHaveLength(2);
    expect(source).toContain('if (!unseededSearchPipelineEnabled) return [];');
    expect(source).toContain('const unseededSearchPipelineEnabled = !clusterSeedApplies;');
  });

  it('recognises seed locations before the asynchronous corpus index commits', () => {
    const seedJobs = [{ location: 'Sementina', addressLocality: 'Sementina' }];
    const locationTokens = collectJobSearchLocationTokens(seedJobs);
    const cityStem = stemSearchToken('sementina');
    const rawRoleTerms = getJobSearchRoleTokens('infermiere sementina');

    expect(locationTokens.has(cityStem)).toBe(true);
    expect(rawRoleTerms).toContain(cityStem);
    expect(rawRoleTerms.filter((token) => !locationTokens.has(token))).not.toContain(cityStem);
    expect(source).toContain('collectJobSearchLocationTokens(clusterSeedJobs, set)');
  });

  it('keeps the seed job through passingNonSearchFilters while the index is incomplete', () => {
    const seedJob = {
      title: 'Infermiere di reparto',
      company: 'Clinica Seed',
      location: 'Sementina',
      addressLocality: 'Sementina',
    };
    const query = 'infermiere sementina';
    const searchIndexCurrent = false;
    const searchIndexLocationTokens = new Set<string>();
    const searchLocationTokens = collectJobSearchLocationTokens(
      [seedJob],
      searchIndexCurrent ? searchIndexLocationTokens : new Set<string>(),
    );
    const occupationTerms = deriveJobBoardOccupationTerms(query, searchLocationTokens);

    const passingNonSearchFilters = (job: typeof seedJob) => (
      matchesJobOccupation(job, 'it', occupationTerms)
    );

    expect(searchIndexCurrent).toBe(false);
    expect(searchIndexLocationTokens.size).toBe(0);
    expect(getJobSearchRoleTokens(query)).toContain(stemSearchToken('sementina'));
    expect(occupationTerms).not.toContain(stemSearchToken('sementina'));
    expect(passingNonSearchFilters(seedJob)).toBe(true);
    expect(matchesJobOccupation(seedJob, 'it', getJobSearchRoleTokens(query))).toBe(false);
    expect(source).toContain('if (!matchesJobOccupation(job, locale, occupationTerms)) return false;');
  });

  it('keeps autocomplete and related suggestions populated from the bounded seed', () => {
    const seedJobs = [
      { title: 'Infermiere specializzato', company: 'Clinica Seed', location: 'Lugano' },
      { title: 'Infermiere di cure generali', company: 'Ospedale Seed', location: 'Bellinzona' },
    ];

    expect(deriveJobBoardAutocompleteSuggestions(seedJobs, 'inf', 'it')).toEqual([
      'Infermiere specializzato',
      'Infermiere di cure generali',
    ]);
    expect(source).toContain('const matching = clusterSeedApplies ? clusterSeedJobs : inCantonDerivation.value.queryMatches;');
    expect(source).toContain('const autocompleteSuggestions = clusterSeedApplies');
    expect(source).toContain('deriveJobBoardAutocompleteSuggestions(clusterSeedJobs, deferredSearchQuery, locale)');
  });
});
