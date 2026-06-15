#!/usr/bin/env node
/**
 * Daily Reddit poster for Ticino job listings.
 *
 * Mirrors the STRUCTURE of scripts/schedule-fb-jobs-daily.mjs, but Reddit
 * has NO server-side scheduled-publish: posts go out IMMEDIATELY, a small
 * conservative batch per run, self-paced with a delay between posts to
 * respect Reddit rate limits & anti-spam. Default volume is LOW.
 *
 * Each job is posted ONCE (to the first eligible, not-rate-limited
 * subreddit). Posted jobs are tracked in `data/reddit-posted-jobs.json`
 * to dedup across runs.
 *
 * Usage:
 *   node scripts/schedule-reddit-jobs-daily.mjs
 *
 * Env:
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME,
 *     REDDIT_PASSWORD, REDDIT_USER_AGENT — OAuth credentials (consumed by
 *     scripts/lib/reddit-client.mjs; required for non-dry-run mode).
 *   REDDIT_JOB_VOLUME=N      — posts PER RUN, default 2 (conservative).
 *   REDDIT_POST_DELAY_MS=N   — delay between posts, default 5000 (0 in tests).
 *   DRY_RUN=1                — log payloads, no API call.
 *
 * Soft-fail: every error path logs and `process.exit(0)`. The workflow's
 * commit step is gated on the data file mutating, so a no-op run leaves
 * git untouched.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  selectUnpostedJobs,
  buildJobUrl,
  loadLedger,
  appendLedger,
} from './lib/social-post-utils.mjs';

import { getAccessToken, submitPost, userAgent } from './lib/reddit-client.mjs';
import { buildJobPost } from './lib/reddit-templates.mjs';

// Re-export the channel-agnostic helpers so tests can import them from
// this module directly (mirrors the FB scheduler).
export {
  selectUnpostedJobs,
  buildJobUrl,
} from './lib/social-post-utils.mjs';

// ── Constants ───────────────────────────────────────────────

// Conservative default: posts PER RUN (not 144 like FB). Low volume keeps
// us well under Reddit's anti-spam thresholds.
const DEFAULT_VOLUME = 2;

// Default delay between posts within a run (ms).
const DEFAULT_POST_DELAY_MS = 5000;

// Posted-jobs ledger trim cap.
const POSTED_TRIM_LIMIT = 1000;

// ── Path helpers ────────────────────────────────────────────

function defaultRepoRoot() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '..');
}

function jobsPath(repoRoot) {
  // Prefer public/data, fall back to data/ (the agent worktree only has the
  // latter for tests). Same precedence as the FB scheduler.
  const pub = resolve(repoRoot, 'public', 'data', 'jobs.json');
  if (existsSync(pub)) return pub;
  return resolve(repoRoot, 'data', 'jobs.json');
}

function postedPath(repoRoot) {
  return resolve(repoRoot, 'data', 'reddit-posted-jobs.json');
}

function subredditsPath(repoRoot) {
  return resolve(repoRoot, 'data', 'reddit-subreddits.json');
}

// ── jobs.json loader ────────────────────────────────────────

function loadJobs(repoRoot, log) {
  const file = jobsPath(repoRoot);
  try {
    if (!existsSync(file)) {
      log('⚠️', `jobs.json not found at ${file}`);
      return [];
    }
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log('⚠️', `failed to read jobs.json: ${err.message}`);
    return [];
  }
}

// ── Subreddit config loader ─────────────────────────────────

/**
 * Read `data/reddit-subreddits.json`. Returns a config object with empty
 * `subreddits`/`routing` on missing file or malformed JSON — never throws.
 */
export function loadSubreddits(repoRoot) {
  const file = subredditsPath(repoRoot);
  try {
    if (!existsSync(file)) return { schemaVersion: 1, subreddits: {}, routing: {} };
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return { schemaVersion: 1, subreddits: {}, routing: {} };
    }
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      subreddits: parsed.subreddits && typeof parsed.subreddits === 'object' ? parsed.subreddits : {},
      routing: parsed.routing && typeof parsed.routing === 'object' ? parsed.routing : {},
    };
  } catch {
    return { schemaVersion: 1, subreddits: {}, routing: {} };
  }
}

