import catalogueJson from '../../data/pharmacies-ticino-complete.json';
import { getPharmacyReleaseEvaluation } from './duties';
import {
  validatePharmacyDutyList,
  validatePharmacyList,
  type PharmacyCatalogueDataset,
  type PharmacyDuty,
  type PharmacyDutiesDataset,
} from './types';

export const DUTY_WEEK_TIMEZONE = 'Europe/Zurich';
export const DUTY_WEEK_SOURCE_URL = 'https://www.ofct.ch/farmacieturno/';
export const DUTY_WEEK_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const DEFAULT_PHARMACY_CATALOGUE = catalogueJson as unknown as PharmacyCatalogueDataset;

export const DUTY_WEEK_REGIONS = Object.freeze([
  { key: 'mendrisiotto', name: 'Mendrisiotto' },
  { key: 'luganese', name: 'Luganese' },
  { key: 'bellinzonese', name: 'Bellinzonese' },
  { key: 'biasca-e-valli', name: 'Biasca e Valli' },
] as const);

export type DutyWeekStatus = 'ready' | 'stale' | 'partial' | 'unknown' | 'conflicting' | 'expired' | 'not_published';

export interface DutyWeekRegion {
  key: string;
  name: string;
  duties: PharmacyDuty[];
}

export interface DutyWeekModel {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  sourceUrl: string | null;
  fetchedAt: string | null;
  releaseId: string | null;
  status: DutyWeekStatus;
  indexable: boolean;
  regions: DutyWeekRegion[];
  missingRegions: string[];
  unresolvedPharmacyIds: string[];
  reason: string;
}

export interface BuildDutyWeekOptions {
  now?: Date;
  catalogue?: PharmacyCatalogueDataset;
  maxAgeMs?: number;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Reads the release identity from the P0 nested metadata block. */
export function snapshotReleaseId(snapshot: unknown): string | undefined {
  const record = recordOf(snapshot);
  const release = recordOf(record._release);
  return typeof release.releaseId === 'string' && release.releaseId.trim()
    ? release.releaseId.trim()
    : undefined;
}

function snapshotTimezone(snapshot: unknown): string {
  const record = recordOf(snapshot);
  const release = recordOf(record._release);
  return typeof release.timezone === 'string' && release.timezone.trim()
    ? release.timezone.trim()
    : '';
}

function dateKeyParts(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return [year, month, day];
}

const ZURICH_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUTY_WEEK_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedDateTimeParts(value: Date): ZonedDateTimeParts {
  const parts = ZURICH_DATE_TIME_FORMATTER.formatToParts(value);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
    day: Number(parts.find((part) => part.type === 'day')?.value),
    hour: Number(parts.find((part) => part.type === 'hour')?.value),
    minute: Number(parts.find((part) => part.type === 'minute')?.value),
    second: Number(parts.find((part) => part.type === 'second')?.value),
  };
}

