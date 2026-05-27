import { estimateTicinoSalary } from './salary-estimation.mjs';

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundToHundreds(value) {
  return Math.max(1, Math.round(Number(value || 0) / 100) * 100);
}

function inferSalaryRange(job) {
  const estimated = estimateTicinoSalary(job);
  return {
    min: estimated.minValue,
    max: estimated.maxValue,
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
  const estimated = inferSalaryRange(job);
  const minValue = existingMin && existingMin > 0 ? existingMin : estimated.min;
  let maxValue = existingMax && existingMax >= minValue ? existingMax : null;

  if (!maxValue) {
    maxValue = roundToHundreds(Math.max(estimated.max, minValue * 1.2));
  }

  const currency = normalizeCurrency(job);
  const next = {
    ...job,
    salaryMin: minValue,
    salaryMax: maxValue,
    currency,
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
    baseSalary: job.baseSalary,
  });
  const afterSig = JSON.stringify({
    salaryMin: next.salaryMin,
    salaryMax: next.salaryMax,
    currency: next.currency,
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
