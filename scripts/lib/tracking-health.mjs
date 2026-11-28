/**
 * Pure detector for a broken analytics tag: GA4 sessions or events fall by more
 * than 40% in an hour while Cloudflare still serves the same amount of human
 * page traffic.
 *
 * Why two sources: a GA4 drop alone is ambiguous (the site may really have lost
 * traffic, which scripts/lib/revenue-signals.mjs already judges against a
 * weekday baseline); a GA4 drop with stable edge traffic means the visitors are
 * there and the measurement is not. Cloudflare keeps ~3 days of hourly
 * analytics, so both sides are compared with the same hour 1 and 2 days
 * earlier (median), never with weekly baselines.
 *
 * GA4 intraday lag is NOT a zero (ga4_freshness, scripts/lib/revenue-signals.mjs):
 * a target hour is judged only when GA4 has already returned a LATER hour. If it
 * did and the target hour has no row, GA4 really recorded nothing for it (a
 * dead tag produces no row at all) and that counts as zero. If GA4 has not
 * reached a later hour the run is `pending`, a stale report is `pending` too:
 * the distinct freshness alarm belongs to the revenue monitor, not here.
 *
 * Both sides are keyed by the GA4 dateHour (Europe/Zurich wall clock,
 * YYYYMMDDHH), reusing the hour arithmetic of revenue-signals.mjs.
 *
 * CLI: scripts/monitor-tracking-health.mjs
 * Workflow: .github/workflows/tracking-health-monitor.yml
 */
import { dateHourInZone, latestAvailableHour, parseDateHour, shiftDateHour } from './revenue-signals.mjs';

/** @typedef {{ sessions?: number, events?: number }} Ga4Hour */

export const TRACKING_SIGNALS = Object.freeze({
  sessions: { label: 'Sessioni GA4 per ora', ga4: (h) => h.sessions || 0 },
  events: { label: 'Eventi GA4 per ora', ga4: (h) => h.events || 0 },
});

export const DEFAULT_CONFIG = Object.freeze({
  // The run happens in `currentHour` (still partial). The target hour is two
  // hours back so GA4 had time to process it; the hour before the current one
  // must already be returned for the report to count as fresh.
  targetLag: 2,
  // Same hour 1 and 2 days earlier: Cloudflare's free-plan retention is ~3 days.
  baselineDays: [1, 2],
  minBaselineDays: 2,
  // Slot volumes below these are noise (night hours): skipped, not judged.
  minBaselineGa4: 30,
  minBaselineCf: 100,
  // GA4 below this fraction of its baseline = a drop of more than 40%.
  maxGa4Ratio: 0.6,
  // Cloudflare at or above this fraction of its own baseline = traffic stable.
  minCfRatio: 0.8,
  // Past targets that must be clean before the issue is resolved.
  recoveryRuns: 3,
  // A report whose latest row is older than this is stale, not a tracking verdict.
  maxGa4AgeHours: 6,
});

/** Fixed title: the dedup in scripts/lib/github-issue-creator.mjs keys on its first 60 characters. */
export const ISSUE_TITLE = 'Tracking GA4: calo di sessioni o eventi con traffico edge stabile';
export const ISSUE_FAMILY_LABEL = 'tracking-health-monitor';

/** Cloudflare `datetimeHour` (UTC ISO) → GA4 dateHour key (Europe/Zurich). */
export function cfHourToDateHour(isoHour, timeZone = 'Europe/Zurich') {
  const t = Date.parse(isoHour);
  return Number.isFinite(t) ? dateHourInZone(new Date(t), timeZone) : null;
}

