import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * OBSERVER — "Template crawler: uscita senza pubblicazione senza nome, o prova
 * di zero accettata senza timbro del parser".
 *
 * Two halves of one contract in `runStandardCrawlerPipeline`:
 *
 *   1. every run that ends without publishing names its bail-out in
 *      `counts.abortKind` (the exit guard copies it into the summary slice).
 *      Before, the missing-detail-URL exit and the all-thin exit left `null`
 *      and the monitor could only say "cause not reported" (holmes-place,
 *      premiumpflege24);
 *   2. an empty batch stamped by `markAuthoritativeEmptySnapshot` is a proof on
 *      its own — no runner wiring — while everything that is NOT that exact
 *      stamped array stays fail-closed. The second direction is the dangerous
 *      one: an honoured zero skips the anti-shrink guard and retires every
 *      stored job in the same run.
 *
 * Same module mocks as crawler-template-authoritative-empty.test.ts: the
 * pipeline runs for real, without I/O or network.
 */
const COMPANY_KEY = 'zero-outcome-test';

const mocks = vi.hoisted(() => ({
  archiveRemovedJobsToSlice: vi.fn((jobs: object[]) => jobs.length),
  assembleJobsDataset: vi.fn(async () => undefined),
  readExistingCrawlerJobs: vi.fn((): object[] => []),
  runDedicatedBaseCrawler: vi.fn(async () => undefined),
  mergePreserveLocaleData: vi.fn((existing: object[], fresh: object[], opts: { retainMissingJobs?: boolean } = {}) => (
    opts.retainMissingJobs === false ? fresh : [...fresh, ...existing]
  )),
  validateDedicatedLocaleCoverage: vi.fn(() => undefined),
  writeJobsCrawlerSliceVerified: vi.fn(async () => ({ written: true, shrinkAccepted: false })),
  writeSummaryCrawlerSlice: vi.fn(() => undefined),
  registerCrawlerSummaryGuard: vi.fn(),
  markCrawlerSummaryAbortKind: vi.fn(),
  isConnectionLevelFetchError: vi.fn(() => false),
  detectBoilerplateDescriptions: vi.fn(() => ({ boilerplateJobs: [], totalJobs: 1, boilerplateCount: 0, ratio: 0 })),
  isSystemicBoilerplateFailure: vi.fn(() => false),
}));

vi.mock('../scripts/jobs-url-helper.mjs', () => ({
  snapshotJobSlugs: (jobs: Array<{ id?: string }>) => new Map(jobs.map((job) => [job.id, job])),
  computeCrawlDiff: (before: Map<string, object>, after: Map<string, object>) => ({
    newJobs: [],
    updatedJobs: [],
    removedJobs: [...before.entries()]
      .filter(([id]) => !after.has(id))
      .map(([, job]) => job),
    unchangedJobs: [],
    unchangedCount: 0,
  }),
  printCrawlChangeSummary: vi.fn(),
  writeCrawlChangeSummaryToGH: vi.fn(),
  printPublishedJobUrls: vi.fn(),
  writeJobsSummary: vi.fn(),
  setCrawlerStartTime: vi.fn(),
  getCrawlerElapsedMs: vi.fn(() => 25),
}));

vi.mock('../scripts/assemble-jobs-dataset.mjs', () => ({
  writeJobsCrawlerSlice: vi.fn(),
  writeJobsCrawlerSliceVerified: mocks.writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice: mocks.writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard: mocks.registerCrawlerSummaryGuard,
  markCrawlerSummaryAbortKind: mocks.markCrawlerSummaryAbortKind,
  assembleJobsDataset: mocks.assembleJobsDataset,
  readExistingCrawlerJobs: mocks.readExistingCrawlerJobs,
  detectBoilerplateDescriptions: mocks.detectBoilerplateDescriptions,
  isSystemicBoilerplateFailure: mocks.isSystemicBoilerplateFailure,
}));

