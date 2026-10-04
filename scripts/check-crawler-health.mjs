#!/usr/bin/env node
/**
 * Crawler health checker.
 *
 * Reads `data/jobs/by-crawler/{slug}.json` for jobCount + fallback freshness,
 * and `data/jobs-crawler-summaries/by-crawler/{slug}.json` for the PRIMARY
 * freshness signal. Derives per-crawler health, updates
 * `data/crawler-health.json` (running state), and writes
 * `data/crawler-health-issues.json` if any crawler is stale/broken.
 *
 * Exit code:
 *   0 — all crawlers healthy (or no crawlers at all)
 *   1 — one or more crawlers stale/broken (workflow will open issues)
 *
 * Safe to run multiple times per day. Does NOT throw on individual crawler
 * read errors — logs and continues.
 *
 * Freshness signal — TWO-TIER:
 *
 *   1. PRIMARY: `generatedAt` from the summary slice
 *      (`data/jobs-crawler-summaries/by-crawler/{slug}.json`). The summary is
 *      written on EVERY crawler run, including runs that found zero listings
 *      and took the "Keeping existing" branch (~42 crawlers do this). The
 *      summary is therefore the only reliable "the workflow ran today" proof.
 *
 *   2. FALLBACK: `assembledAt` from the by-crawler slice
 *      (`data/jobs/by-crawler/{slug}.json`) — only updated when the slice
 *      itself is rewritten, so it freezes for weeks on "Keeping existing"
 *      runs. Used only when no summary slice exists yet.
 *
 * Both timestamps are slice-self-reported (not fs.stat mtime), because mtime
 * is unreliable on CI checkouts (always equals checkout time).
 *
 * Status transitions:
 *   - healthy           → summary fresh (<= 7d) AND (jobs > 0 OR low empty streak)
 *   - broken            → 3+ consecutive empty observations (legitimately
 *                         empty source like BancaStato won't cross this gate
 *                         because the daily monitor records the same fresh
 *                         summary repeatedly — see consecutiveEmptyRuns logic)
 *   - stale             → summary `generatedAt` older than 7d (or fallback
 *                         `assembledAt` older than 7d when no summary exists)
 *   - warming_up        → never observed before, freshness OK, and empty
 *                         (do NOT flag — wait until we have history)
 *
 * Advisory (issue #6496): an `EMPTY_OK_CRAWLERS`/auto-filtered slug's
 * `consecutiveEmptyRuns` is pinned at 0 every empty-ok run by design, so it
 * can never trip `broken` no matter how long the source has actually gone
 * dead. A separate `consecutiveEmptyOkRuns` counter keeps incrementing
 * regardless of `emptyOk` (reset only when jobs > 0); once it crosses
 * `EMPTY_OK_ADVISORY_AFTER_RUNS`, `nextCrawlerState` sets `state.advisory`
 * WITHOUT changing `status` away from 'healthy' — the intentional
 * allowlist/auto-filter behavior is preserved — and `main()` still opens a
 * (lower-priority, `advisory` status) `crawler-health` issue for it so a
 * multi-month zero is no longer silent. A current
 * `authoritativeEmptySnapshot` is different: the crawler has just proved
 * that the source is alive and explicitly empty, so it does not need the
 * long-run liveness advisory. If that proof disappears, the ordinary broken
 * streak applies again.
 *
 * Auto-detected filtered-empty (issue #5945): a summary slice MAY report
 * `discovered` (count found before the crawler's Swiss/location filter) and
 * `written` (count kept after it) for a given run. When `discovered > 0` and
 * `written === 0`, the run legitimately filtered everything out rather than
 * finding nothing — the monitor treats this the same as an `EMPTY_OK_CRAWLERS`
 * entry (see `nextCrawlerState`), without needing a human to add the slug to
 * the allowlist first. Crawlers that don't report these fields keep behaving
 * exactly as before (manual allowlist only). Only `scripts/update-baronie-jobs.mjs`
 * reports them today; instrumenting the rest of the fleet is incremental,
 * per-crawler follow-up (each has a bespoke discover/filter boundary).
 *
 * Fetch outcome (issue #7897): a summary slice MAY report `lastFetchOutcome`,
 * the run's own verdict on WHY it ended up empty — `ok`, `anti_bot_block`,
 * `selector_miss`, `filtered_empty`, `connection_error` or
 * `exhausted_retry` or `feed_endpoint_unavailable`. It answers on the FIRST
 * observation the
 * question the empty-streak gate can only guess at after three days, and even
 * then only as "0 jobs, cause unknown": a source that refused the fetch, a
 * parser whose selectors stopped matching, and a source that is legitimately
 * quiet all publish the same `total: 0`. `selector_miss`/`anti_bot_block`,
 * `connection_error`, `exhausted_retry` and `feed_endpoint_unavailable` are
 * proof of a broken refresh, so they flag `broken` immediately and NAME the
 * cause. The exception is a `connection-level-fetch` early exit: the standard
 * pipeline explicitly preserves the previous slice for this transient
 * transport failure, so the monitor keeps the normal three-run corroboration
 * gate for it.
 * `filtered_empty` is the same evidence as the `discovered > 0, written === 0`
 * signal above and clears the streak. Like `discovered`/`written`, the field is
 * OPTIONAL: a slice without it — every historical slice included — is read
 * exactly as before, so no backfill is needed. Only the SMN clinic parsers
 * report it today (via `runStandardCrawlerPipeline`); instrumenting the rest of
 * the fleet is incremental, per-crawler work (each has its own fetch/parse
 * boundary).
 *
 * Early-exit cause (issue #7784): a guard slice MAY report `abortKind` as
 * `no-jobs-parsed`, `connection-level-fetch` or `crash`. `exitCode: 0` alone
 * cannot distinguish a fail-closed no-jobs bail-out from a transport failure;
 * the explicit class keeps the monitor's triage at the right layer.
 *
 * Missing summary (site issue 11069): a crawler-group member that exits
 * non-zero never gets its summary onto `main` (the group commit only carries
 * the members whose crawl succeeded). The generation ledger
 * (`data/crawler-generation-ledger.jsonl`) and the roster
 * (`scripts/ci/crawler-generation-roster.json`) prove the generation ran; a
 * member absent from a generation in which its siblings published is recorded
 * as an aborted run with cause `summary-missing` instead of a repeat of its
 * last published summary — see `applyGenerationSummaryAbsence`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { isSliceFile } from './lib/crawler-slice-files.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import {
  CRAWLER_FETCH_FAILURE_OUTCOMES,
  normalizeAbortKind,
  normalizeFetchOutcome,
} from './lib/crawler-fetch-outcome.mjs';
import { detailDropFromSummary, detailDropAdvisoryReason } from './lib/crawler-detail-drop.mjs';
import {
  EMPTY_OK_CRAWLERS,
  LEGACY_SOURCE_PROVEN_EMPTY_CRAWLERS,
} from './lib/crawler-empty-ok-registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const SUMMARIES_DIR = path.join(
  ROOT,
  'data',
  'jobs-crawler-summaries',
  'by-crawler',
);
const CRAWLER_GENERATION_LEDGER_PATH = path.join(ROOT, 'data', 'crawler-generation-ledger.jsonl');
const CRAWLER_GENERATION_ROSTER_PATH = path.join(ROOT, 'scripts', 'ci', 'crawler-generation-roster.json');
const HEALTH_STATE_PATH = path.join(ROOT, 'data', 'crawler-health.json');
const HEALTH_ISSUES_PATH = path.join(ROOT, 'data', 'crawler-health-issues.json');
const CRAWLER_QUARANTINE_PATH = path.join(ROOT, 'data', 'crawler-quarantine.json');

// The site remains the canonical job-data repository. During the cross-repo
// crawler migration, however, issue #6712 caused some valid crawler commits to
// land in the corpus repository because the caller's GITHUB_REPOSITORY
// clobbered an explicitly configured site origin. Those observations are
// useful recovery evidence, but never a preferred source by themselves: the
// monitor only uses one when its self-reported timestamp is strictly newer
// than the local site observation. A newer site zero therefore still wins over
// an older corpus non-zero and remains visible to the broken-run gate.
const CORPUS_RECOVERY_DATA_BASE_URL =
  process.env.CRAWLER_HEALTH_CORPUS_RECOVERY_DATA_BASE_URL ??
  'https://raw.githubusercontent.com/nanakokyobashi-rgb/frontaliere-articles/main/data';
const CORPUS_RECOVERY_TIMEOUT_MS = 10_000;
const CORPUS_RECOVERY_DEADLINE_MS = 8_000;
const CORPUS_RECOVERY_CONCURRENCY = 6;

const STALE_AFTER_DAYS = 7;
const BROKEN_AFTER_EMPTY_RUNS = 3;
// `EMPTY_OK_CRAWLERS`/auto-filtered entries never accumulate a broken streak
// (consecutiveEmptyRuns resets to 0 every empty-ok run), which means a
// genuinely dead source among them would sit "healthy" forever with zero
// downstream signal (issue #6496). This threshold gates a SEPARATE counter
// (`consecutiveEmptyOkRuns`) that keeps incrementing regardless of emptyOk —
// crossing it raises an advisory without flipping `status` away from
// 'healthy' (the EMPTY_OK_CRAWLERS design stays intentional either way).
const EMPTY_OK_ADVISORY_AFTER_RUNS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Read JSON file, return null on any error. */
async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** List `*.json` slugs in a dir (best-effort; empty array on read failure). */
async function listJsonSlugs(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter(isSliceFile)
      .map((name) => name.replace(/\.json$/, ''));
  } catch (err) {
    console.error(`[health] Cannot read ${dir}: ${err.message}`);
    return [];
  }
}

