/**
 * jobgate-v3 — multi-arm A/B test on the job-detail auth gate.
 *
 * Pure, dependency-free core shared by the SPA (services/jobGateExperiment.ts,
 * which adds types and the browser state) and by the Remote Config publisher
 * (scripts/experiments/jobgate-v3-rc.mjs), so the weights the script validates
 * are parsed by exactly the code the browser runs.
 *
 * Contract (shared with the readout, scripts/analytics/job-gate-experiment-readout.mjs):
 *   - experiment_id `jobgate-v3`;
 *   - Remote Config strings JOBGATE_EXPERIMENT_ENABLED / _ARMS / _FORCE;
 *   - ENABLED other than `true` → nobody is enrolled, the page is unchanged;
 *   - ARMS = JSON object of non-negative integer weights over the known arms;
 *     anything invalid falls back to `{"control":100}`;
 *   - FORCE = a known arm forces it for every visitor (QA/promotion), only
 *     while ENABLED is `true` (the kill switch always wins);
 *   - the arm is a deterministic function of (stable visitor id, experiment id),
 *     so a returning visitor keeps the same arm across sessions.
 */

export const JOBGATE_EXPERIMENT_ID = 'jobgate-v3';

export const JOBGATE_RC_KEYS = Object.freeze({
  enabled: 'JOBGATE_EXPERIMENT_ENABLED',
  arms: 'JOBGATE_EXPERIMENT_ARMS',
  force: 'JOBGATE_EXPERIMENT_FORCE',
});

/**
 * Canonical arm order. Bucketing walks the weights in THIS order, never in the
 * JSON key order, so re-ordering keys in Remote Config cannot reshuffle
 * visitors between arms.
 */
export const JOBGATE_ARMS = Object.freeze(['control', 'similar_alerts', 'social_first', 'email_first']);

export const JOBGATE_DEFAULT_WEIGHTS = Object.freeze({ control: 100 });
export const JOBGATE_DEFAULT_ARMS_JSON = '{"control":100}';

/** Upper bound per weight: large enough for basis points, small enough to catch typos. */
const MAX_WEIGHT = 10000;

/** @param {unknown} value @returns {value is 'control'|'similar_alerts'|'social_first'|'email_first'} */
export function isJobGateArm(value) {
  return typeof value === 'string' && JOBGATE_ARMS.includes(value);
}

/** @param {unknown} raw */
export function normalizeJobGateArm(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return isJobGateArm(value) ? value : null;
}

/** @param {unknown} raw */
export function parseJobGateEnabled(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * Validate a weights JSON. Returns the problems found (empty array = valid) so
 * the publisher script can print them; the browser only needs the boolean.
 *
 * @param {unknown} raw
 * @returns {{ valid: boolean, weights: Record<string, number>, problems: string[] }}
 */
export function validateJobGateWeights(raw) {
  const problems = [];
  let parsed;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw;
  } else {
    const text = String(raw ?? '').trim();
    if (!text) return { valid: false, weights: { ...JOBGATE_DEFAULT_WEIGHTS }, problems: ['empty'] };
    try {
      parsed = JSON.parse(text);
    } catch {
      return { valid: false, weights: { ...JOBGATE_DEFAULT_WEIGHTS }, problems: ['not JSON'] };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, weights: { ...JOBGATE_DEFAULT_WEIGHTS }, problems: ['not a JSON object'] };
  }
  const weights = {};
  let total = 0;
  for (const [arm, weight] of Object.entries(parsed)) {
    if (!isJobGateArm(arm)) {
      problems.push(`unknown arm "${arm}"`);
      continue;
    }
    if (!Number.isInteger(weight) || weight < 0 || weight > MAX_WEIGHT) {
      problems.push(`weight of "${arm}" must be an integer 0..${MAX_WEIGHT}`);
      continue;
    }
    weights[arm] = weight;
    total += weight;
  }
  if (problems.length === 0 && total <= 0) problems.push('total weight is 0');
  if (problems.length > 0) return { valid: false, weights: { ...JOBGATE_DEFAULT_WEIGHTS }, problems };
  return { valid: true, weights, problems };
}

/** @param {unknown} raw @returns {Record<string, number>} */
export function parseJobGateWeights(raw) {
  return validateJobGateWeights(raw).weights;
}

/** FNV-1a over UTF-16 code units, then murmur3's fmix32 to spread the low bits. */
export function hashJobGateKey(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Deterministic arm for a visitor under a weights map.
 *
 * @param {string} visitorId
 * @param {Record<string, number>} weights
 * @param {string} [experimentId]
 */
export function pickJobGateArm(visitorId, weights, experimentId = JOBGATE_EXPERIMENT_ID) {
  const entries = JOBGATE_ARMS
    .map((arm) => [arm, Number(weights?.[arm]) || 0])
    .filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return 'control';
  const unit = hashJobGateKey(`${experimentId}:${visitorId}`) / 4294967296;
  let cursor = unit * total;
  for (const [arm, weight] of entries) {
    if (cursor < weight) return arm;
    cursor -= weight;
  }
  return entries[entries.length - 1][0];
}

/**
 * Resolve the assignment from the three raw Remote Config strings.
 *
 * @param {{ enabled?: unknown, arms?: unknown, force?: unknown, visitorId?: string | null }} input
 * @returns {{ enrolled: boolean, arm: string, reason: 'disabled' | 'forced' | 'weighted' | 'no_visitor' }}
 */
export function resolveJobGateAssignment(input) {
  if (!parseJobGateEnabled(input?.enabled)) return { enrolled: false, arm: 'control', reason: 'disabled' };
  const forced = normalizeJobGateArm(input?.force);
  if (forced) return { enrolled: true, arm: forced, reason: 'forced' };
  const visitorId = String(input?.visitorId ?? '').trim();
  // Without a stable id the arm could change on every page view: keep the
  // visitor out of the experiment rather than polluting an arm.
  if (!visitorId) return { enrolled: false, arm: 'control', reason: 'no_visitor' };
  return { enrolled: true, arm: pickJobGateArm(visitorId, parseJobGateWeights(input?.arms)), reason: 'weighted' };
}

/** Value written to `newsletter_subscribers.variant` for a gate signup. */
export function jobGateSubscriberVariant(arm) {
  return `${JOBGATE_EXPERIMENT_ID}:${arm}`;
}

/**
 * The `source_cta` values the JobBoard auth gate sends with its `newsletter`
 * subscribe event (`job_gate_<provider>_unlock`, `job_board_email_unlock`).
 * Deliberately NOT every `job_gate` channel: the expired/orphan/bridge views,
 * saved-jobs nudge and salary alert share the channel but not the gate UI.
 */
export function isJobGateNewsletterCta(sourceCta) {
  const cta = String(sourceCta ?? '');
  return /^job_gate_[a-z]+_unlock$/.test(cta) || cta === 'job_board_email_unlock';
}