/** Cloudflare rows `{hour, count}` → `{ dateHour: requests }` (hours are summed when two UTC hours share a key). */
export function cfRowsToHours(rows) {
  const hours = {};
  for (const row of rows || []) {
    const key = cfHourToDateHour(row.hour);
    if (!key) continue;
    hours[key] = (hours[key] || 0) + (Number(row.count) || 0);
  }
  return hours;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ageHours(currentHour, latest) {
  return latest === null ? null : (parseDateHour(currentHour).getTime() - parseDateHour(latest).getTime()) / 3_600_000;
}

/**
 * One signal for one target hour.
 * Statuses: `ok`, `alarm`, `pending` (GA4 or Cloudflare not complete yet),
 * `no_baseline`, `low_volume`.
 */
function checkSignal({ name, ga4Hours, cfHours, currentHour, config }) {
  const signal = TRACKING_SIGNALS[name];
  const target = shiftDateHour(currentHour, -config.targetLag);
  const check = { signal: name, label: signal.label, hour: target };

  const latest = latestAvailableHour(ga4Hours, currentHour);
  const age = ageHours(currentHour, latest);
  // GA4 must have returned a later hour than the target: until then a missing
  // row is lag, not a zero.
  if (latest === null || latest <= target || age > config.maxGa4AgeHours) return { ...check, status: 'pending', reason: 'ga4_not_fresh' };
  if (!has(cfHours, target)) return { ...check, status: 'pending', reason: 'cloudflare_incomplete' };

  const ga4Now = has(ga4Hours, target) ? signal.ga4(ga4Hours[target]) : 0;
  const cfNow = cfHours[target];
  const baseGa4 = [];
  const baseCf = [];
  for (const days of config.baselineDays) {
    const key = shiftDateHour(target, -24 * days);
    if (!has(ga4Hours, key) || !has(cfHours, key)) continue;
    baseGa4.push(signal.ga4(ga4Hours[key]));
    baseCf.push(cfHours[key]);
  }
  if (baseGa4.length < config.minBaselineDays) return { ...check, status: 'no_baseline' };
  const ga4Base = median(baseGa4);
  const cfBase = median(baseCf);
  if (ga4Base < config.minBaselineGa4 || cfBase < config.minBaselineCf) return { ...check, status: 'low_volume' };
  const ga4Ratio = ga4Now / ga4Base;
  const cfRatio = cfNow / cfBase;
  const broken = ga4Ratio < config.maxGa4Ratio && cfRatio >= config.minCfRatio;
  return { ...check, status: broken ? 'alarm' : 'ok', ga4Ratio, cfRatio, ga4Missing: !has(ga4Hours, target) };
}

/**
 * @param {{ ga4Hours: Record<string, Ga4Hour>, cfHours: Record<string, number>, currentHour: string, config?: typeof DEFAULT_CONFIG }} input
 * @returns {{ currentHour: string, targetHour: string, latestGa4Hour: string|null, checks: object[], alarms: object[] }}
 */
export function evaluateTracking({ ga4Hours, cfHours, currentHour, config = DEFAULT_CONFIG }) {
  const checks = Object.keys(TRACKING_SIGNALS).map((name) => checkSignal({ name, ga4Hours, cfHours, currentHour, config }));
  return {
    currentHour,
    targetHour: shiftDateHour(currentHour, -config.targetLag),
    latestGa4Hour: latestAvailableHour(ga4Hours, currentHour),
    checks,
    alarms: checks.filter((c) => c.status === 'alarm'),
  };
}

/**
 * What the hourly run does with the issue:
 * - `alarm`: open or comment (dedup on ISSUE_TITLE);
 * - `pending`: GA4/Cloudflare not complete: neutral, neither open nor resolve;
 * - `watching`: an alarm within the last `recoveryRuns` targets: leave it;
 * - `recovered`: no alarm in those targets and one measured `ok`: resolve it;
 * - `quiet`: nothing judgeable (night volumes, no baseline): do nothing.
 * Past targets are re-evaluated on the same data, so a skipped cron is no gap.
 */
export function trackingDecision({ ga4Hours, cfHours, currentHour, config = DEFAULT_CONFIG }) {
  const evaluation = evaluateTracking({ ga4Hours, cfHours, currentHour, config });
  if (evaluation.alarms.length > 0) return { status: 'alarm', evaluation };
  const measured = (e) => e.checks.some((c) => c.status === 'ok');
  const pending = (e) => e.checks.some((c) => c.status === 'pending');
  let anyMeasured = measured(evaluation);
  let anyPending = pending(evaluation);
  for (let back = 1; back < config.recoveryRuns; back++) {
    const past = evaluateTracking({ ga4Hours, cfHours, currentHour: shiftDateHour(currentHour, -back), config });
    if (past.alarms.length > 0) return { status: 'watching', evaluation, lastAlarmHour: past.targetHour };
    anyMeasured ||= measured(past);
    anyPending ||= pending(past);
  }
  if (anyPending) return { status: 'pending', evaluation };
  return { status: anyMeasured ? 'recovered' : 'quiet', evaluation };
}

/** Oldest hour any evaluation reads: widest baseline behind the oldest recovery target. */
export function earliestHourNeeded(currentHour, config = DEFAULT_CONFIG) {
  return shiftDateHour(currentHour, -(config.targetLag + config.recoveryRuns - 1 + 24 * Math.max(...config.baselineDays)));
}

/** Issue body in the bl-planner card shape. Public repo: measurements stay private. */
export function buildIssueBody({ decision, runUrl = '' }) {
  const signals = [...new Set((decision.evaluation.alarms || []).map((a) => a.signal))];
  return [
    `<!-- ${ISSUE_FAMILY_LABEL} -->`,
    `Il tracking GA4 risulta interrotto o degradato mentre il traffico edge è stabile.${runUrl ? ` Workflow run: ${runUrl}` : ''}`,
    '',
    'Valori GA4/Cloudflare, rapporti e ore misurate restano fuori da questa issue pubblica: verificarli solo in un runtime autorizzato.',
    signals.length ? `Segnali in allarme: ${signals.join(', ')}.` : '',
    '',
    'SCHEDA: tracking-health-monitor',
    '1-CAUSA: le sessioni o gli eventi GA4 sono scesi di oltre il 40% rispetto a ieri e all altroieri alla stessa ora, mentre le pagine HTML servite da Cloudflare no: indizio di un tag rotto (script GA4, consenso, deploy del client), non di meno visitatori.',
    '2-FIX: da decidere dopo la verifica del tag in produzione (rete del browser verso GA4, console, ultimo deploy del client) | REPO: sito | MODE: non-nel-manifest',
    '3-METRICA: sessioni e eventi GA4 dell ora target tornano ad almeno il 60% della baseline con traffico edge stabile | COMANDO: `node scripts/monitor-tracking-health.mjs`',
    '4-OSSERVATORE: il workflow «Tracking health monitor» (cron orario): chiude questa issue dopo tre ore consecutive misurate senza allarme; un ritardo di GA4 resta neutro e non conta come zero.',
    `5-FALLIMENTO: "${ISSUE_TITLE}"`,
    '',
    '## Suggested action',
    '- Controllare in produzione che il tag GA4 parta (gtag/consenso) e correlare con l ultimo deploy; non pubblicare misure in questa issue.',
  ].join('\n');
}
