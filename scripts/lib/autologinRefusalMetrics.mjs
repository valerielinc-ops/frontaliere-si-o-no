/**
 * autologinRefusalMetrics.mjs — the arithmetic behind the `ac` rollout's
 * rollback trigger (#5724).
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * `check-autologin-refusal-rate.mjs` is a network script: it holds a service
 * account, pages through Cloud Logging and writes a state file. None of that is
 * testable, and none of it is where the decision lives. The decision — "is this
 * refusal rate the one that means roll back?" — is pure arithmetic over parsed
 * log lines, so it lives here, where `tests/autologin-refusal-metrics.test.ts`
 * can pin it against fixtures instead of against production.
 *
 * WHY THE FAMILIES, AND WHY THE RATE EXCLUDES THREE OF THEM
 *
 * `exchange_auth_code` refuses for five distinct reasons, and lumping them into
 * one "403 count" is the exact mistake that made this endpoint unmeasurable in
 * the first place. They are not the same event:
 *
 *   invalid_auth_code       → a code that never verified. Anti-phishing scanners
 *                             generate these all day (35 hits, 25 of them inside
 *                             7 seconds from Microsoft IPs, measured on this
 *                             domain). NOISE. It swamps everything else and says
 *                             nothing about policy.
 *   autologin_disabled      → the subscriber turned autologin off. A refusal the
 *                             person ASKED FOR. Counting it as a lockout would
 *                             put a permanent floor under the rate and make the
 *                             threshold meaningless.
 *   auth_code_not_yet_valid → the code is stamped in the future. That is a
 *                             MINTER with a wrong clock, not a locked-out
 *                             reader, and the operator response is different
 *                             (find the sender, not roll back the policy). It
 *                             also has a known synthetic contributor: the probe
 *                             in autologinProbe.mjs deliberately produces one
 *                             per run, so a raw count here would alert on our
 *                             own health check.
 *   auth_code_expired       → the TTL (or the legacy sunset) turned somebody
 *                             away. LOCKOUT.
 *   auth_code_revoked       → the revocation watermark turned somebody away.
 *                             LOCKOUT.
 *
 * Only the last two can be CAUSED by flipping NEWSLETTER_AC_SCHEME /
 * NEWSLETTER_AC_TTL_DAYS / NEWSLETTER_AC_LEGACY_SUNSET, and only they can be
 * UNDONE by clearing them. So they, and nothing else, form the numerator of the
 * number the rollback decision reads.
 *
 * WHY THE PRE-FLIP BASELINE IS ZERO BY CONSTRUCTION, NOT BY MEASUREMENT
 *
 * With all three parameters empty, `resolveAutologinPolicy` returns
 * `{mintScheme:'legacy', ttlDays:0, legacySunsetMs:null}`. Under that policy
 * `verifyAutologinCode` cannot set `expired` (both branches need a configured
 * value) and `isAutologinRevoked` returns false for every legacy code. So
 * `lockoutRate` is 0 for structural reasons, and the first non-zero reading is
 * not noise to be tuned away — it is the flip becoming visible. That is why
 * `evaluate()` reports a finding at the FIRST lockout, well below the
 * percentage thresholds, instead of waiting for a rate to build.
 */

/** The two prefixes the Cloud Function writes. Kept here so the query filter,
 *  the parser and the tests cannot drift apart. */
export const REFUSED_PREFIX = '[exchange_auth_code] refused';
export const ACCEPTED_PREFIX = '[exchange_auth_code] accepted';

/** Reasons that a policy flip can cause and a rollback can undo. */
export const LOCKOUT_REASONS = Object.freeze(['auth_code_expired', 'auth_code_revoked']);
/** Deliberate, subscriber-chosen refusals. Tracked, never alerted on. */
export const OPTOUT_REASONS = Object.freeze(['autologin_disabled']);
/** A minter's clock, not a reader's lockout. Has a synthetic contributor. */
export const CLOCK_REASONS = Object.freeze(['auth_code_not_yet_valid']);
/** Scanner traffic. */
export const NOISE_REASONS = Object.freeze(['invalid_auth_code']);

/**
 * Alert thresholds, expressed as a share of graded exchanges.
 *
 * The numbers are anchored to measured volume, not picked round: this endpoint
 * served 335-502 exchanges a day over the week before the metric existed. At
 * that volume 2% is 7-10 people a day who clicked a link in an email and were
 * refused a session — past the point where a rollback (clear three Remote Config
 * values, effective on the next 5-minute template cache read) is cheaper than
 * waiting for the next data point. 5% is 17-25 a day and is a page.
 */