vi.mock('../scripts/lib/dedicated-crawler-common.mjs', () => ({
  runDedicatedBaseCrawler: mocks.runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage: mocks.validateDedicatedLocaleCoverage,
  mergePreserveLocaleData: mocks.mergePreserveLocaleData,
  detectLang: vi.fn(() => 'it'),
  deriveLocalizedSlug: vi.fn(() => 'slug'),
}));

vi.mock('../scripts/lib/expired-jobs-archive.mjs', () => ({
  archiveRemovedJobsToSlice: mocks.archiveRemovedJobsToSlice,
}));

vi.mock('../scripts/lib/transient-fetch.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/transient-fetch.mjs')>();
  return {
    RETRYABLE_STATUS: new Set([500, 502, 503, 504]),
    WAF_IP_BLOCK_STATUS: new Set([403]),
    isTransientFetchError: vi.fn(() => false),
    isConnectionLevelFetchError: mocks.isConnectionLevelFetchError,
    fetchWithRetry: vi.fn(),
    isRetryBudgetExhausted: actual.isRetryBudgetExhausted,
  };
});

vi.mock('../scripts/lib/jina-proxy.mjs', () => ({
  fetchHtmlViaJinaWithRetry: vi.fn(),
  rescueHtmlIfChallenged: vi.fn(),
}));

vi.mock('../scripts/lib/prospector/public-fetch-policy.mjs', () => ({
  fetchFollowingValidatedRedirects: vi.fn(),
}));

vi.mock('../scripts/lib/slug-truncate.mjs', () => ({
  truncateSlugAtWordBoundary: (value: string, maxLength: number) => value.slice(0, maxLength),
}));

import {
  evaluateAuthoritativeSnapshot,
  runStandardCrawlerPipeline,
} from '../scripts/lib/crawler-template.mjs';
import { markAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import {
  CRAWLER_ABORT_KINDS,
  CRAWLER_FETCH_FAILURE_OUTCOMES,
  normalizeAbortKind,
  CRAWLER_FETCH_OUTCOMES,
  fetchOutcomeAllowsStampedEmpty,
} from '../scripts/lib/crawler-fetch-outcome.mjs';

const SCRATCH_PATH = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${COMPANY_KEY}.json`);
const SOURCE_BODY = Array(60).fill('source').join(' ');
const EVIDENCE = 'listing rendered its explicit "no open positions" state';

const storedJob = (n: number, description = SOURCE_BODY) => ({
  id: `stored-${n}`,
  slug: `stored-job-${n}`,
  url: `https://example.com/stored-job-${n}`,
  companyKey: COMPANY_KEY,
  sourceLang: 'de',
  description,
  descriptionByLocale: { de: description },
});
const STORED = [storedJob(1), storedJob(2), storedJob(3)];
const stampedEmpty = () => markAuthoritativeEmptySnapshot([], EVIDENCE);

afterEach(() => {
  vi.clearAllMocks();
  mocks.readExistingCrawlerJobs.mockReset();
  mocks.readExistingCrawlerJobs.mockImplementation(() => []);
  fs.rmSync(SCRATCH_PATH, { force: true });
});

