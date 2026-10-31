#!/usr/bin/env node
/**
 * exchange-hreflang-manifests — wait until all four same-run hreflang manifests
 * are published, then download the three this leg does not own.
 *
 * Contract and rationale of the manifest: scripts/lib/hreflang-index-manifest.mjs.
 *
 * Where it runs: deploy.yml `build-locale`, after this leg published its own
 * manifest as an artifact and before the rewrite pass that requires them all.
 *
 * Why artifacts and not actions/cache. Run 41088323300 lost three legs after
 * more than two hours of build: `actions/cache/restore` reported a cache hit,
 * GitHub then answered `Egress is over the account limit`, and the action turned
 * that into a warning plus a miss. A cache is best-effort by contract, offers no
 * retry a workflow can drive, and can be evicted; this manifest is mandatory.
 * Artifacts are readable with the job token, so the retry lives here.
 *
 * Why the barrier ends at a point of the job and not after a duration. The legs
 * start together but reach this step far apart, and the gap follows their
 * incremental cache hits: run 41119148516 published en at 21:19 and it at 22:21,
 * two minutes after a fixed 60-minute wait had expired and taken the other legs
 * with it. That wait had already gone from 15 to 60 minutes (#15173) and then to
 * 120 (#16148): no fixed duration fits a gap that moves. A leg that died is caught
 * by the sibling check, so the only real limit is the job budget.
 *
 * Which attempt a manifest belongs to. Every leg of an attempt publishes under
 * that attempt, so no leg judges a sibling against a different snapshot. The one
 * exception is a sibling that already succeeded in an earlier attempt: "Re-run
 * failed jobs" does not run it again, and its shard is the one that shipped, so
 * its manifest is the correct one. Reading only the current attempt would leave a
 * rerun waiting for a file nobody will ever write.
 *
 * Failure model
 *   - Listing or download errors are transient: retried inside a bounded budget.
 *   - Unreadable manifest content is not: an artifact is immutable, so a second
 *     download returns the same bytes. It fails at once.
 *   - Exhausting a budget fails the leg. A missing manifest must never be read
 *     as an unknown member, or one shard would publish a different graph.
 *
 * Usage (env: GH_TOKEN, GH_REPO, HREFlANG_RUN_ID, HREFlANG_RUN_ATTEMPT,
 * HREFlANG_BUILD_LOCALE, HREFlANG_JOB_START_EPOCH):
 *   node scripts/ci/exchange-hreflang-manifests.mjs
 *     [--manifest-dir .cache/hreflang-index-manifest]
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { MANIFEST_LOCALES, parseHreflangManifest } from '../lib/hreflang-index-manifest.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { buildLocaleFromJobName } from './lib/deploy-job-failure-signature.mjs';

const execFileAsync = promisify(execFile);

// Minutes after the job start by which the slowest leg must have published. The
// rest of the 360-minute job covers the longest post-barrier work (76 minutes on
// the it leg in run 41119148516) and the download budget below.
export const BARRIER_JOB_ELAPSED_MS = 260 * 60_000;
// A leg can wait for hours here, so the poll stays gentle on the shared token
// quota. A manifest seen 30 s late costs nothing next to the wait itself.
export const DEFAULT_POLL_MS = 30_000;
// Shared by the three downloads, so the step has one known upper bound.
export const DEFAULT_DOWNLOAD_BUDGET_MS = 20 * 60_000;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const API_TIMEOUT_MS = 30_000;
// A throttled transfer stalls instead of failing, so each try needs its own end.
const DOWNLOAD_TIMEOUT_MS = 3 * 60_000;
const GH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TERMINAL_FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);

export class ManifestExchangeError extends Error {}

export function manifestArtifactName(locale, runId, runAttempt) {
  return `hreflang-index-manifest-${locale}-${runId}-${runAttempt}`;
}

function describeError(error) {
  if (error?.killed) return 'timed out';
  const stderr = String(error?.stderr || '').trim();
  const detail = stderr || String(error?.message || error);
  return detail.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) || 'unknown error';
}

async function isPublished({ gh, repo, runId, name }) {
  const url = `repos/${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}`;
  const { artifacts = [] } = JSON.parse(await gh(['api', '-X', 'GET', url], API_TIMEOUT_MS));
  return artifacts.some((artifact) => artifact?.name === name && artifact?.expired === false);
}

async function readJobs({ gh, repo, runId }) {
  const url = `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;
  const { jobs = [] } = JSON.parse(await gh(['api', '-X', 'GET', url], API_TIMEOUT_MS));
  return jobs;
}

function manifestAttemptOf(locale, jobs, runAttempt) {
  const job = jobs.find((candidate) => buildLocaleFromJobName(candidate?.name) === locale);
  const attempt = Number(job?.run_attempt);
  return job?.conclusion === 'success' && attempt >= 1 && attempt < Number(runAttempt)
    ? String(attempt)
    : String(runAttempt);
}

async function firstMissingLocale({ gh, repo, runId, runAttempt, jobs, published }) {
  for (const locale of MANIFEST_LOCALES) {
    // Decided on every poll: a job list can show a rerun only after the first read.
    const attempt = manifestAttemptOf(locale, jobs, runAttempt);
    if (published.get(locale) === attempt) continue;
    published.delete(locale);
    const name = manifestArtifactName(locale, runId, attempt);
    if (!(await isPublished({ gh, repo, runId, name }))) return locale;
    published.set(locale, attempt);
  }
  return null;
}

function terminatedLocaleJob(jobs) {
  const job = jobs.find((candidate) => buildLocaleFromJobName(candidate?.name)
    && TERMINAL_FAILURE_CONCLUSIONS.has(candidate?.conclusion));
  return job?.name ?? null;
}

/**
 * Block until the four manifests of this run attempt are published. One failed
 * API read must not end a leg that has already built for two hours, so an
 * unreadable poll only counts as "not complete yet".
 *
 * @returns {Promise<Map<string, string>>} locale → attempt of its manifest.
 */
