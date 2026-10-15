import { createHash, createHmac } from 'node:crypto';

/**
 * Ordine degli annunci nelle email con annunci (job alert e newsletter).
 *
 * Varianti assegnate una volta per persona (assignJobRankingVariant):
 *  - `control`: l'ordine del matcher, con la diversita' per azienda a parita'
 *    di pertinenza;
 *  - `affinity`: stessa pertinenza, moltiplicata per l'affinita' della persona
 *    con l'annuncio (profilo di interessi dai clic, ./jobEmailAffinity.js):
 *    rankingScore = relevanceScore * (1 - w + w * affinita'), w =
 *    JOB_EMAIL_RANKING_AFFINITY_WEIGHT.
 *  - `control_plus_newness`: stessa pertinenza, ma un annuncio recente puo'
 *    precedere un quasi-pari solo dentro una banda di rilevanza stretta.
 *
 * Il profilo decide SOLO l'ordine fra annunci gia' selezionati per la persona
 * (privacy policy, services/legal/privacy.ts): nessuna variante aggiunge o
 * toglie annunci dal pool del matcher, e senza profilo valido, con opposizione
 * registrata o con w = 0 la variante `affinity` produce l'ordine del control.
 *
 * Il vecchio trattamento (`treatment`, riordino per CTR con esplorazione) non
 * viene piu' emesso; la sua fotografia e' in
 * scripts/measurements/job-email-ranking-ctr-experiment-2026-09-08_2026-10-03.json.
 */
export const JOB_EMAIL_RANKING_VARIANTS = Object.freeze({
  control: 'control',
  affinity: 'affinity',
  controlPlusNewness: 'control_plus_newness',
});

/**
 * Seme dell'assegnazione: fisso per persona, uguale su tutte le superfici e
 * tutti i giorni. Cambiarlo rimescola l'intera popolazione dell'esperimento.
 */
export const JOB_EMAIL_RANKING_ASSIGNMENT_SEED = 'job-email-control-plus-newness-2026-10';
export const JOB_EMAIL_AFFINITY_ASSIGNMENT_SEED = 'job-email-affinity-2026-10';

export const JOB_EMAIL_RANKING_DEFAULTS = Object.freeze({
  // The global switch is off until the owner publishes the Remote Config
  // values for the approved treatment.
  enabled: false,
  rollout: 0.5,
  affinityWeight: 0.5,
  treatmentVariant: JOB_EMAIL_RANKING_VARIANTS.controlPlusNewness,
});

export const JOB_EMAIL_RANKING_NEWNESS_WINDOW_DAYS = 7;
export const JOB_EMAIL_RANKING_NEWNESS_RELEVANCE_BAND = 1;

import {
  MAX_SAFE_SCORE,
  stableJobId as stableJobIdPure,
} from './jobEmailRankingLinks.js';

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = integer ? Math.trunc(parsed) : parsed;
  return Math.min(max, Math.max(min, normalized));
}

function parseTreatmentVariant(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === JOB_EMAIL_RANKING_VARIANTS.affinity
    || normalized === JOB_EMAIL_RANKING_VARIANTS.controlPlusNewness) return normalized;
  // An invalid remote value must not silently enable an unknown treatment.
  return JOB_EMAIL_RANKING_VARIANTS.control;
}

/**
 * Read the ranking settings at process start.  Invalid Remote Config values
 * fall back independently, so one bad knob cannot disable the safety rails of
 * the others.
 */
export function readJobEmailRankingConfig(env = process.env) {
  return Object.freeze({
    enabled: parseBoolean(env.JOB_EMAIL_RANKING_ENABLED, JOB_EMAIL_RANKING_DEFAULTS.enabled),
    rollout: parseNumber(env.JOB_EMAIL_RANKING_ROLLOUT, JOB_EMAIL_RANKING_DEFAULTS.rollout, { min: 0, max: 1 }),
    affinityWeight: parseNumber(env.JOB_EMAIL_RANKING_AFFINITY_WEIGHT, JOB_EMAIL_RANKING_DEFAULTS.affinityWeight, { min: 0, max: 1 }),
    treatmentVariant: parseTreatmentVariant(env.JOB_EMAIL_RANKING_TREATMENT, JOB_EMAIL_RANKING_DEFAULTS.treatmentVariant),
  });
}

