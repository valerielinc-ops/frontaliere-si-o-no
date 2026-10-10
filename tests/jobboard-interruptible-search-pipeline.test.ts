import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  offerBoundedRankedCandidate,
  rankedCandidateValues,
  scheduleFrameBudgetedScan,
  type FrameBudgetScheduler,
} from '@/services/jobBoardSearchPipeline';

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
    expect(source).toContain('enabled: !searchIndexPending && !clusterSeedApplies');
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
