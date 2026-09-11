import { createHash, createHmac } from 'node:crypto';

/**
 * Ranking configuration for jobs shown in email recommendations.
 *
 * The defaults intentionally start with a small treatment cohort.  Relevance
 * remains the first gate: this module only reorders jobs that the existing
 * matcher has already deemed relevant.
 */
export const JOB_EMAIL_RANKING_DEFAULTS = Object.freeze({
  enabled: true,
  rollout: 0.15,
  alpha: 0.8,
  epsilon: 0.15,
  windowDays: 60,
  shrinkK: 25,
  minImpressions: 50,
  newJobBoost: 0.15,
  maxConsecutiveExposures: 3,
});

export const JOB_EMAIL_RANKING_WINDOWS = Object.freeze([7, 30, 90]);

const DEFAULT_PRIOR_CTR = 0.05;
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

/**
 * Read the ranking settings at process start.  Invalid Remote Config values
 * fall back independently, so one bad knob cannot disable the safety rails of
 * the others.
 */
export function readJobEmailRankingConfig(env = process.env) {
  return Object.freeze({
    enabled: parseBoolean(env.JOB_EMAIL_RANKING_ENABLED, JOB_EMAIL_RANKING_DEFAULTS.enabled),
    rollout: parseNumber(env.JOB_EMAIL_RANKING_ROLLOUT, JOB_EMAIL_RANKING_DEFAULTS.rollout, { min: 0, max: 1 }),
    alpha: parseNumber(env.JOB_EMAIL_RANKING_ALPHA, JOB_EMAIL_RANKING_DEFAULTS.alpha, { min: 0, max: 1 }),
    epsilon: parseNumber(env.JOB_EMAIL_RANKING_EPSILON, JOB_EMAIL_RANKING_DEFAULTS.epsilon, { min: 0, max: 1 }),
    windowDays: parseNumber(env.JOB_EMAIL_RANKING_WINDOW_DAYS, JOB_EMAIL_RANKING_DEFAULTS.windowDays, { min: 1, max: 90, integer: true }),
    shrinkK: parseNumber(env.JOB_EMAIL_RANKING_SHRINK_K, JOB_EMAIL_RANKING_DEFAULTS.shrinkK, { min: 1, max: 1000, integer: true }),
    minImpressions: parseNumber(env.JOB_EMAIL_RANKING_MIN_IMPRESSIONS, JOB_EMAIL_RANKING_DEFAULTS.minImpressions, { min: 0, max: 100000, integer: true }),
    newJobBoost: parseNumber(env.JOB_EMAIL_RANKING_NEW_JOB_BOOST, JOB_EMAIL_RANKING_DEFAULTS.newJobBoost, { min: 0, max: 1 }),
    maxConsecutiveExposures: parseNumber(env.JOB_EMAIL_RANKING_MAX_CONSECUTIVE_EXPOSURES, JOB_EMAIL_RANKING_DEFAULTS.maxConsecutiveExposures, { min: 0, max: 100, integer: true }),
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

/**
 * Assignment is stable for a recipient + campaign, which makes the control
 * and treatment populations reproducible across a retry of the same send.
 */
export function assignJobRankingVariant({
  subjectId,
  surface = 'newsletter',
  campaignId = '',
  config = JOB_EMAIL_RANKING_DEFAULTS,
} = {}) {
  if (!config.enabled || config.rollout <= 0) return 'control';
  const bucket = hashUnitInterval(`${surface}:${campaignId}:${normalizeSubjectId(subjectId)}`);
  return bucket < config.rollout ? 'treatment' : 'control';
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

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
}

/** Bayesian shrinkage towards the surface/category prior. */
export function computeSmoothedCtr(clicks, impressions, priorCtr = DEFAULT_PRIOR_CTR, shrinkK = 25) {
  const c = Math.max(0, Number(clicks) || 0);
  const i = Math.max(0, Number(impressions) || 0);
  const prior = clamp(Number(priorCtr) || DEFAULT_PRIOR_CTR);
  const k = Math.max(1, Number(shrinkK) || 25);
  return (c + prior * k) / (i + k);
}

function dateDiffInDays(date, nowMs) {
  const time = Date.parse(String(date || ''));
  if (!Number.isFinite(time)) return Infinity;
  return Math.floor((nowMs - time) / 86_400_000);
}

function normalizeDayKey(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * Aggregate a daily stats map.  Keeping daily rows lets reporting inspect
 * 7/30/90 day windows while ranking can use one configured window.
 */
export function aggregateRankingStats(rawStats, { nowMs = Date.now(), windowDays = 60 } = {}) {
  const stats = rawStats || {};
  const days = stats.days && typeof stats.days === 'object' ? stats.days : null;
  let impressions = 0;
  let clicks = 0;
  let positionSum = 0;
  let recentImpressions = 0;
  let consecutiveExposures = Math.max(0, Number(stats.consecutive_exposures) || 0);
  const rolling = Object.fromEntries(JOB_EMAIL_RANKING_WINDOWS.map((days) => [days, {
    impressions: 0,
    clicks: 0,
    positionSum: 0,
  }]));
  let weightedImpressions = 0;
  let weightedClicks = 0;

  if (days) {
    const exposureDays = [];
    const maxWindow = Math.max(windowDays, ...JOB_EMAIL_RANKING_WINDOWS);
    for (const [day, row] of Object.entries(days)) {
      const dayKey = normalizeDayKey(day);
      if (!dayKey) continue;
      const age = dateDiffInDays(`${dayKey}T00:00:00.000Z`, nowMs);
      if (age < 0 || age >= maxWindow) continue;
      const dayImpressions = Math.max(0, Number(row?.impressions) || 0);
      const dayClicks = Math.max(0, Number(row?.clicks) || 0);
      const dayPositionSum = Math.max(0, Number(row?.position_sum) || 0);
      for (const daysWindow of JOB_EMAIL_RANKING_WINDOWS) {
        if (age < daysWindow) {
          rolling[daysWindow].impressions += dayImpressions;
          rolling[daysWindow].clicks += dayClicks;
          rolling[daysWindow].positionSum += dayPositionSum;
        }
      }
      if (age < windowDays) {
        impressions += dayImpressions;
        clicks += dayClicks;
        positionSum += dayPositionSum;
        if (age < 7) recentImpressions += dayImpressions;
        // Recent observations carry more weight without allowing a one-click
        // yesterday to erase a well-sampled 30/60-day signal.
        const recencyWeight = age < 7 ? 1.5 : age < 30 ? 1 : 0.6;
        weightedImpressions += dayImpressions * recencyWeight;
        weightedClicks += dayClicks * recencyWeight;
      }
      if (dayImpressions > 0 && age < windowDays) exposureDays.push(dayKey);
    }
    // A daily row is one observed exposure for this job on this ranking
    // surface. Counting the most recent contiguous rows gives the configured
    // rotation cap a useful behavior without a second mutable counter.
    exposureDays.sort((a, b) => b.localeCompare(a));
    if (exposureDays.length > 0) {
      consecutiveExposures = 1;
      for (let i = 1; i < exposureDays.length; i++) {
        const previous = Date.parse(`${exposureDays[i - 1]}T00:00:00.000Z`);
        const current = Date.parse(`${exposureDays[i]}T00:00:00.000Z`);
        if (previous - current === 86_400_000) consecutiveExposures++;
        else break;
      }
    }
  } else {
    impressions = Math.max(0, Number(stats.impressions) || 0);
    clicks = Math.max(0, Number(stats.clicks) || 0);
    positionSum = Math.max(0, Number(stats.position_sum) || 0);
    weightedImpressions = impressions;
    weightedClicks = clicks;
    for (const daysWindow of JOB_EMAIL_RANKING_WINDOWS) {
      rolling[daysWindow] = { impressions, clicks, positionSum };
    }
  }

  return {
    impressions,
    clicks,
    positionSum,
    positionAvg: impressions > 0 ? positionSum / impressions : null,
    consecutiveExposures,
    recentImpressions,
    weightedImpressions,
    weightedClicks,
    rolling,
  };
}

export function computePriorCtr(statsByJob, fallback = DEFAULT_PRIOR_CTR) {
  let clicks = 0;
  let impressions = 0;
  const values = statsByJob instanceof Map ? [...statsByJob.values()] : Object.values(statsByJob || {});
  for (const raw of values) {
    const stats = raw?.impressions === undefined
      ? aggregateRankingStats(raw)
      : raw;
    clicks += Math.max(0, Number(stats.clicks) || 0);
    impressions += Math.max(0, Number(stats.impressions) || 0);
  }
  return impressions > 0 ? clamp(clicks / impressions, 0.001, 0.5) : fallback;
}

function getStats(statsByJob, jobId) {
  if (statsByJob instanceof Map) return statsByJob.get(jobId) || {};
  return statsByJob?.[jobId] || {};
}

function relevanceFor(job) {
  const value = job?.relevanceScore ?? job?.score ?? job?.ranking?.relevanceScore ?? 0;
  return Math.max(0, Math.min(MAX_SAFE_SCORE, Number(value) || 0));
}

function compareByExposureThenRandom(a, b) {
  const exposureDiff = (a.ranking.impressions || 0) - (b.ranking.impressions || 0);
  if (exposureDiff !== 0) return exposureDiff;
  return b.ranking.randomBoost - a.ranking.randomBoost;
}

function rankTieBreak(a, b) {
  const scoreDiff = b.ranking.rankingScore - a.ranking.rankingScore;
  if (scoreDiff !== 0) return scoreDiff;
  const freshnessA = Date.parse(a.firstSeenAt || '') || 0;
  const freshnessB = Date.parse(b.firstSeenAt || '') || 0;
  return freshnessB - freshnessA;
}

function insertExplorationSlots(exploit, explore, limit, fallback = []) {
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (safeLimit === 0) return [];
  const result = [];
  const selected = new Set();
  const add = (candidate) => {
    if (result.length >= safeLimit || selected.has(candidate)) return;
    selected.add(candidate);
    result.push(candidate);
  };

  if (explore.length === 0) {
    exploit.forEach(add);
  }

  let exploitIndex = 0;
  let exploreIndex = 0;
  const slots = explore.length;
  for (let position = 0; explore.length > 0 && position < safeLimit && (exploitIndex < exploit.length || exploreIndex < slots); position++) {
    const nextExplorePosition = Math.floor(((exploreIndex + 1) * safeLimit) / (slots + 1));
    if (exploreIndex < slots && position === nextExplorePosition) {
      add(explore[exploreIndex++]);
    } else if (exploitIndex < exploit.length) {
      add(exploit[exploitIndex++]);
    } else if (exploreIndex < slots) {
      add(explore[exploreIndex++]);
    }
  }

  // `maxConsecutiveExposures` can remove the preferred exploit candidates.
  // Fill the requested safeLimit from the ranked pool when the interleaving
  // is short, so `insertExplorationSlots(...)` never under-fills while enough
  // candidates remain available.
  fallback.forEach(add);
  return result;
}

/**
 * Rank an already matched list.  Control preserves the caller's order.  The
 * treatment uses smoothed CTR, relevance, deterministic exploration and a
 * small cold-start boost; exploration slots are explicitly injected so a low-
 * impression job is not permanently hidden by the exploit sort.
 */
export function rankEmailJobs(jobs, {
  statsByJob = new Map(),
  variant = 'control',
  surface = 'newsletter',
  surfaceId = '',
  campaignId = '',
  randomSeed = '',
  limit = jobs?.length || 0,
  config = JOB_EMAIL_RANKING_DEFAULTS,
  priorCtr,
  nowMs = Date.now(),
} = {}) {
  const source = Array.isArray(jobs) ? jobs : [];
  const safeLimit = Math.max(0, Math.trunc(limit));
  const prior = priorCtr ?? computePriorCtr(statsByJob);
  const isTreatment = variant === 'treatment' && config.enabled;
  const candidates = source.map((job, sourceIndex) => {
    const jobId = stableJobId(job);
    const aggregate = aggregateRankingStats(getStats(statsByJob, jobId), {
      nowMs,
      windowDays: config.windowDays,
    });
    const relevanceScore = relevanceFor(job);
    const ctrShrink = computeSmoothedCtr(
      aggregate.weightedClicks ?? aggregate.clicks,
      aggregate.weightedImpressions ?? aggregate.impressions,
      prior,
      config.shrinkK,
    );
    const normalizedCtr = clamp(ctrShrink / Math.max(0.1, prior * 2));
    const jobRandomSeed = `${surface}:${surfaceId}:${campaignId}:${normalizeSubjectId(randomSeed)}:${jobId}`;
    const rawRandomBoost = hashUnitInterval(jobRandomSeed);
    const coldStartFactor = aggregate.impressions < config.minImpressions
      ? 1 - clamp(aggregate.impressions / Math.max(1, config.minImpressions))
      : 0;
    const randomBoost = clamp(rawRandomBoost + config.newJobBoost * coldStartFactor);
    const rankingScore = relevanceScore * (
      config.alpha * normalizedCtr + (1 - config.alpha) * randomBoost
    );
    const ranking = {
      variant: isTreatment ? 'treatment' : 'control',
      rankingScore: Number.isFinite(rankingScore) ? rankingScore : 0,
      relevanceScore,
      ctrShrink,
      normalizedCtr,
      randomBoost,
      impressions: aggregate.impressions,
      clicks: aggregate.clicks,
      positionAvg: aggregate.positionAvg,
      consecutiveExposures: aggregate.consecutiveExposures,
      sourceIndex,
    };
    return { ...job, ranking, jobId };
  });

  if (!isTreatment) {
    return candidates.slice(0, safeLimit).map(({ ranking: meta, ...job }) => ({
      ...job,
      ranking: { ...meta, rankingScore: meta.relevanceScore, randomBoost: 0 },
    }));
  }

  const sorted = [...candidates].sort(rankTieBreak);
  const explorationCount = Math.min(
    Math.max(0, sorted.length - 1),
    Math.max(0, Math.round(safeLimit * config.epsilon)),
  );
  const explorationPool = [...sorted]
    .filter((candidate) => candidate.ranking.impressions < config.minImpressions)
    .sort(compareByExposureThenRandom);
  // If every candidate is already well sampled, explore a non-top candidate;
  // falling back to `sorted` would remove the top result from exploit and put
  // it in an arbitrary middle slot without adding any exploration value.
  const fallbackExplorationPool = sorted.length > 1 ? sorted.slice(1) : sorted;
  const explore = (explorationPool.length > 0 ? explorationPool : fallbackExplorationPool)
    .slice(0, explorationCount);
  const exploreIds = new Set(explore.map((candidate) => candidate.jobId));

  // Once a job has occupied the same ranking surface repeatedly, prefer the
  // remaining candidates. If there are no alternatives, retain it so a sparse
  // alert does not become empty.
  const capped = config.maxConsecutiveExposures > 0
    ? sorted.filter((candidate) => candidate.ranking.consecutiveExposures < config.maxConsecutiveExposures)
    : sorted;
  const exploitSource = capped.length >= Math.min(safeLimit, sorted.length)
    ? capped
    : sorted;
  const exploit = exploitSource.filter((candidate) => !exploreIds.has(candidate.jobId));
  const selected = insertExplorationSlots(exploit, explore, safeLimit, sorted);
  return selected.map(({ ranking: meta, ...job }, index) => ({
    ...job,
    ranking: { ...meta, position: index + 1 },
  }));
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
