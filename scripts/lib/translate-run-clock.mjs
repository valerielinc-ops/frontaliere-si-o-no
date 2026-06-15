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
 * Fix: the cascade publishes its run-start epoch here when invoked directly; the
 * mop-up reads it back and bounds itself to (DEADLINE − elapsed-since-run-start),
 * exactly mirroring the cascade's own elapsed-aware budget.
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
 * Publish the run-start epoch (ms). Call this ONLY when the cascade is invoked
 * directly — never on import — so the mop-up importing the cascade module can't
 * overwrite the real run start with the mop-up's own start time.
 */
export function markRunStart(epochMs) {
  try {
    fs.writeFileSync(MARKER_PATH, String(epochMs), 'utf-8');
  } catch {
    // Best-effort: a marker-write failure must never break the cascade. The
    // mop-up will simply fall back to its own start as the reference.
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