// ── Pure utilities (exported for tests) ─────────────────────

/**
 * Resolve the automation-enabled subreddit names routed for a topic.
 * Returns an array of `{ name, config }` for subs whose
 * `subreddits[name].allowsAutomation === true`, preserving routing order.
 *
 * @param {object} config — parsed reddit-subreddits.json
 * @param {string} topic — e.g. 'jobs' | 'articles'
 * @returns {Array<{ name: string, config: object }>}
 */
export function eligibleSubsForTopic(config, topic) {
  const routed = Array.isArray(config?.routing?.[topic]) ? config.routing[topic] : [];
  const out = [];
  for (const name of routed) {
    const sub = config?.subreddits?.[name];
    if (sub && sub.allowsAutomation === true) {
      out.push({ name, config: sub });
    }
  }
  return out;
}

/**
 * Determine whether a subreddit is rate-limited right now, given the
 * ledger's `posted` entries. Looks at the most recent entry for that
 * subreddit and compares the gap to `now` against `minIntervalHours`.
 * Pure: no I/O.
 *
 * @param {Array<object>} ledgerPosted — ledger `posted` array
 * @param {string} subreddit
 * @param {number} minIntervalHours — 0/undefined disables the limit
 * @param {Date|number} now
 * @returns {boolean} true when the sub posted too recently
 */
