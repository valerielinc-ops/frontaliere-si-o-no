/** Match the L3 handoff rule: an absolute HTTPS URL with a host. */
export function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Separate jobs with a publishable HTTPS application handoff from quarantined rows. */
export function partitionByHttpsApplyUrl(jobs) {
  const publishable = [];
  const quarantined = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    (isHttpsUrl(job?.applyUrl) ? publishable : quarantined).push(job);
  }
  return { publishable, quarantined };
}

/**
 * Prove deliberate quarantine only for prior rows observed again at their
 * official source without a verified HTTPS application destination. Rows
 * absent from the current observation are left to the normal source check.
 */
export function buildObservedHttpsApplyUrlHousekeepingProof({
  priorJobs = [],
  observedJobs = [],
  keyFor,
} = {}) {
  if (typeof keyFor !== 'function') {
    throw new TypeError('keyFor must identify the same posting across source observations');
  }

  const handoffByKey = new Map();
  for (const job of Array.isArray(observedJobs) ? observedJobs : []) {
    const key = String(keyFor(job) || '').trim();
    if (!key) continue;
    // A source-backed HTTPS handoff wins if duplicate source rows disagree.
    handoffByKey.set(key, Boolean(handoffByKey.get(key)) || isHttpsUrl(job?.applyUrl));
  }

  return (Array.isArray(priorJobs) ? priorJobs : [])
    .filter((job) => {
      const key = String(keyFor(job) || '').trim();
      return key && handoffByKey.has(key) && !handoffByKey.get(key);
    })
    .map((job) => ({
      job,
      reason: 'official source has no verified HTTPS application destination',
      definitive: true,
    }));
}
