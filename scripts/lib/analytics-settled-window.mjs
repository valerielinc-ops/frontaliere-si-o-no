// Finestra ASSESTATA per i report analytics (GA4 / GSC / AdSense).
//
// Perché esiste (issue #7510): GA4 non ha finito di elaborare i giorni più
// freschi, e su quelli riporta engagement/bounce che contraddicono la durata
// media di sessione (il pattern misurato in `ga4-engagement-reliability.mjs`).
// `dailyEngagementConsistency()` marca l'INTERA finestra se anche UNA sola
// giornata è incoerente, quindi una finestra che finisce OGGI include per
// costruzione i giorni in lag 24-48h ed è quasi sempre inaffidabile: i
// consumer gateati da quel verdetto — le `highBouncePaths` di
// `analytics-report.mjs` — venivano soppressi in blocco, anche quando il
// bounce alto era genuino.
//
// La cura è chiudere la finestra sull'ultimo giorno assestato invece di
// sopprimere a valle. L'idioma esisteva già copiato a mano in mezzo repo
// (`revenue-monitor.mjs`, `perf-sources/safe.mjs`, i vari script GSC): qui
// vive una volta sola, così il lag è un numero solo e non deriva.

/** Giorni di ritardo di elaborazione oltre i quali il dato è considerato assestato. */
export const ANALYTICS_PROCESSING_LAG_DAYS = 2;

const MS_PER_UTC_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in UTC (stesso output di `toISOString().slice(0, 10)`). */
export const fmtUtcDate = (d) => d.toISOString().slice(0, 10);

function parseUtcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return fmtUtcDate(date) === value ? date : null;
}

/**
 * Count calendar days in an inclusive UTC date range.
 *
 * Returning null for malformed or reversed ranges keeps callers from
 * silently scaling a threshold from an invalid API response.
 * @param {string} startDate `YYYY-MM-DD`
 * @param {string} endDate `YYYY-MM-DD`
 * @returns {number|null}
 */
export function countInclusiveUtcDays(startDate, endDate) {
  const start = parseUtcDate(startDate);
  const end = parseUtcDate(endDate);
  if (!start || !end || end < start) return null;
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_UTC_DAY) + 1;
}

/**
 * Scale a session-count threshold to the actual duration of a queried window.
 *
 * Positive thresholds stay at least 1, and invalid window metadata falls back
 * to the configured base threshold rather than weakening the filter.
 * @param {number} baseThreshold
 * @param {number|null} referenceDays
 * @param {number|null} actualDays
 * @returns {number}
 */
export function scaleSessionThreshold(baseThreshold, referenceDays, actualDays) {
  const base = Number(baseThreshold);
  const fallback = Number.isFinite(base) ? Math.max(0, Math.ceil(base)) : 0;
  const reference = Number(referenceDays);
  const actual = Number(actualDays);
  if (
    !Number.isFinite(base)
    || !Number.isFinite(reference)
    || reference <= 0
    || !Number.isFinite(actual)
    || actual <= 0
  ) {
    return fallback;
  }
  return Math.max(base > 0 ? 1 : 0, Math.ceil(base * actual / reference));
}

/**
 * `date` spostata indietro di `days` giornate sul calendario UTC.
 *
 * Perché non `setDate`/`getDate` (issue #7694): quelli leggono e scrivono il
 * calendario LOCALE, mentre ogni data di questi report viene poi formattata in
 * UTC da `fmtUtcDate`. Con `TZ` non-UTC la differenza è invisibile finché non
 * cade un salto DST dentro la finestra: `setDate` conserva l'ora di parete
 * locale, quindi l'istante UTC scivola di un'ora e — se l'ora UTC è a ridosso
 * della mezzanotte — la data formattata scivola di un giorno. La finestra
 * interrogata smette di coincidere con quella dichiarata, e il confronto con
 * `settledEndDate()` (già UTC) confronta due calendari diversi.
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
export function utcDaysBefore(date, days) {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted;
}

/**
 * Ultimo giorno considerato assestato rispetto a `now`.
 * @param {Date} [now]
 * @param {number} [lagDays]
 * @returns {Date}
 */
export function settledEndDate(now = new Date(), lagDays = ANALYTICS_PROCESSING_LAG_DAYS) {
  return utcDaysBefore(now, lagDays);
}

/**
 * Finestra di `days` giornate consecutive che termina sull'ultimo giorno
 * assestato (estremi inclusi).
 * @param {{days?: number, now?: Date, lagDays?: number}} [opts]
 * @returns {{start: string, end: string}}
 */
export function settledWindow({ days = 7, now = new Date(), lagDays = ANALYTICS_PROCESSING_LAG_DAYS } = {}) {
  const end = settledEndDate(now, lagDays);
  const start = utcDaysBefore(end, Math.max(1, days) - 1);
  return { start: fmtUtcDate(start), end: fmtUtcDate(end) };
}

// La dimensione `date` di GA4 torna `YYYYMMDD`, le API GSC/AdSense `YYYY-MM-DD`:
// normalizzare a cifre rende i due formati confrontabili come stringhe.
const compact = (v) => (typeof v === 'string' ? v.replace(/-/g, '') : '');

/**
 * `true` se la giornata è al più l'ultimo giorno assestato. Una data assente o
 * malformata NON è assestata: un input che non sappiamo collocare non deve
 * entrare in un verdetto che dichiara un dato buono.
 * @param {string|undefined|null} date `YYYYMMDD` o `YYYY-MM-DD`
 */
export function isSettledDate(date, { now = new Date(), lagDays = ANALYTICS_PROCESSING_LAG_DAYS } = {}) {
  const d = compact(date);
  if (!/^\d{8}$/.test(d)) return false;
  return d <= compact(fmtUtcDate(settledEndDate(now, lagDays)));
}

/**
 * Sottoinsieme assestato di righe per-giorno (`{ date, ... }`).
 * @template {{date?: string}} T
 * @param {T[]} days
 * @returns {T[]}
 */
export function settledDays(days, opts) {
  return (Array.isArray(days) ? days : []).filter((d) => d && isSettledDate(d.date, opts));
}