export function isRateLimited(ledgerPosted, subreddit, minIntervalHours, now) {
  const minHours = Number(minIntervalHours);
  if (!Number.isFinite(minHours) || minHours <= 0) return false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return false;

  let lastMs = 0;
  for (const entry of Array.isArray(ledgerPosted) ? ledgerPosted : []) {
    if (!entry || entry.subreddit !== subreddit) continue;
    const t = Date.parse(entry.ts);
    if (Number.isFinite(t) && t > lastMs) lastMs = t;
  }
  if (lastMs === 0) return false; // never posted there → not limited
  const gapHours = (nowMs - lastMs) / 3_600_000;
  return gapHours < minHours;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main entry ──────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Date} [opts.now]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.repoRoot]
 * @param {(...a: unknown[]) => void} [opts.log]
 * @param {(...a: unknown[]) => void} [opts.warn]
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;

  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const volumeRaw = Number(env.REDDIT_JOB_VOLUME);
  const volume = Number.isFinite(volumeRaw) && volumeRaw > 0 ? Math.floor(volumeRaw) : DEFAULT_VOLUME;
  const delayRaw = Number(env.REDDIT_POST_DELAY_MS);
  const postDelayMs = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : DEFAULT_POST_DELAY_MS;

  log('🗓️', `Reddit jobs daily poster — volume=${volume}, dry=${dryRun}`);

  // 1. Load jobs
  const jobs = loadJobs(repoRoot, log);
  if (jobs.length === 0) {
    log('ℹ️', 'no jobs available, exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }

  // 2. Ledger → postedSet (a job is "posted" if its id appears for ANY sub).
  const path = postedPath(repoRoot);
  const ledger = loadLedger(path);
  const postedSet = new Set(ledger.posted.map((e) => e?.id).filter(Boolean));

  // 3. Pick top-N never-posted jobs.
  const candidates = selectUnpostedJobs(jobs, postedSet, volume);
  if (candidates.length === 0) {
    log('ℹ️', 'no unposted jobs eligible, exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }
  log('ℹ️', `selected ${candidates.length}/${volume} candidate jobs`);

  // 4. Eligible job subreddits (automation-enabled, routed for "jobs").
  const config = loadSubreddits(repoRoot);
  const eligible = eligibleSubsForTopic(config, 'jobs');
  if (eligible.length === 0) {
    log('ℹ️', 'no automation-enabled job subreddits — exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }

  // Track per-sub last-post time so we don't hammer the same sub within one
  // run. Seed from the ledger so cross-run rate-limiting is consistent.
  // Map<name, ms>
  const lastPostMs = new Map();

  /** Find the first eligible sub that is not rate-limited right now. */
  function pickSub() {
    for (const { name, config: subCfg } of eligible) {
      const minHours = subCfg?.minPostIntervalHours;
      // Cross-run limit from the persisted ledger.
      if (isRateLimited(ledger.posted, name, minHours, now)) continue;
      // In-run limit from this run's own posts.
      const inRunLast = lastPostMs.get(name);
      if (inRunLast != null && Number(minHours) > 0) {
        const gapHours = (now.getTime() - inRunLast) / 3_600_000;
        if (gapHours < Number(minHours)) continue;
      }
      return { name, config: subCfg };
    }
    return null;
  }

  // Early exit if nothing is postable right now.
  if (!pickSub()) {
    log('ℹ️', 'all eligible subreddits rate-limited right now — exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }

  // 5/6. Build + post (or plan) per candidate.
  const payloads = [];
  let posted = 0;
  let acquiredToken = null;

  for (const job of candidates) {
    const target = pickSub();
    if (!target) {
      log('ℹ️', 'no eligible subreddit available for remaining candidates — stopping');
      break;
    }
    const url = buildJobUrl(job);
    if (!url) {
      log('⚠️', `skipping job ${job.id} — no slug`);
      continue;
    }
    const post = buildJobPost(job);
    const payload = {
      jobId: job.id,
      url,
      subreddit: target.name,
      title: post.title,
      kind: post.kind || 'self',
      text: post.text,
    };
    payloads.push(payload);

    if (dryRun) {
      log('  •', `[dry] ${job.id} → r/${target.name} → "${post.title}"`);
      // Mark in-run so dry-run planning also respects per-sub spacing.
      lastPostMs.set(target.name, now.getTime());
      continue;
    }

    // Lazily acquire the token on the first real post.
    if (!acquiredToken) {
      acquiredToken = await getAccessToken(env, fetchImpl);
      if (!acquiredToken) {
        warn('⚠️', 'Reddit access token unavailable (missing credentials?) — skipping');
        return { ok: false, posted, dryRun, payloads };
      }
    }

    const ua = userAgent(env);
    let res = null;
    try {
      res = await submitPost({
        token: acquiredToken,
        subreddit: target.name,
        kind: payload.kind,
        title: payload.title,
        url: payload.url,
        text: payload.text,
        flairId: target.config?.flairId,
        flairText: target.config?.flairText,
        fetchImpl,
        ua,
      });
    } catch (err) {
      warn('⚠️', `submit failed for ${job.id} → r/${target.name}: ${err.message}`);
      res = null;
    }

    if (res?.ok) {
      posted += 1;
      // Append to the ledger IMMEDIATELY so a partial failure still records.
      appendLedger(path, [{
        id: job.id,
        url,
        subreddit: target.name,
        ts: new Date().toISOString(),
        redditPostId: res.name || res.id,
        redditUrl: res.url,
      }], POSTED_TRIM_LIMIT);
      lastPostMs.set(target.name, now.getTime());
      log('✅', `${job.id} → r/${target.name} → ${res.url || res.name || res.id || ''}`.trim());
    } else {
      warn('⚠️', `Reddit submit error for ${job.id} → r/${target.name}: ${res?.error || 'unknown error'}`);
    }

    // Self-pace between posts.
    if (postDelayMs > 0) await sleep(postDelayMs);
  }

  if (dryRun) {
    log('🏃', `DRY_RUN=1 — would post ${payloads.length} jobs`);
    return { ok: true, posted: 0, dryRun: true, payloads };
  }

  log('🏁', `posted ${posted}/${payloads.length} jobs`);
  return { ok: posted > 0, posted, dryRun, payloads };
}

// ── CLI ─────────────────────────────────────────────────────

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  run().then(
    () => process.exit(0),
    (err) => {
      console.error('⚠️ reddit poster crashed:', err?.message || err);
      process.exit(0); // soft-fail
    },
  );
}