async function runPipeline(fetchJobs: () => Promise<unknown>, extra: Record<string, unknown> = {}, stored: object[] = STORED) {
  mocks.readExistingCrawlerJobs.mockImplementation(() => stored);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-outcome-root-'));
  try {
    await runStandardCrawlerPipeline({
      companyKey: COMPANY_KEY,
      companyLabel: 'Zero Outcome Test',
      root,
      fetchJobs,
      isCompanyJob: (job: { companyKey?: string }) => job.companyKey === COMPANY_KEY,
      ...extra,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const [, , counts] = mocks.registerCrawlerSummaryGuard.mock.calls.at(-1)!;
  return counts as { abortKind: string | null; lastFetchOutcome: string | null; parsed: number | null };
}

/** The slice was neither rewritten, nor retired, nor published. */
function expectSliceUntouched() {
  expect(mocks.writeJobsCrawlerSliceVerified).not.toHaveBeenCalled();
  expect(mocks.archiveRemovedJobsToSlice).not.toHaveBeenCalled();
  expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
  expect(mocks.writeSummaryCrawlerSlice).not.toHaveBeenCalled();
}

function expectProvenZeroPublished() {
  expect(mocks.archiveRemovedJobsToSlice).toHaveBeenCalledTimes(1);
  const [retired, key] = mocks.archiveRemovedJobsToSlice.mock.calls[0] as unknown as [Array<{ id: string }>, string];
  expect(key).toBe(COMPANY_KEY);
  expect(retired.map((job) => job.id).sort()).toEqual(STORED.map((job) => job.id).sort());
  expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
    COMPANY_KEY,
    [],
    expect.objectContaining({ skipShrinkGuard: true }),
  );
  expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
    expect.objectContaining({ key: COMPANY_KEY, total: 0, authoritativeEmptySnapshot: true }),
  );
  expect(mocks.runDedicatedBaseCrawler).not.toHaveBeenCalled();
}

describe('parser-stamped zero: honoured by default, without runner wiring', () => {
  it('(a) publishes the zero and retires every stored job when the runner passes no validator', async () => {
    const counts = await runPipeline(async () => stampedEmpty());
    expectProvenZeroPublished();
    expect(counts.abortKind).toBeNull();
  });

  it('(a) also honours the stamp on a structured `{ jobs }` result', async () => {
    const counts = await runPipeline(async () => ({ jobs: stampedEmpty(), fetchOutcome: 'ok' }));
    expectProvenZeroPublished();
    expect(counts).toMatchObject({ abortKind: null, lastFetchOutcome: 'ok' });
  });

  it('(b) keeps a bare [] fail-closed: no-jobs-parsed, slice intact', async () => {
    const counts = await runPipeline(async () => []);
    expect(counts.abortKind).toBe('no-jobs-parsed');
    expectSliceUntouched();
  });

  it.each([
    ['spread', (stamped: object[]) => [...stamped]],
    ['filter', (stamped: object[]) => stamped.filter(Boolean)],
    ['map', (stamped: object[]) => stamped.map((job) => job)],
    ['slice', (stamped: object[]) => stamped.slice()],
  ])('(c) loses the proof when the stamped batch is rebuilt with %s', async (_name, rebuild) => {
    const counts = await runPipeline(async () => rebuild(stampedEmpty()));
    expect(counts.abortKind).toBe('no-jobs-parsed');
    expectSliceUntouched();
  });

  it('(d) lets a runner opt out with allowAuthoritativeEmptySnapshot: false', async () => {
    const counts = await runPipeline(async () => stampedEmpty(), { allowAuthoritativeEmptySnapshot: false });
    expect(counts.abortKind).toBe('no-jobs-parsed');
    expectSliceUntouched();
  });

  it('(g) never reads an unstamped zero with a fetch failure as a proof', async () => {
    const counts = await runPipeline(async () => ({ jobs: [], fetchOutcome: 'anti_bot_block' }));
    expect(counts).toMatchObject({ abortKind: 'no-jobs-parsed', lastFetchOutcome: 'anti_bot_block' });
    expectSliceUntouched();
  });

  it.each([...CRAWLER_FETCH_FAILURE_OUTCOMES])(
    '(g) refuses a stamp that contradicts the run\'s own fetch verdict (%s)',
    async (fetchOutcome) => {
      const counts = await runPipeline(async () => ({ jobs: stampedEmpty(), fetchOutcome }));
      expect(counts).toMatchObject({ abortKind: 'no-jobs-parsed', lastFetchOutcome: fetchOutcome });
      expectSliceUntouched();
    },
  );

  // A value outside the vocabulary is a producer bug. The summary reads it as
  // "nothing reported" on purpose (a typo must not flip a health verdict), but
  // the stamped-zero decision must not: with the stamp honoured, a parser that
  // names an unknown failure would retire every stored job and skip the shrink
  // guard.
  it.each([
    ['an unknown failure name', 'unknown-failure'],
    ['a typo of a known failure', 'selector-miss'],
    ['an empty string', ''],
    ['a non-string value', 503],
  ])('(g) refuses a stamp next to an unrecognised fetch outcome: %s', async (_label, fetchOutcome) => {
    const counts = await runPipeline(async () => ({ jobs: stampedEmpty(), fetchOutcome }));
    expect(counts).toMatchObject({ abortKind: 'no-jobs-parsed', lastFetchOutcome: null });
    expectSliceUntouched();
  });

  it('honours a stamp next to the outcomes that assert the zero is legitimate', () => {
    const proven = { authoritativeSnapshotVerified: true, authoritativeEmptySnapshot: true };
    const refused = { authoritativeSnapshotVerified: false, authoritativeEmptySnapshot: false };
    for (const fetchOutcome of CRAWLER_FETCH_OUTCOMES) {
      const expected = CRAWLER_FETCH_FAILURE_OUTCOMES.has(fetchOutcome) ? refused : proven;
      expect(evaluateAuthoritativeSnapshot(stampedEmpty(), { fetchOutcome }), fetchOutcome).toEqual(expected);
      expect(fetchOutcomeAllowsStampedEmpty(fetchOutcome), fetchOutcome).toBe(expected === proven);
    }
    for (const absent of [null, undefined]) {
      expect(evaluateAuthoritativeSnapshot(stampedEmpty(), { fetchOutcome: absent })).toEqual(proven);
      expect(fetchOutcomeAllowsStampedEmpty(absent)).toBe(true);
    }
    for (const unknown of ['unknown-failure', 'OK', '', 0, false, {}, []]) {
      expect(evaluateAuthoritativeSnapshot(stampedEmpty(), { fetchOutcome: unknown as never })).toEqual(refused);
      expect(fetchOutcomeAllowsStampedEmpty(unknown)).toBe(false);
    }
  });

  it('does not synthesize a fetch outcome the parser did not report', async () => {
    const counts = await runPipeline(async () => stampedEmpty());
    expect(counts.lastFetchOutcome).toBeNull();
    expect(mocks.writeSummaryCrawlerSlice).toHaveBeenCalledWith(
      expect.objectContaining({ lastFetchOutcome: null }),
    );
  });

  it('leaves a runner that wires its own validator on the explicit contract', async () => {
    // Validator present, no opt-in: the stamp alone does not publish (ipersonal shape).
    const validator = vi.fn(() => true);
    const counts = await runPipeline(async () => stampedEmpty(), { validateAuthoritativeSnapshot: validator });
    expect(validator).toHaveBeenCalledOnce();
    expect(counts.abortKind).toBe('no-jobs-parsed');
    expect(mocks.writeSummaryCrawlerSlice).not.toHaveBeenCalled();
  });

  it('states the same rule at the evaluateAuthoritativeSnapshot boundary', () => {
    const proven = { authoritativeSnapshotVerified: true, authoritativeEmptySnapshot: true };
    const refused = { authoritativeSnapshotVerified: false, authoritativeEmptySnapshot: false };
    expect(evaluateAuthoritativeSnapshot(stampedEmpty())).toEqual(proven);
    expect(evaluateAuthoritativeSnapshot(stampedEmpty(), { allowAuthoritativeEmptySnapshot: true })).toEqual(proven);
    expect(evaluateAuthoritativeSnapshot(stampedEmpty(), { allowAuthoritativeEmptySnapshot: false })).toEqual(refused);
    expect(evaluateAuthoritativeSnapshot(stampedEmpty(), { fetchOutcome: 'selector_miss' })).toEqual(refused);
    expect(evaluateAuthoritativeSnapshot([])).toEqual(refused);
    expect(evaluateAuthoritativeSnapshot([], { allowAuthoritativeEmptySnapshot: true })).toEqual(refused);
    expect(evaluateAuthoritativeSnapshot(null)).toEqual(refused);
    // A forged marker on a NON-empty batch is not a stamp.
    const forged = Object.assign([{ id: 'job-1' }], { authoritativeEmptyState: 'authoritative-source-zero' });
    expect(evaluateAuthoritativeSnapshot(forged)).toEqual(refused);
  });
});

describe('every exit without publication names its cause', () => {
  it('(e) names thin-source-all and still quarantines the thin stored rows', async () => {
    const thinStored = [storedJob(1, '')];
    const counts = await runPipeline(
      async () => [{ ...storedJob(1, ''), id: 'fresh-1' }],
      { prepareExistingJobs: (jobs: object[]) => jobs },
      thinStored,
    );

    expect(counts).toMatchObject({ abortKind: 'thin-source-all', parsed: thinStored.length });
    // Same assertion as tests/crawler-template-prepare-existing-jobs.test.ts.
    expect(mocks.mergePreserveLocaleData).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      [],
      expect.objectContaining({
        housekeepingProof: [expect.objectContaining({
          job: expect.objectContaining({ url: thinStored[0].url, slug: thinStored[0].slug }),
          reason: 'thin-source-quarantine',
          definitive: true,
        })],
      }),
    );
    expect(mocks.writeSummaryCrawlerSlice).not.toHaveBeenCalled();
  });

  it('(e) names thin-source-all and keeps stored rows whose body clears the floor', async () => {
    // Fresh rows are thin and match nothing stored: nothing publishable, but
    // the stored slice is valid and must not be rewritten.
    const counts = await runPipeline(async () => [{
      ...storedJob(9, 'too short'),
      id: 'fresh-9',
    }]);
    expect(counts.abortKind).toBe('thin-source-all');
    expect(mocks.writeJobsCrawlerSliceVerified).not.toHaveBeenCalled();
    expect(mocks.archiveRemovedJobsToSlice).not.toHaveBeenCalled();
    expect(mocks.writeSummaryCrawlerSlice).not.toHaveBeenCalled();
  });

  it('(e) names source-extraction-failed when every parsed row reports an extraction failure', async () => {
    const thinStored = [storedJob(1, '')];
    const counts = await runPipeline(
      async () => [{
        ...storedJob(1, ''),
        sourceBodyFailureReason: 'pdf-extraction-failed',
        sourceBodyFailureMessage: 'no text extracted',
      }],
      { prepareExistingJobs: (jobs: object[]) => jobs },
      thinStored,
    );

    expect(counts.abortKind).toBe('source-extraction-failed');
    expect(mocks.writeJobsCrawlerSliceVerified).toHaveBeenCalledWith(
      COMPANY_KEY,
      [],
      expect.objectContaining({
        housekeepingProof: [expect.objectContaining({ reason: 'pdf-extraction-failed', definitive: true })],
      }),
    );
  });

  it('(f) names missing-detail-url and leaves the slice untouched', async () => {
    const counts = await runPipeline(async () => ({
      jobs: [{ ...storedJob(1), id: 'fresh-1' }],
      // Over MISSING_DETAIL_URL_MAX_RATIO of the stored slice.
      missingDetailUrlCount: STORED.length,
    }));
    expect(counts.abortKind).toBe('missing-detail-url');
    expectSliceUntouched();
  });

  it('(f) a missing-detail-url loss wins over a stamped zero', async () => {
    const counts = await runPipeline(async () => ({
      jobs: stampedEmpty(),
      missingDetailUrlCount: STORED.length,
    }));
    expect(counts.abortKind).toBe('missing-detail-url');
    expectSliceUntouched();
  });

  it('carries the new names through the exit-guard vocabulary, and drops unknown ones', () => {
    for (const kind of ['missing-detail-url', 'thin-source-all', 'source-extraction-failed', 'no-jobs-parsed']) {
      expect(CRAWLER_ABORT_KINDS.has(kind)).toBe(true);
      expect(normalizeAbortKind(kind)).toBe(kind);
    }
    expect(normalizeAbortKind('thin_source_all')).toBeNull();
    // Deliberately absent: no exit of the template is a "healthy" abort.
    expect(normalizeAbortKind('observed-empty')).toBeNull();
    expect(normalizeAbortKind('filtered-empty')).toBeNull();
  });
});
