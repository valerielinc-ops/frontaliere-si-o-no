// Bounded rollout, telemetry and kill-switch for the Argos semantic gate (#9677).
//
// #9675 put a semantic judge in front of every mop-up write. It did not say how
// many writes a run may make on the judge's word, what the judge answered, or
// how to stop a bad batch: a run that overwrote hundreds of SEO titles on an
// uncalibrated threshold would show up only in the corpus diff. This module is
// the policy around the judge, kept separate from the judge (which only scores)
// and from the mop-up loop (which only walks slices), so the write boundary and
// the tests share one definition.
//
// Three controls, all local, no provider, no secret:
// - kill-switch: an OVERWRITE (a language-driven replacement of a stored,
//   non-empty title) is written only when LOCAL_MT_LANG_AWARE_OVERWRITE=1. That
//   is the existing default-off rollout switch of the language arm, reused on
//   purpose: one repo variable, one line to flip, one line to revert. With the
//   switch off the arm stays in shadow: a bounded sample of its candidates is
//   still judged and counted, nothing is written.
// - hard cap: at most `maxOverwrites` overwrites per process (one mop-up
//   phase). Past the cap every further overwrite is withheld, not judged. The
//   cap is always finite: an invalid, negative or infinite value falls back to
//   the default and any value is clamped to HARD_MAX_OVERWRITES.
// - error stop: after `maxConsecutiveErrors` judge errors in a row the model
//   is treated as down; every later candidate of the run — fills included —
//   is withheld without calling the judge, and the run reports
//   `rollbackRecommended`. Those slots stay queued for the next run.
//
// Fills of an empty slot and repairs of a stored value the structural chain
// already proved bad (too short, source copy) are not capped: they cannot
// degrade a good title and they are the bulk of the mop-up's work.

import { interpretSemanticVerdict, SEMANTIC_VERDICT } from './local-mt-semantic-judge.mjs';

export const LOCAL_MT_SEMANTIC_TELEMETRY_SCHEMA_VERSION = 1;
export const DEFAULT_LOCAL_MT_SEMANTIC_MAX_OVERWRITES = 100;
export const HARD_MAX_LOCAL_MT_SEMANTIC_OVERWRITES = 2000;
export const DEFAULT_LOCAL_MT_SEMANTIC_MAX_CONSECUTIVE_ERRORS = 10;
export const LOCAL_MT_SEMANTIC_KILL_SWITCH_VARIABLE = 'LOCAL_MT_LANG_AWARE_OVERWRITE';

export const SEMANTIC_BUCKETS = Object.freeze(['accepted', 'rejected', 'unclear', 'error']);
export const SEMANTIC_WITHHELD_REASONS = Object.freeze(['kill-switch', 'cap', 'error-stop']);
export const SEMANTIC_WRITE_KINDS = Object.freeze(['fill', 'repair', 'overwrite']);

// Reasons that mean the judge FAILED, as opposed to "had nothing to score".
// Emitted by createLocalMtSemanticJudge() and by judgeMopupWrite()'s catch.
const ERROR_REASONS = new Set(['embedding-error', 'judge-error']);