function normalizeSubjectId(value) {
  return String(value || '').trim().toLowerCase();
}

/** Stable, non-random bucket in [0, 1). */
export function hashUnitInterval(seed) {
  const digest = createHash('sha256').update(String(seed || '')).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function configuredTreatmentVariant(config = JOB_EMAIL_RANKING_DEFAULTS) {
  const value = config?.treatmentVariant;
  if (value === undefined || value === null || value === '') return JOB_EMAIL_RANKING_DEFAULTS.treatmentVariant;
  return value === JOB_EMAIL_RANKING_VARIANTS.affinity || value === JOB_EMAIL_RANKING_VARIANTS.controlPlusNewness
    ? value
    : JOB_EMAIL_RANKING_VARIANTS.control;
}

/**
 * Variante di una persona: il trattamento configurato se il suo bucket cade
 * sotto il rollout, altrimenti `control`. Il seme e' solo l'email normalizzata:
 * la stessa persona ha la stessa variante nei job alert e nella newsletter,
 * oggi e domani, cosi' l'effetto si misura per persona e non si diluisce
 * cambiando braccio a ogni invio. `JOB_EMAIL_RANKING_ENABLED` spento rimette
 * tutti in `control`.
 */
export function assignJobRankingVariant({
  subjectId,
  config = JOB_EMAIL_RANKING_DEFAULTS,
} = {}) {
  const subject = normalizeSubjectId(subjectId);
  if (!subject || !config.enabled || !(config.rollout > 0)) return JOB_EMAIL_RANKING_VARIANTS.control;
  const treatmentVariant = configuredTreatmentVariant(config);
  if (treatmentVariant === JOB_EMAIL_RANKING_VARIANTS.control) return JOB_EMAIL_RANKING_VARIANTS.control;
  const assignmentSeed = treatmentVariant === JOB_EMAIL_RANKING_VARIANTS.affinity
    ? JOB_EMAIL_AFFINITY_ASSIGNMENT_SEED
    : JOB_EMAIL_RANKING_ASSIGNMENT_SEED;
  const bucket = hashUnitInterval(`${assignmentSeed}:${subject}`);
  return bucket < config.rollout ? treatmentVariant : JOB_EMAIL_RANKING_VARIANTS.control;
}

export function stableJobId(jobOrId) {
  return stableJobIdPure(jobOrId, (seed) => createHash('sha256').update(seed).digest('hex'));
}

/** One-way identifier used in the ranking data, never placed in an href. */
export function pseudonymousUserId(email, secret = process.env.NEWSLETTER_SECRET) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  if (secret) return createHmac('sha256', String(secret)).update(normalized).digest('hex').slice(0, 32);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/** Stable per-send identifier; it contains no recipient address. */
export function buildJobEmailDeliveryId({ surface, surfaceId, recipientId, campaignId = '', runId = '' } = {}) {
  const digest = createHash('sha256')
    .update(`${surface || ''}|${surfaceId || ''}|${normalizeSubjectId(recipientId)}|${campaignId}|${runId}`)
    .digest('hex')
    .slice(0, 24);
  return `jer_${String(surface || 'email').replace(/[^a-z0-9_-]/gi, '_')}_${digest}`;
}

// Job attributes carried by every manifest entry and compared with the
// interest profile. A job_id stops resolving once the listing expires (the
// expired archive has no id, category or canton), so the manifest itself must
// say which kind of listing a click was about.
export const MANIFEST_ATTRIBUTE_MAX_LENGTH = 80;

/** Short, whitespace-normalized string, or null when the value is absent. */
function manifestAttribute(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Array.from cuts on code points, never inside a surrogate pair.
  return Array.from(text).slice(0, MANIFEST_ATTRIBUTE_MAX_LENGTH).join('').trim();
}

/** Two-letter uppercase canton code (`TI`), or null for anything else. */
function manifestCanton(value) {
  const code = manifestAttribute(value)?.toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * The four listing attributes of a job, in the delivery-manifest shape
 * (jobManifestEntry in ./jobEmailRankingStore.js spreads this). The ranking
 * compares the same object with the interest profile, so what is recorded on
 * a click and what is scored at send time cannot drift apart.
 */
export function jobRankingAttributes(job) {
  return {
    category: manifestAttribute(job?.category),
    canton: manifestCanton(job?.canton),
    // companyKey is already the normalized key the crawlers emit
    // (scripts/lib/company-key.mjs); Cloud Functions cannot import scripts/.
    company_key: manifestAttribute(job?.companyKey),
    // A newsletter card's `sector` falls back to the category for display and
    // alert matching; `rawSector` keeps the listing's own sector key.
    sector: manifestAttribute(job?.rawSector !== undefined ? job.rawSector : job?.sector),
  };
}

function relevanceFor(job) {
  const value = job?.relevanceScore ?? job?.score ?? job?.ranking?.relevanceScore ?? 0;
  return Math.max(0, Math.min(MAX_SAFE_SCORE, Number(value) || 0));
}

function companyDiversityKey(job) {
  const company = String(job?.company || '').trim().toLowerCase();
  return company || '∅';
}

/**
 * Interleave candidates only inside equal-score groups. A candidate with a
 * higher score always stays ahead; within a tie, the first appearance of each
 * company gets a turn before that company receives another one.
 */
function diversifyEqualRankGroups(candidates, scoreFor) {
  const source = Array.isArray(candidates) ? candidates : [];
  if (source.length < 2) return source;

  const result = [];
  let start = 0;
  while (start < source.length) {
    const tieScore = scoreFor(source[start]);
    let end = start + 1;
    while (end < source.length && scoreFor(source[end]) === tieScore) end++;

    const buckets = new Map();
    for (let index = start; index < end; index++) {
      const key = companyDiversityKey(source[index]);
      const bucket = buckets.get(key) || [];
      bucket.push(source[index]);
      buckets.set(key, bucket);
    }
    const maxBucketSize = Math.max(...[...buckets.values()].map((bucket) => bucket.length));
    for (let depth = 0; depth < maxBucketSize; depth++) {
      for (const bucket of buckets.values()) {
        if (bucket[depth]) result.push(bucket[depth]);
      }
    }
    start = end;
  }
  return result;
}

function finiteAffinity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function timestampFromValue(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || value === null || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Date used by the newness treatment. `newnessAt` is the normalized value
 * supplied by the two senders; the raw fields remain fallbacks for callers
 * and tests that rank a dataset row directly. `crawledAt` is deliberately not
 * used because it moves on every re-crawl and would make old listings appear
 * new again.
 */
export function jobNewnessTimestamp(job) {
  for (const value of [
    job?.newnessAt,
    job?.firstSeenAt,
    job?.postedDate,
    job?.datePosted,
    job?.publishedAt,
  ]) {
    const ms = timestampFromValue(value);
    if (ms !== null && ms > 0) return ms;
  }
  return null;
}

/**
 * Freshness score in [0, 1]. Only listings first seen within the configured
 * window receive a positive score; unknown, future and older dates are neutral.
 */
export function jobNewnessScore(job, now = Date.now(), windowDays = JOB_EMAIL_RANKING_NEWNESS_WINDOW_DAYS) {
  const postedAt = jobNewnessTimestamp(job);
  if (postedAt === null) return 0;
  const nowMs = timestampFromValue(now);
  if (nowMs === null) return 0;
  const windowMs = Math.max(1, Number(windowDays) || JOB_EMAIL_RANKING_NEWNESS_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const ageMs = nowMs - postedAt;
  if (ageMs < 0 || ageMs >= windowMs) return 0;
  return 1 - (ageMs / windowMs);
}

/**
 * True only when the `affinity` branch actually reorders: affinity variant,
 * ranking enabled, a scorer (valid profile, no opt-out) and a positive weight.
 * Every caller that changes behaviour for affinity recipients (the ranking
 * below, the newsletter candidate pool) asks this, so a person without a
 * profile gets exactly the control jobs in the control order.
 */
export function affinityReorders({ variant, affinityScorer = null, config = JOB_EMAIL_RANKING_DEFAULTS } = {}) {
  return variant === JOB_EMAIL_RANKING_VARIANTS.affinity
    && Boolean(config.enabled)
    && typeof affinityScorer === 'function'
    && finiteAffinity(config.affinityWeight) > 0;
}

/** True when the newness treatment is active, even without a profile. */
export function newnessReorders({ variant, config = JOB_EMAIL_RANKING_DEFAULTS } = {}) {
  return variant === JOB_EMAIL_RANKING_VARIANTS.controlPlusNewness && Boolean(config.enabled);
}

/** True only when a sender needs to read affinity profiles for this config. */
export function rankingNeedsAffinityProfile({ config = JOB_EMAIL_RANKING_DEFAULTS } = {}) {
  return Boolean(config.enabled)
    && configuredTreatmentVariant(config) === JOB_EMAIL_RANKING_VARIANTS.affinity
    && Number(config.rollout) > 0;
}

/** Any active ranking treatment may need a wider candidate pool. */
export function rankingReorders({ variant, affinityScorer = null, config = JOB_EMAIL_RANKING_DEFAULTS } = {}) {
  return affinityReorders({ variant, affinityScorer, config }) || newnessReorders({ variant, config });
}

function orderByNewnessWithinRelevanceBands(candidates, nowMs) {
  const relevanceOrdered = [...candidates].sort((a, b) => (
    (b.ranking.relevanceScore - a.ranking.relevanceScore)
    || (a.ranking.sourceIndex - b.ranking.sourceIndex)
  ));
  const ordered = [];
  let start = 0;
  while (start < relevanceOrdered.length) {
    const firstRelevance = relevanceOrdered[start].ranking.relevanceScore;
    let end = start + 1;
    while (end < relevanceOrdered.length
      && firstRelevance - relevanceOrdered[end].ranking.relevanceScore <= JOB_EMAIL_RANKING_NEWNESS_RELEVANCE_BAND) {
      end++;
    }
    const band = relevanceOrdered.slice(start, end);
    if (band.some((candidate) => jobNewnessScore(candidate, nowMs) > 0)) {
      band.sort((a, b) => (
        (b.ranking.newnessScore - a.ranking.newnessScore)
        || (a.ranking.sourceIndex - b.ranking.sourceIndex)
      ));
    }
    ordered.push(...band);
    start = end;
  }
  return ordered;
}

/**
 * Rank an already matched list.
 *
 * `affinityScorer` is the recipient's scorer from createAffinityScorer
 * (./jobEmailAffinity.js), or null when the person has no valid profile or
 * has opposed the personalization. The ranking module takes the function
 * instead of the profile so it never imports the profile module (which
 * imports this one).
 *
 * Control, and `affinity` without a scorer or with weight 0, preserve the
 * caller's order with company diversity as a tie-breaker. `affinity` with a
 * scorer sorts by relevance * (1 - w + w * affinity), keeping the caller's
 * order on equal scores, then applies the same company diversity. The
 * `control_plus_newness` branch starts from relevance order and only sorts a
 * narrow relevance band by a positive recent-listing score. When a scorer is
 * given the control branch still records the affinity score of the jobs it
 * returns (for the measurement), without using it.
 */
export function rankEmailJobs(jobs, {
  variant = JOB_EMAIL_RANKING_VARIANTS.control,
  affinityScorer = null,
  limit = jobs?.length || 0,
  config = JOB_EMAIL_RANKING_DEFAULTS,
  now = Date.now(),
} = {}) {
  const source = Array.isArray(jobs) ? jobs : [];
  const safeLimit = Math.max(0, Math.trunc(limit));
  const isAffinity = variant === JOB_EMAIL_RANKING_VARIANTS.affinity && Boolean(config.enabled);
  const isNewness = variant === JOB_EMAIL_RANKING_VARIANTS.controlPlusNewness && Boolean(config.enabled);
  const scorer = typeof affinityScorer === 'function' ? affinityScorer : null;
  const weight = finiteAffinity(config.affinityWeight);
  const affinityOrdering = affinityReorders({ variant, affinityScorer: scorer, config });
  const newnessOrdering = newnessReorders({ variant, config });
  const nowMs = timestampFromValue(now) ?? Date.now();
  const variantLabel = isAffinity
    ? JOB_EMAIL_RANKING_VARIANTS.affinity
    : isNewness ? JOB_EMAIL_RANKING_VARIANTS.controlPlusNewness : JOB_EMAIL_RANKING_VARIANTS.control;

  const candidates = source.map((job, sourceIndex) => {
    const relevanceScore = relevanceFor(job);
    const affinityScore = affinityOrdering ? finiteAffinity(scorer(jobRankingAttributes(job))) : null;
    const newnessScore = isNewness ? jobNewnessScore(job, nowMs) : null;
    const rankingScore = affinityOrdering
      ? relevanceScore * (1 - weight + weight * affinityScore)
      : relevanceScore;
    return {
      ...job,
      jobId: stableJobId(job),
      ranking: {
        variant: variantLabel,
        rankingScore: Number.isFinite(rankingScore) ? rankingScore : 0,
        relevanceScore,
        affinityScore,
        newnessScore,
        sourceIndex,
      },
    };
  });

  const ordered = affinityOrdering
    ? diversifyEqualRankGroups(
      // Array.prototype.sort is stable: equal scores keep the matcher order.
      [...candidates].sort((a, b) => b.ranking.rankingScore - a.ranking.rankingScore),
      (candidate) => candidate.ranking.rankingScore,
    )
    : newnessOrdering
      ? diversifyEqualRankGroups(
        orderByNewnessWithinRelevanceBands(candidates, nowMs),
        (candidate) => candidate.ranking.relevanceScore,
      )
    : diversifyEqualRankGroups(candidates, (candidate) => candidate.ranking.relevanceScore);

  return ordered.slice(0, safeLimit).map((candidate, index) => {
    const ranking = { ...candidate.ranking, position: index + 1 };
    // Only the returned jobs need a score when it does not drive the order.
    if (!affinityOrdering && scorer) ranking.affinityScore = finiteAffinity(scorer(jobRankingAttributes(candidate)));
    return { ...candidate, ranking };
  });
}

/** Safe key for a nested `ranking_stats` field in an alert document. */
export function rankingStatsKey(jobId) {
  return `j_${createHash('sha256').update(String(jobId || '')).digest('hex').slice(0, 24)}`;
}

export function rankingDay(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

/**
 * Flat Firestore update for the per-alert embedded stats map.  `FieldValue`
 * is injected so the ranking module stays usable in Vitest and in scripts.
 */
export function buildEmbeddedRankingUpdate({
  jobId,
  day = rankingDay(),
  eventType = 'impression',
  position = null,
  variant = 'unknown',
  FieldValue,
} = {}) {
  if (!jobId || !FieldValue) return {};
  const key = rankingStatsKey(jobId);
  const prefix = `ranking_stats.${key}`;
  const update = {
    [`${prefix}.job_id`]: String(jobId),
    [`${prefix}.days.${day}.${eventType === 'click' ? 'clicks' : 'impressions'}`]: FieldValue.increment(1),
    [`${prefix}.last_event_at`]: new Date(),
  };
  if (variant) update[`${prefix}.${eventType === 'click' ? 'last_click_variant' : 'last_impression_variant'}`] = String(variant);
  if (eventType === 'impression' && Number.isFinite(Number(position))) {
    update[`${prefix}.days.${day}.position_sum`] = FieldValue.increment(Math.max(1, Math.trunc(Number(position))));
  }
  return update;
}
