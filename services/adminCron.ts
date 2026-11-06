export const ADMIN_TIME_ZONE = 'Europe/Zurich';

export interface CronField {
  values: ReadonlySet<number>;
  wildcard: boolean;
}

export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  source: string;
}

export interface CronOccurrence {
  at: string;
  localLabel: string;
  cron: string;
}

const FIELD_LIMITS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

function rangeValues(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

function parseField(raw: string, index: number): CronField {
  const limits = FIELD_LIMITS[index];
  const source = raw.trim();
  if (!source) throw new Error(`Cron: campo ${index + 1} vuoto.`);
  const wildcard = source === '*' || source.startsWith('*/');
  const values = new Set<number>();

  for (const part of source.split(',')) {
    const [rangePart, stepText] = part.split('/');
    if (stepText !== undefined && (!/^\d+$/u.test(stepText) || Number(stepText) < 1)) {
      throw new Error(`Cron: passo non valido (${part}).`);
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    const normalizedRange = rangePart === '*' ? `${limits.min}-${limits.max}` : rangePart;
    const range = normalizedRange.split('-');
    if (range.length > 2 || !range.every((value) => /^\d+$/u.test(value))) {
      throw new Error(`Cron: intervallo non valido (${part}).`);
    }
    const start = Number(range[0]);
    const end = range.length === 2 ? Number(range[1]) : start;
    if (start < limits.min || end > limits.max || start > end) {
      throw new Error(`Cron: valore fuori intervallo (${part}).`);
    }
    for (const value of rangeValues(start, end, step)) values.add(index === 4 && value === 7 ? 0 : value);
  }

  if (values.size === 0) throw new Error(`Cron: campo senza valori (${source}).`);
  return { values, wildcard };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const source = String(expression || '').trim();
  const fields = source.split(/\s+/u);
  if (fields.length !== 5) throw new Error(`Cron: attesi 5 campi, ricevuti ${fields.length}.`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(parseField);
  return { minute, hour, dayOfMonth, month, dayOfWeek, source };
}

export function cronMatches(date: Date, expression: ParsedCronExpression | string): boolean {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(dayOfMonth);
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(dayOfWeek);
  const dayMatch = parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard
    ? true
    : parsed.dayOfMonth.wildcard
      ? dayOfWeekMatch
      : parsed.dayOfWeek.wildcard
        ? dayOfMonthMatch
        : dayOfMonthMatch || dayOfWeekMatch;
  return parsed.minute.values.has(minute)
    && parsed.hour.values.has(hour)
    && parsed.month.values.has(month)
    && dayMatch;
}

function partsForDate(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function localDateKey(date: Date, timeZone = ADMIN_TIME_ZONE): string {
  const parts = partsForDate(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatLocalDateTime(date: Date, timeZone = ADMIN_TIME_ZONE): string {
  return new Intl.DateTimeFormat('it-CH', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export function scheduledOccurrencesForLocalDay(
  expression: ParsedCronExpression | string,
  localDay: string | Date,
  timeZone = ADMIN_TIME_ZONE,
): Date[] {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const dayKey = typeof localDay === 'string' ? localDay : localDateKey(localDay, timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) throw new Error(`Giorno locale non valido: ${dayKey}.`);
  const [year, month, day] = dayKey.split('-').map(Number);
  const center = Date.UTC(year, month - 1, day);
  const matches: Date[] = [];
  // A Zurich civil day can cross a UTC date boundary and DST changes can
  // create 23 or 25 hours. The bounded 72-hour window is deliberately wider
  // than both cases and keeps the calculation independent of the host TZ.
  for (let timestamp = center - 36 * 60 * 60 * 1000; timestamp <= center + 36 * 60 * 60 * 1000; timestamp += 60 * 1000) {
    const candidate = new Date(timestamp);
    if (localDateKey(candidate, timeZone) === dayKey && cronMatches(candidate, parsed)) matches.push(candidate);
  }
  return matches;
}

export function describeCronForLocalDay(
  expression: ParsedCronExpression | string,
  localDay: string | Date,
  timeZone = ADMIN_TIME_ZONE,
): CronOccurrence[] {
  const source = typeof expression === 'string' ? expression : expression.source;
  return scheduledOccurrencesForLocalDay(expression, localDay, timeZone).map((date) => ({
    at: date.toISOString(),
    localLabel: formatLocalDateTime(date, timeZone),
    cron: source,
  }));
}
