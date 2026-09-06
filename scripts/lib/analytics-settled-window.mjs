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

/** `YYYY-MM-DD` in UTC (stesso output di `toISOString().slice(0, 10)`). */
export const fmtUtcDate = (d) => d.toISOString().slice(0, 10);

/**
 * Ultimo giorno considerato assestato rispetto a `now`.
 * @param {Date} [now]
 * @param {number} [lagDays]
 * @returns {Date}
 */
export function settledEndDate(now = new Date(), lagDays = ANALYTICS_PROCESSING_LAG_DAYS) {
  const end = new Date(now.getTime());
  end.setUTCDate(end.getUTCDate() - lagDays);
  return end;
}

/**
 * Finestra di `days` giornate consecutive che termina sull'ultimo giorno
 * assestato (estremi inclusi).
 * @param {{days?: number, now?: Date, lagDays?: number}} [opts]
 * @returns {{start: string, end: string}}
 */
export function settledWindow({ days = 7, now = new Date(), lagDays = ANALYTICS_PROCESSING_LAG_DAYS } = {}) {
  const end = settledEndDate(now, lagDays);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (Math.max(1, days) - 1));
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
