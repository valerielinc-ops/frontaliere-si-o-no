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
// Two controls plus one reading, all local, no provider, no secret:
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
// - rollback: NOT a second stop. The run rollback of the overwrite arm is
//   createSemanticRollbackGuard() in local-mt-semantic-policy.mjs (#9676): it
//   trips on the first unavailable verdict or on a rejected share above its
//   limit, and the mop-up then returns `skip:semantic-rollback`. This module
//   only counts those candidates as withheld (`rollback`) and reports the
//   guard's state as `rollbackRecommended`, so there is one rollback policy
//   and one place that decides it. A judge error on a fill already fails
//   closed per candidate (no score, no write) and is counted as `error`.
//
// Fills of an empty slot and repairs of a stored value the structural chain
// already proved bad (too short, source copy) are not capped: they cannot
// degrade a good title and they are the bulk of the mop-up's work.

import { interpretSemanticVerdict, SEMANTIC_VERDICT } from './local-mt-semantic-judge.mjs';

export const LOCAL_MT_SEMANTIC_TELEMETRY_SCHEMA_VERSION = 2;
export const DEFAULT_LOCAL_MT_SEMANTIC_MAX_OVERWRITES = 100;
export const HARD_MAX_LOCAL_MT_SEMANTIC_OVERWRITES = 2000;
export const LOCAL_MT_SEMANTIC_KILL_SWITCH_VARIABLE = 'LOCAL_MT_LANG_AWARE_OVERWRITE';

export const SEMANTIC_BUCKETS = Object.freeze(['accepted', 'rejected', 'unclear', 'error']);
export const SEMANTIC_WITHHELD_REASONS = Object.freeze(['kill-switch', 'cap', 'rollback']);
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
 * - `accepted`: the gate (and, for an overwrite, the #9676 policy) let the
 *   write through;
 * - `rejected`: a finite score below the threshold (`skip:semantic-mismatch`)
 *   or a policy reject — meaning guard, echo, cutoff (`skip:semantic-reject`);
 * - `unclear`: the policy's uncertain band (`skip:semantic-unclear`), or no
 *   usable score without a failure (missing text, non-finite score);
 * - `error`: the judge failed (model load/inference threw).
 * Returns null for a result that was not judged on its merits: a structural
 * skip, or `skip:semantic-rollback` (the arm was already switched off; that is
 * a withheld candidate, not a verdict).
 */
export function semanticBucketOf(judged) {
  switch (judged?.decision) {
    case 'write': return 'accepted';
    case 'skip:semantic-mismatch':
    case 'skip:semantic-reject': return 'rejected';
    case 'skip:semantic-unclear': return 'unclear';
    case 'skip:semantic-unavailable':
      return ERROR_REASONS.has(String(judged.semanticReason || '')) ? 'error' : 'unclear';
    default: return null;
  }
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
  rollbackGuard = null,
} = {}) {
  const overwriteCap = parseSemanticLimit(
    maxOverwrites,
    DEFAULT_LOCAL_MT_SEMANTIC_MAX_OVERWRITES,
    HARD_MAX_LOCAL_MT_SEMANTIC_OVERWRITES,
  );
  const enabled = overwritesEnabled === true;

  const verdicts = zeroed(SEMANTIC_BUCKETS);
  const shadowVerdicts = zeroed(SEMANTIC_BUCKETS);
  const written = zeroed(SEMANTIC_WRITE_KINDS);
  const withheld = zeroed(SEMANTIC_WITHHELD_REASONS);
  let capReached = false;
  let shadowJudged = 0;

  function overwriteRoom() {
    return written.overwrite < overwriteCap;
  }

  return {
    get overwritesEnabled() { return enabled; },
    /** The #9676 run rollback of the overwrite arm, owned by the policy module. */
    get rollbackGuard() { return rollbackGuard; },

    /**
     * Called before the judge. Returns the withheld reason, or null when the
     * candidate may be judged. A withheld candidate costs no embedding.
     */
    beforeJudge({ kind }) {
      let reason = null;
      if (kind === 'overwrite' && !enabled) reason = 'kill-switch';
      else if (kind === 'overwrite' && !overwriteRoom()) {
        capReached = true;
        reason = 'cap';
      }
      if (reason) withheld[reason] += 1;
      return reason;
    },

    /**
     * Record what the judge and the policy answered for an enforced candidate.
     * `skip:semantic-rollback` is counted as withheld, not as a verdict.
     */
    recordJudged(judged) {
      if (judged?.decision === 'skip:semantic-rollback') {
        withheld.rollback += 1;
        return;
      }
      const bucket = semanticBucketOf(judged);
      if (bucket) verdicts[bucket] += 1;
    },

    /**
     * Called after an accepted verdict, right before the assignment. Re-checks
     * the cap so it is hard at the write itself. Returns the withheld reason,
     * or null after reserving the write.
     */
    admitWrite({ kind }) {
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
      return !enabled && shadowJudged < overwriteCap;
    },

    recordShadowVerdict(bucket) {
      if (!bucket) return;
      shadowJudged += 1;
      shadowVerdicts[bucket] += 1;
    },

    snapshot() {
      const guard = rollbackGuard?.status?.() ?? null;
      const rollbackTripped = guard?.tripped === true;
      const status = rollbackTripped ? 'rollback' : (capReached ? 'capped' : 'ok');
      return {
        schemaVersion: LOCAL_MT_SEMANTIC_TELEMETRY_SCHEMA_VERSION,
        status,
        rollbackRecommended: rollbackTripped,
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
        rollback: guard ? {
          tripped: rollbackTripped,
          reason: guard.reason,
          observed: guard.observed,
          regressions: guard.regressions,
          unavailable: guard.unavailable,
          withheld: guard.withheld,
          maxRegressionRate: guard.maxRegressionRate,
          minObservations: guard.minObservations,
        } : null,
        verdicts: { ...verdicts, total: sum(verdicts) },
        shadowVerdicts: { ...shadowVerdicts, total: sum(shadowVerdicts) },
        written: { ...written, total: sum(written) },
        withheld: { ...withheld, total: sum(withheld) },
      };
    },
  };
}

