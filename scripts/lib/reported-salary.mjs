/**
 * Returns an annual CHF range only when the source marked it as reported and
 * the values satisfy the same bounds used by realSalaryMedian.ts.
 */
export function reportedAnnualChfSalaryRange(job = {}) {
  const min = job.salaryMin;
  const max = job.salaryMax;
  if (
    job.salarySource !== 'reported'
    || String(job.currency || '').toUpperCase() !== 'CHF'
    || typeof min !== 'number' || !Number.isFinite(min)
    || typeof max !== 'number' || !Number.isFinite(max)
    || min < 20000 || max < min || max > 300000
  ) {
    return null;
  }

  return { min, max };
}

export function isReportedAnnualChfSalary(job = {}) {
  return reportedAnnualChfSalaryRange(job) !== null;
}
