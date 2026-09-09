/**
 * Node-backed health-premium loaders and YoY helpers.
 *
 * URL tables, path builders and route predicates live in
 * `healthPremiumsLinks.ts`, which is safe for browser consumers.
 */
export * from './healthPremiumsLinks';

import {
  HEALTH_PREMIUM_AGE_BRACKETS,
  HEALTH_PREMIUM_BRACKET_RISK_CLASS,
  type HealthPremiumAgeBracket,
  type HealthPremiumRiskClass,
} from './healthPremiumsLinks';

// ── Multi-year loader + YoY computation (F2 A3) ────────────────
//
// Premiums are now stored under `data/health-premiums/{year}.json` so we can
// compute year-over-year variation for each insurer × canton × age. The
// legacy flat path (`data/health-premiums.json`) remains supported as a
// fallback for the current-year dataset so pre-A3 consumers stay green.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal shape of the dataset JSON — we intentionally avoid re-importing
 * the full `HealthPremiumsDataset` type from the plugin to prevent a circular
 * import (plugin imports from this file).
 */
interface PremiumsJsonShape {
  year?: number;
  fetchedAt?: string;
  insurers?: Array<{ id: string; name?: string; website?: string }>;
  premiums?: Record<string, unknown>;
}

/**
 * Load the premiums dataset for a given calendar year. Returns `null` when
 * the file does not exist or fails to parse — callers must treat this as a
 * soft miss, never a build failure (F2 A3 "graceful degradation").
 */
export function loadPremiumsForYear(
  rootDir: string,
  year: number,
): PremiumsJsonShape | null {
  const candidates = [
    path.resolve(rootDir, 'data', 'health-premiums', `${year}.json`),
    // Legacy fallback: the flat `data/health-premiums.json` mirrors the
    // current year. Only treat it as a match when the embedded `year`
    // metadata agrees — otherwise a historical-year request could silently
    // read the wrong dataset.
    path.resolve(rootDir, 'data', 'health-premiums.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as PremiumsJsonShape;
      if (parsed.year === year) return parsed;
    } catch {
      // fall through to next candidate
    }
  }
  return null;
}

/**
 * Per-insurer standard-premium YoY variation (percent). Positive means the
 * 2026 premium is higher than 2025. `null` entries signal that the prior-year
 * dataset did not expose a usable premium for that insurer.
 */
export type YoyInsurerDeltaMap = Record<string, number | null>;

/**
 * Per-bracket YoY delta slice. `perInsurer` is keyed by insurer id → percent
 * change between the two years at the requested risk class; `medianPct` is
 * the median of non-null entries; `sourceInsurers` records how many insurers
 * contributed to the median calculation so downstream UI can hide sparse
 * deltas (< 3 insurers).
 */
export interface YoyBracketDelta {
  riskClass: HealthPremiumRiskClass;
  perInsurer: YoyInsurerDeltaMap;
  medianPct: number | null;
  sourceInsurers: number;
}

/**
 * Full YoY delta for a canton: one slice per age bracket, plus an aggregate
 * canton-level median across the adult bracket (ERW). Returns `null` when
 * no prior dataset was available — callers skip the entire YoY section in
 * that case.
 */
export interface YoyCantonDelta {
  priorYear: number;
  currentYear: number;
  byBracket: Record<HealthPremiumAgeBracket, YoyBracketDelta | null>;
  /** Median YoY percent across adults (ERW) — the headline figure. */
  adultMedianPct: number | null;
  /** Number of insurers contributing to the adult median. */
  adultInsurers: number;
}

/**
 * Percent-change helper, rounded to two decimal places. Returns `null` when
 * either value is non-finite or the denominator is zero.
 */
function pctDelta(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  return Math.round(((current - prior) / prior) * 100 * 100) / 100;
}

/**
 * Compute per-insurer standard-premium averages, aggregated across every
 * premium block that belongs to a given BAG canton code, for a given risk
 * class. Only `standard` prices with matching `byAgeClass[riskClass]` are
 * considered — we never blend in multiplier-derived values for YoY (that
 * would hide real variation behind the multiplier).
 *
 * Kept internal to the YoY path so we do not alter the existing plugin
 * aggregation semantics used by `aggregatePremiumsByRiskClass`.
 */
