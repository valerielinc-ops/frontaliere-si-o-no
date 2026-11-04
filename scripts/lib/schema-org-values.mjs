const ITEM_AVAILABILITIES = new Set([
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

/** Normalize a Schema.org ItemAvailability value; reject unrelated URLs/names. */
export function normalizeSchemaOrgItemAvailability(value) {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (ITEM_AVAILABILITIES.has(raw)) return `https://schema.org/${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'schema.org' || url.port) return undefined;
  const member = url.pathname.replace(/^\/+|\/+$/gu, '');
  if (!ITEM_AVAILABILITIES.has(member) || url.search || url.hash) return undefined;
  return `https://schema.org/${member}`;
}

/** Return a valid ISO date/date-time, normalizing ISO offsets written without a colon. */
export function normalizeSchemaOrgDateTime(value) {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/iu.exec(normalized);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  if (hourText !== undefined) {
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText || 0);
    if (hour > 23 || minute > 59 || second > 59) return undefined;
  }
  if (offset && offset !== 'Z') {
    const [offsetHour, offsetMinute] = offset.slice(1).split(':').map(Number);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return undefined;
  }
  return normalized;
}
