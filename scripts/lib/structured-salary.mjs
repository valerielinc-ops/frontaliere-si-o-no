import { estimateSwissSalary } from './salary-estimation.mjs';

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundToHundreds(value) {
  return Math.max(1, Math.round(Number(value || 0) / 100) * 100);
}

function inferSalaryRange(job) {
  // Canton-aware: jobs outside Ticino are scaled to their BFS Grossregion
  // wage level. Jobs without a canton default to Ticino (factor 1.0).
  const estimated = estimateSwissSalary(job);
  return {
    min: estimated.minValue,
    max: estimated.maxValue,
  };
}

// Part-time roles state an employment percentage in the contract/title
// (e.g. "Part-time (20%)", "Teilzeit 60%", "Temps partiel (20 %)"). The salary
// estimate is a full-time-equivalent annual figure, so it must be reduced to
// the stated workload. Same percentage-extraction shape as isPartTime() in
// build-plugins/jobEditorialLanding.ts.
function partTimeEmploymentFraction(job) {
  const raw = [
    job?.contract,
    job?.employmentType,
    job?.title,
    job?.titleByLocale?.it,
    job?.titleByLocale?.en,
    job?.titleByLocale?.de,
    job?.titleByLocale?.fr,
  ]
    .map((value) => String(value || ''))
    .join(' ');
  const pcts = (raw.match(/(\d{1,3})\s*%/g) || [])
    .map((match) => Number(match.replace(/[^0-9]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
  if (!pcts.length) return null;
  // Use the upper bound of a stated range ("60-80%" → 80). A workload of 100%
  // (or a "80-100%" span) is effectively full-time — never reduce the salary.
  const workload = Math.max(...pcts);
  if (workload >= 100) return null;
  return workload / 100;
}

/**
 * Reduce a full-time-equivalent salary estimate to the stated part-time
 * workload. Returns null for full-time roles (or part-time roles with no
 * stated percentage), so callers keep the unscaled estimate. Shared by
 * ensureStructuredSalary() here and the re-enrich pipeline so both produce
 * the identical part-time band (no estimator drift between the two writers).
 *
 * @param {number} estimatedMin - Full-time estimate lower bound
 * @param {number} estimatedMax - Full-time estimate upper bound
 * @param {object} job - Job whose contract/title carries the employment %
 * @returns {{ min: number, max: number, fraction: number } | null}
 */
/**
 * True when an existing structured salary EXACTLY matches the estimator's
 * output for the same job (full-time or part-time-reduced, whichever the
 * caller passes in) — i.e. it's a previously-persisted estimate, not a real
 * declared/structured salary. Shared by ensureStructuredSalary() here and the
 * re-enrich pipeline's salarySource classification so both use the identical
 * fingerprint (no drift on what counts as "still an estimate").
 */
export function matchesEstimateFingerprint(existingMin, existingMax, estimatedMin, estimatedMax) {
  return existingMin === estimatedMin && existingMax === estimatedMax;
}

export function reduceSalaryToPartTime(estimatedMin, estimatedMax, job) {
  const fraction = partTimeEmploymentFraction(job);
  if (fraction === null) return null;
  return {
    min: roundToHundreds(estimatedMin * fraction),
    max: roundToHundreds(estimatedMax * fraction),
    fraction,
  };
}

function normalizeCurrency(job) {
  const raw = String(
    job?.currency ||
    job?.baseSalary?.currency ||
    job?.baseSalary?.value?.currency ||
    'CHF'
  ).trim().toUpperCase();
  return raw === 'EUR' ? 'EUR' : 'CHF';
}

export function ensureStructuredSalary(job) {
  if (!job || typeof job !== 'object') return { job, changed: false };

  const existingMin = toFiniteNumber(job.salaryMin) ?? toFiniteNumber(job?.baseSalary?.value?.minValue);
  const existingMax = toFiniteNumber(job.salaryMax) ?? toFiniteNumber(job?.baseSalary?.value?.maxValue);
  const hasExisting = existingMin != null && existingMin > 0;
  const estimated = inferSalaryRange(job);
  let minValue = hasExisting ? existingMin : estimated.min;
  let maxValue = existingMax && existingMax >= minValue ? existingMax : null;

  if (!maxValue) {
    maxValue = roundToHundreds(Math.max(estimated.max, minValue * 1.2));
  }

  // Reduce a full-time-equivalent estimate to the stated part-time workload.
  // Computed unconditionally (not just when minValue currently equals the
  // full-time estimate) so the part-time-aware target stays available for the
  // salarySource fingerprint below on a re-run too, once minValue is already
  // the reduced figure and no longer matches estimated.min directly.
  const reducedEstimate = reduceSalaryToPartTime(estimated.min, estimated.max, job);

  // Only applied when the current bounds ARE the full-time estimate, never a
  // salary reported in the posting (which already reflects the real pay). This
  // also keeps the pass idempotent: once scaled, the bounds no longer equal the
  // full-time estimate, so a re-run leaves them untouched.
  if (minValue === estimated.min && reducedEstimate) {
    minValue = reducedEstimate.min;
    maxValue = reducedEstimate.max;
  }

  // Salary provenance. jobs.json persists across assemble runs, so a job
  // hardened yesterday re-enters today already carrying the estimate this
  // function wrote as salaryMin/salaryMax — that must classify as 'estimated'
  // again, not flip to 'reported' just because the fields are now populated.
  // Fingerprint existingMin/Max against today's estimator output (full-time or
  // part-time-reduced, whichever applies to this job) to tell a persisted
  // estimate apart from a real declared/structured salary — using the
  // part-time-reduced target even when the reduction above didn't just run,
  // since a prior pass already left minValue at the reduced figure. Same
  // fingerprint idea as the 'existing' vs 'estimated' split in
  // re-enrich-jobs.mjs:978-1014, simplified to two states here since this
  // chokepoint never parses posting text.
  const estimatedFingerprintMin = reducedEstimate ? reducedEstimate.min : estimated.min;
  const estimatedFingerprintMax = reducedEstimate ? reducedEstimate.max : estimated.max;
  const isEstimateFingerprint =
    hasExisting && matchesEstimateFingerprint(existingMin, existingMax, estimatedFingerprintMin, estimatedFingerprintMax);
  const salarySource = hasExisting && !isEstimateFingerprint ? 'reported' : 'estimated';

  const currency = normalizeCurrency(job);
  const next = {
    ...job,
    salaryMin: minValue,
    salaryMax: maxValue,
    currency,
    salarySource,
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue,
        maxValue,
        unitText: 'YEAR',
      },
    },
  };

  const beforeSig = JSON.stringify({
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    currency: job.currency,
    salarySource: job.salarySource,
    baseSalary: job.baseSalary,
  });
  const afterSig = JSON.stringify({
    salaryMin: next.salaryMin,
    salaryMax: next.salaryMax,
    currency: next.currency,
    salarySource: next.salarySource,
    baseSalary: next.baseSalary,
  });

  return {
    job: next,
    changed: beforeSig !== afterSig,
  };
}

export function hardenJobsWithStructuredSalary(jobs) {
  if (!Array.isArray(jobs)) {
    return { jobs, changed: false, updated: 0, total: 0 };
  }

  let changed = false;
  let updated = 0;
  const hardened = jobs.map((job) => {
    const result = ensureStructuredSalary(job);
    if (result.changed) {
      changed = true;
      updated += 1;
    }
    return result.job;
  });

  return {
    jobs: hardened,
    changed,
    updated,
    total: hardened.length,
  };
}