/**
 * List all active crawler slugs: union of `data/jobs/by-crawler/*.json` and
 * `data/jobs-crawler-summaries/by-crawler/*.json`, excluding crawlers retired
 * in `data/crawler-quarantine.json`. A retired crawler intentionally keeps its
 * historical slices for route/data continuity, but those slices must not turn
 * into a new stale/broken alert after its scheduler has been removed.
 * A crawler that has never produced an active-jobs shard (e.g. `earlyExit: true`
 * on every run) only ever writes the summary slice — reading BY_CRAWLER_DIR
 * alone made those crawlers permanently invisible to this monitor (issue #3797).
 */
async function readRetiredCrawlerSlugs() {
  const registry = await readJsonSafe(CRAWLER_QUARANTINE_PATH);
  const retired = registry && typeof registry === 'object' && !Array.isArray(registry)
    ? registry.retired
    : null;
  if (!retired || typeof retired !== 'object' || Array.isArray(retired)) return new Set();
  return new Set(Object.keys(retired));
}

async function listCrawlerSlugs({ retiredSlugs = null } = {}) {
  const [byCrawler, summaries] = await Promise.all([
    listJsonSlugs(BY_CRAWLER_DIR),
    listJsonSlugs(SUMMARIES_DIR),
  ]);
  const retired = retiredSlugs instanceof Set
    ? retiredSlugs
    : await readRetiredCrawlerSlugs();
  return [...new Set([...byCrawler, ...summaries])]
    .filter((slug) => !retired.has(slug))
    .sort();
}

function shouldCarryForwardCrawlerSlug(slug) {
  return isSliceFile(`${slug}.json`);
}

/**
 * Inspect one crawler and return derived facts.
 *
 * Reads:
 *   - `data/jobs/by-crawler/{slug}.json`            → activeJobCount + fallback timestamp
 *   - `data/jobs-crawler-summaries/by-crawler/{slug}.json` → primary timestamp
 *
 * The by-crawler slice is optional — a crawler that has never produced an
 * active-jobs shard (e.g. every run exits early with `earlyExit: true`,
 * issue #3797) is tracked via the summary slice alone instead of being
 * skipped. `activeJobCount` and `assembledAt` degrade to 0/null in that case.
 *
 * Returns `{ slug, freshnessAt, freshnessSource, assembledAt, generatedAt,
 * jobCount, activeJobCount, discovered, written }`:
 *   - `freshnessAt` is the timestamp the stale gate compares against
 *     (summary `generatedAt` when present, otherwise by-crawler `assembledAt`).
 *   - `freshnessSource` is `'summary' | 'by-crawler' | 'mtime' | 'none'`.
 *   - `discovered`/`written` are the optional pre-/post-filter counts a
 *     crawler MAY report on its summary slice (issue #5945); `null` when
 *     absent.
 */
function summaryHasAuthoritativeEmpty(slug, summary) {
  if (!summary || typeof summary !== 'object') return false;
  return summary.authoritativeEmptySnapshot === true || (
    LEGACY_SOURCE_PROVEN_EMPTY_CRAWLERS.has(slug) &&
    summary.sourceProvenEmpty === true
  );
}

/**
 * Commit del sito che ha prodotto la summary (`codeCommit`, scritto da
 * `writeSummaryCrawlerSlice`). `null` per le summary che precedono il campo o
 * che non lo dichiarano in forma di sha completo: mai un valore dedotto.
 */