function averageRealPremiumsForCanton(
  dataset: PremiumsJsonShape,
  cantonCode: string,
  riskClass: HealthPremiumRiskClass,
): Record<string, number> {
  const all = dataset.premiums ?? {};
  const sums: Record<string, { sum: number; count: number }> = {};

  for (const [key, rawBlock] of Object.entries(all)) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    // Accept either canton-level or commune-level blocks belonging to the
    // requested canton code.
    const block = rawBlock as {
      canton?: string;
      type?: string;
      insurers?: Record<string, {
        standard?: number;
        byAgeClass?: Partial<Record<HealthPremiumRiskClass, { standard?: number }>>;
      }>;
    };
    if (key !== cantonCode && block.canton !== cantonCode) continue;
    if (key === cantonCode && block.type !== 'canton') {
      // The canton-code key is valid only when it is a canton-level block.
      if (block.canton !== cantonCode) continue;
    }
    for (const [insurerId, models] of Object.entries(block.insurers ?? {})) {
      const bac = models.byAgeClass?.[riskClass];
      let price: number | null = null;
      if (bac && typeof bac.standard === 'number') {
        price = bac.standard;
      } else if (riskClass === 'ERW' && typeof models.standard === 'number') {
        // Legacy datasets alias ERW in the flat field.
        price = models.standard;
      }
      if (price === null || !Number.isFinite(price)) continue;
      if (!sums[insurerId]) sums[insurerId] = { sum: 0, count: 0 };
      sums[insurerId].sum += price;
      sums[insurerId].count += 1;
    }
  }

  const out: Record<string, number> = {};
  for (const [id, { sum, count }] of Object.entries(sums)) {
    if (count === 0) continue;
    out[id] = Math.round((sum / count) * 100) / 100;
  }
  return out;
}

function medianOf(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
    : sorted[mid];
}

/**
 * Compute YoY variation for a canton. Returns `null` when the prior dataset
 * is absent — the plugin skips the "Variazione vs {priorYear}" section in
 * that case, exactly as A3 specifies (no fake data).
 */
export function computeYoyDelta(opts: {
  current: PremiumsJsonShape;
  prior: PremiumsJsonShape | null;
  cantonBagCode: string;
}): YoyCantonDelta | null {
  const { current, prior, cantonBagCode } = opts;
  if (!prior) return null;
  if (!current.year || !prior.year) return null;
  if (current.year === prior.year) return null;

  const byBracket = {} as Record<HealthPremiumAgeBracket, YoyBracketDelta | null>;
  for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
    const rc = HEALTH_PREMIUM_BRACKET_RISK_CLASS[ab.id];
    const cur = averageRealPremiumsForCanton(current, cantonBagCode, rc);
    const pri = averageRealPremiumsForCanton(prior, cantonBagCode, rc);
    const perInsurer: YoyInsurerDeltaMap = {};
    const deltas: number[] = [];
    for (const [id, curPrice] of Object.entries(cur)) {
      const priPrice = pri[id];
      if (typeof priPrice !== 'number') {
        perInsurer[id] = null;
        continue;
      }
      const delta = pctDelta(curPrice, priPrice);
      perInsurer[id] = delta;
      if (delta !== null) deltas.push(delta);
    }
    if (Object.keys(perInsurer).length === 0) {
      byBracket[ab.id] = null;
    } else {
      byBracket[ab.id] = {
        riskClass: rc,
        perInsurer,
        medianPct: medianOf(deltas),
        sourceInsurers: deltas.length,
      };
    }
  }

  const adult = byBracket['31-45'];
  return {
    priorYear: prior.year,
    currentYear: current.year,
    byBracket,
    adultMedianPct: adult?.medianPct ?? null,
    adultInsurers: adult?.sourceInsurers ?? 0,
  };
}

// ── 3-year tri-year trend (B-cont-4) ───────────────────────────
//
// Wave A3 added a 2-year YoY (current vs prior). B-cont-4 extends the same
// pattern to a 3-year trend (oldest → prior → current) that lets each
// canton × age leaf show two consecutive YoY deltas plus a cumulative
// 2-year percentage. The earliest year is OPTIONAL: callers must gracefully
// degrade to the existing YoY-only rendering when no 2024 dataset is
// available, exactly per CLAUDE.md rule #6 (no fake data).

/**
 * Median premium per age bracket across all insurers, both for the prior and
 * the oldest years. Used by leaf and hub trend sparklines so we can plot
 * the 3-year trajectory of the bracket median without recomputing inside the
 * renderer.
 */
export interface BracketTrendPoint {
  /** Calendar year (e.g. 2024). */
  year: number;
  /** Median standard premium across insurers (CHF/month). */
  median: number | null;
  /** Insurers that contributed to the median. */
  insurers: number;
}

export interface BracketTrend {
  riskClass: HealthPremiumRiskClass;
  /** Always sorted oldest → newest (e.g. [2024, 2025, 2026]). */
  points: BracketTrendPoint[];
  /** Year-over-year percent: index i is `points[i+1]` vs `points[i]`. */
  yoyPct: Array<number | null>;
  /** Cumulative percent change from the oldest to the newest point. */
  cumulativePct: number | null;
}

export interface TriYearCantonDelta {
  /** Oldest year in the window (e.g. 2024). */
  oldestYear: number;
  priorYear: number;
  currentYear: number;
  byBracket: Record<HealthPremiumAgeBracket, BracketTrend | null>;
  /** Median 2-year cumulative % across the adult bracket (ERW 31-45). */
  adultCumulativePct: number | null;
}

