/** Employer application deadline: validate independently of publication and allow future dates. */
export function normalizeSourceExpiryDate(input) {
  if (typeof input !== 'string') return '';
  const raw = input.trim().replace(/^(\d{4})\/(\d{2})\/(\d{2})$/, '$1-$2-$3');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(raw);
  if (!match) return '';
  const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (calendar.getUTCFullYear() !== Number(match[1]) || calendar.getUTCMonth() + 1 !== Number(match[2]) || calendar.getUTCDate() !== Number(match[3])) return '';
  if (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] || 0) > 59)) return '';
  return Number.isFinite(Date.parse(raw)) ? raw : '';
}
