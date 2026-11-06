const EVENT_STATUSES = new Set([
  'EventCancelled',
  'EventMovedOnline',
  'EventPostponed',
  'EventRescheduled',
  'EventScheduled',
]);
const EVENT_ATTENDANCE_MODES = new Set([
  'OfflineEventAttendanceMode',
  'OnlineEventAttendanceMode',
  'MixedEventAttendanceMode',
]);
// The crawler preserves the complete Schema.org ItemAvailability vocabulary.
// Google Event structured data has a narrower documented contract, so keep its
// allowlist separate instead of making the publication gate accept every code.
export const SCHEMA_ORG_ITEM_AVAILABILITY_CODES = new Set([
  'BackOrder',
  'Discontinued',
  'InStock',
  'InStoreOnly',
  'LimitedAvailability',
  'MadeToOrder',
  'OnlineOnly',
  'OutOfStock',
  'PreOrder',
  'PreSale',
  'Reserved',
  'SoldOut',
]);
export const GOOGLE_EVENT_AVAILABILITY_CODES = new Set(['InStock', 'PreOrder', 'SoldOut']);

export function areSupportedGoogleEventStatuses(value) {
  const statuses = Array.isArray(value) ? value : [value];
  return statuses.length > 0 && statuses.every((status) => EVENT_STATUSES.has(status));
}

export function isSupportedGoogleEventAttendanceMode(value) {
  return EVENT_ATTENDANCE_MODES.has(value);
}

export function isGoogleEventStatusCompatible(status, attendanceMode) {
  const statuses = Array.isArray(status) ? status : [status];
  const attendanceModes = Array.isArray(attendanceMode) ? attendanceMode : [attendanceMode];
  return !statuses.includes('EventMovedOnline')
    || (attendanceModes.length === 1 && attendanceModes[0] === 'OnlineEventAttendanceMode');
}

function normalizedEventDate(value) {
  if (typeof value !== 'string') return undefined;
  const trimmedValue = value.trim();
  const normalized = trimmedValue.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(normalized);
  const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(normalized);
  const zonedDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized);
  if (!dateOnly && !localDateTime && !zonedDateTime) return undefined;

  // A timezone-free value has no recoverable wall-clock zone. Interpret a
  // homogeneous pair as UTC, but never compare it to an explicit offset: that
  // would invent a zone and can flip the range classification near midnight.
  const policy = zonedDateTime ? 'explicit-offset' : 'timezone-free-utc';
  const parseValue = zonedDateTime || dateOnly ? normalized : `${normalized}Z`;
  const timestamp = Date.parse(parseValue);
  if (!Number.isFinite(timestamp)) return undefined;
  return { normalized, policy, timestamp };
}

/**
 * Normalize an Event range under one timezone policy before comparing it.
 * Mixed timezone-free/explicit-offset pairs are unknown rather than guessed.
 */
export function normalizeEventDateRange(startDate, endDate) {
  const start = normalizedEventDate(startDate);
  const end = normalizedEventDate(endDate);
  if (!start || !end || start.policy !== end.policy) return undefined;
  return {
    startDate: start.normalized,
    endDate: end.normalized,
    startTime: start.timestamp,
    endTime: end.timestamp,
    policy: start.policy,
  };
}

export function isValidEventDateRange(startDate, endDate) {
  const range = normalizeEventDateRange(startDate, endDate);
  return Boolean(range && range.endTime >= range.startTime);
}