function observedCodeCommit(summary) {
  const value = summary && typeof summary === 'object' ? summary.codeCommit : null;
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

async function inspectCrawler(slug) {
  const sliceFilePath = path.join(BY_CRAWLER_DIR, `${slug}.json`);
  const data = await readJsonSafe(sliceFilePath);
  if (data === null) {
    console.warn(`[health] ${slug}: no active-jobs shard (never produced or unparseable) — tracking via summary only`);
  }

  // Tolerate any shape: array of jobs OR { jobs: [...] } OR { entries: [...] }.
  let activeJobCount = 0;
  if (Array.isArray(data)) {
    activeJobCount = data.length;
  } else if (data && Array.isArray(data.jobs)) {
    activeJobCount = data.jobs.length;
  } else if (data && Array.isArray(data.entries)) {
    activeJobCount = data.entries.length;
  } else if (data && typeof data === 'object') {
    // Best-effort: count any array property at the top level.
    for (const v of Object.values(data)) {
      if (Array.isArray(v) && v.length > activeJobCount) activeJobCount = v.length;
    }
  }

  // Slice shape is `{ crawlerKey, assembledAt, jobs }`. The by-crawler
  // `assembledAt` is only updated when the slice itself is rewritten — it
  // freezes for weeks on "Keeping existing" runs.
  let assembledAt =
    data && typeof data === 'object' && typeof data.assembledAt === 'string'
      ? data.assembledAt
      : null;

  if (!assembledAt) {
    try {
      const stat = await fs.stat(sliceFilePath);
      assembledAt = stat.mtime.toISOString();
    } catch {
      assembledAt = null;
    }
  }

  // PRIMARY freshness signal: summary slice's `generatedAt`. Written on every
  // crawler run, including "found 0, keeping existing" runs.
  const summaryFilePath = path.join(SUMMARIES_DIR, `${slug}.json`);
  const summary = await readJsonSafe(summaryFilePath);
  const generatedAt =
    summary && typeof summary === 'object' && typeof summary.generatedAt === 'string'
      ? summary.generatedAt
      : null;
  const summaryTotal =
    summary && typeof summary === 'object' && Number.isFinite(Number(summary.total))
      ? Number(summary.total)
      : null;
  // Optional pre-/post-filter counts (issue #5945) — null when the crawler
  // hasn't been instrumented to report them yet.
  const discovered =
    summary && typeof summary === 'object' && Number.isFinite(Number(summary.discovered))
      ? Number(summary.discovered)
      : null;
  const written =
    summary && typeof summary === 'object' && Number.isFinite(Number(summary.written))
      ? Number(summary.written)
      : null;
  // Post-parser, pre-pipeline count (issue #7707): how many jobs the parser
  // actually handed to the pipeline, AFTER its own Swiss/location filter and
  // BEFORE merge/localization/validation/slice. `discovered` alone cannot tell
  // "the geo filter dropped everything" (healthy) from "a post-parser gate of
  // the pipeline dropped everything" (broken) — both read `discovered > 0,
  // written === 0`. Null for crawlers not yet instrumented: unchanged behaviour.
  const parsed =
    summary && typeof summary === 'object' && Number.isFinite(Number(summary.parsed))
      ? Number(summary.parsed)
      : null;
  const detailDrop = detailDropFromSummary(summary);
  // Source-proven empty state (crawler-template `evaluateAuthoritativeSnapshot`):
  // absent for crawlers without an authoritative-snapshot validator. The
  // `sourceProvenEmpty` alias is retained only for summaries emitted by the
  // two legacy custom runners while their already-published slices roll
  // forward to the canonical field.
  const authoritativeEmpty = summaryHasAuthoritativeEmpty(slug, summary);
  // Issue #7461 & al.: this slice was written by the process-exit guard
  // (`registerCrawlerSummaryGuard`, assemble-jobs-dataset.mjs), not by the
  // pipeline — the run RETURNED BEFORE PUBLISHING and kept the previous slice
  // live. Its `total: 0` is the guard's placeholder, NOT an observation that
  // the source is empty.
  // The run's own verdict on why it ended up empty (#7897). Optional and
  // closed-set validated: `null` for every slice that predates the field or is
  // produced by a crawler that doesn't report it — unchanged behaviour.
  const lastFetchOutcome = normalizeFetchOutcome(
    summary && typeof summary === 'object' ? summary.lastFetchOutcome : null,
  );
  const abortKind = normalizeAbortKind(
    summary && typeof summary === 'object' ? summary.abortKind : null,
  );
  const earlyExit = summary && typeof summary === 'object' && summary.earlyExit === true;
  // Separates a deliberate bail-out (0) from a crash (non-zero) — different
  // triage, and the guard already records it. `null` when absent: "unknown" is
  // not "clean exit".
  const exitCode =
    earlyExit && Number.isFinite(Number(summary.exitCode)) ? Number(summary.exitCode) : null;
  // For crawler health, count what the crawler found, not what later
  // housekeeping kept in the active slice. URL cleanup has its own failure
  // surface; otherwise a cleanup false positive is mislabeled as a parser
  // returning zero jobs.
  const jobCount = summaryTotal ?? activeJobCount;

  let freshnessAt;
  let freshnessSource;
  if (generatedAt) {
    freshnessAt = generatedAt;
    freshnessSource = 'summary';
  } else if (assembledAt) {
    freshnessAt = assembledAt;
    // If we used fs.stat above the field name is approximate but the source
    // is still the by-crawler slice (or its mtime); flag distinctly for logs.
    freshnessSource =
      data && typeof data === 'object' && typeof data.assembledAt === 'string'
        ? 'by-crawler'
        : 'mtime';
  } else {
    freshnessAt = null;
    freshnessSource = 'none';
  }

  return {
    slug,
    freshnessAt,
    freshnessSource,
    assembledAt,
    generatedAt,
    jobCount,
    activeJobCount,
    discovered,
    written,
    parsed,
    detailDrop,
    authoritativeEmpty,
    lastFetchOutcome,
    abortKind,
    earlyExit,
    exitCode,
    codeCommit: observedCodeCommit(summary),
  };
}

async function fetchJsonSafe(
  url,
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(CORPUS_RECOVERY_TIMEOUT_MS),
) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Build recovery evidence from the corpus slice + summary payloads. */
function corpusObservationFromPayloads(slug, data, summary) {
  if (!summary || typeof summary !== 'object' || typeof summary.generatedAt !== 'string') {
    return null;
  }
  if (summary.key !== slug) return null;
  if (data && typeof data === 'object' && typeof data.crawlerKey === 'string' && data.crawlerKey !== slug) {
    return null;
  }

  let activeJobCount = 0;
  if (Array.isArray(data)) {
    activeJobCount = data.length;
  } else if (data && Array.isArray(data.jobs)) {
    activeJobCount = data.jobs.length;
  } else if (data && Array.isArray(data.entries)) {
    activeJobCount = data.entries.length;
  } else if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.length > activeJobCount) activeJobCount = value.length;
    }
  }

  const generatedAt = summary.generatedAt;
  if (!Number.isFinite(Date.parse(generatedAt))) return null;
  const summaryTotal = summary.total;
  if (
    typeof summaryTotal !== 'number' ||
    !Number.isSafeInteger(summaryTotal) ||
    summaryTotal < 0
  ) {
    return null;
  }
  const assembledAt =
    data && typeof data === 'object' && typeof data.assembledAt === 'string'
      ? data.assembledAt
      : null;
  const discovered =
    typeof summary.discovered === 'number' &&
    Number.isSafeInteger(summary.discovered) &&
    summary.discovered >= 0
      ? summary.discovered
      : null;
  const written =
    typeof summary.written === 'number' &&
    Number.isSafeInteger(summary.written) &&
    summary.written >= 0
      ? summary.written
      : null;
  // Same post-parser count as `inspectCrawler` (#7707): the corpus republishes
  // the slice verbatim, so the cross-repo observation must carry it too or the
  // pipeline-drop signal would be lost exactly for the crawlers whose
  // observation usually wins `selectNewestCrawlerObservation`.
  const parsed =
    typeof summary.parsed === 'number' &&
    Number.isSafeInteger(summary.parsed) &&
    summary.parsed >= 0
      ? summary.parsed
      : null;
  const detailDrop = detailDropFromSummary(summary);
  const authoritativeEmpty = summaryHasAuthoritativeEmpty(slug, summary);
  // Same fetch verdict as `inspectCrawler` (#7897), mirrored here for the same
  // reason the counts above are: the corpus republishes the slice verbatim, and
  // for cross-repo crawlers this observation is usually the one that wins
  // `selectNewestCrawlerObservation` — dropping the field here would lose the
  // named cause exactly where it is the only evidence available.
  const lastFetchOutcome = normalizeFetchOutcome(
    summary && typeof summary === 'object' ? summary.lastFetchOutcome : null,
  );
  const abortKind = normalizeAbortKind(
    summary && typeof summary === 'object' ? summary.abortKind : null,
  );
  // Same guard-slice marker as `inspectCrawler` above: the corpus republishes
  // whatever slice the crawler wrote, exit-guard placeholders included — and
  // for cross-repo crawlers the corpus observation is usually the one that
  // wins `selectNewestCrawlerObservation`, so it has to carry `exitCode` too
  // or the reason would report a crash as a deliberate bail-out.
  const earlyExit = summary.earlyExit === true;
  const exitCode =
    earlyExit && Number.isFinite(Number(summary.exitCode)) ? Number(summary.exitCode) : null;

  return {
    slug,
    freshnessAt: generatedAt,
    freshnessSource: 'corpus-summary',
    assembledAt,
    generatedAt,
    jobCount: summaryTotal,
    activeJobCount,
    discovered,
    written,
    parsed,
    detailDrop,
    authoritativeEmpty,
    lastFetchOutcome,
    abortKind,
    earlyExit,
    exitCode,
    codeCommit: observedCodeCommit(summary),
  };
}

/**
 * Read the recovery-only observation from the corpus over the public HTTP
 * boundary. A missing or malformed summary is not authoritative enough to
 * override the site.
 */
async function inspectCorpusRecoveryCrawler(
  slug,
  {
    baseUrl = CORPUS_RECOVERY_DATA_BASE_URL,
    fetchImpl = globalThis.fetch,
    signal,
  } = {},
) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, '');
  const encodedSlug = encodeURIComponent(slug);
  const [data, summary] = await Promise.all([
    fetchJsonSafe(
      `${base}/jobs/by-crawler/${encodedSlug}.json`,
      fetchImpl,
      signal,
    ),
    fetchJsonSafe(
      `${base}/jobs-crawler-summaries/by-crawler/${encodedSlug}.json`,
      fetchImpl,
      signal,
    ),
  ]);
  return corpusObservationFromPayloads(slug, data, summary);
}

/**
 * Resolve recovery candidates under one short global deadline. Remote evidence
 * is optional: when the deadline expires, unresolved crawlers retain their
 * site observation and therefore still emit the original alert.
 */
async function inspectCorpusRecoveryBatch(
  slugs,
  {
    baseUrl = CORPUS_RECOVERY_DATA_BASE_URL,
    fetchImpl = globalThis.fetch,
    concurrency = CORPUS_RECOVERY_CONCURRENCY,
    deadlineMs = CORPUS_RECOVERY_DEADLINE_MS,
  } = {},
) {
  const candidates = [...new Set(slugs)];
  const results = new Map();
  if (candidates.length === 0 || deadlineMs <= 0) return results;

  const controller = new AbortController();
  let cursor = 0;
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve();
    }, deadlineMs);
  });

  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= candidates.length) return;
      const slug = candidates[index];
      const observation = await inspectCorpusRecoveryCrawler(slug, {
        baseUrl,
        fetchImpl,
        signal: controller.signal,
      });
      if (observation) results.set(slug, observation);
    }
  };

  const workerCount = Math.min(
    candidates.length,
    Math.max(1, Math.floor(concurrency)),
  );
  try {
    await Promise.race([
      Promise.all(Array.from({ length: workerCount }, () => worker())),
      deadline,
    ]);
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
  }
  return results;
}

