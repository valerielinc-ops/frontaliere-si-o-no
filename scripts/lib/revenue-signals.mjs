/**
 * Pure detector for ad-revenue incidents, evaluated hourly on GA4 data
 * restricted to Italy + Switzerland to keep unrelated traffic out of the signal.
 *
 * Every signal is a RATIO of the same window, compared with the median of
 * the same hours on the same weekday 1, 2 and 3 weeks earlier: ratios survive
 * GA4's intraday lag (numerator and denominator arrive together) and weekday
 * matching absorbs the weekend and night shape.
 *
 * The CLI is scripts/monitor-revenue-signals.mjs, the workflow
 * .github/workflows/revenue-signal-monitor.yml.
 */

/** @typedef {{ sessions?: number, pageViews?: number, impressions?: number, revenue?: number, ad_filled?: number, ad_consent_granted?: number, ad_consent_denied?: number }} HourCounts */

export const GA4_FRESHNESS_SIGNAL = 'ga4_freshness';

export const DEFAULT_CONFIG = Object.freeze({
  // The current hour and the previous one are still partial, so the events
  // window ends 2 h back. GA4 freshness is checked from returned rows, not
  // from this window's end or a guessed fixed delay.
  eventsWindow: { from: 3, to: 2 },
  // publisherAdImpressions / totalAdRevenue come from the AdSense link and keep
  // growing for ~3 h: read them only on settled hours.
  revenueWindow: { from: 6, to: 4 },
  baselineWeeks: [1, 2, 3],
  minBaselineWeeks: 2,
  minPageViews: 200,
  minRevenuePageViews: 300,
  thresholds: { consent: 0.4, fill: 0.35, revenue: 0.5, traffic: 0.5 },
  // Require persistence for noisy ratios; consent changes are evaluated sooner.
  persistence: { consent: 1, fill: 2, revenue: 2, traffic: 2 },
  // The monitor closes its issue only after this many consecutive measured
  // hourly runs without an alarm: the backlog gets a day to verify the cause.
  recoveryRuns: 24,
  // A report with no newly processed hour beyond this age is a distinct GA4
  // freshness alarm, not a traffic-zero alarm.
  maxGa4AgeHours: 6,
});

/** Fixed title: the dedup in scripts/lib/github-issue-creator.mjs keys on its first 60 characters. */
export const ISSUE_TITLE = 'Revenue ads: segnali orari sotto la baseline IT+CH';

export const SIGNALS = Object.freeze({
  consent: {
    label: 'Decisioni sul consenso CMP per sessione',
    window: 'eventsWindow',
    digits: 3,
    num: (c) => (c.ad_consent_granted || 0) + (c.ad_consent_denied || 0),
    den: (c) => c.sessions || 0,
  },
  fill: {
    label: 'Annunci riempiti (ad_filled) per page view',
    window: 'eventsWindow',
    digits: 3,
    num: (c) => c.ad_filled || 0,
    den: (c) => c.pageViews || 0,
  },
  revenue: {
    label: 'Revenue AdSense per 1.000 page view (€)',
    window: 'revenueWindow',
    digits: 2,
    num: (c) => (c.revenue || 0) * 1000,
    den: (c) => c.pageViews || 0,
  },
  traffic: {
    label: 'Page view IT+CH per ora',
    window: 'eventsWindow',
    digits: 0,
    num: (c) => c.pageViews || 0,
    den: () => 1,
  },
});

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYYMMDDHH' (GA4 dateHour, property time zone) → Date at that wall-clock hour, UTC-based. */
export function parseDateHour(key) {
  return new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(8, 10)));
}

export function formatDateHour(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}`;
}

/** The GA4 dateHour of `date` in the property time zone (Europe/Zurich). */
export function dateHourInZone(date, timeZone = 'Europe/Zurich') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}`;
}

export function shiftDateHour(key, hours) {
  return formatDateHour(new Date(parseDateHour(key).getTime() + hours * 3_600_000));
}

/** The dateHour keys of a window that ends `to` hours and starts `from` hours before `currentHour`. */
export function windowKeys(currentHour, { from, to }, weeksBack = 0) {
  const keys = [];
  for (let back = from; back >= to; back--) keys.push(shiftDateHour(currentHour, -back - weeksBack * 168));
  return keys;
}

function hasHour(hours, key) {
  return Object.prototype.hasOwnProperty.call(hours, key);
}

