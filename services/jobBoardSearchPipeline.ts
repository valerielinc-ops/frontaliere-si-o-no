export interface FrameBudgetScheduler {
  now(): number;
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface FrameBudgetedScanOptions<TItem, TAccumulator, TResult> {
  items: ReadonlyArray<TItem>;
  createAccumulator(): TAccumulator;
  /** Return false when the ordered result is already complete. */
  visit(accumulator: TAccumulator, item: TItem, index: number): boolean | void;
  finish(accumulator: TAccumulator): TResult;
  onComplete(result: TResult): void;
  scheduler?: FrameBudgetScheduler;
  frameBudgetMs?: number;
  clockCheckEvery?: number;
}

export interface FrameBudgetedScanHandle {
  cancel(): void;
}

function browserFrameScheduler(): FrameBudgetScheduler {
  return {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

/**
 * Visit an ordered collection without monopolising one browser task.
 *
 * The scan yields after a wall-clock budget, can be cancelled between frames,
 * and only publishes a complete result. The clock is sampled in small groups
 * so large JobBoard corpora do not pay one performance.now() call per record.
 */
export function scheduleFrameBudgetedScan<TItem, TAccumulator, TResult>(
  options: FrameBudgetedScanOptions<TItem, TAccumulator, TResult>,
): FrameBudgetedScanHandle {
  const scheduler = options.scheduler ?? browserFrameScheduler();
  const frameBudgetMs = options.frameBudgetMs ?? 8;
  const clockCheckEvery = Math.max(1, Math.floor(options.clockCheckEvery ?? 16));
  const accumulator = options.createAccumulator();
  let cursor = 0;
  let frameHandle = 0;
  let cancelled = false;

  const processFrame = () => {
    const deadline = scheduler.now() + frameBudgetMs;
    let sinceClockCheck = 0;
    let completeEarly = false;

    while (cursor < options.items.length) {
      const keepGoing = options.visit(accumulator, options.items[cursor], cursor);
      cursor += 1;
      if (keepGoing === false) {
        completeEarly = true;
        break;
      }
      sinceClockCheck += 1;
      if (sinceClockCheck >= clockCheckEvery) {
        sinceClockCheck = 0;
        if (scheduler.now() >= deadline) break;
      }
    }

    if (cancelled) return;
    if (!completeEarly && cursor < options.items.length) {
      frameHandle = scheduler.request(processFrame);
      return;
    }
    options.onComplete(options.finish(accumulator));
  };

  frameHandle = scheduler.request(processFrame);
  return {
    cancel() {
      cancelled = true;
      if (frameHandle) scheduler.cancel(frameHandle);
    },
  };
}

export interface RankedCandidate<T> {
  value: T;
  score: number;
  sourceIndex: number;
}

/**
 * Keep only the best ordered candidates while a scan is running.
 *
 * This is equivalent to a stable `score desc` sort followed by `slice(0, N)`:
 * ties retain source order, but the synchronous finalisation cost is bounded by
 * `limit` instead of sorting every match in a 10k–30k record corpus.
 */
export function offerBoundedRankedCandidate<T>(
  ranked: RankedCandidate<T>[],
  candidate: RankedCandidate<T>,
  limit: number,
): void {
  if (limit <= 0) return;
  const insertionIndex = ranked.findIndex((current) => (
    candidate.score > current.score
    || (candidate.score === current.score && candidate.sourceIndex < current.sourceIndex)
  ));
  if (insertionIndex < 0) ranked.push(candidate);
  else ranked.splice(insertionIndex, 0, candidate);
  if (ranked.length > limit) ranked.pop();
}

export function rankedCandidateValues<T>(ranked: ReadonlyArray<RankedCandidate<T>>): T[] {
  return ranked.map(({ value }) => value);
}
