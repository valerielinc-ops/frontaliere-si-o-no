function utcDay(value) {
  return String(value || '').slice(0, 10);
}

function historyFor(spec, candidate, adapterVersionFor) {
  const history = Array.isArray(candidate?.validationHistory) ? candidate.validationHistory : [];
  const adapterVersion = adapterVersionFor?.(spec) || null;
  return adapterVersion
    ? history.filter((entry) => entry.sourceAdapterVersion === adapterVersion)
    : history.filter((entry) => !entry.sourceAdapterVersion);
}

function lastAt(spec, candidate, adapterVersionFor) {
  const history = historyFor(spec, candidate, adapterVersionFor);
  return String(history.at(-1)?.at || '');
}

/**
 * Order validation work without letting never-validated alphabetical entries
 * consume every slot while one-good-day candidates wait indefinitely for the
 * second, distinct-day observation.
 *
 * A quarter of the daily budget is reserved for candidates whose latest
 * complete result is their first good UTC day and which are now due for day 2.
 * Remaining slots preserve oldest-first fairness across unvalidated and
 * retryable candidates. Candidates with two good days stay in the background
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

  const compareOldest = (a, b) => lastAt(a, candidateForSpec(a), options.adapterVersionFor)
    .localeCompare(lastAt(b, candidateForSpec(b), options.adapterVersionFor))
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