/**
 * The cause this monitor names when a crawler-group generation finished
 * without publishing a member's summary. It is NOT one of the producer's
 * `CRAWLER_ABORT_KINDS`: no crawler writes it — the monitor derives it from
 * the generation ledger, because the run that would have reported its own
 * cause never got its receipt onto `main`.
 */
export const SUMMARY_MISSING_ABORT_KIND = 'summary-missing';

/**
 * Parse `data/crawler-generation-ledger.jsonl` leniently: one finalizer
 * verdict per group run. A malformed line is skipped, never fatal — the
 * ledger only ADDS evidence here, so an unreadable record must leave the
 * monitor exactly as it was before this signal existed.
 *
 * @param {string} raw
 * @returns {Array<{group:string, checkedAt:string, callerRepository:string|null, callerRunId:string|null, callerRunAttempt:number|null}>}
 */
export function parseCrawlerGenerationLedger(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const entries = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.group !== 'string' || entry.group.length === 0) continue;
    if (typeof entry.checkedAt !== 'string' || !Number.isFinite(Date.parse(entry.checkedAt))) continue;
    entries.push({
      group: entry.group,
      checkedAt: entry.checkedAt,
      callerRepository: typeof entry.callerRepository === 'string' ? entry.callerRepository : null,
      callerRunId: typeof entry.callerRunId === 'string' ? entry.callerRunId : null,
      callerRunAttempt: Number.isInteger(entry.callerRunAttempt) ? entry.callerRunAttempt : null,
    });
  }
  return entries;
}

/**
 * A crawler-group member that exits non-zero publishes NOTHING: the group's
 * atomic commit is built only from the descriptors of members whose crawl
 * succeeded (scripts/lib/git-commit-data.sh `--group-batch`), so even the
 * exit guard's failure summary — written on disk with the real exit code —
 * never reaches `main`. This monitor reads only what reached `main`, saw the
 * previous summary again, classified it as a repeat observation and left the
 * state frozen: the failure was invisible and so was any later fix (site
 * issue 11069: `a-group` failed every generation after 2026-10-03 09:19Z, the
 * health state kept describing that last placeholder).
 *
 * The generation ledger is persisted even when the group fails, so it is the
 * witness of "the group ran". For each group take its newest ledger entry E
 * and the one before it, P: the summaries of generation E are exactly those
 * with `generatedAt` in (P.checkedAt, E.checkedAt] (group runs hold a lease,
 * so generations never overlap). When at least one member published inside
 * that window — the group commit did land, so the absence is specific to the
 * member — every member whose newest summary is not newer than P.checkedAt is
 * replaced by an ABORTED observation (`earlyExit`, 0 jobs, cause
 * `summary-missing`) whose freshness is E.checkedAt. A new generation is a new
 * observation and advances the streak; the same generation seen again is a
 * repeat, exactly as for a published summary.
 *
 * A generation where no member published is left alone: that is a group-wide
 * fault (commit or setup), already reported once at group level, and turning
 * it into one broken alert per member would be the per-crawler issue storm the
 * group workflow deliberately avoids.
 *
 * @param {Array<object>} observations site observations from `inspectCrawler`
 * @param {{groups?: Record<string, string[]>, ledgerEntries?: ReturnType<typeof parseCrawlerGenerationLedger>}} sources
 * @returns {{observations: Array<object>, absent: Array<{slug:string, group:string, checkedAt:string}>}}
 */
export function applyGenerationSummaryAbsence(observations, { groups, ledgerEntries } = {}) {
  const list = Array.isArray(observations) ? observations : [];
  if (!groups || typeof groups !== 'object' || !Array.isArray(ledgerEntries) || ledgerEntries.length === 0) {
    return { observations: list, absent: [] };
  }
  const bySlug = new Map(list.map((observation) => [observation?.slug, observation]));
  const entriesByGroup = new Map();
  for (const entry of ledgerEntries) {
    if (!entriesByGroup.has(entry.group)) entriesByGroup.set(entry.group, []);
    entriesByGroup.get(entry.group).push(entry);
  }

  const replacements = new Map();
  for (const [group, members] of Object.entries(groups)) {
    if (!Array.isArray(members) || members.length === 0) continue;
    const entries = (entriesByGroup.get(group) ?? [])
      .slice()
      .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
    if (entries.length < 2) continue;
    const latest = entries[entries.length - 1];
    const latestAt = Date.parse(latest.checkedAt);
    const previous = entries.slice(0, -1).reverse().find((entry) => Date.parse(entry.checkedAt) < latestAt);
    if (!previous) continue;
    const previousAt = Date.parse(previous.checkedAt);

    const generatedAtOf = (slug) => Date.parse(bySlug.get(slug)?.generatedAt ?? '');
    const publishedInGeneration = members.filter((slug) => {
      const at = generatedAtOf(slug);
      return Number.isFinite(at) && at > previousAt && at <= latestAt;
    });
    if (publishedInGeneration.length === 0) continue;

    for (const slug of members) {
      const observation = bySlug.get(slug);
      if (!observation) continue;
      const at = generatedAtOf(slug);
      if (Number.isFinite(at) && at > previousAt) continue;
      replacements.set(slug, {
        ...observation,
        freshnessAt: latest.checkedAt,
        freshnessSource: 'generation-ledger',
        jobCount: 0,
        discovered: null,
        written: null,
        parsed: null,
        detailDrop: null,
        authoritativeEmpty: false,
        lastFetchOutcome: null,
        abortKind: null,
        earlyExit: true,
        exitCode: null,
        // The commit of the stale summary would attribute this generation's
        // failure to an older checkout.
        codeCommit: null,
        summaryMissing: {
          group,
          checkedAt: latest.checkedAt,
          callerRepository: latest.callerRepository,
          callerRunId: latest.callerRunId,
          callerRunAttempt: latest.callerRunAttempt,
          lastSummaryAt: observation.generatedAt ?? null,
          publishedMembers: publishedInGeneration.length,
        },
      });
    }
  }

  if (replacements.size === 0) return { observations: list, absent: [] };
  return {
    observations: list.map((observation) => replacements.get(observation?.slug) ?? observation),
    absent: [...replacements.values()].map(({ slug, summaryMissing }) => ({
      slug,
      group: summaryMissing.group,
      checkedAt: summaryMissing.checkedAt,
    })),
  };
}

function summaryMissingRunUrl(summaryMissing) {
  if (!summaryMissing?.callerRepository || !summaryMissing?.callerRunId) return null;
  return `https://github.com/${summaryMissing.callerRepository}/actions/runs/${summaryMissing.callerRunId}`;
}

const OBSERVATION_DIAGNOSTIC_FIELDS = [
  'authoritativeEmpty',
  'authoritativeEmptySnapshot',
  'lastFetchOutcome',
  'abortKind',
  'earlyExit',
  'exitCode',
  'detailDrop',
];

/**
 * Keep the winning observation's freshness and counts, while carrying forward
 * diagnostic evidence that the winning producer did not publish. A newer
 * slice must never inherit an older count, but losing a diagnostic such as an
 * exit code would turn an observed bail-out into `unknown`.
 */
function mergeMissingObservationDiagnostics(winner, loser) {
  // A `summary-missing` observation is null on purpose: the diagnostics of an
  // older published summary describe a different run.
  if (winner?.summaryMissing) return winner;
  let merged = winner;
  for (const field of OBSERVATION_DIAGNOSTIC_FIELDS) {
    if (merged?.[field] !== null && merged?.[field] !== undefined) continue;
    const fallback = loser?.[field];
    if (fallback === null || fallback === undefined) continue;
    // `false` is the absence of positive evidence for these boolean fields;
    // copying it into a legacy observation would only create a needless clone.
    if (fallback === false) continue;
    if (merged === winner) merged = { ...winner };
    merged[field] = fallback;
  }
  return merged;
}

/**
 * Prefer recovery evidence only when it is strictly newer than the canonical
 * site observation. Counts are deliberately not part of the choice: a newer
 * corpus zero is a real empty run and must remain visible. Missing diagnostic
 * fields are filled from the other observation after the winner is chosen.
 */
