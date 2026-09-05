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
export const RUN_PHASES_PATH = path.join(MARKER_DIR, 'translate-pending-phases.json');

// A translate run is a sequence of steps in ONE job, and each step is a separate
// process: no step can see how long the others took. That blindness is why the
// cascade's window used to be unreadable — its deadline is measured from
// RUN_START_MS (published by the FIRST translation step, normally the Argos bulk
// pass), so the window it actually receives is whatever the earlier phases left,
// and a run where they left nothing looked, from the outside, exactly like a run
// where the cascade simply found little to do. Each phase appends one entry here;
// the observability collector reads them back at the end of the job and puts the
// window in the report, so a starved run is visible without opening the log.
//
// Timestamps are ELAPSED MILLISECONDS SINCE RUN START, not epochs: that is the
// quantity every consumer wants, it stays comparable across runs, and it keeps a
// wall clock out of an artifact that is committed to history.
const MAX_RUN_PHASES = 32;


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
 * Append one phase entry. Named recordRunPhase, not recordPhase: this repo
 * already exports a recordPhase from build-plugins/shared/jobsSeoProfiler.ts, an
 * in-process hrtime profiler for a Vite build. Same word, unrelated lifetime and
 * storage — the distinct name keeps the two from reading as one utility. Best-effort exactly like markRunStart: instrumentation
 * must never be able to fail a translation step. The cap is not defensive
 * bookkeeping — the observability report is hard-capped at 1 MiB, so an unbounded
 * append is a way to break the report from a script that only meant to measure it.
 */
export function recordRunPhase(entry) {
  try {
    if (!entry || typeof entry.name !== 'string' || !entry.name) return;
    const phases = readRunPhases();
    if (phases.length >= MAX_RUN_PHASES) return;
    phases.push(entry);
    fs.writeFileSync(RUN_PHASES_PATH, JSON.stringify(phases), 'utf-8');
  } catch {
    // Best-effort: a sidecar write failure must never break the step.
  }
}

/**
 * Read the phase entries recorded so far, in the order they ran. Always an array:
 * a local run, a missing marker or a corrupt sidecar yields an empty one, and the
 * collector then simply reports no phases rather than failing the run.
 */
export function readRunPhases() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUN_PHASES_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