export const LOCKOUT_RATE_WARN = 0.02;
export const LOCKOUT_RATE_URGENT = 0.05;

/**
 * Below this many graded exchanges in the window, no rate is reported.
 *
 * Not tuning: at n=10 a single `auth_code_revoked` is a 10% rate, so without a
 * floor the loudest alert this monitor can raise is also its least informative
 * one. 50 is ~3 hours of this endpoint's traffic — small enough that a real
 * outage still alerts the same day, large enough that one event cannot.
 */
export const MIN_SAMPLE = 50;

/**
 * How many `auth_code_not_yet_valid` events are OURS, on a quiet day.
 *
 * The synthetic probe presents a deliberately future-stamped code, so it scores
 * one clock refusal every time it runs (daily from the monitor, daily from
 * newsletter-qa, plus manual dispatches). The budget is what keeps the clock
 * alarm from firing on the health check that proves the endpoint is alive — the
 * self-inflicted-alert shape that makes a monitor get muted.
 *
 * This is only the DEFAULT `evaluate()` falls back to, and the floor
 * check-autologin-refusal-rate.mjs's caller-supplied `clockBudget` is clamped
 * to (#5757): a fixed number shared between the monitor and every
 * newsletter-qa.mjs run is exactly as tight as its busiest day, so a run of
 * manual QA iterations before a send could exhaust it and either mask a real
 * skew or trip a false one. The caller sizes the real budget from
 * scripts/lib/autologinProbeLog.mjs's durable, per-source counts instead —
 * this constant only guards the days before that history exists.
 */
export const CLOCK_PROBE_BUDGET = 6;

/** @returns {'lockout'|'optout'|'clock'|'noise'|'unknown'} */
export function classifyReason(reason) {
  const r = String(reason || '');
  if (LOCKOUT_REASONS.includes(r)) return 'lockout';
  if (OPTOUT_REASONS.includes(r)) return 'optout';
  if (CLOCK_REASONS.includes(r)) return 'clock';
  if (NOISE_REASONS.includes(r)) return 'noise';
  return 'unknown';
}

/**
 * Pull the text out of a Cloud Logging entry.
 *
 * Two shapes, and the parser accepts both on purpose. A gen-2 function's bare
 * `console.log` lands as `textPayload` (verified against this project's live
 * log), but `firebase-functions/logger` — and `console` once that logger has
 * patched it, which a future import anywhere in the functions codebase would do
 * — lands as `jsonPayload.message`. Handling only the shape observed today would
 * make this monitor go quietly to zero on an unrelated refactor, which is the
 * failure mode it exists to prevent.
 */
export function entryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.textPayload === 'string') return entry.textPayload;
  const jp = entry.jsonPayload;
  if (jp && typeof jp === 'object' && typeof jp.message === 'string') return jp.message;
  return '';
}

/**
 * Parse one line into a record, or null when it is not one of ours.
 *
 * The line is `<prefix> <json>`, so the JSON starts at the first `{`. Slicing on
 * that rather than on a fixed offset keeps the parser working if the prefix ever
 * grows a field, and a malformed tail returns null rather than throwing: one
 * truncated log line must not take down the run that reads a day of them.
 */