function bracketMedian(
  dataset: PremiumsJsonShape | null,
  cantonCode: string,
  riskClass: HealthPremiumRiskClass,
): { median: number | null; insurers: number } {
  if (!dataset) return { median: null, insurers: 0 };
  const perInsurer = averageRealPremiumsForCanton(dataset, cantonCode, riskClass);
  const values = Object.values(perInsurer).filter((v): v is number => Number.isFinite(v));
  return { median: medianOf(values), insurers: values.length };
}

/**
 * Compute the 3-year trend for a canton. The function tolerates a missing
 * `oldest` dataset — when only `prior` + `current` are available it returns
 * the same 2-point series so callers can still render a YoY arc but no
 * tri-year cumulative point. Returns `null` when neither prior nor current
 * carry data for the canton (no point worth plotting).
 */
export function computeTriYearDelta(opts: {
  current: PremiumsJsonShape;
  prior: PremiumsJsonShape | null;
  oldest: PremiumsJsonShape | null;
  cantonBagCode: string;
}): TriYearCantonDelta | null {
  const { current, prior, oldest, cantonBagCode } = opts;
  if (!current.year) return null;

  const byBracket = {} as Record<HealthPremiumAgeBracket, BracketTrend | null>;
  let hasAnyTrend = false;

  for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
    const rc = HEALTH_PREMIUM_BRACKET_RISK_CLASS[ab.id];
    const points: BracketTrendPoint[] = [];

    if (oldest?.year) {
      const m = bracketMedian(oldest, cantonBagCode, rc);
      if (m.median !== null) points.push({ year: oldest.year, median: m.median, insurers: m.insurers });
    }
    if (prior?.year) {
      const m = bracketMedian(prior, cantonBagCode, rc);
      if (m.median !== null) points.push({ year: prior.year, median: m.median, insurers: m.insurers });
    }
    {
      const m = bracketMedian(current, cantonBagCode, rc);
      if (m.median !== null) points.push({ year: current.year, median: m.median, insurers: m.insurers });
    }

    // Need at least 2 anchor points (one YoY) to render a trend; otherwise
    // there is nothing meaningful and the bracket gets a null.
    if (points.length < 2) {
      byBracket[ab.id] = null;
      continue;
    }
    points.sort((a, b) => a.year - b.year);
    const yoyPct: Array<number | null> = [];
    for (let i = 1; i < points.length; i++) {
      yoyPct.push(pctDelta(points[i].median!, points[i - 1].median!));
    }
    const first = points[0].median!;
    const last = points[points.length - 1].median!;
    const cumulativePct = pctDelta(last, first);
    byBracket[ab.id] = {
      riskClass: rc,
      points,
      yoyPct,
      cumulativePct,
    };
    hasAnyTrend = true;
  }

  if (!hasAnyTrend) return null;

  const oldestYear = oldest?.year ?? prior?.year ?? current.year;
  const priorYear = prior?.year ?? current.year;
  const adult = byBracket['31-45'];
  return {
    oldestYear,
    priorYear,
    currentYear: current.year,
    byBracket,
    adultCumulativePct: adult?.cumulativePct ?? null,
  };
}

/**
 * Convenience helper: load up to 3 years of premium datasets. Returns the
 * raw datasets so callers can compose richer views without re-reading from
 * disk. `currentYear` defaults to the calendar year.
 */
export function loadPriorTwoYearsForBracket(
  rootDir: string,
  currentYear: number = new Date().getUTCFullYear(),
): {
  current: PremiumsJsonShape | null;
  prior: PremiumsJsonShape | null;
  oldest: PremiumsJsonShape | null;
} {
  return {
    current: loadPremiumsForYear(rootDir, currentYear),
    prior: loadPremiumsForYear(rootDir, currentYear - 1),
    oldest: loadPremiumsForYear(rootDir, currentYear - 2),
  };
}

// ── BAG age-bracket multipliers (FALLBACK ONLY) ────────────────
//
// Since F2-LAMal real data wiring, the dataset persists per-insurer premiums
// for all three BAG risk classes (AKL-KIN, AKL-JUG, AKL-ERW). These
// multipliers are retained only as a graceful-degradation fallback for the
// edge case where `byAgeClass.KIN` / `byAgeClass.JUG` are missing on an
// insurer × region pair — either legacy datasets pre-dating the schema
// upgrade or a BAG feed regression.
//
// The BAG statutory maxima (art. 61 al. 3 LAMal, BAG 2026) are:
//   - Children 0-18: capped at ~25% of adult premium.
//   - Young adults 19-25: capped at ~80% of adult premium.
// Callers should prefer the real per-insurer premium from
// `byAgeClass[riskClass]` and reach for these ratios only when the real
// value is absent.
export const HEALTH_PREMIUM_AGE_MULTIPLIER: Record<HealthPremiumAgeBracket, number> = {
  '0-18': 0.25,
  '19-25': 0.80,
  '26-30': 1.0,
  '31-45': 1.0,
  '46-55': 1.0,
  '56-plus': 1.0,
};