export async function waitForManifestSet({
  gh,
  repo,
  runId,
  runAttempt,
  deadline,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  sleep,
  log = console.log,
}) {
  const published = new Map();
  let waitingFor = 'the first poll';
  for (;;) {
    try {
      const jobs = await readJobs({ gh, repo, runId });
      const missing = await firstMissingLocale({ gh, repo, runId, runAttempt, jobs, published });
      if (missing === null) {
        log('✓ complete same-run hreflang manifest set is available');
        return published;
      }
      waitingFor = missing;
      // A sibling that has terminated cannot publish its manifest. Stop now, so
      // the rearm job classifies the failed leg itself instead of three
      // misleading barrier timeouts after the readiness budget expires.
      const failed = terminatedLocaleJob(jobs);
      if (failed) {
        throw new ManifestExchangeError(
          `same-run hreflang manifest barrier aborted: ${failed} terminated before publishing its manifest`,
        );
      }
    } catch (error) {
      if (error instanceof ManifestExchangeError) throw error;
      log(`::warning::same-run hreflang manifest barrier poll failed: ${describeError(error)}`);
    }
    if (now() >= deadline) {
      throw new ManifestExchangeError(`same-run hreflang manifest barrier timed out waiting for ${waitingFor}`);
    }
    await sleep(pollMs);
  }
}

function readForeignManifest(file, locale, runId) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ManifestExchangeError(`invalid same-run hreflang manifest ${locale}: ${describeError(error)}`);
  }
  const parsed = parseHreflangManifest(text, locale);
  if ('error' in parsed) {
    throw new ManifestExchangeError(`invalid same-run hreflang manifest ${locale}: ${parsed.error}`);
  }
  if (!parsed.runId || parsed.runId !== String(runId)) {
    throw new ManifestExchangeError(
      `foreign same-run hreflang manifest ${locale}: runId=${parsed.runId || '<missing>'}, expected=${runId}`,
    );
  }
}

/**
 * Download one sibling manifest into `manifestDir/<locale>.json`. The final path
 * appears only after validation, so a partial transfer is never visible to the
 * rewrite pass.
 *
 * @returns {Promise<number>} the number of tries used.
 */
