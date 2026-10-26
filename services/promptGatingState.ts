const LOCAL_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Accept only canonical calendar dates, not merely date-shaped strings. */
export function isValidLocalDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !LOCAL_DAY_KEY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Normalize an untrusted persisted prompt counter to its integral cap range. */
export function clampPersistedPromptCounter(value: unknown, cap: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(cap, Math.max(0, Math.trunc(value)));
}
