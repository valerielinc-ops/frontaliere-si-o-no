import { ANALYTICS_PROCESSING_LAG_DAYS, settledWindow } from './analytics-settled-window.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value) {
  if (!DATE_RE.test(String(value ?? ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayAfter(value) {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Resolve a settled readout interval, never including the experiment launch day
 * or any earlier date. `experimentStart` is the server-only Remote Config date.
 */
export function resolveJobGateReadoutWindow(args, {
  experimentStart = null,
  defaultSince = null,
  now = new Date(),
  lagDays = ANALYTICS_PROCESSING_LAG_DAYS,
} = {}) {
  if (experimentStart != null && !isDateOnly(experimentStart)) {
    throw new Error(`Invalid jobgate launch date: ${experimentStart}`);
  }
  const earliestSince = experimentStart ? dayAfter(experimentStart) : defaultSince;
  if (earliestSince && !isDateOnly(earliestSince)) {
    throw new Error(`Invalid default analysis start: ${earliestSince}`);
  }

  if (args.days != null && args.since) {
    throw new Error('--since and --days are mutually exclusive; choose a fixed start date or a rolling window.');
  }

  if (args.days != null) {
    const days = Number(args.days);
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be an integer >= 1');
    const settled = settledWindow({ days, lagDays, now });
    const since = earliestSince && settled.start < earliestSince ? earliestSince : settled.start;
    const until = args.until || settled.end;
    if (!isDateOnly(until)) throw new Error('--until must be a real YYYY-MM-DD date');
    if (until < since) throw new Error(`--until ${until} precedes --since ${since} (no settled day in the window)`);
    return { since, until };
  }

  const since = args.since || (args.baseline ? null : earliestSince);
  if (!since || !isDateOnly(since)) throw new Error('serve --since YYYY-MM-DD (oppure --days N)');
  if (earliestSince && since < earliestSince) {
    throw new Error(`--since ${since} precedes the experiment analysis start ${earliestSince}`);
  }
  const until = args.until || settledWindow({ days: 1, lagDays, now }).end;
  if (!isDateOnly(until)) throw new Error('--until must be a real YYYY-MM-DD date');
  if (until < since) throw new Error(`--until ${until} precedes --since ${since} (no settled day in the window)`);
  return { since, until };
}