function selectNewestCrawlerObservation(
  siteObservation,
  corpusObservation,
  nowMs = Date.now(),
) {
  if (!corpusObservation) return siteObservation;
  const siteAt = Date.parse(siteObservation?.freshnessAt ?? '');
  const corpusAt = Date.parse(corpusObservation.freshnessAt ?? '');
  if (!Number.isFinite(corpusAt)) return siteObservation;
  // A future-dated remote payload could otherwise suppress health alerts
  // indefinitely. Five minutes tolerates ordinary clock skew without trusting
  // an impossible observation.
  if (corpusAt > nowMs + 5 * 60 * 1000) return siteObservation;
  const winner = Number.isFinite(siteAt) && siteAt >= corpusAt
    ? siteObservation
    : corpusObservation;
  const loser = winner === siteObservation ? corpusObservation : siteObservation;
  return mergeMissingObservationDiagnostics(winner, loser);
}

/**
 * Compose new state for a crawler, given previous state + new observation.
 *
 * Status priority (first match wins):
 *   1. `freshnessAt` older than 7d → "stale" (regardless of streak)
 *   2. 3+ consecutive empty observations → "broken"
 *   3. fresh + empty + no prior non-zero ever → "warming_up" (do NOT flag)
 *   4. otherwise → "healthy"
 *
 * `freshnessAt` is the summary slice's `generatedAt` when present, otherwise
 * the by-crawler slice's `assembledAt`. See `inspectCrawler` for details.
 *
 * `emptyOk` (no verification-live needed to treat a 0-job run as healthy) is
 * true either for a manually-curated `EMPTY_OK_CRAWLERS` slug, OR — issue
 * #5945 — when the observation itself proves the run found candidates but
 * its Swiss/location filter dropped all of them (`discovered > 0` and
 * `jobCount === 0`), OR — issue #7324 — when the run carried an authoritative
 * empty-snapshot proof (`authoritativeEmptySnapshot`, written by
 * `crawler-template` only when the parser matched the source's explicit "no
 * open positions" marker). The latter two need no allowlist entry: the run's
 * own evidence already distinguishes "legitimately empty" from "broken".
 *
 * The filtered-empty rule is narrowed by `observation.parsed` when the run
 * reports it (#7707): `discovered` is counted BEFORE the parser's geographic
 * filter, `written` AFTER the whole pipeline, so a run whose parser emitted
 * jobs that the pipeline then dropped (merge, expiry archival, validation,
 * slice filter) shows the same `discovered > 0, written === 0` shape as a
 * genuine geographic filter-empty. `parsed > 0` says the jobs existed past the
 * parser's own filter, so that run is broken and must accrue its streak.
 *
 * A zero can also mean neither: `observation.earlyExit` marks a slice written
 * by the process-exit guard, i.e. a run that returned BEFORE publishing. That
 * does not make the crawler healthy (it stays broken and keeps its streak) —
 * it only changes the reason we report, because "returned 0 jobs" is a claim
 * about the source that an aborted run never made.
 */
/**
 * How old a crawler's last SUCCESS may be before a transport failure stops
 * counting as transient.
 *
 * Ten days = twice the measured p90 refresh age of the tracked fleet (5 days;
 * 552 of the 597 crawlers carrying a `lastSuccessfulRunAt` refresh inside a
 * week). Only reachable together with a proven transport failure on the last
 * observation — see the rationale at its use site. Raising it past 14 days
 * re-opens the hole it closes: `nord-anglia` sat at exactly 14 days.
 */
export const TRANSPORT_ABORT_STALE_FLOOR_DAYS = 10;
export const TRANSPORT_ABORT_STALE_FLOOR_MS = TRANSPORT_ABORT_STALE_FLOOR_DAYS * 24 * 60 * 60 * 1000;