export async function downloadManifest({
  gh,
  repo,
  runId,
  manifestAttempt,
  locale,
  manifestDir,
  deadline,
  now = Date.now,
  sleep,
  log = console.log,
}) {
  const name = manifestArtifactName(locale, runId, manifestAttempt);
  const unavailable = (tries, reason) => new ManifestExchangeError(
    `same-run hreflang manifest unavailable after ${tries} tries: ${locale} (${reason})`,
  );
  for (let attempt = 1; ; attempt += 1) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw unavailable(attempt - 1, 'download budget exhausted');
    const dir = fs.mkdtempSync(path.join(manifestDir, `.download-${locale}-`));
    try {
      await gh(
        ['run', 'download', String(runId), '--repo', repo, '--name', name, '--dir', dir],
        Math.min(DOWNLOAD_TIMEOUT_MS, remainingMs),
      );
      if (now() >= deadline) throw unavailable(attempt, 'download budget exhausted');
      const file = path.join(dir, `${locale}.json`);
      readForeignManifest(file, locale, runId);
      fs.renameSync(file, path.join(manifestDir, `${locale}.json`));
      return attempt;
    } catch (error) {
      if (error instanceof ManifestExchangeError) throw error;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
      if (now() + delay >= deadline) throw unavailable(attempt, describeError(error));
      log(`::warning::same-run hreflang manifest ${locale}: try ${attempt} failed (${describeError(error)}), retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Barrier first, then every sibling manifest. Exported for tests. */
export async function exchangeHreflangManifests({
  gh,
  repo,
  runId,
  runAttempt,
  buildLocale,
  manifestDir,
  jobStartEpoch,
  barrierJobElapsedMs = BARRIER_JOB_ELAPSED_MS,
  pollMs = DEFAULT_POLL_MS,
  downloadBudgetMs = DEFAULT_DOWNLOAD_BUDGET_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  log = console.log,
}) {
  if (!MANIFEST_LOCALES.includes(buildLocale)) {
    throw new ManifestExchangeError(`unknown hreflang build locale: ${buildLocale || '<missing>'}`);
  }
  for (const [label, value] of Object.entries({ repo, runId, runAttempt, jobStartEpoch })) {
    if (!value) throw new ManifestExchangeError(`missing hreflang manifest exchange input: ${label}`);
  }
  const jobStartMs = Number(jobStartEpoch) * 1000;
  if (!Number.isSafeInteger(jobStartMs) || jobStartMs <= 0) {
    throw new ManifestExchangeError(`invalid hreflang job start epoch: ${jobStartEpoch}`);
  }
  const attempts = await waitForManifestSet({
    gh,
    repo,
    runId,
    runAttempt,
    deadline: jobStartMs + barrierJobElapsedMs,
    pollMs,
    now,
    sleep,
    log,
  });

  fs.mkdirSync(manifestDir, { recursive: true });
  const deadline = now() + downloadBudgetMs;
  for (const locale of MANIFEST_LOCALES) {
    if (locale === buildLocale) continue;
    const manifestAttempt = attempts.get(locale);
    const tries = await downloadManifest({ gh, repo, runId, manifestAttempt, locale, manifestDir, deadline, now, sleep, log });
    log(`✓ same-run hreflang manifest ${locale} downloaded (${tries} ${tries === 1 ? 'try' : 'tries'})`);
  }
}

async function runGh(args, timeoutMs) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: GH_MAX_BUFFER_BYTES,
  });
  return stdout;
}

function parseArgs(argv) {
  const args = { manifestDir: '.cache/hreflang-index-manifest' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest-dir') args.manifestDir = argv[++i];
    else throw new ManifestExchangeError(`unknown argument: ${argv[i]}`);
  }
  return args;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const { manifestDir } = parseArgs(process.argv.slice(2));
    await exchangeHreflangManifests({
      gh: runGh,
      repo: process.env.GH_REPO,
      runId: process.env.HREFlANG_RUN_ID,
      runAttempt: process.env.HREFlANG_RUN_ATTEMPT,
      buildLocale: process.env.HREFlANG_BUILD_LOCALE,
      jobStartEpoch: process.env.HREFlANG_JOB_START_EPOCH,
      manifestDir: path.resolve(manifestDir),
    });
  } catch (error) {
    if (!(error instanceof ManifestExchangeError)) throw error;
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
