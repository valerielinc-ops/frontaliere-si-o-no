/**
 * trafficCollectionCalendar.js — calendario UTC delle raccolte traffico.
 *
 * Unica fonte di verità per gli slot in cui Cloud Scheduler
 * (`dispatchTrafficCollection` in functions/index.js) lancia
 * traffic-scheduler.yml, e per il controllo di freschezza che misura l'età dello
 * snapshot contro quello stesso calendario (`staleThresholdMinutesFor()` in
 * scripts/check-border-data-health.mjs, usato da traffic-data-freshness.yml).
 *
 * Modulo senza dipendenze: il controllo di freschezza gira con il Node del
 * runner senza `npm ci`, quindi non può importare trafficSchedulerDispatch.js
 * (che tira dentro firebase-admin tramite githubProxy.js).
 */

const SLOT_STEP_MS = 60 * 60 * 1000;
// Il buco più lungo del calendario è venerdì 17:00 → sabato 06:00 (13h):
// una settimana di ricerca all'indietro copre ogni caso con ampio margine.
const MAX_LOOKBACK_SLOTS = 7 * 24;

export function toValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('scheduledAt must be a valid date');
  return date;
}

/**
 * Keep the UTC collection calendar aligned with the routing quota budget while
 * Cloud Scheduler owns the clock for the existing GitHub workflow.
 */
export function isTrafficCollectionSlot(scheduledAt) {
  const date = toValidDate(scheduledAt);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const weekend = day === 0 || day === 6;

  if (weekend) return minute === 0 && [6, 10, 14, 18].includes(hour);
  if (minute !== 0) return false;
  return (hour >= 5 && hour <= 7)
    || hour === 11
    || (hour >= 14 && hour <= 17);
}

/**
 * Ultimo slot di raccolta del calendario a o prima di `at`.
 * @param {Date|string|number} at
 * @returns {Date|null} null solo se il calendario non ha slot nell'ultima settimana
 */
export function latestTrafficCollectionSlotAtOrBefore(at) {
  const date = toValidDate(at);
  // Gli slot cadono sempre allo scoccare dell'ora → parti dall'ora piena ≤ at.
  let slotMs = Math.floor(date.getTime() / SLOT_STEP_MS) * SLOT_STEP_MS;
  for (let i = 0; i <= MAX_LOOKBACK_SLOTS; i++, slotMs -= SLOT_STEP_MS) {
    if (isTrafficCollectionSlot(slotMs)) return new Date(slotMs);
  }
  return null;
}
