import { qualityContractVersionOf } from './quality-contract.mjs';

function utcDay(value) {
  return String(value || '').slice(0, 10);
}

function historyFor(spec, candidate, adapterVersionFor) {
  const history = Array.isArray(candidate?.validationHistory) ? candidate.validationHistory : [];
  const adapterVersion = adapterVersionFor?.(spec) || null;
  const contractVersion = qualityContractVersionOf(spec);
  const currentContract = history.filter((entry) => qualityContractVersionOf(entry) === contractVersion);
  return adapterVersion
    ? currentContract.filter((entry) => entry.sourceAdapterVersion === adapterVersion)
    : currentContract.filter((entry) => !entry.sourceAdapterVersion);
}

function lastAt(spec, candidate, adapterVersionFor) {
  const history = historyFor(spec, candidate, adapterVersionFor);
  return String(history.at(-1)?.at || '');
}

function validationSortAt(spec, candidate, adapterVersionFor) {
  return lastAt(spec, candidate, adapterVersionFor)
    || String(candidate?.firstSeenAt || candidate?.updatedAt || spec?.firstSeenAt || spec?.updatedAt || '\uffff');
}

export const VALIDATION_RETRY_DELAYS_HOURS = Object.freeze({
  not_found: 72,
  dns: 6,
  rate_limited: 12,
  timeout: 6,
  pagination: 12,
  empty_listing: 24,
  runtime: 24,
});

/** Classify an incomplete runtime snapshot without retaining external payloads. */
export function classifyValidationFailure(report = {}) {
  const statuses = (report.samples || []).map((sample) => Number(sample?.status)).filter(Number.isFinite);
  const text = [
    report.runtimeObservation?.failure,
    ...(Array.isArray(report.runErrors) ? report.runErrors : []),
    ...((report.problems || []).slice(0, 3)),
  ].filter(Boolean).join(' ').toLowerCase();
  if (statuses.some((status) => status === 404 || status === 410) || /http[_ ]?(404|410)|not found|gone/.test(text)) return 'not_found';
  if (statuses.includes(429) || /rate.?limit|too many requests|http[_ ]?429/.test(text)) return 'rate_limited';
  if (/enotfound|eai_again|name_not_resolved|dns|resolve(host|d|ing)?/.test(text)) return 'dns';
  if (/timeout|timed out|aborterror|etimedout/.test(text)) return 'timeout';
  if (/pagination|page token|next page|cursor/.test(text)) return 'pagination';
  if (Number(report.vacancyCount) === 0) return 'empty_listing';
  return 'runtime';
}

export function validationRetryAt(category, at = Date.now()) {
  const delayHours = VALIDATION_RETRY_DELAYS_HOURS[category] ?? VALIDATION_RETRY_DELAYS_HOURS.runtime;
  const base = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return new Date(base + delayHours * 3_600_000).toISOString();
}

export function isValidationRetryDue(candidate, now = Date.now(), { qualityContractVersion, sourceAdapterVersion } = {}) {
  const history = Array.isArray(candidate?.validationHistory) ? candidate.validationHistory : [];
  const latest = history.filter((entry) =>
    (qualityContractVersion === undefined || qualityContractVersionOf(entry) === qualityContractVersion)
    && (sourceAdapterVersion === undefined
      ? !entry.sourceAdapterVersion
      : entry.sourceAdapterVersion === sourceAdapterVersion)).at(-1);
  if (latest?.runtimeSnapshotComplete !== false || !latest?.retryAfterAt) return true;
  const retryAt = Date.parse(latest.retryAfterAt);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return !Number.isFinite(retryAt) || retryAt <= nowMs;
}

/**
 * Production output is never downgraded by this audit. The audit only fills
 * missing current-contract evidence, requiring two complete good observations
 * on distinct UTC days before calling its evidence current and stable.
 */
export function needsProductionQualityAudit(spec, candidate, {
  date = new Date(),
  adapterVersionFor,
  minimumDays = 2,
} = {}) {
  const now = date instanceof Date ? date : new Date(date);
  const today = now.toISOString().slice(0, 10);
  const history = historyFor(spec, candidate, adapterVersionFor)
    .slice()
    .sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')));
  const latest = history.at(-1);
  const lastUnstableIndex = history.findLastIndex((entry) =>
    entry.runtimeSnapshotComplete !== true || entry.verdict !== 'good');
  const stabilityHistory = history.slice(lastUnstableIndex + 1);
  const goodDays = new Set(stabilityHistory
    .filter((entry) => entry.runtimeSnapshotComplete === true && entry.verdict === 'good')
    .map((entry) => utcDay(entry.at))
    .filter(Boolean));
  if (latest?.runtimeSnapshotComplete === true && latest.verdict === 'good'
    && goodDays.size >= minimumDays) return false;

  const retryAt = Date.parse(String(latest?.retryAfterAt || ''));
  if (latest?.runtimeSnapshotComplete === false && Number.isFinite(retryAt) && retryAt > now.getTime()) return false;
  if (latest && utcDay(latest.at) === today) return false;
  return true;
}

