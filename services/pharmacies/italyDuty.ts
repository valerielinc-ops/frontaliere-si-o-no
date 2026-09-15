import italyDutiesJson from '../../data/pharmacy-duties-italy.json';
import italyStatusJson from '../../data/pharmacy-duties-italy-status.json';
import italyCatalogueJson from '../../data/pharmacies-italy-border.json';
import { formatDutyDateTimeInTimezone } from './dutyWeek';
import {
  evaluateItalyDutyRelease,
  ITALY_DUTY_RELEASE_MAX_AGE_MS,
  ITALY_DUTY_RELEASE_TIMEZONE,
  type ItalyDutyProvince,
  type ItalyDutyProvinceCoverage,
  type ItalyDutyProvinceFreshness,
  type ItalyDutyReleaseState,
  type ItalyDutySnapshot,
} from './italyRelease';
import type { PharmacyDuty } from './types';

export const ITALY_DUTY_WEEK_TIMEZONE = ITALY_DUTY_RELEASE_TIMEZONE;

export const ITALY_DUTY_PROVINCES = Object.freeze([
  { code: 'CO', name: 'Como' },
  { code: 'VA', name: 'Varese' },
  { code: 'VB', name: 'Verbano-Cusio-Ossola' },
] as const);

const DEFAULT_DUTIES = italyDutiesJson as unknown as ItalyDutySnapshot;
const DEFAULT_STATUS = italyStatusJson as unknown as ItalyDutySnapshot;
const DEFAULT_PHARMACY_IDS = new Set(italyCatalogueJson.pharmacies.map((pharmacy) => pharmacy.id));

export interface ItalyDutyWeekProvince {
  code: ItalyDutyProvince;
  name: string;
  state: ItalyDutyReleaseState;
  freshness: ItalyDutyProvinceFreshness;
  coverage: ItalyDutyProvinceCoverage;
  dutyCount: number;
  sourceUrl: string | null;
  fetchedAt: string | null;
  duties: readonly PharmacyDuty[];
}

export interface ItalyDutyWeekModel {
  weekStart: string;
  weekEnd: string;
  timezone: typeof ITALY_DUTY_WEEK_TIMEZONE;
  releaseId: string | null;
  fetchedAt: string | null;
  state: ItalyDutyReleaseState;
  publishable: boolean;
  indexable: boolean;
  provinces: readonly ItalyDutyWeekProvince[];
  unresolvedPharmacyIds: readonly string[];
  reason: string;
}

export interface BuildItalyDutyWeekOptions {
  now?: Date;
  weekStart?: string;
  duties?: ItalyDutySnapshot;
  status?: ItalyDutySnapshot;
  maxAgeMs?: number;
  pharmacyIds?: ReadonlySet<string>;
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const ROME_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: ITALY_DUTY_WEEK_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function zonedDateTimeParts(value: Date): ZonedDateTimeParts {
  const parts = ROME_DATE_TIME_FORMATTER.formatToParts(value);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
    day: Number(parts.find((part) => part.type === 'day')?.value),
    hour: Number(parts.find((part) => part.type === 'hour')?.value),
    minute: Number(parts.find((part) => part.type === 'minute')?.value),
    second: Number(parts.find((part) => part.type === 'second')?.value),
  };
}

function dateKeyParts(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? [year, month, day]
    : null;
}

function zonedMidnight(value: string): Date | null {
  const parts = dateKeyParts(value);
  if (!parts) return null;
  const [year, month, day] = parts;
  const localAsUtc = Date.UTC(year, month - 1, day);
  let candidate = new Date(localAsUtc);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = zonedDateTimeParts(candidate);
    const localAsUtcAtCandidate = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const offsetMs = localAsUtcAtCandidate - candidate.getTime();
    const next = new Date(localAsUtc - offsetMs);
    if (next.getTime() === candidate.getTime()) {
      const resolved = zonedDateTimeParts(next);
      return resolved.year === year
        && resolved.month === month
        && resolved.day === day
        && resolved.hour === 0
        && resolved.minute === 0
        && resolved.second === 0
        ? next
        : null;
    }
    candidate = next;
  }
  return null;
}

