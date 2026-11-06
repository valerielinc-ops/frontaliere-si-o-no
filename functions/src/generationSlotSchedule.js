const SLOT_MINUTES = Object.freeze({ frontaliere: 7, svizzera: 37 });

export const GENERATION_SLOT_MAX_LATE_MINUTES = 13;
export const GENERATION_SLOT_SETTLE_MINUTES = 2;
export const GENERATION_SLOT_ENTRIES = Object.freeze([
  Object.freeze({
    id: 'corpus-generation-slot-frontaliere',
    repo: 'corpus',
    workflow: 'generate-article.yml',
    everyMinutes: 60,
    generationSlot: 'frontaliere',
  }),
  Object.freeze({
    id: 'corpus-generation-slot-svizzera',
    repo: 'corpus',
    workflow: 'generate-article.yml',
    everyMinutes: 60,
    generationSlot: 'svizzera',
  }),
]);

export function generationSlotMinute(section) {
  return SLOT_MINUTES[section] ?? null;
}

/**
 * Resolve the nominal UTC generation slot owned by this clock tick.
 * Cloud Scheduler ticks on five-minute boundaries; :10 and :40 own the :07
 * and :37 generation slots respectively. A bounded late window lets the next
 * two ticks recover one missed invocation without ever inventing a new slot.
 */
export function generationSlotDateForEntry(entry, scheduledAt, {
  maxLateMinutes = GENERATION_SLOT_MAX_LATE_MINUTES,
  settleMinutes = GENERATION_SLOT_SETTLE_MINUTES,
} = {}) {
  const minute = generationSlotMinute(entry?.generationSlot);
  const scheduled = scheduledAt instanceof Date ? new Date(scheduledAt.getTime()) : new Date(scheduledAt);
  if (minute === null || !Number.isFinite(scheduled.getTime())
    || !Number.isFinite(maxLateMinutes) || maxLateMinutes < 0
    || !Number.isFinite(settleMinutes) || settleMinutes < 0) return null;

  const tickMs = 5 * 60_000;
  const tick = new Date(Math.floor(scheduled.getTime() / tickMs) * tickMs);
  const nominal = new Date(tick.getTime());
  nominal.setUTCMinutes(minute, 0, 0);
  if (nominal.getTime() > tick.getTime()) nominal.setUTCHours(nominal.getUTCHours() - 1);

  const lateByMs = tick.getTime() - nominal.getTime();
  if (lateByMs < settleMinutes * 60_000 || lateByMs > maxLateMinutes * 60_000) return null;
  return nominal;
}

export function dueGenerationSlotEntries(scheduledAt) {
  return GENERATION_SLOT_ENTRIES.filter((entry) => generationSlotDateForEntry(entry, scheduledAt));
}