/** Rotate due production audits by their oldest current-contract observation. */
export function prioritizeProductionAuditSpecs(specs, candidateForSpec, options = {}) {
  const adapterVersionFor = options.adapterVersionFor;
  return specs.slice().sort((a, b) => {
    const aAt = lastAt(a, candidateForSpec(a), adapterVersionFor);
    const bAt = lastAt(b, candidateForSpec(b), adapterVersionFor);
    return aAt.localeCompare(bAt) || String(a.companyKey).localeCompare(String(b.companyKey));
  });
}

/**
 * Order validation work without letting never-validated alphabetical entries
 * consume every slot while one-good-day candidates wait indefinitely for the
 * second, distinct-day observation.
 *
 * A quarter of the daily budget is reserved for candidates whose latest
 * complete result is their first good UTC day and which are now due for day 2.
 * Remaining slots preserve oldest-first fairness across unvalidated and
 * retryable candidates, using first-seen time for candidates without history.
 * Candidates with two good days stay in the background
 * while unfinished candidates remain.
 *
 * @param {any[]} specs
 * @param {(spec: any) => any} candidateForSpec
 * @param {{ limit?: number, date?: Date|string|number, adapterVersionFor?: (spec: any) => string|null }} [options]
 * @returns {any[]}
 */
export function prioritizeValidationSpecs(specs, candidateForSpec, options = {}) {
  const limit = Math.max(0, Math.floor(Number(options.limit ?? specs.length) || 0));
  const now = options.date instanceof Date ? options.date : new Date(options.date ?? Date.now());
  const today = now.toISOString().slice(0, 10);
  const dueSecondDay = [];
  const retryable = [];
  const alreadyStable = [];

  for (const spec of specs) {
    const candidate = candidateForSpec(spec);
    const history = historyFor(spec, candidate, options.adapterVersionFor);
    const latestAttempt = history.at(-1);
    const retryAt = Date.parse(String(latestAttempt?.retryAfterAt || ''));
    if (latestAttempt?.runtimeSnapshotComplete === false
      && Number.isFinite(retryAt) && retryAt > now.getTime()) continue;
    const lastIncompleteIndex = history.findLastIndex((entry) => entry.runtimeSnapshotComplete === false);
    const stabilityHistory = history.slice(lastIncompleteIndex + 1);
    const latest = stabilityHistory.at(-1);
    const goodDays = new Set(stabilityHistory
      .filter((entry) => entry.verdict === 'good' && entry.runtimeSnapshotComplete !== false)
      .map((entry) => utcDay(entry.at))
      .filter(Boolean));

    if (latest?.verdict === 'good' && latest.runtimeSnapshotComplete !== false
      && goodDays.size === 1 && [...goodDays][0] !== today) {
      dueSecondDay.push(spec);
    } else if (latest?.verdict === 'good' && latest.runtimeSnapshotComplete !== false
      && (goodDays.size >= 2 || (goodDays.size === 1 && utcDay(latest.at) === today))) {
      alreadyStable.push(spec);
    } else {
      retryable.push(spec);
    }
  }

  const compareOldest = (a, b) => validationSortAt(a, candidateForSpec(a), options.adapterVersionFor)
    .localeCompare(validationSortAt(b, candidateForSpec(b), options.adapterVersionFor))
    || String(a.companyKey).localeCompare(String(b.companyKey));
  dueSecondDay.sort(compareOldest);
  retryable.sort(compareOldest);
  alreadyStable.sort(compareOldest);

  const reservedSlots = dueSecondDay.length
    ? Math.min(limit, Math.max(1, Math.ceil(limit * 0.25)))
    : 0;
  const reserved = dueSecondDay.slice(0, reservedSlots);
  const remaining = [
    ...retryable,
    ...dueSecondDay.slice(reservedSlots),
    ...alreadyStable,
  ];
  return [...reserved, ...remaining].slice(0, limit);
}
