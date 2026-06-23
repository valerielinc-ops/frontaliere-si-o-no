/**
 * translate-run-clock.mjs — cross-STEP, cross-PROCESS run-start clock for the
 * translate-pending job.
 *
 * Why this exists: the cascade (scripts/relocalize-pending-jobs.mjs) and the
 * local-MT mop-up (scripts/local-mt-mopup.mjs) run as SEPARATE Node processes in
 * SEPARATE workflow steps of the SAME GitHub Actions job. The cascade already
 * makes its per-company localization budget ELAPSED-AWARE
 * (JOBS_AI_LOCALIZATION_TIME_BUDGET_MS = CASCADE_DEADLINE − elapsed since its own
 * RUN_START_MS). The mop-up, being a fresh process, has no reference to that run
 * start, so its LOCAL_MT_TIME_BUDGET_MS used to be a fresh, full static budget
 * measured from the mop-up's own start. If the cascade overflowed its 250min gate
 * (legitimately: in-flight concurrency + setup), a fresh full mop-up budget plus
 * commit/scatter/slug/deploy could approach the 350min job timeout → the job is
 * externally killed mid-batch and uncommitted incremental writes are lost (#2212).
 *
 * Fix: the FIRST translation step to run publishes its start epoch here; every
 * later step (and process) reads it back and bounds itself to
 * (DEADLINE − elapsed-since-run-start), exactly mirroring an elapsed-aware budget.
 *
 * WRITE-ONCE: markRunStart only writes when no valid marker exists yet, so the
 * first writer wins and the epoch reflects the TRUE start of the whole translate
 * job — regardless of step order. This matters for the Argos-first ordering
 * (translate-pending.yml): the local-MT BULK pass (Phase 2a) now runs BEFORE the
 * cascade (Phase 2b), so the bulk pass establishes the run start and the cascade's
 * own elapsed-aware deadline then correctly accounts for the time the bulk already
 * spent — without this the cascade would measure its 250min from its own (later)
 * process start, and Phase 2a(≤150min)+cascade(250min) could exceed the 350min job
 * timeout and lose uncommitted incremental writes (the very failure #2212 fixed).
 *
 * Storage: RUNNER_TEMP (per-job temp dir, persists across steps within a job but
 * is never part of the committed workspace), falling back to os.tmpdir() for
 * local runs. Best-effort: a missing/unreadable marker just makes the mop-up fall
 * back to its own start as the reference — never a hard failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER_DIR = process.env.RUNNER_TEMP || os.tmpdir();
export const MARKER_PATH = path.join(MARKER_DIR, 'translate-pending-run-start.txt');

/**
 * Publish the run-start epoch (ms), WRITE-ONCE: a no-op when a valid marker
 * already exists, so the FIRST translation step of the job wins and the epoch is
 * the true whole-job start regardless of which step runs first (cascade-first or
 * Argos-first). Call this ONLY when a script is invoked directly — never on import
 * — so a module importing the cascade/mop-up can't seed the marker with its own
 * start time. Steps are sequential within a job, so there is no write race.
 */
export function markRunStart(epochMs) {
  try {
    // First writer wins: don't clobber an earlier step's (truer) run start.
    if (readRunStartMs() !== null) return;
    fs.writeFileSync(MARKER_PATH, String(epochMs), 'utf-8');
  } catch {
    // Best-effort: a marker-write failure must never break the step. The reader
    // will simply fall back to its own start as the reference.
  }
}

/**
 * Read the published run-start epoch (ms), or null when no valid marker exists
 * (local run, cascade skipped/crashed pre-write). Callers fall back to Date.now()
 * so the mop-up still self-bounds, just from its own start.
 */
export function readRunStartMs() {
  try {
    const ms = Number(fs.readFileSync(MARKER_PATH, 'utf-8').trim());
    if (Number.isFinite(ms) && ms > 0) return ms;
  } catch {
    // No marker → caller falls back to Date.now().
  }
  return null;
}
