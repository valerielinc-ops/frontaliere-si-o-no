// scripts/lib/discovery/discoveryScore.mjs
//
// Source-specific scoring for the discovery pool. Each source has a
// confidence multiplier reflecting how much we trust its signal:
//   orphan  → 1.0  (real GSC impressions, just orphan landing pages)
//   suggest → 0.6  (autocomplete demand, no impression evidence)
//   news    → 0.7  (fresh interest, freshness boost up to 1.3x)
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.4

import { classifyByRegex } from '../cluster-classifier-prompt.mjs';
import { hasDomainAnchor } from './domainAnchor.mjs';

const ORPHAN_CONFIDENCE = 1.0;
const SUGGEST_CONFIDENCE = 0.6;
const NEWS_CONFIDENCE = 0.7;

const CLUSTER_FALLBACK_P50 = 100;
const ORPHAN_CLUSTER_DIVISOR = 400;
const SUGGEST_CLUSTER_FACTOR = 0.5;

const NEWS_FRESHNESS_BOOST = 0.3;
const NEWS_FRESHNESS_HORIZON_HOURS = 48;

const WINDOW_DAYS_DEFAULT = 90;

function clusterP50(evidence, cluster) {
  const stats = evidence?.clusterStats?.[cluster];
  const p50 = stats && Number.isFinite(Number(stats.p50)) ? Number(stats.p50) : NaN;
  return Number.isFinite(p50) ? p50 : CLUSTER_FALLBACK_P50;
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Compute the freshness multiplier for a news candidate. Linear decay
 * from 1.3 (age=0) to 1.0 (age >= 48h). Clamped at both ends.
 *
 * @param {number} ageHours
 * @returns {number}
 */
export function freshnessFactorForAgeHours(ageHours) {
  const safeAge = safeNumber(ageHours, NEWS_FRESHNESS_HORIZON_HOURS);
  const remaining = Math.max(0, 1 - safeAge / NEWS_FRESHNESS_HORIZON_HOURS);
  return 1 + NEWS_FRESHNESS_BOOST * remaining;
}

/**
 * Score a discovery candidate per its `source` tag. Returns a score
 * breakdown with shape compatible with `cascadedScore` output (so the
 * existing ranker code paths can consume it identically).
 *
 * @param {{ headline: string, source: 'orphan'|'suggest'|'news', meta?: object }} candidate
 * @param {object} evidence
 * @returns {{ stage: string, source: string, rawScore: number, confidence: number, freshnessFactor: number, finalScore: number, cluster: string }}
 */
export function discoveryScore(candidate, evidence) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('discoveryScore: candidate is required');
  }
  const headline = String(candidate.headline || '');
  const meta = candidate.meta || {};
  const cluster = classifyByRegex(headline);
  const safeEvidence = evidence || {};

  switch (candidate.source) {
    case 'orphan': {
      const windowDays = Number(safeEvidence.windowDays) > 0
        ? Number(safeEvidence.windowDays)
        : WINDOW_DAYS_DEFAULT;
      const imp = safeNumber(meta.imp, 0);
      const p50 = clusterP50(safeEvidence, cluster);
      const clusterMultiplier = p50 / ORPHAN_CLUSTER_DIVISOR;
      const rawScore = (imp / windowDays) * clusterMultiplier;
      return {
        stage: 'discovery',
        source: 'orphan',
        rawScore,
        confidence: ORPHAN_CONFIDENCE,
        freshnessFactor: 1.0,
        finalScore: rawScore * ORPHAN_CONFIDENCE,
        cluster,
      };
    }
    case 'suggest': {
      // Backstop domain-anchor gate — googleSuggestSource.mjs already
      // filters here, but if any other path ever feeds an anchorless
      // suggest candidate (e.g. a future source-aggregator bug) we
      // refuse to score it. Throw so the pool's try/catch logs the
      // sanity-check failure instead of silently scoring garbage.
      if (!hasDomainAnchor(headline)) {
        throw new Error(
          `discoveryScore: suggest candidate "${headline.slice(0, 80)}" lacks a Ticino/frontalieri anchor token`,
        );
      }
      const p50 = clusterP50(safeEvidence, cluster);
      const rawScore = p50 * SUGGEST_CLUSTER_FACTOR;
      return {
        stage: 'discovery',
        source: 'suggest',
        rawScore,
        confidence: SUGGEST_CONFIDENCE,
        freshnessFactor: 1.0,
        finalScore: rawScore * SUGGEST_CONFIDENCE,
        cluster,
      };
    }
    case 'news': {
      const p50 = clusterP50(safeEvidence, cluster);
      const ageHours = safeNumber(meta.ageHours, NEWS_FRESHNESS_HORIZON_HOURS);
      const freshnessFactor = freshnessFactorForAgeHours(ageHours);
      const rawScore = p50;
      return {
        stage: 'discovery',
        source: 'news',
        rawScore,
        confidence: NEWS_CONFIDENCE,
        freshnessFactor,
        finalScore: rawScore * NEWS_CONFIDENCE * freshnessFactor,
        cluster,
      };
    }
    default:
      throw new Error(`discoveryScore: unknown source "${candidate.source}"`);
  }
}
