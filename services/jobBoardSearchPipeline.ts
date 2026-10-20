import { RELATED_SEARCH_STOPWORDS, sanitizeJobTitle } from './relatedSearchClusters';
import { getJobSearchRoleTokens } from './jobSearchRelevance';
import { normalizeSearchText, stemSearchToken } from './textUtils';

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

export interface JobBoardSearchSurfaceItem {
  readonly title?: string;
  readonly titleByLocale?: Partial<Record<string, string>>;
  readonly company?: string;
  readonly location?: string;
  readonly addressLocality?: string;
}

/** Add the non-ambiguous location vocabulary used to remove cities from role intent. */
export function addJobSearchLocationTokens(
  target: Set<string>,
  job: JobBoardSearchSurfaceItem,
): void {
  const location = `${job.addressLocality || ''} ${job.location || ''}`;
  for (const token of normalizeSearchText(location).split(' ')) {
    if (!token) continue;
    const stem = stemSearchToken(token);
    if (stem.length <= 3 || RELATED_SEARCH_STOPWORDS.has(stem)) continue;
    target.add(stem);
  }
}

export function collectJobSearchLocationTokens(
  jobs: ReadonlyArray<JobBoardSearchSurfaceItem>,
  tokens = new Set<string>(),
): Set<string> {
  for (const job of jobs) addJobSearchLocationTokens(tokens, job);
  return tokens;
}

/** Keep location words out of the occupation predicate before the full index exists. */
export function deriveJobBoardOccupationTerms(
  query: string,
  locationTokens: ReadonlySet<string>,
): string[] {
  return getJobSearchRoleTokens(query).filter((token) => !locationTokens.has(token));
}

/** A cancelled in-flight fallback may retry; a settled one remains terminal. */
export function shouldRearmCancelledFetchAttempt(
  cancelled: boolean,
  attemptSettled: boolean,
): boolean {
  return cancelled && !attemptSettled;
}

/**
 * Autocomplete over a bounded result seed. Cluster seeds contain at most 30
 * records, so this keeps suggestions available without starting a corpus scan.
 */
export function addJobBoardAutocompleteSuggestions(
  suggestions: string[],
  seen: Set<string>,
  job: JobBoardSearchSurfaceItem,
  query: string,
  locale: string,
  limit = 5,
): void {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < 2 || limit <= 0 || suggestions.length >= limit) return;
  const add = (raw: string) => {
    const clean = raw.trim();
    const key = clean.toLowerCase();
    if (!clean || key === normalizedQuery || seen.has(key)) return;
    seen.add(key);
    suggestions.push(clean);
  };

  const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title ?? '')
    .split(/[-–—|•·]/)[0]?.trim() || '';
  const company = String(job.company || '').trim();
  const location = String(job.location || '').trim();
  if (title.toLowerCase().startsWith(normalizedQuery)) add(title);
  if (suggestions.length < limit && company.toLowerCase().startsWith(normalizedQuery)) add(company);
  if (suggestions.length < limit && location.toLowerCase().startsWith(normalizedQuery)) add(location);
}

export function deriveJobBoardAutocompleteSuggestions(
  jobs: ReadonlyArray<JobBoardSearchSurfaceItem>,
  query: string,
  locale: string,
  limit = 5,
): string[] {
  const suggestions: string[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    addJobBoardAutocompleteSuggestions(suggestions, seen, job, query, locale, limit);
    if (suggestions.length >= limit) break;
  }
  return suggestions.slice(0, limit);
}