/** Resolves a calendar date to midnight in Europe/Zurich, including DST. */
function zonedMidnight(value: string): Date | null {
  const parts = dateKeyParts(value);
  if (!parts) return null;
  const [year, month, day] = parts;
  const localAsUtc = Date.UTC(year, month - 1, day);
  let candidate = new Date(localAsUtc);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = zonedDateTimeParts(candidate);
    const localAsUtcAtCandidate = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
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

function weekStartDate(value: string): Date | null {
  const parts = dateKeyParts(value);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return date.getUTCDay() === 1 ? zonedMidnight(value) : null;
}

function keyForDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addCalendarDays(value: string, days: number): string | null {
  const parts = dateKeyParts(value);
  if (!parts) return null;
  const next = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  next.setUTCDate(next.getUTCDate() + days);
  return keyForDate(next);
}

function localDateParts(now: Date): { year: number; month: number; day: number } {
  const parts = zonedDateTimeParts(now);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

export function currentDutyWeekStart(now: Date = new Date()): string {
  const local = localDateParts(now);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return keyForDate(date);
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

/**
 * Builds the dated read model used by both the static page and the SPA.
 * A model is indexable only when catalogue and duty snapshots are the same
 * release, all four declared OFCT areas have verified intervals, and the
 * source fetch is fresh. Missing/old/preserved/conflicting data remains
 * inspectable but is explicitly non-indexable.
 */
export function buildDutyWeekModel(
  dataset: PharmacyDutiesDataset,
  weekStartKey: string,
  options: BuildDutyWeekOptions = {},
): DutyWeekModel {
  const start = weekStartDate(weekStartKey);
  const weekEndKey = start ? addCalendarDays(weekStartKey, 7) : null;
  const weekEndDate = weekEndKey ? zonedMidnight(weekEndKey) : null;
  const now = options.now || new Date();
  const record = recordOf(dataset);
  const sourceUrl = typeof record._source === 'string' && record._source.trim() ? record._source : null;
  const fetchedAt = typeof record._fetchedAt === 'string' && record._fetchedAt.trim() ? record._fetchedAt : null;
  const effectiveCatalogue = options.catalogue ?? DEFAULT_PHARMACY_CATALOGUE;
  const evaluation = getPharmacyReleaseEvaluation(dataset, now, effectiveCatalogue);
  const releaseId = evaluation.releaseId;
  const timezone = snapshotTimezone(dataset);
  const dutyEntryErrors = validatePharmacyDutyList(record.duties, now, { checkTemporalState: false });
  const catalogueEntryErrors = validatePharmacyList(recordOf(effectiveCatalogue).pharmacies);
  const duties = dutyEntryErrors.length === 0 && Array.isArray(record.duties)
    ? record.duties as PharmacyDuty[]
    : [];
  const cataloguePharmacyIds = catalogueEntryErrors.length === 0 && Array.isArray(effectiveCatalogue.pharmacies)
    ? new Set(effectiveCatalogue.pharmacies.map((pharmacy) => pharmacy.id))
    : undefined;
  const regions = DUTY_WEEK_REGIONS.map((region) => ({
    key: region.key,
    name: region.name,
    duties: start && weekEndDate
      ? duties
        .filter((duty) => duty.coverageName === region.name && duty.status === 'verified' && dutyIntersectsWeek(duty, start, weekEndDate))
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      : [],
  }));
  const missingRegions = regions.filter((region) => region.duties.length === 0).map((region) => region.name);
  const overlappingUnverified = start && weekEndDate
    ? duties.filter((duty) => dutyIntersectsWeek(duty, start, weekEndDate) && duty.status !== 'verified')
    : [];
  const unresolvedPharmacyIds = cataloguePharmacyIds
    ? uniqueSorted(regions.flatMap((region) => region.duties
      .filter((duty) => !cataloguePharmacyIds.has(duty.pharmacyId))
      .map((duty) => duty.pharmacyId)))
    : [];
  const reasons: string[] = [...evaluation.reasons];
  let status: DutyWeekStatus = evaluation.state === 'fresh' ? 'ready' : evaluation.state;
  const preserveFailClosedStatus = (fallback: DutyWeekStatus): DutyWeekStatus => (
    status === 'conflicting' || status === 'unknown' || status === 'not_published' ? status : fallback
  );
  if (!evaluation.publishable && evaluation.reasons.length === 0) {
    reasons.push('catalogue and duties release is not publishable');
  }

  if (!start) {
    status = 'unknown';
    reasons.push('weekStart must be an ISO Monday');
  }
  if (!sourceUrl) {
    status = 'unknown';
    reasons.push('duty source is missing');
  }
  if (!timezone) {
    status = status === 'conflicting' ? status : 'unknown';
    reasons.push('duty release timezone is missing');
  } else if (timezone !== DUTY_WEEK_TIMEZONE) {
    status = status === 'conflicting' ? status : 'unknown';
    reasons.push(`unsupported timezone ${timezone}`);
  }
  const parsedFetchedAt = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const maxAgeMs = options.maxAgeMs ?? DUTY_WEEK_MAX_AGE_MS;
  if (!Number.isFinite(parsedFetchedAt)) {
    status = preserveFailClosedStatus('stale');
    reasons.push('duty snapshot has no valid fetch timestamp');
  } else if (parsedFetchedAt < now.getTime() - maxAgeMs) {
    status = preserveFailClosedStatus('stale');
    reasons.push('duty snapshot is older than the freshness SLA');
  }
  if (Array.isArray(record._errors) && record._errors.length > 0) {
    status = preserveFailClosedStatus('partial');
    reasons.push('one or more duty regions failed to refresh');
  }
  if (Array.isArray(record._preservedRegions) && record._preservedRegions.length > 0) {
    status = preserveFailClosedStatus('partial');
    reasons.push('one or more duty regions use preserved data');
  }
  if (overlappingUnverified.length > 0) {
    status = 'conflicting';
    reasons.push('the week contains pending or conflicting duty intervals');
  }
  if (missingRegions.length > 0) {
    status = preserveFailClosedStatus('partial');
    reasons.push(`missing verified intervals: ${missingRegions.join(', ')}`);
  }
  if (unresolvedPharmacyIds.length > 0) {
    status = preserveFailClosedStatus('partial');
    reasons.push(`unresolved pharmacy ids: ${unresolvedPharmacyIds.join(', ')}`);
  }
  if (start && weekEndDate
    && weekEndDate.getTime() <= now.getTime()
    && missingRegions.length === DUTY_WEEK_REGIONS.length
    && status !== 'unknown'
    && status !== 'conflicting') {
    status = 'expired';
    reasons.push('the requested week has expired and has no verified intervals');
  }

  const indexable = evaluation.publishable
    && evaluation.state === 'fresh'
    && status === 'ready'
    && regions.every((region) => region.duties.length > 0);
  return {
    weekStart: weekStartKey,
    weekEnd: weekEndKey ?? '',
    timezone,
    sourceUrl,
    fetchedAt,
    releaseId,
    status: indexable ? 'ready' : status,
    indexable,
    regions,
    missingRegions,
    unresolvedPharmacyIds,
    reason: reasons.length > 0 ? reasons.join('; ') : 'all declared OFCT regions have fresh, verified data',
  };
}
