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

const SLOT_STEP_MS = 30 * 60 * 1000;
// Il buco più lungo del calendario è venerdì 17:30 → sabato 06:00 (12h30):
// una settimana di ricerca all'indietro copre ogni caso con ampio margine.
const MAX_LOOKBACK_SLOTS = 7 * 48;

export function toValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('scheduledAt must be a valid date');
  return date;
}

/**
 * Keep the existing UTC collection calendar while moving its clock from the
 * delayed GitHub scheduler to Cloud Scheduler.
 */
export function isTrafficCollectionSlot(scheduledAt) {
  const date = toValidDate(scheduledAt);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const weekend = day === 0 || day === 6;

  if (weekend) return minute === 0 && [6, 10, 14, 18].includes(hour);
  if (minute !== 0 && minute !== 30) return false;
  return (hour >= 4 && hour <= 7)
    || (hour === 11 && minute === 0)
    || (hour >= 14 && hour <= 17);
}

/**
 * Ultimo slot di raccolta del calendario a o prima di `at`.
 * @param {Date|string|number} at
 * @returns {Date|null} null solo se il calendario non ha slot nell'ultima settimana
 */
export function latestTrafficCollectionSlotAtOrBefore(at) {
  const date = toValidDate(at);
  // Gli slot cadono sempre su :00/:30 → parti dal mezz'ora pieno ≤ at.
  let slotMs = Math.floor(date.getTime() / SLOT_STEP_MS) * SLOT_STEP_MS;
  for (let i = 0; i <= MAX_LOOKBACK_SLOTS; i++, slotMs -= SLOT_STEP_MS) {
    if (isTrafficCollectionSlot(slotMs)) return new Date(slotMs);
  }
  return null;
}