export function latestAvailableHour(hours, currentHour) {
  return Object.keys(hours)
    .filter((key) => /^\d{10}$/.test(key) && (!currentHour || key <= currentHour))
    .sort()
    .at(-1) ?? null;
}

function sumWindow(hours, keys, signal) {
  let num = 0;
  let den = 0;
  let pageViews = 0;
  let completeHours = 0;
  for (const k of keys) {
    if (!hasHour(hours, k)) continue;
    const c = hours[k] || {};
    completeHours++;
    num += signal.num(c);
    den += signal.den(c);
    pageViews += c.pageViews || 0;
  }
  return { num, den, pageViews, completeHours, expectedHours: keys.length, value: den > 0 ? num / den : null };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param {{ hours: Record<string, HourCounts>, currentHour: string, config?: typeof DEFAULT_CONFIG }} input
 * `currentHour` is the hour the run happens in (still incomplete).
 * @returns {{ currentHour: string, alarms: object[], checks: object[] }}
 */
function checkSignal(hours, currentHour, name, config) {
  const signal = SIGNALS[name];
  const win = config[signal.window];
  const minPv = signal.window === 'revenueWindow' ? config.minRevenuePageViews : config.minPageViews;
  const keys = windowKeys(currentHour, win);
  const current = sumWindow(hours, keys, signal);
  const weeks = config.baselineWeeks
    .map((w) => sumWindow(hours, windowKeys(currentHour, win, w), signal))
    .filter((b) => b.completeHours === b.expectedHours && b.value !== null && b.pageViews >= minPv);
  const check = {
    signal: name,
    label: signal.label,
    window: [keys[0], keys[keys.length - 1]],
    current: current.value,
    pageViews: current.pageViews,
    completeHours: current.completeHours,
    expectedHours: current.expectedHours,
    missingHours: keys.filter((key) => !hasHour(hours, key)),
    baselineWeeks: weeks.length,
  };
  if (current.completeHours === 0) return { ...check, status: 'pending' };
  if (current.completeHours < current.expectedHours) return { ...check, status: 'incomplete' };
  // Low volume is a property of the SLOT, not of the current window: a night
  // hour is skipped because its baseline is thin too. A daytime slot that
  // drops to zero is the outage itself (site down, tag broken), so traffic is
  // judged anyway; the per-page ratios have no denominator left to judge.
  if (weeks.length < config.minBaselineWeeks) return { ...check, status: current.pageViews < minPv ? 'low_volume' : 'no_baseline' };
  if (current.pageViews < minPv && name !== 'traffic') return { ...check, status: 'low_volume' };
  const baseline = median(weeks.map((b) => b.value));
  const ratio = baseline > 0 ? current.value / baseline : null;
  const threshold = config.thresholds[name];
  return { ...check, baseline, ratio, threshold, status: ratio !== null && ratio < threshold ? 'below' : 'ok' };
}

function checkFreshness(hours, currentHour, config) {
  const latest = latestAvailableHour(hours, currentHour);
  const ageHours = latest === null ? null : (parseDateHour(currentHour).getTime() - parseDateHour(latest).getTime()) / 3_600_000;
  const fresh = ageHours !== null && ageHours <= config.maxGa4AgeHours;
  return {
    signal: GA4_FRESHNESS_SIGNAL,
    label: 'Freschezza dati GA4 (ore dall’ultima riga elaborata)',
    window: [latest || currentHour, latest || currentHour],
    current: ageHours,
    pageViews: null,
    latestAvailableHour: latest,
    ageHours,
    threshold: config.maxGa4AgeHours,
    status: fresh ? 'ok' : 'alarm',
  };
}

/**
 * @param {{ hours: Record<string, HourCounts>, currentHour: string, config?: typeof DEFAULT_CONFIG }} input
 * `currentHour` is the hour the run happens in (still incomplete).
 * A signal is an `alarm` when it is below its threshold in this run and in the
 * previous `persistence - 1` hourly runs, re-evaluated on the same data.
 * @returns {{ currentHour: string, alarms: object[], checks: object[] }}
 */
export function evaluateRevenueSignals({ hours, currentHour, config = DEFAULT_CONFIG }) {
  const signalChecks = Object.keys(SIGNALS).map((name) => {
    const check = checkSignal(hours, currentHour, name, config);
    if (check.status !== 'below') return check;
    const runs = config.persistence?.[name] ?? 1;
    for (let back = 1; back < runs; back++) {
      if (checkSignal(hours, shiftDateHour(currentHour, -back), name, config).status !== 'below') return { ...check, status: 'below_once' };
    }
    return { ...check, status: 'alarm' };
  });
  const freshness = checkFreshness(hours, currentHour, config);
  const checks = [...signalChecks, freshness];
  return { currentHour, latestAvailableHour: freshness.latestAvailableHour, freshness, alarms: checks.filter((c) => c.status === 'alarm'), checks };
}

/**
 * What the hourly run should do with the issue:
 * - `alarm`: open it, or comment on the open one (dedup on ISSUE_TITLE);
 * - `pending`/`incomplete`: GA4 has not completed the current window; this is neutral for
 *   recovery and does not open or resolve the issue;
 * - `watching`: no alarm now, but one in the last `recoveryRuns` runs, or a
 *   signal below threshold for its first run: leave it;
 * - `recovered`: no alarm in the last `recoveryRuns` runs, nothing below
 *   threshold now, and at least one signal measured: close it if open;
 * - `quiet`: nothing measurable (night volumes, missing baseline): do nothing.
 * Past runs are re-evaluated on the same data, so a skipped cron is not a gap.
 */
export function monitorDecision({ hours, currentHour, config = DEFAULT_CONFIG }) {
  const evaluation = evaluateRevenueSignals({ hours, currentHour, config });
  if (evaluation.alarms.length > 0) return { status: 'alarm', evaluation };
  const measured = (e) => e.checks.some((c) => SIGNALS[c.signal] && (c.status === 'ok' || c.status === 'below_once'));
  const pending = (e) => e.checks.some((c) => c.status === 'pending' || c.status === 'incomplete');
  let anyMeasured = measured(evaluation);
  let anyPending = pending(evaluation);
  for (let back = 1; back < config.recoveryRuns; back++) {
    const past = evaluateRevenueSignals({ hours, currentHour: shiftDateHour(currentHour, -back), config });
    if (past.alarms.length > 0) return { status: 'watching', evaluation, lastAlarmHour: past.currentHour };
    anyMeasured ||= measured(past);
    anyPending ||= pending(past);
  }
  // A signal on its way to an alarm is not a recovery.
  if (evaluation.checks.some((c) => c.status === 'below_once')) return { status: 'watching', evaluation, lastAlarmHour: null };
  // Pending/incomplete is neutral: do not close an issue while its recovery window is
  // not measurable. Once rows arrive, the same data is re-evaluated here.
  if (anyPending) return { status: 'pending', evaluation };
  return { status: anyMeasured ? 'recovered' : 'quiet', evaluation };
}

/** Issue body in the bl-planner card shape (.claude/agents/bl-planner.md): the consumer is the backlog loop. */
export function buildIssueBody({ decision, runUrl = '' }) {
  const { evaluation } = decision;
  const alarms = Array.isArray(evaluation.alarms) ? evaluation.alarms : [];
  const signals = [...new Set(alarms.map((alarm) => alarm.signal).filter((signal) => typeof signal === 'string'))];
  return [
    '<!-- revenue-signal-monitor -->',
    `A revenue-related monitoring alert was detected.${runUrl ? ` Workflow run: ${runUrl}` : ''}`,
    '',
    'Raw GA4 values, baselines, ratios, timestamps and diagnostics are withheld from this public issue.',
    'Review the underlying measurements only in an authorized private runtime.',
    signals.length ? `Signal categories: ${signals.join(', ')}.` : '',
    '',
    'SCHEDA: revenue-signal-monitor',
    '1-CAUSA: stato di allarme del monitor; i valori di misura restano privati.',
    '2-FIX: da decidere dopo una verifica privata della causa | REPO: sito | MODE: non-nel-manifest',
    '3-METRICA: verificare il monitor in un runtime autorizzato, senza pubblicare valori GA4 | COMANDO: `node scripts/monitor-revenue-signals.mjs`',
    // No workflow path here: check-workflows-scope.mjs reads the body to route the fixer.
    '4-OSSERVATORE: il workflow «Revenue signal monitor» (cron orario) — mantiene il ciclo di allarme e recupero senza esporre misure.',
    `5-FALLIMENTO: "${ISSUE_TITLE}"`,
    '',
    '## Suggested action',
    '- Review the alert using an authorized private analytics session; keep measurements out of public comments and artifacts.',
  ].join('\n');
}
