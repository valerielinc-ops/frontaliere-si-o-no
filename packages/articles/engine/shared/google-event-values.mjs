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

function eventDateTimestamp(value) {
  const trimmedValue = value.trim();
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(trimmedValue);
  const isDateTime = /^\d{4}-\d{2}-\d{2}T/iu.test(trimmedValue);
  const normalized = trimmedValue.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2');
  const utcValue = isDateTime && !hasExplicitTimezone ? `${normalized}Z` : normalized;
  return Date.parse(utcValue);
}

export function isValidEventDateRange(startDate, endDate) {
  if (typeof startDate !== 'string' || typeof endDate !== 'string') return false;
  const startTime = eventDateTimestamp(startDate);
  const endTime = eventDateTimestamp(endDate);
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime;
}