export function parseExchangeLine(text) {
  const line = String(text || '');
  let kind = null;
  if (line.includes(REFUSED_PREFIX)) kind = 'refused';
  else if (line.includes(ACCEPTED_PREFIX)) kind = 'accepted';
  if (!kind) return null;

  const brace = line.indexOf('{');
  if (brace === -1) return null;
  let payload;
  try {
    payload = JSON.parse(line.slice(brace));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  return {
    kind,
    reason: kind === 'refused' ? String(payload.reason || 'unknown') : null,
    family: kind === 'refused' ? classifyReason(payload.reason) : null,
    scheme: payload.scheme ? String(payload.scheme) : 'unparsed',
    mintScheme: payload.mint_scheme ? String(payload.mint_scheme) : null,
    ttlDays: Number.isFinite(payload.ttl_days) ? payload.ttl_days : null,
    // `legacy_sunset` is absent from lines written before #5724 shipped. `null`
    // and "not present" collapse here on purpose: both mean "no sunset visible",
    // and the policy key below renders them identically, so a window straddling
    // the deploy does not read as a policy change.
    legacySunset: payload.legacy_sunset ? String(payload.legacy_sunset) : null,
    ageDays: Number.isFinite(payload.age_days) ? payload.age_days : null,
  };
}

/** The three-parameter policy as one comparable string. */
export function policyKey({ mintScheme, ttlDays, legacySunset } = {}) {
  return `${mintScheme || 'legacy'}:${ttlDays ?? 0}:${legacySunset || 'none'}`;
}

/** True for the state the three Remote Config parameters are in today: empty,
 *  i.e. exactly the pre-#5719 behaviour, i.e. the regime a baseline is valid
 *  for. Anything else is post-flip and must not overwrite the baseline. */
export function isPreFlightPolicy(policy) {
  if (!policy) return false;
  return (policy.mintScheme || 'legacy') === 'legacy'
    && (policy.ttlDays ?? 0) === 0
    && !policy.legacySunset;
}

/** Inverse of `policyKey`: turn one tally key from `aggregate()`'s `policyMix`
 *  back into the shape `isPreFlightPolicy` reads. */
function parsePolicyKey(key) {
  const [mintScheme, ttlDaysRaw, legacySunset] = String(key).split(':');
  return {
    mintScheme,
    ttlDays: Number(ttlDaysRaw),
    legacySunset: legacySunset === 'none' ? null : legacySunset,
  };
}

/**
 * True only when EVERY line that carried a policy in this window is pre-flip
 * — not just the majority.
 *
 * `aggregate()`'s `observedPolicy` is the DOMINANT policy, by design (so a
 * straddled window renders as straddled instead of averaging two regimes
 * silently). That is the right read for the report, but the wrong read for
 * the baseline: a window that is 95% pre-flip and 5% post-flip still has real
 * post-flip lockouts folded into `agg.counts.lockout`, and classifying the
 * whole window as pre-flip would fold those lockouts into what the rollback
 * trigger treats as a clean floor — quietest exactly on the day the flip
 * needs the baseline to hold still.
 */
export function isPolicyMixPreFlight(policyMix) {
  const keys = Object.keys(policyMix || {});
  if (keys.length === 0) return false;
  return keys.every((key) => isPreFlightPolicy(parsePolicyKey(key)));
}

/**
 * Fold parsed records into the shape the alert and the state file both read.
 *
 * `observedPolicy` is deliberately taken from the LOG LINES rather than from the
 * script's own `resolveAutologinPolicy()`. The script runs in Actions and reads
 * Remote Config through `load-rc-env.mjs`, which does not overwrite a variable
 * already in the environment — so a stale export would have it comparing the
 * rate against a policy the deployed function is not running. The lines are
 * written by the function itself, so they cannot disagree with it.
 */
export function aggregate(records) {
  const counts = { accepted: 0, lockout: 0, optout: 0, clock: 0, noise: 0, unknown: 0 };
  const byReason = {};
  const acceptedByScheme = {};
  const ages = [];
  const policySeen = {};

  for (const rec of records || []) {
    if (!rec) continue;
    if (rec.kind === 'accepted') {
      counts.accepted += 1;
      acceptedByScheme[rec.scheme] = (acceptedByScheme[rec.scheme] || 0) + 1;
      if (Number.isFinite(rec.ageDays)) ages.push(rec.ageDays);
    } else if (rec.kind === 'refused') {
      counts[rec.family] = (counts[rec.family] || 0) + 1;
      byReason[rec.reason] = (byReason[rec.reason] || 0) + 1;
    }
    if (rec.mintScheme) {
      const key = policyKey(rec);
      policySeen[key] = (policySeen[key] || 0) + 1;
    }
  }

  // The policy the majority of lines were written under. A deploy or a Remote
  // Config change mid-window puts two values in here; reporting the dominant one
  // plus the full tally means a window that straddles the flip is visibly
  // straddling it instead of silently averaging two regimes.
  const policyKeys = Object.keys(policySeen).sort((a, b) => policySeen[b] - policySeen[a]);
  const dominant = policyKeys[0] || null;

  return {
    counts,
    byReason,
    acceptedByScheme,
    graded: counts.accepted + counts.lockout,
    lockoutRate: lockoutRate({ counts }),
    ageDaysP50: percentile(ages, 0.5),
    ageDaysP95: percentile(ages, 0.95),
    ageSamples: ages.length,
    observedPolicy: dominant ? parsePolicyKey(dominant) : null,
    policyMix: policySeen,
  };
}

/**
 * lockout / (lockout + accepted).
 *
 * `null`, not 0, when there is nothing to divide: a window with no traffic is
 * not a window with a perfect score, and returning 0 would let a dead endpoint
 * read as healthy — the same "silence looks like success" shape that let the
 * unsubscribe defect live for months.
 */
export function lockoutRate(agg) {
  const c = agg?.counts || {};
  const denom = (c.accepted || 0) + (c.lockout || 0);
  if (denom === 0) return null;
  return (c.lockout || 0) / denom;
}

function percentile(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Turn an aggregate into findings, each with the priority the issue should carry.
 *
 * Priorities match `github-issue-creator.mjs`: 1 = urgent, 2 = high, 3 = low.
 *
 * @param {ReturnType<typeof aggregate>} agg
 * @param {{baseline?: {lockoutRate: number|null}|null, clockBudget?: number}} [opts]
 */
export function evaluate(agg, { baseline = null, clockBudget = CLOCK_PROBE_BUDGET } = {}) {
  const findings = [];
  const counts = agg?.counts || {};
  const rate = agg?.lockoutRate ?? null;
  const graded = agg?.graded ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0);

  // A monitor that reads nothing reports "all clear" in every other branch here,
  // and this endpoint has not served fewer than 335 exchanges on any day of the
  // measured week — so an empty window is a broken query, an undeployed log line
  // or a dead endpoint, never a quiet day. Alerting on it is what stops #5724
  // from re-creating, in the monitor, the silent failure it was opened about.
  if (total === 0) {
    return {
      findings: [{
        code: 'no_signal',
        priority: 2,
        alert: true,
        message: 'Zero righe `[exchange_auth_code]` nella finestra: filtro sbagliato, log non deployato, o endpoint morto. La misura NON è verde, è cieca.',
      }],
      alert: true,
      priority: 2,
    };
  }

  if (graded < MIN_SAMPLE) {
    // Reported, not silent. A window that fell under the floor is a window where
    // the monitor abstained, and an abstention that leaves no trace is
    // indistinguishable from a green run — so it says so, at the lowest
    // priority, and the run still exits 0.
    findings.push({
      code: 'insufficient_sample',
      priority: 3,
      alert: false,
      message: `Solo ${graded} scambi graduati nella finestra (soglia ${MIN_SAMPLE}): nessun rapporto calcolato.`,
    });
  } else if (rate !== null) {
    if (rate >= LOCKOUT_RATE_URGENT) {
      findings.push({
        code: 'lockout_rate_urgent',
        priority: 1,
        alert: true,
        message: `Lockout rate ${pct(rate)} ≥ ${pct(LOCKOUT_RATE_URGENT)} su ${graded} scambi: ROLLBACK ORA.`,
      });
    } else if (rate >= LOCKOUT_RATE_WARN) {
      findings.push({
        code: 'lockout_rate_warn',
        priority: 2,
        alert: true,
        message: `Lockout rate ${pct(rate)} ≥ ${pct(LOCKOUT_RATE_WARN)} su ${graded} scambi: rollback entro il turno.`,
      });
    } else if (counts.lockout > 0 && baselineIsZero(baseline)) {
      // The one that actually fires on flip day. The baseline is zero by
      // construction while the three parameters are empty, so the first
      // policy-caused refusal ever recorded is a state change worth a line —
      // long before it is a percentage worth paging over.
      findings.push({
        code: 'first_lockout_after_zero_baseline',
        priority: 3,
        alert: true,
        message: `Primi ${counts.lockout} rifiuti da policy (${pct(rate)}) con baseline a zero: la scadenza ha iniziato a mordere.`,
      });
    }
  }

  if (counts.clock > clockBudget) {
    findings.push({
      code: 'clock_skew',
      priority: 2,
      alert: true,
      message: `${counts.clock} codici datati nel futuro (budget sonda ${clockBudget}): un minter ha l'orologio sbagliato.`,
    });
  }

  // Zero graded exchanges with refusals present means the ACCEPTED line stopped
  // arriving while the endpoint kept serving — a broken denominator, which reads
  // as a perfect score in every other check here. It is the failure this whole
  // monitor is one deploy away from at any time.
  if (counts.accepted === 0 && (counts.noise + counts.optout + counts.lockout + counts.clock) > 0) {
    findings.push({
      code: 'denominator_missing',
      priority: 2,
      alert: true,
      message: 'Rifiuti presenti ma zero righe `accepted`: il denominatore non arriva più (deploy senza acceptAutologin?).',
    });
  }

  const alerting = findings.filter((f) => f.alert);
  return {
    findings,
    alert: alerting.length > 0,
    priority: alerting.length ? Math.min(...alerting.map((f) => f.priority)) : 3,
  };
}

function baselineIsZero(baseline) {
  if (!baseline) return true; // no baseline recorded yet ⇒ treat as the pre-flip zero
  return !baseline.lockoutRate;
}

export function pct(value) {
  if (value === null || value === undefined) return 'n/d';
  return `${(value * 100).toFixed(2)}%`;
}
