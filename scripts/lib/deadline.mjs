export function normalizeDeadlineMs(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeNonNegativeDeadlineMs(value) {
  const deadlineMs = normalizeDeadlineMs(value);
  return deadlineMs === null ? null : Math.max(0, deadlineMs);
}

export function effectiveDeadlineMs(value, reserveValue = 0) {
  const deadlineMs = normalizeDeadlineMs(value);
  if (deadlineMs === null) return null;
  const reserveMs = Number(reserveValue);
  const safeReserveMs = Number.isFinite(reserveMs) && reserveMs > 0 ? reserveMs : 0;
  return Math.max(0, deadlineMs - safeReserveMs);
}

export function remainingDeadlineMs(value) {
  const deadlineMs = normalizeDeadlineMs(value);
  if (deadlineMs === null) return null;
  return Math.floor(deadlineMs - Date.now());
}

export function timeoutWithinDeadline(value, maximumMs) {
  const maxMs = Math.max(0, Math.floor(Number(maximumMs) || 0));
  const remainingMs = remainingDeadlineMs(value);
  if (remainingMs === null) return maxMs;
  return Math.min(maxMs, Math.max(0, remainingMs));
}

export function hasDeadlineWindow(value, minimumMs = 0) {
  const deadlineMs = normalizeDeadlineMs(value);
  if (deadlineMs === null) return true;
  const minimum = Number(minimumMs);
  const safeMinimumMs = Number.isFinite(minimum) && minimum > 0 ? minimum : 0;
  return deadlineMs - Date.now() >= safeMinimumMs;
}