function nextCrawlerState(prev, observation, nowIso, nowMs) {
  const previous = prev && typeof prev === 'object' ? prev : {};
  const hadPriorState = Boolean(prev);
  const lastObservedJobs = observation.jobCount;

  const hasDiscoveredSignal =
    observation.discovered !== undefined &&
    observation.discovered !== null &&
    Number.isFinite(observation.discovered);
  // Post-parser count (#7707). `discovered > 0 && written === 0` is only
  // evidence of a GEOGRAPHIC filter-empty while the parser itself emitted
  // nothing: the pipeline that runs after it (merge, expiry archival,
  // localization, validation, slug re-pin, `isCompanyJob` slice filter) can
  // also zero a run, and that is a break, not a quiet source. When the run
  // reports `parsed > 0` with nothing written, the jobs survived the parser's
  // own filter and were dropped downstream — never `emptyOk`.
  const hasParsedSignal =
    observation.parsed !== undefined &&
    observation.parsed !== null &&
    Number.isFinite(observation.parsed);
  const pipelineDroppedAll =
    hasParsedSignal && observation.parsed > 0 && lastObservedJobs === 0;
  const autoFilteredEmpty =
    hasDiscoveredSignal &&
    observation.discovered > 0 &&
    lastObservedJobs === 0 &&
    !pipelineDroppedAll;
  // A source-proven empty state (the run's own `validateAuthoritativeSnapshot`
  // matched the page's explicit "no open positions" marker) is the SAME kind of
  // evidence as the filtered-empty counts above, for the complementary case
  // where `discovered` is legitimately 0: the source published nothing, and it
  // said so. Without it, a crawler that can only ever return a proven 0 —
  // `ocst`, `artisa`, `cippatrasporti`, … — accrues a broken streak that no
  // parser fix can clear (#7324), and the only workaround is an
  // `EMPTY_OK_CRAWLERS` entry that keeps masking the slug after the source
  // really dies. This signal cannot: the proof is re-established every run or
  // the crawler throws.
  const authoritativeEmpty =
    (observation.authoritativeEmpty === true ||
      observation.authoritativeEmptySnapshot === true) &&
    lastObservedJobs === 0;

  // The run's own verdict on WHY it is empty (#7897). Every signal above is
  // the monitor INFERRING a cause from counts it can compare; this one is the
  // run reporting what it actually saw at the fetch/parse boundary, which is
  // the only place the difference is observable at all. Unknown or absent →
  // `null` → every branch below behaves exactly as it did before the field
  // existed, which is what keeps historical slices readable without a backfill.
  const fetchOutcome = normalizeFetchOutcome(observation.lastFetchOutcome);
  // `summary-missing` is derived by this monitor (applyGenerationSummaryAbsence),
  // never written by a crawler, so it does not go through the producer's
  // closed vocabulary.
  const summaryMissing =
    observation.summaryMissing && typeof observation.summaryMissing === 'object'
      ? observation.summaryMissing
      : null;
  const abortKind = summaryMissing
    ? SUMMARY_MISSING_ABORT_KIND
    : normalizeAbortKind(observation.abortKind);
  // The standard pipeline soft-exits on a transport failure after preserving
  // the previous live slice. Keep that run in the ordinary empty streak so a
  // single CI/egress incident cannot turn a healthy crawler into a broken one.
  const abortedRun = observation.earlyExit === true && lastObservedJobs === 0;
  // ...but only while it is genuinely a blip. That reclassification routes a
  // proven transport failure into the 3-empty-run streak, and the streak
  // counter is the wrong witness for a source that has actually died: it only
  // advances on runs that observe the crawler at all, so `nord-anglia` sat at
  // `consecutiveEmptyRuns: 1` with `feed_endpoint_unavailable` and a last
  // success of 2026-09-04 — fifteen days. Without a floor this monitor goes
  // green with nothing repaired, which is a detection change wearing a
  // recovery's clothes.
  //
  // The floor is the age of the last SUCCESS, which is independent of the
  // counter. It is deliberately NOT a bare age check: measured on the 612
  // tracked crawlers (597 carry a `lastSuccessfulRunAt`), 37 are older than 14
  // days and all 37 are `healthy`, because the field only advances on a
  // non-zero-jobs run and a source with no vacancies for months is legitimately
  // quiet — `linnea` is at 108 days. Age alone would flag all 37 and drown the
  // signal. The predicate is age AND a proven transport failure on the last
  // observation, which today holds for exactly 4 crawlers.
  //
  // Threshold from that same distribution: p50 and p90 of the age are both 5
  // days (552 of 597 refresh inside a week), so 10 days is twice the p90
  // cadence and cannot fire on normal quiet. Measured effect at this value:
  // 1 crawler (nord-anglia, 14 days). The three genuine 5-day transport blips
  // stay inside the transient window, which is what that window is for.
  const lastSuccessAtMs = previous.lastSuccessfulRunAt
    ? Date.parse(previous.lastSuccessfulRunAt)
    : NaN;
  const transportAbortOutlivedFloor =
    Number.isFinite(lastSuccessAtMs) &&
    nowMs - lastSuccessAtMs > TRANSPORT_ABORT_STALE_FLOOR_MS;
  const transientTransportAbort =
    abortedRun && abortKind === 'connection-level-fetch' && !transportAbortOutlivedFloor;
  // Same evidence as the #5945 filtered-empty counts, stated directly instead
  // of derived: the run fetched and parsed fine, its own filter kept nothing.
  const filteredEmptyOutcome = fetchOutcome === 'filtered_empty' && lastObservedJobs === 0;
  // A PROVEN break, on the run's own report. Waiting three days to say "0 jobs"
  // adds nothing here: the cause is already known and named. A soft transport
  // abort is intentionally excluded and uses the ordinary empty-streak gate.
  const fetchFailed =
    (CRAWLER_FETCH_FAILURE_OUTCOMES.has(fetchOutcome) || abortKind === 'connection-level-fetch') &&
    lastObservedJobs === 0 &&
    !transientTransportAbort;

  // A fetch failure, process-exit receipt, or parser-positive zero-output
  // receipt cancels every empty-ok signal, including a manual
  // EMPTY_OK_CRAWLERS entry. None of those receipts proves that the source is
  // empty: an abort may have happened before publication, and `parsed > 0`
  // with no output proves that work was lost after the parser. Letting an
  // allowlist or inferred-filter signal win would reset the streak on an
  // incomplete result instead of keeping the prior slice protected.
  const emptyOk =
    !fetchFailed &&
    !abortedRun &&
    !pipelineDroppedAll &&
    (EMPTY_OK_CRAWLERS.has(observation.slug) ||
      autoFilteredEmpty ||
      authoritativeEmpty ||
      filteredEmptyOutcome);

  // The run aborted before publishing (exit-guard slice). This deliberately
  // does NOT feed `emptyOk`: even a soft transport abort must keep its streak
  // so a persistent outage is eventually surfaced. It only changes the
  // failure we NAME, because "returned 0 jobs" asserts something about the
  // source that the run never established.
  //
  // It is the exact complement of the #7324 proof above. That one carries a
  // proof the source IS empty and can only ride on a slice the pipeline wrote
  // itself; this one marks the slices the pipeline never reached, which is why
  // the #7324 mechanism can never classify them however many validators are
  // added. Together they cover both halves of a zero: proven-empty, and
  // never-observed.
  // Back-compat: legacy callers (older tests) pass `{ assembledAt, jobCount }`
  // directly. Resolve a freshness timestamp from whichever field is present.
  const freshnessAt =
    observation.freshnessAt !== undefined
      ? observation.freshnessAt
      : (observation.assembledAt ?? null);
  const freshnessSource = observation.freshnessSource ?? 'by-crawler';

  // The monitor's own cadence (daily cron + manual workflow_dispatch) can run
  // MORE often than a given crawler actually re-crawls (crawler workflows
  // vary: cross-repo dispatch, disabled/migrated groups, backlog delays). If
  // this tick's freshness timestamp is IDENTICAL to the one already counted
  // on the previous tick, no new crawl happened between checks — it is the
  // same run being observed twice, not a second empty attempt. Without this
  // guard, N stale re-observations of a SINGLE genuine empty run inflate
  // `consecutiveEmptyRuns` to the `broken` threshold in N ticks instead of N
  // actual crawl attempts (#6694: giardino crawled once on 2026-08-27,
  // returned 0 jobs, then its crawl workflow stopped running entirely for
  // days — 3 unrelated daily health-check ticks over that same frozen
  // summary still counted "3 consecutive runs returned 0 jobs"). A crawl
  // that has genuinely stopped running is still caught by the `stale` gate
  // above once `freshnessAt` ages past `STALE_AFTER_DAYS` — that is the
  // correct signal for "the workflow stopped", not a fabricated empty streak.
  // `freshnessAt` alone is not a complete run identity: some producers use
  // day-granularity timestamps. Treat the observation as a repeat only when
  // its count and empty classification also agree. With no upstream run id,
  // equal freshness + count + classification is the same observable run by
  // construction; a distinct same-day run must change at least one of those
  // signals. Missing classification fields remain migration-compatible.
  const previousEmptyOk =
    typeof previous._lastObservedEmptyOk === 'boolean'
      ? previous._lastObservedEmptyOk
      : EMPTY_OK_CRAWLERS.has(observation.slug)
        || previous._autoFilteredEmpty === true
        || previous._authoritativeEmptySnapshot === true;
  const isRepeatObservation =
    hadPriorState &&
    freshnessAt !== null &&
    freshnessAt !== undefined &&
    previous._lastObservedFreshnessAt !== null &&
    previous._lastObservedFreshnessAt !== undefined &&
    freshnessAt === previous._lastObservedFreshnessAt &&
    previous._lastObservedJobs !== null &&
    previous._lastObservedJobs !== undefined &&
    lastObservedJobs === previous._lastObservedJobs &&
    emptyOk === previousEmptyOk;

  const consecutiveEmptyRuns = isRepeatObservation
    ? (previous.consecutiveEmptyRuns ?? 0)
    : lastObservedJobs > 0 || emptyOk
      ? 0
      : (previous.consecutiveEmptyRuns ?? 0) + 1;

  // Unlike `consecutiveEmptyRuns` above, this counts EVERY empty observation
  // — emptyOk included — resetting only when jobs actually come back. It is
  // the only thing that keeps growing while an unproven emptyOk signal masks
  // a source that has gone from "legitimate lull" to "dead" (#6496). A
  // current authoritative empty snapshot is already a liveness proof, so it
  // does not need to raise that advisory. Same repeat-observation guard
  // applies: a re-observed stale summary is not a new empty-ok run.
  const consecutiveEmptyOkRuns = isRepeatObservation
    ? (previous.consecutiveEmptyOkRuns ?? 0)
    : lastObservedJobs > 0
      ? 0
      : (previous.consecutiveEmptyOkRuns ?? 0) + 1;
  let advisory =
    lastObservedJobs === 0 &&
    emptyOk &&
    !authoritativeEmpty &&
    consecutiveEmptyOkRuns >= EMPTY_OK_ADVISORY_AFTER_RUNS;
  let advisoryReason = advisory
    ? `${consecutiveEmptyOkRuns} consecutive empty-ok runs (>= ${EMPTY_OK_ADVISORY_AFTER_RUNS}) — verify the source is still alive, not just "legitimately quiet"`
    : null;

  const detailDropReason = detailDropAdvisoryReason(observation.detailDrop);
  if (!advisory && detailDropReason !== null) {
    advisory = true;
    advisoryReason = detailDropReason;
  }

  const lastNonZeroJobs =
    lastObservedJobs > 0 ? lastObservedJobs : (previous.lastNonZeroJobs ?? 0);

  // "Successful" = slice carries non-zero jobs. We use the freshness timestamp
  // (summary preferred, by-crawler fallback) so the value survives CI
  // checkouts cleanly.
  const lastSuccessfulRunAt =
    lastObservedJobs > 0
      ? freshnessAt
      : (previous.lastSuccessfulRunAt ?? null);

  // Freshness derives from the summary slice (or the by-crawler fallback when
  // no summary exists yet), NOT from `lastSuccessfulRunAt`. A source like
  // BancaStato may legitimately be empty for weeks — the summary slice is
  // still being refreshed daily, so the crawler is working. Only flag stale
  // when the workflow itself stops running.
  const freshnessAgeMs =
    freshnessAt !== null && freshnessAt !== undefined
      ? nowMs - new Date(freshnessAt).getTime()
      : Infinity;
  const freshnessAgeDays = freshnessAgeMs / MS_PER_DAY;

  let status = 'healthy';
  let reason = null;
  if (freshnessAgeDays > STALE_AFTER_DAYS) {
    status = 'stale';
    reason = `crawler not run in ${Math.round(freshnessAgeDays)} days (freshnessAt=${freshnessAt ?? 'unknown'}, source=${freshnessSource})`;
  } else if (fetchFailed) {
    // FIRST observation, no streak. The empty-streak gate needs three runs
    // because `total: 0` on its own is ambiguous — anti-bot block, dead
    // selector and a genuinely quiet source are the same number — so it waits
    // for a pattern it can only ever describe as "N runs returned 0 jobs",
    // still without a cause. This run already carries the cause, so the wait
    // buys nothing but three days of a broken crawler serving a stale slice,
    // and the reason can send triage to the right layer instead of the parser
    // by default.
    status = 'broken';
    if (abortKind === 'connection-level-fetch') {
      reason = 'run reported abortKind=connection-level-fetch with 0 jobs — the crawler could not reach the source after retries and proxy fallback; look at crawler egress/transport, not at selectors';
    } else if (fetchOutcome === 'anti_bot_block') {
      reason = 'run reported lastFetchOutcome=anti_bot_block with 0 jobs — the source refused the fetch (WAF/anti-bot/IP reputation) and the selectors were never exercised; look at the fetch transport, not at the parser';
    } else if (fetchOutcome === 'selector_miss') {
      reason = 'run reported lastFetchOutcome=selector_miss with 0 jobs — the fetch succeeded and the parser matched nothing it used to match (selector/label drift); look at the parser config, the source is reachable';
    } else if (fetchOutcome === 'connection_error') {
      reason = 'run reported lastFetchOutcome=connection_error with 0 jobs — retries and proxy fallback never observed the source; look at crawler egress/transport, not at selectors';
    } else if (fetchOutcome === 'exhausted_retry') {
      reason = 'run reported lastFetchOutcome=exhausted_retry with 0 jobs — the source returned retryable HTTP responses until the response retry budget was exhausted; look at the source transport, not at selectors';
    } else {
      reason = 'run reported lastFetchOutcome=feed_endpoint_unavailable with 0 jobs — the expected feed host answered with a redirect or HTML document; look at the vendor endpoint, not at XML selectors';
    }
  } else if (lastObservedJobs === 0 && emptyOk) {
    status = 'healthy';
    reason = null;
  } else if (consecutiveEmptyRuns >= BROKEN_AFTER_EMPTY_RUNS) {
    status = 'broken';
    // Still broken — an aborting crawler IS broken and must stay flagged. What
    // changes is WHICH failure we name. "Returned 0 jobs" is a claim about the
    // SOURCE and it sends triage to the parser selectors or to retiring the
    // crawler; when the run aborted, both are the wrong place to look and the
    // source is usually still full. Say what actually happened instead.
    const abortKindDiagnosis = abortKind === 'no-jobs-parsed'
      ? 'the crawler reached a fail-closed no-jobs bail-out before publishing'
      : abortKind === 'connection-level-fetch'
        ? 'the crawler could not reach the source at the transport boundary'
        : abortKind === 'crash'
          ? 'the crawler crashed before publishing'
          // A cause the receipt names but this map does not describe (the
          // template's newer exits: missing-detail-url, thin-source-all, …)
          // is still a reported cause: say its name instead of claiming that
          // none was given, so a new kind reaches the issue without editing
          // this monitor.
          : abortKind
            ? `the crawler reported its early exit as abortKind=${abortKind}`
            : 'the early-exit cause was not reported';
    const summaryMissingRun = summaryMissingRunUrl(summaryMissing);
    reason = summaryMissing
      // No receipt reached `main` at all: the group generation published its
      // siblings and withheld this member. The only place the real cause
      // exists is that run's member step log, so the reason links it.
      ? `${consecutiveEmptyRuns} consecutive runs aborted before publishing a result (abortKind=${SUMMARY_MISSING_ABORT_KIND}: crawler-group ${summaryMissing.group} generation ${summaryMissingRun ?? 'run unknown'} finished at ${summaryMissing.checkedAt} and published ${summaryMissing.publishedMembers} sibling summaries but not this crawler's; last published summary ${summaryMissing.lastSummaryAt ?? 'never'}) — the member exited non-zero or was killed, so its receipt was withheld from the group commit; read this crawler's "Run" step log in that run; the source was NOT observed empty and the previous slice is still live`
      : pipelineDroppedAll
      // The parser emitted jobs but the receipt has no output. For an early
      // exit this is an incomplete/truncated run, not a source-proven empty
      // state; direct triage downstream of the parser and at the abort path.
      ? abortedRun
        ? `${consecutiveEmptyRuns} consecutive runs aborted with a 0-job receipt after the parser emitted ${observation.parsed} (post-parser pipeline drop or truncated receipt) — inspect the pipeline and abort path; the source was observed`
        : `${consecutiveEmptyRuns} consecutive runs published 0 jobs while the parser emitted ${observation.parsed} (post-parser pipeline drop: merge/expiry/validation/slice) — the selectors are working, look downstream of the parser`
      : abortedRun
      // `?? 'unknown'` and never `?? 0`: 0 means "deliberate bail-out" and
      // non-zero means "crash", which is different triage. An absent field is
      // neither, and defaulting it to 0 would assert a clean bail-out on a
      // crash — the same substitution of a placeholder for evidence this whole
      // change exists to stop.
      ? `${consecutiveEmptyRuns} consecutive runs aborted before publishing a result (abortKind=${abortKind ?? 'unknown'}, exit guard, last exitCode=${observation.exitCode ?? 'unknown'}) — ${abortKindDiagnosis}; the source was NOT observed empty and the previous slice is still live; look for the crawler's own bail-out, not for a dead selector`
      : `${consecutiveEmptyRuns} consecutive runs returned 0 jobs`;
  } else if (lastObservedJobs === 0 && !lastSuccessfulRunAt && !hadPriorState) {
    // First time we see this crawler AND it's empty AND we have no history.
    // We can't tell yet if this is a legitimately-empty source (BancaStato)
    // or a freshly-broken parser. Wait for the empty-streak gate to catch
    // genuinely broken parsers — they'll fail 3 days in a row.
    status = 'warming_up';
    reason = null;
  }

  return {
    state: {
      lastSuccessfulRunAt,
      lastNonZeroJobs,
      consecutiveEmptyRuns,
      consecutiveEmptyOkRuns,
      advisory,
      advisoryReason,
      lastFailureReason: reason,
      status,
      _lastObservedAt: nowIso,
      _lastObservedJobs: lastObservedJobs,
      _lastObservedEmptyOk: emptyOk,
      _lastObservedFreshnessAt: freshnessAt,
      _lastObservedFreshnessSource: freshnessSource,
      _lastObservedAssembledAt: observation.assembledAt ?? null,
      _lastObservedGeneratedAt: observation.generatedAt ?? null,
      _lastObservedDiscoveredCount: hasDiscoveredSignal ? observation.discovered : null,
      _lastObservedWrittenCount: observation.written ?? null,
      _lastObservedParsedCount: hasParsedSignal ? observation.parsed : null,
      _lastObservedDetailDrop: observation.detailDrop ?? null,
      _autoFilteredEmpty: autoFilteredEmpty,
      _pipelineDroppedAll: pipelineDroppedAll,
      _authoritativeEmptySnapshot: authoritativeEmpty,
      _lastObservedFetchOutcome: fetchOutcome,
      _lastObservedAbortKind: abortKind,
      // Non entra in OBSERVATION_DIAGNOSTIC_FIELDS di proposito: il commit
      // descrive l'osservazione vincente, e ereditarlo da quella scartata
      // attribuirebbe a una run il codice di un'altra.
      _lastObservedCodeCommit: observedCodeCommit(observation),
      _abortedRun: abortedRun,
      _lastObservedSummaryMissing: summaryMissing,
    },
    reason,
    status,
  };
}

