#!/usr/bin/env node

/**
 * probe-cron-dispatch-delay.mjs — records how late GitHub actually DISPATCHED
 * the scheduled run that is executing this script (#3798 Fase 1 follow-up).
 *
 * WHY THIS EXISTS
 * ---------------
 * The 2026-08-05 audit established that in this repo the cost of a cron slot is
 * not runner contention — post-dispatch job queue wait is a median of 2s — but
 * GitHub's scheduled-DISPATCH backlog, which ranges from ~51 min (22:00 UTC) to
 * ~240 min (00:00 UTC). Crucially, a "runs created per hour" histogram cannot
 * measure this: it counts every run at its already-delayed time, so the night
 * looks empty precisely because the night's own work has slid into the morning.
 *
 * That audit left one slot unmeasured: 23:00 UTC. No workflow in the repo is
 * scheduled there, and the neighbouring 21:00 (62 min) and 22:00 (51 min)
 * numbers suggest a 23:xx cron could start around 00:15 UTC — earlier, and with
 * a far tighter tail, than send-job-alerts' current 00:33 slot (median 240 min
 * → ~04:33, p90 471 min, max 590 min). That is a guess. This probe turns it
 * into a measurement.
 *
 * WHAT "BETTER" MEANS HERE — read this before tuning anything
 * -----------------------------------------------------------
 * The goal is NOT punctuality. scripts/lib/send-schedule.mjs
 * computeScheduledSendAt targets the NEXT occurrence of each subscriber's
 * preferred hour, so every subscriber whose hour has already passed when the
 * run fires is pushed onto tomorrow's slot and receives ~24h-old content. What
 * matters is therefore the effective start expressed as a position in the UTC
 * day (`effective_start_minute_of_utc_day`), not the delay itself. A slot that
 * drifts 75 min but starts at 00:15 UTC is strictly better for this feature
 * than one that drifts 20 min but starts at 04:30 — firing early beats firing
 * punctually. See scripts/ci/audit-cron-dispatch-delay.mjs, which turns this
 * column into an expected share-of-base-deferred.
 *
 * SENDS NOTHING. Dispatch delay is a property of GitHub Actions, not of email,
 * so it is measurable without touching a single subscriber. This probe reads
 * its own run's metadata and appends one line to a history file. No email
 * provider is contacted, no Firestore document is read or written.
 *
 * Usage (inside the canary workflow):
 *   CANARY_SLOT=23:17 GH_TOKEN=... node scripts/ci/probe-cron-dispatch-delay.mjs
 *
 * Env:
 *   CANARY_SLOT       required, "HH:MM" — the nominal cron slot this run is for
 *   GITHUB_RUN_ID     required in CI (provided by Actions)
 *   GITHUB_REPOSITORY required in CI (provided by Actions)
 *   GH_TOKEN          token with `actions: read`
 *   CRON_DISPATCH_HISTORY_FILE  optional, default data/cron-dispatch-history.jsonl
 *                               (in CI richiede CRON_DISPATCH_HISTORY_FILE_ALLOW_CI=1)
 *   CANARY_EVENT      optional, defaults to $GITHUB_EVENT_NAME — only `schedule`
 *                     runs are recorded (a workflow_dispatch has no nominal slot
 *                     to be late against; recording it would poison the median)
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOutputPath } from '../lib/resolve-output-path.mjs';

export const DEFAULT_HISTORY_FILE = 'data/cron-dispatch-history.jsonl';

/**
 * A dispatch delay larger than this means we almost certainly attributed the
 * run to the wrong nominal occurrence (a skipped cron, a backfill, a manual
 * re-run of a scheduled workflow). Recorded with `suspect: true` rather than
 * dropped — a slot that starts SKIPPING is itself a reason not to move a
 * production send onto it, so the sample must stay visible.
 */
export const SUSPECT_DELAY_MINUTES = 12 * 60;