function addCalendarDays(value: string, days: number): string | null {
  const parts = dateKeyParts(value);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function weekStartDate(value: string): Date | null {
  const parts = dateKeyParts(value);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return date.getUTCDay() === 1 ? zonedMidnight(value) : null;
}

export function currentItalyDutyWeekStart(now: Date = new Date()): string {
  const local = zonedDateTimeParts(now);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function dutyIntersectsWeek(duty: PharmacyDuty, start: Date, end: Date): boolean {
  const startsAt = Date.parse(duty.startsAt);
  const endsAt = Date.parse(duty.endsAt);
  return Number.isFinite(startsAt)
    && Number.isFinite(endsAt)
    && endsAt > startsAt
    && endsAt > start.getTime()
    && startsAt < end.getTime();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function formatItalyDutyDateTime(iso: string): string {
  return formatDutyDateTimeInTimezone(iso, ITALY_DUTY_WEEK_TIMEZONE);
}

export function buildItalyDutyWeekModel(options: BuildItalyDutyWeekOptions = {}): ItalyDutyWeekModel {
  const now = options.now ?? new Date();
  const weekStart = options.weekStart ?? currentItalyDutyWeekStart(now);
  const start = weekStartDate(weekStart);
  const weekEnd = start ? addCalendarDays(weekStart, 7) : null;
  const end = weekEnd ? zonedMidnight(weekEnd) : null;
  const duties = options.duties ?? DEFAULT_DUTIES;
  const status = options.status ?? DEFAULT_STATUS;
  const evaluation = evaluateItalyDutyRelease({
    duties,
    status,
    now,
    maxAgeMs: options.maxAgeMs ?? ITALY_DUTY_RELEASE_MAX_AGE_MS,
  });
  const rawRows = recordOf(duties).duties;
  const validRows = evaluation.publishable && Array.isArray(rawRows) ? rawRows as PharmacyDuty[] : [];
  const weekRows = start && end
    ? validRows
      .filter((duty) => duty.status === 'verified' && dutyIntersectsWeek(duty, start, end))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    : [];
  const pharmacyIds = options.pharmacyIds ?? DEFAULT_PHARMACY_IDS;
  const unresolvedPharmacyIds = uniqueSorted(weekRows
    .filter((duty) => !pharmacyIds.has(duty.pharmacyId))
    .map((duty) => duty.pharmacyId));
  const publishable = evaluation.publishable && unresolvedPharmacyIds.length === 0;
  const reasons = [...evaluation.reasons];
  if (!start || !end) reasons.push('weekStart must be an ISO Monday');
  if (unresolvedPharmacyIds.length > 0) reasons.push(`unresolved Italian pharmacy ids: ${unresolvedPharmacyIds.join(', ')}`);

  const provinces = ITALY_DUTY_PROVINCES.map(({ code, name }) => {
    const province = evaluation.provinces[code];
    return {
      code,
      name,
      state: province.state,
      freshness: province.freshness,
      coverage: province.coverage,
      dutyCount: province.dutyCount,
      sourceUrl: publishable ? province.sourceUrl : null,
      fetchedAt: province.fetchedAt,
      duties: publishable ? weekRows.filter((duty) => duty.province === code) : [],
    };
  });
  const missingProvinces = provinces.filter((province) => province.duties.length === 0).map((province) => province.code);
  const indexable = publishable && Boolean(start && end) && missingProvinces.length === 0;
  if (publishable && missingProvinces.length > 0) reasons.push(`missing verified intervals: ${missingProvinces.join(', ')}`);
  if (!indexable && reasons.length === 0) reasons.push('Italy duty week is not indexable');

  return {
    weekStart,
    weekEnd: weekEnd ?? '',
    timezone: ITALY_DUTY_WEEK_TIMEZONE,
    releaseId: evaluation.releaseId,
    fetchedAt: evaluation.fetchedAt,
    state: evaluation.state,
    publishable,
    indexable,
    provinces,
    unresolvedPharmacyIds,
    reason: reasons.length > 0
      ? [...new Set(reasons)].join('; ')
      : 'all Italian duty provinces have a fresh, verified and indexable release',
  };
}