async function main() {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const retiredSlugs = await readRetiredCrawlerSlugs();
  const slugs = await listCrawlerSlugs({ retiredSlugs });
  if (slugs.length === 0) {
    console.warn('[health] No crawler files found; nothing to check.');
  }

  const prevState = (await readJsonSafe(HEALTH_STATE_PATH)) ?? {
    _lastCheckedAt: null,
    crawlers: {},
  };
  const prevCrawlers = prevState.crawlers ?? {};

  const nextCrawlers = {};
  const issues = [];
  const siteObservations = [];

  const publishedObservations = [];
  for (const slug of slugs) {
    const siteObservation = await inspectCrawler(slug);
    if (!siteObservation) continue; // Skipped — already logged.
    publishedObservations.push(siteObservation);
  }
  // A group member whose generation ran without publishing its summary is an
  // aborted run, not a repeat of the last summary that did reach `main`.
  const roster = await readJsonSafe(CRAWLER_GENERATION_ROSTER_PATH);
  let ledgerRaw = '';
  try {
    ledgerRaw = await fs.readFile(CRAWLER_GENERATION_LEDGER_PATH, 'utf8');
  } catch (err) {
    console.warn(`[health] Cannot read crawler generation ledger: ${err.message}`);
  }
  const absence = applyGenerationSummaryAbsence(publishedObservations, {
    groups: roster?.groups,
    ledgerEntries: parseCrawlerGenerationLedger(ledgerRaw),
  });
  for (const { slug, group, checkedAt } of absence.absent) {
    console.warn(`[health] ${slug}: crawler-group ${group} generation of ${checkedAt} published no summary for it — recorded as an aborted run (${SUMMARY_MISSING_ABORT_KIND})`);
  }
  siteObservations.push(...absence.observations);

  const recoveryCandidates = siteObservations
    .filter((observation) => {
      const { status } = nextCrawlerState(
        prevCrawlers[observation.slug],
        observation,
        nowIso,
        nowMs,
      );
      return status === 'stale' || status === 'broken';
    })
    .map(({ slug }) => slug);
  const corpusObservations = await inspectCorpusRecoveryBatch(
    recoveryCandidates,
  );

  for (const siteObservation of siteObservations) {
    const { slug } = siteObservation;
    let observation = siteObservation;
    let evaluation = nextCrawlerState(
      prevCrawlers[slug],
      observation,
      nowIso,
      nowMs,
    );
    if (evaluation.status === 'stale' || evaluation.status === 'broken') {
      const corpusObservation = corpusObservations.get(slug);
      observation = selectNewestCrawlerObservation(
        siteObservation,
        corpusObservation,
        nowMs,
      );
      if (observation !== siteObservation) {
        console.warn(
          `[health] ${slug}: using newer corpus recovery observation ` +
          `(${observation.freshnessAt}) over site (${siteObservation.freshnessAt ?? 'unknown'})`,
        );
        evaluation = nextCrawlerState(
          prevCrawlers[slug],
          observation,
          nowIso,
          nowMs,
        );
      }
    }

    const { state, status, reason } = evaluation;
    nextCrawlers[slug] = state;

    if (status === 'stale' || status === 'broken' || state.advisory) {
      // `state.advisory` fires while `status` is still 'healthy' (the
      // EMPTY_OK_CRAWLERS design is intentionally not overridden) — surface
      // it as its own issue status so it doesn't read as stale/broken.
      const issueStatus = state.advisory && status === 'healthy' ? 'advisory' : status;
      const issue = {
        slug,
        reason: issueStatus === 'advisory' ? state.advisoryReason : (reason ?? `status=${status}`),
        lastSeenAt: state.lastSuccessfulRunAt,
        status: issueStatus,
        consecutiveEmptyRuns: state.consecutiveEmptyRuns,
        codeCommit: state._lastObservedCodeCommit ?? null,
      };
      // La scheda viaggia nel file, non nel workflow: la condizione di chiusura
      // di questa issue vive nel codice del closer (lo step "Close recovered
      // crawler-health issues"), e finora nessuno che leggesse la issue poteva
      // vederla. Il corpo lo compone la bash dello step di apertura, ma il testo
      // si costruisce qui — dove i valori esistono — invece di duplicare il
      // formato della scheda dentro un heredoc.
      issues.push({ ...issue, scheda: buildHealthScheda(issue) });
    }
  }

  // Carry forward any previously-tracked crawlers that disappeared from disk
  // (e.g. crawler renamed) so we don't lose their history silently. Historical
  // scratch companions are not crawler identities and must not survive forever
  // merely because an older monitor discovered them before isSliceFile existed.
  for (const [slug, prev] of Object.entries(prevCrawlers)) {
    if (retiredSlugs.has(slug)) {
      // Keep a retired crawler's prior state as a healthy, explicit marker so
      // the monitor's existing issue closer can resolve an alert opened before
      // the retirement. Its old summary remains available for SEO/data audits,
      // but it is no longer an active health observation.
      nextCrawlers[slug] = {
        ...prev,
        status: 'healthy',
        advisory: false,
        advisoryReason: null,
        lastFailureReason: null,
        _retired: true,
      };
      continue;
    }
    if (!(slug in nextCrawlers) && shouldCarryForwardCrawlerSlug(slug)) {
      nextCrawlers[slug] = { ...prev, status: 'unknown', _missingAt: nowIso };
    }
  }

  const nextState = {
    _lastCheckedAt: nowIso,
    crawlers: nextCrawlers,
  };

  await fs.writeFile(HEALTH_STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');

  if (issues.length > 0) {
    await fs.writeFile(HEALTH_ISSUES_PATH, JSON.stringify(issues, null, 2) + '\n');
    console.error(
      `[health] ${issues.length} crawler(s) stale/broken:`,
      issues.map((i) => `${i.slug}(${i.status})`).join(', '),
    );
    process.exit(1);
  }

  // Clear the stale issues file if it exists from a prior run — nothing to flag.
  try {
    await fs.unlink(HEALTH_ISSUES_PATH);
  } catch {
    /* file did not exist */
  }

  console.log(`[health] All ${slugs.length} crawler(s) healthy.`);
  process.exit(0);
}

// Exported for tests. `main()` only runs when the script is invoked directly.
export {
  corpusObservationFromPayloads,
  inspectCorpusRecoveryBatch,
  inspectCorpusRecoveryCrawler,
  inspectCrawler,
  listCrawlerSlugs,
  nextCrawlerState,
  selectNewestCrawlerObservation,
  shouldCarryForwardCrawlerSlug,
};

/**
 * Il blocco `## Scheda` della issue `[crawler-health] <slug>`.
 *
 * La condizione di chiusura esisteva gia', ma solo come codice: lo step "Close
 * recovered crawler-health issues" di `crawler-health-monitor.yml` risolve la
 * issue quando `data/crawler-health.json` dice `status: "healthy"` e
 * `advisory: false` per quello slug. Qui quella stessa condizione diventa
 * leggibile da chi raccoglie la issue, con il comando che la verifica.
 *
 * @param {{slug:string, status:string, reason:string, consecutiveEmptyRuns?:number, codeCommit?:string|null}} issue
 */
export function buildHealthScheda(issue) {
  const { slug, status } = issue;
  const codeCommit = observedCodeCommit(issue);
  return buildScheda({
    causa: [
      `(ipotesi, da confermare.) Il crawler \`${slug}\` non pubblica piu' annunci freschi:`,
      `${issue.reason}. Leggi la Reason PRIMA di aprire il parser: se dice che le run`,
      "*abortiscono prima di pubblicare*, la sorgente non e' stata osservata vuota e il",
      "difetto e' un bail-out fail-closed del crawler, non un selettore morto.",
    ],
    fix: [
      'Dipende da cosa mostra la sorgente; non preassegnata qui. | **REPO**: sito |',
      '**MODE**: nessun vincolo di mirror (i crawler non sono nel manifest del ciclo).',
    ],
    metrica: `prima=status:${status} atteso=status:healthy`,
    comando: `git show origin/main:data/crawler-health.json | jq -r '.crawlers["${slug}"] | .status + " advisory=" + (.advisory // false | tostring)'`,
    note: [
      '`healthy advisory=false` e\' la condizione esatta con cui lo step di chiusura',
      'risolve questa issue: qualunque altro valore la tiene aperta. Si legge da git e non',
      'dal disco per due motivi: lo stato che il closer guarda e\' quello che il monitor',
      'committa su `main`, non uno ricalcolato in locale, e cosi\' verificare il criterio non',
      'lascia file dati modificati nel working tree di chi verifica.',
      codeCommit
        ? `Codice osservato: l'ultima summary e' stata prodotta dal commit \`${codeCommit}\` del sito. Una fix mergiata DOPO quel commit non ha ancora girato: \`git merge-base --is-ancestor <merge commit della fix> ${codeCommit}\` lo verifica prima di riaprire il parser.`
        : "Codice osservato: l'ultima summary non dichiara `codeCommit`, quindi da qui non si puo' stabilire se una fix recente ha gia' girato.",
    ],
    osservatore: [
      '`.github/workflows/crawler-health-monitor.yml` — lo step "Close recovered',
      'crawler-health issues" chiude questa issue da solo quando il criterio sopra torna',
      'vero, e lo step di apertura la riconia se il crawler ricade. La serie sta in',
      '`data/crawler-health.json`.',
    ],
    fallimento: `\`[crawler-health] ${slug}: crawler unhealthy\``,
  });
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error('[health] Fatal error:', err);
    process.exit(2);
  });
}