/** @returns {{hour:number, minute:number}} */
export function parseSlot(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) throw new Error(`CANARY_SLOT must look like "HH:MM", got "${raw}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`CANARY_SLOT out of range: "${raw}"`);
  return { hour, minute };
}

/**
 * The most recent occurrence of `slot` at or before `createdAt`.
 *
 * Looks back two days, not one: a 23:17 slot whose run is dispatched at 00:15
 * belongs to the PREVIOUS UTC day, and naively building the candidate from
 * createdAt's own date would produce a negative delay and silently flip the
 * sign of the whole measurement. That wrap is the normal case for exactly the
 * late-evening slot this probe exists to evaluate.
 * @param {Date} createdAt
 * @param {{hour:number, minute:number}} slot
 * @returns {Date}
 */
export function computeNominalInstant(createdAt, slot) {
  for (const backDay of [0, 1, 2]) {
    const candidate = new Date(Date.UTC(
      createdAt.getUTCFullYear(),
      createdAt.getUTCMonth(),
      createdAt.getUTCDate() - backDay,
      slot.hour,
      slot.minute,
      0,
      0,
    ));
    if (candidate <= createdAt) return candidate;
  }
  throw new Error('could not locate a nominal cron instant at or before the run creation time');
}

/** Minutes from `nominal` to `createdAt`, never negative. */
export function computeDispatchDelayMinutes(createdAt, nominal) {
  return Math.max(0, (createdAt.getTime() - nominal.getTime()) / 60000);
}

/**
 * Position of an instant within its UTC day, in minutes. THE decision metric:
 * lower means fewer subscribers have already passed their preferred hour, so
 * fewer get deferred to tomorrow's slot with stale content.
 */
export function minutesIntoUtcDay(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
}

/**
 * @param {object} params
 * @returns {object} the record appended to the history file
 */
export function buildRecord({ slotRaw, createdAt, runStartedAt, runId, workflow, repo, now = new Date() }) {
  const slot = parseSlot(slotRaw);
  const nominal = computeNominalInstant(createdAt, slot);
  const dispatchDelayMinutes = computeDispatchDelayMinutes(createdAt, nominal);
  // run_started_at is when the run began; on this repo it equals created_at for
  // every scheduled run sampled so far (post-dispatch queueing is ~2s), but it
  // is recorded separately so the day that stops being true is visible in the
  // data instead of being folded into the dispatch figure.
  const started = runStartedAt ?? createdAt;
  return {
    recorded_at: now.toISOString(),
    slot: `${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`,
    nominal_at: nominal.toISOString(),
    created_at: createdAt.toISOString(),
    run_started_at: started.toISOString(),
    dispatch_delay_minutes: Math.round(dispatchDelayMinutes * 100) / 100,
    post_dispatch_queue_seconds: Math.round(((started.getTime() - createdAt.getTime()) / 1000) * 100) / 100,
    effective_start_utc: started.toISOString().slice(11, 16),
    effective_start_minute_of_utc_day: Math.round(minutesIntoUtcDay(started) * 100) / 100,
    suspect: dispatchDelayMinutes > SUSPECT_DELAY_MINUTES,
    run_id: runId ?? null,
    workflow: workflow ?? null,
    repo: repo ?? null,
  };
}

export function appendRecord(file, record) {
  const dir = path.dirname(file);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

async function main() {
  const event = process.env.CANARY_EVENT ?? process.env.GITHUB_EVENT_NAME ?? 'schedule';
  if (event !== 'schedule') {
    // Exit 0: a manual run is a legitimate way to smoke-test the probe, it just
    // must not enter the dataset.
    console.log(`ℹ️  event="${event}" is not a scheduled run — nothing to record (only \`schedule\` has a nominal slot to be late against).`);
    return;
  }

  const slotRaw = process.env.CANARY_SLOT;
  const runId = process.env.GITHUB_RUN_ID;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!slotRaw) throw new Error('CANARY_SLOT is required');
  if (!runId || !repo) throw new Error('GITHUB_RUN_ID and GITHUB_REPOSITORY are required');

  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} fetching run ${runId}`);
  const run = await res.json();

  const record = buildRecord({
    slotRaw,
    createdAt: new Date(run.created_at),
    runStartedAt: run.run_started_at ? new Date(run.run_started_at) : null,
    runId: Number(runId),
    workflow: run.name ?? null,
    repo,
  });

  // Il default e' un file TRACCIATO: un override d'ambiente rediregge la
  // scrittura fuori dal repo senza lasciare traccia (issue #7291).
  const file = resolveOutputPath({
    label: 'probe-cron-dispatch-delay',
    envVar: 'CRON_DISPATCH_HISTORY_FILE',
    canonicalPath: DEFAULT_HISTORY_FILE,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  });
  appendRecord(file, record);

  console.log(`📌 slot ${record.slot} → dispatched ${record.dispatch_delay_minutes} min late, effective start ${record.effective_start_utc} UTC${record.suspect ? ' (SUSPECT: >12h, likely a skipped occurrence)' : ''}`);
  console.log(`   appended to ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`❌ probe failed: ${err?.message || err}`);
    process.exit(1);
  });
}