/** Build the rollout from the environment the workflow passes. */
export function createSemanticRolloutFromEnv(env = process.env, { overwritesEnabled, rollbackGuard = null } = {}) {
  return createSemanticRollout({
    overwritesEnabled: overwritesEnabled ?? String(env[LOCAL_MT_SEMANTIC_KILL_SWITCH_VARIABLE] || '0') === '1',
    maxOverwrites: env.LOCAL_MT_SEMANTIC_MAX_OVERWRITES,
    rollbackGuard,
  });
}

/**
 * Human and machine report lines for a snapshot. The `LOCAL_MT_SEMANTIC_TELEMETRY`
 * line is one JSON object, greppable from the job log for before/after
 * comparisons; the `::warning::`/`::error::` lines are GitHub annotations.
 */
export function formatSemanticTelemetry(snapshot) {
  const lines = [];
  const { verdicts, shadowVerdicts, written, withheld, killSwitch, cap, rollback } = snapshot;
  lines.push(`🧭 [local-mt] Semantic gate telemetry — ${killSwitch.variable}=${killSwitch.overwritesEnabled ? '1' : '0'} (overwrites ${killSwitch.mode}), overwrite cap ${written.overwrite}/${cap.maxOverwrites}, status ${snapshot.status}`);
  lines.push(`   verdicts: accepted ${verdicts.accepted} · rejected ${verdicts.rejected} · unclear ${verdicts.unclear} · error ${verdicts.error} (total ${verdicts.total})`);
  lines.push(`   written:  fill ${written.fill} · repair ${written.repair} · overwrite ${written.overwrite} (total ${written.total})`);
  lines.push(`   withheld: kill-switch ${withheld['kill-switch']} · cap ${withheld.cap} · rollback ${withheld.rollback} (total ${withheld.total})`);
  lines.push(`   shadow overwrite sample (judged, never written): accepted ${shadowVerdicts.accepted} · rejected ${shadowVerdicts.rejected} · unclear ${shadowVerdicts.unclear} · error ${shadowVerdicts.error} (total ${shadowVerdicts.total})`);
  lines.push(`LOCAL_MT_SEMANTIC_TELEMETRY ${JSON.stringify(snapshot)}`);
  if (cap.reached) {
    lines.push(`::warning title=Argos semantic cap reached::${withheld.cap} overwrite(s) withheld after ${cap.maxOverwrites} written this phase; raise LOCAL_MT_SEMANTIC_MAX_OVERWRITES (hard max ${cap.hardMax}) only after reading this run.`);
  }
  if (rollback?.tripped) {
    lines.push(`::error title=Argos overwrite rollback tripped::${rollback.reason} after ${rollback.observed} observed overwrite(s) (rejected ${rollback.regressions}, unavailable ${rollback.unavailable}); ${withheld.rollback} candidate(s) withheld. Rollback: set repo variable ${killSwitch.variable}=0 before the next run.`);
  }
  if (verdicts.error > 0) {
    lines.push(`::warning title=Argos semantic judge errors::${verdicts.error} candidate(s) got no score from the local e5 judge and were not written; check the model load in this run.`);
  }
  return lines;
}