function zeroed(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function sum(record) {
  return Object.values(record).reduce((total, n) => total + n, 0);
}

/**
 * Parse a non-negative integer limit. Anything that is not a finite integer
 * >= 0 — empty, NaN, negative, Infinity, a fraction — is the fallback; a valid
 * value is clamped to `hardMax`. The result is never Infinity.
 */
export function parseSemanticLimit(value, fallback, hardMax = Number.MAX_SAFE_INTEGER) {
  const raw = String(value ?? '').trim();
  const parsed = raw === '' ? Number.NaN : Number(raw);
  const limit = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  return Math.min(limit, hardMax);
}

/**
 * The telemetry bucket of a judged structural result:
 * - `accepted`: the gate let the write through;
 * - `rejected`: a finite score below the threshold (`skip:semantic-mismatch`);
 * - `error`: the judge failed (model load/inference threw);
 * - `unclear`: no usable score without a failure (missing text, non-finite
 *   score, verdict-less answer).
 * Returns null for a result that never reached the judge.
 */
export function semanticBucketOf(judged) {
  if (judged?.decision === 'write') return 'accepted';
  if (judged?.decision === 'skip:semantic-mismatch') return 'rejected';
  if (judged?.decision === 'skip:semantic-unavailable') {
    return ERROR_REASONS.has(String(judged.semanticReason || '')) ? 'error' : 'unclear';
  }
  return null;
}

/** The same bucket, from a raw judge verdict instead of a folded result. */
export function semanticBucketOfVerdict(verdict) {
  const { outcome } = interpretSemanticVerdict(verdict);
  if (outcome === SEMANTIC_VERDICT.ACCEPT) return 'accepted';
  if (outcome === SEMANTIC_VERDICT.MISMATCH) return 'rejected';
  return ERROR_REASONS.has(String(verdict?.reason || '')) ? 'error' : 'unclear';
}

/**
 * What a structural `write` would do to the slot: `overwrite` for the
 * language arm (replaces a stored non-empty title the chain judged good
 * except for its language), `repair` for a stored value the chain proved bad,
 * `fill` for an empty slot.
 */
export function semanticWriteKind(candidate) {
  if (candidate?.languageDriven === true) return 'overwrite';
  return String(candidate?.existing || '').trim() ? 'repair' : 'fill';
}

/**
 * Create the per-process rollout state. Sequential and synchronous: every
 * decision reads and updates the counters in the same tick, so the cap holds
 * even if two commits interleave around an await.
 */
export function createSemanticRollout({
  overwritesEnabled = false,
  maxOverwrites = DEFAULT_LOCAL_MT_SEMANTIC_MAX_OVERWRITES,
  maxConsecutiveErrors = DEFAULT_LOCAL_MT_SEMANTIC_MAX_CONSECUTIVE_ERRORS,
} = {}) {
  const overwriteCap = parseSemanticLimit(
    maxOverwrites,
    DEFAULT_LOCAL_MT_SEMANTIC_MAX_OVERWRITES,
    HARD_MAX_LOCAL_MT_SEMANTIC_OVERWRITES,
  );
  // 0 would stop the run before the first verdict; at least one error is needed.
  const errorLimit = Math.max(1, parseSemanticLimit(
    maxConsecutiveErrors,
    DEFAULT_LOCAL_MT_SEMANTIC_MAX_CONSECUTIVE_ERRORS,
  ));
  const enabled = overwritesEnabled === true;

  const verdicts = zeroed(SEMANTIC_BUCKETS);
  const shadowVerdicts = zeroed(SEMANTIC_BUCKETS);
  const written = zeroed(SEMANTIC_WRITE_KINDS);
  const withheld = zeroed(SEMANTIC_WITHHELD_REASONS);
  let consecutiveErrors = 0;
  let errorStopped = false;
  let capReached = false;
  let shadowJudged = 0;

  function noteError(bucket) {
    if (bucket === 'error') {
      consecutiveErrors += 1;
      if (consecutiveErrors >= errorLimit) errorStopped = true;
    } else if (bucket) {
      consecutiveErrors = 0;
    }
  }

  function overwriteRoom() {
    return written.overwrite < overwriteCap;
  }

  return {
    get overwritesEnabled() { return enabled; },
    get errorStopped() { return errorStopped; },

    /**
     * Called before the judge. Returns the withheld reason, or null when the
     * candidate may be judged. A withheld candidate costs no embedding.
     */
    beforeJudge({ kind }) {
      let reason = null;
      if (errorStopped) reason = 'error-stop';
      else if (kind === 'overwrite' && !enabled) reason = 'kill-switch';
      else if (kind === 'overwrite' && !overwriteRoom()) {
        capReached = true;
        reason = 'cap';
      }
      if (reason) withheld[reason] += 1;
      return reason;
    },

    /** Record the verdict of an enforced candidate. */
    recordVerdict(bucket) {
      if (!bucket) return;
      verdicts[bucket] += 1;
      noteError(bucket);
    },

    /**
     * Called after an accepted verdict, right before the assignment. Re-checks
     * the cap so it is hard at the write itself. Returns the withheld reason,
     * or null after reserving the write.
     */
    admitWrite({ kind }) {
      if (errorStopped) {
        withheld['error-stop'] += 1;
        return 'error-stop';
      }
      if (kind === 'overwrite') {
        if (!enabled) {
          withheld['kill-switch'] += 1;
          return 'kill-switch';
        }
        if (!overwriteRoom()) {
          capReached = true;
          withheld.cap += 1;
          return 'cap';
        }
      }
      written[kind] += 1;
      if (kind === 'overwrite' && !overwriteRoom()) capReached = true;
      return null;
    },

    /**
     * Shadow sample of the language arm while the kill-switch is off: bounded
     * by the same cap, so it measures what the first enforced run would do.
     */
    shouldShadowJudge() {
      return !enabled && !errorStopped && shadowJudged < overwriteCap;
    },

    recordShadowVerdict(bucket) {
      if (!bucket) return;
      shadowJudged += 1;
      shadowVerdicts[bucket] += 1;
      noteError(bucket);
    },

    snapshot() {
      const status = errorStopped ? 'error-stop' : (capReached ? 'capped' : 'ok');
      return {
        schemaVersion: LOCAL_MT_SEMANTIC_TELEMETRY_SCHEMA_VERSION,
        status,
        rollbackRecommended: errorStopped,
        killSwitch: {
          variable: LOCAL_MT_SEMANTIC_KILL_SWITCH_VARIABLE,
          overwritesEnabled: enabled,
          mode: enabled ? 'enforcing' : 'shadow',
        },
        cap: {
          maxOverwrites: overwriteCap,
          hardMax: HARD_MAX_LOCAL_MT_SEMANTIC_OVERWRITES,
          reached: capReached,
        },
        errorStop: {
          maxConsecutiveErrors: errorLimit,
          tripped: errorStopped,
        },
        verdicts: { ...verdicts, total: sum(verdicts) },
        shadowVerdicts: { ...shadowVerdicts, total: sum(shadowVerdicts) },
        written: { ...written, total: sum(written) },
        withheld: { ...withheld, total: sum(withheld) },
      };
    },
  };
}

/** Build the rollout from the environment the workflow passes. */
export function createSemanticRolloutFromEnv(env = process.env, { overwritesEnabled } = {}) {
  return createSemanticRollout({
    overwritesEnabled: overwritesEnabled ?? String(env[LOCAL_MT_SEMANTIC_KILL_SWITCH_VARIABLE] || '0') === '1',
    maxOverwrites: env.LOCAL_MT_SEMANTIC_MAX_OVERWRITES,
    maxConsecutiveErrors: env.LOCAL_MT_SEMANTIC_MAX_CONSECUTIVE_ERRORS,
  });
}

/**
 * Human and machine report lines for a snapshot. The `LOCAL_MT_SEMANTIC_TELEMETRY`
 * line is one JSON object, greppable from the job log for before/after
 * comparisons; the `::warning::`/`::error::` lines are GitHub annotations.
 */
export function formatSemanticTelemetry(snapshot) {
  const lines = [];
  const { verdicts, shadowVerdicts, written, withheld, killSwitch, cap, errorStop } = snapshot;
  lines.push(`🧭 [local-mt] Semantic gate telemetry — ${killSwitch.variable}=${killSwitch.overwritesEnabled ? '1' : '0'} (overwrites ${killSwitch.mode}), overwrite cap ${written.overwrite}/${cap.maxOverwrites}, status ${snapshot.status}`);
  lines.push(`   verdicts: accepted ${verdicts.accepted} · rejected ${verdicts.rejected} · unclear ${verdicts.unclear} · error ${verdicts.error} (total ${verdicts.total})`);
  lines.push(`   written:  fill ${written.fill} · repair ${written.repair} · overwrite ${written.overwrite} (total ${written.total})`);
  lines.push(`   withheld: kill-switch ${withheld['kill-switch']} · cap ${withheld.cap} · error-stop ${withheld['error-stop']} (total ${withheld.total})`);
  lines.push(`   shadow overwrite sample (judged, never written): accepted ${shadowVerdicts.accepted} · rejected ${shadowVerdicts.rejected} · unclear ${shadowVerdicts.unclear} · error ${shadowVerdicts.error} (total ${shadowVerdicts.total})`);
  lines.push(`LOCAL_MT_SEMANTIC_TELEMETRY ${JSON.stringify(snapshot)}`);
  if (cap.reached) {
    lines.push(`::warning title=Argos semantic cap reached::${withheld.cap} overwrite(s) withheld after ${cap.maxOverwrites} written this phase; raise LOCAL_MT_SEMANTIC_MAX_OVERWRITES (hard max ${cap.hardMax}) only after reading this run.`);
  }
  if (errorStop.tripped) {
    lines.push(`::error title=Argos semantic gate stopped::${errorStop.maxConsecutiveErrors} consecutive judge errors; ${withheld['error-stop']} candidate(s) withheld unjudged. Rollback: set repo variable ${killSwitch.variable}=0 and check the local e5 model.`);
  }
  return lines;
}
