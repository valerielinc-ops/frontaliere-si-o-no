const DECIMAL_EPOCH_MILLIS_RE = /^\d+$/;

/**
 * Returns true only for a finite, safe epoch-millisecond deadline in the future.
 * Corrupt storage must behave like an expired deadline so a prompt can recover.
 */
export function isFutureEpochMillis(raw: string | null | undefined, nowMs = Date.now()): boolean {
 if (typeof raw !== 'string' || !DECIMAL_EPOCH_MILLIS_RE.test(raw)) return false;
 const value = Number(raw);
 return Number.isSafeInteger(value) && value > nowMs;
}
