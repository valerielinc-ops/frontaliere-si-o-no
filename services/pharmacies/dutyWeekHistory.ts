import { currentDutyWeekStart, DUTY_WEEK_REGIONS } from './dutyWeek';
import type { Locale } from '../i18n';
import { getPharmacyReleaseEvaluation } from './duties';
import { safePharmacyUrl, validatePharmacyDuty, validatePharmacyDutyList, type Pharmacy, type PharmacyCatalogueDataset, type PharmacyDuty, type PharmacyDutiesDataset } from './types';

export interface DutyWeekHistoryEntry {
  duty: PharmacyDuty;
  // Keep the identity actually present in this edition, not today's catalogue.
  pharmacy: Pick<Pharmacy, 'id' | 'name' | 'city' | 'sourceUrl'>;
}

export interface DutyWeekObservation {
  fetchedAt: string;
  catalogueFetchedAt: string;
  releaseId: string;
  snapshots: { catalogue: string; duties: string };
  sourceCommit?: string;
  sourceBlobs?: { catalogue: string; duties: string };
  entries: DutyWeekHistoryEntry[];
}

export interface DutyWeekHistory {
  version: 1;
  weekStart: string;
  observations: DutyWeekObservation[];
}

export function dutyWeekArchiveTitle(weekStart: string, locale: Locale): string {
  const titles = {
    it: 'Farmacie di turno in Ticino: archivio della settimana del',
    en: 'On-duty pharmacies in Ticino: archive for the week of',
    de: 'Notdienst-Apotheken im Tessin: Archiv der Woche ab',
    fr: 'Pharmacies de garde au Tessin : archives de la semaine du',
  };
  return `${titles[locale]} ${weekStart}`;
}

/** Keep the dated identity in compact SERP titles instead of truncating it. */
export function dutyWeekArchiveMetaTitle(weekStart: string, locale: Locale): string {
  const titles = { it: 'Archivio turni farmacie', en: 'Pharmacy duty archive', de: 'Apotheken-Notdienstarchiv', fr: 'Archives des gardes' };
  return `${titles[locale]}: ${weekStart}`;
}

export function isDutyWeekKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && currentDutyWeekStart(date) === value;
}

function dutyIntersectsWeek(duty: PharmacyDuty, weekStart: string): boolean {
  return currentDutyWeekStart(new Date(duty.startsAt)) <= weekStart
    && currentDutyWeekStart(new Date(Date.parse(duty.endsAt) - 1)) >= weekStart;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validTime = (value: unknown): value is string => nonEmpty(value) && Number.isFinite(Date.parse(value));

/** Historical observations are not a live release and can never grant availability. */
export function validateDutyWeekHistory(value: unknown): value is DutyWeekHistory {
  if (!value || typeof value !== 'object') return false;
  const doc = value as DutyWeekHistory;
  if (doc.version !== 1 || !isDutyWeekKey(doc.weekStart) || !Array.isArray(doc.observations) || !doc.observations.length) return false;
  return doc.observations.every((observation) => {
    if (!observation || !validTime(observation.fetchedAt) || !validTime(observation.catalogueFetchedAt)
      || !/^pharmacy-v1-[a-f0-9]{64}$/.test(observation.releaseId)
      || !/^[a-f0-9]{64}$/.test(observation.snapshots?.catalogue) || !/^[a-f0-9]{64}$/.test(observation.snapshots?.duties)
      || !Array.isArray(observation.entries) || !observation.entries.length) return false;
    if (observation.sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(observation.sourceCommit)) return false;
    if (observation.sourceBlobs !== undefined && (!/^[a-f0-9]{40}$/.test(observation.sourceBlobs?.catalogue) || !/^[a-f0-9]{40}$/.test(observation.sourceBlobs?.duties))) return false;
    // This clock validates an observation; it is never exposed as its fetch time.
    const clock = new Date(Math.max(Date.parse(observation.fetchedAt), Date.parse(observation.catalogueFetchedAt)));
    if (validatePharmacyDutyList(observation.entries.map((entry) => entry?.duty), clock).length > 0) return false;
    return observation.entries.every((entry) => {
      const duty = entry?.duty;
      const pharmacy = entry?.pharmacy;
      return duty && pharmacy && validatePharmacyDuty('history', duty, clock).length === 0
        && (duty.status === 'verified' || duty.status === 'expired')
        && duty.coverageType === 'region' && DUTY_WEEK_REGIONS.some((region) => region.name === duty.coverageName)
        && validTime(duty.fetchedAt) && Date.parse(duty.fetchedAt) <= clock.getTime()
        && (duty.verifiedAt === undefined || Date.parse(duty.verifiedAt) <= clock.getTime())
        && pharmacy.id === duty.pharmacyId && nonEmpty(pharmacy.name) && nonEmpty(pharmacy.city)
        && Boolean(safePharmacyUrl(pharmacy.sourceUrl)) && dutyIntersectsWeek(duty, doc.weekStart);
    });
  });
}

export function isClosedDutyWeek(weekStart: string, now = new Date()): boolean {
  return isDutyWeekKey(weekStart) && weekStart < currentDutyWeekStart(now);
}

export function resolveDutyWeekHistory(value: unknown, weekStart: string, now = new Date()): DutyWeekHistory | null {
  return validateDutyWeekHistory(value) && value.weekStart === weekStart && isClosedDutyWeek(weekStart, now)
    && value.observations.every((observation) => Math.max(Date.parse(observation.fetchedAt), Date.parse(observation.catalogueFetchedAt)) <= now.getTime())
    ? value : null;
}

/** Ignore fetch/verification clocks when identifying the same published assignment. */
function entryKey(entry: DutyWeekHistoryEntry): string {
  const { duty, pharmacy } = entry;
  return JSON.stringify([duty.id, duty.pharmacyId, duty.coverageName, duty.startsAt, duty.endsAt, duty.dutyType, duty.sourceUrl, duty.sourceType, pharmacy]);
}

/** Keep older rows when later source editions drop them; retain revisions separately. */
export function mergeDutyWeekHistory(previous: DutyWeekHistory | undefined, incoming: DutyWeekHistory): DutyWeekHistory {
  if (!validateDutyWeekHistory(incoming) || (previous && (!validateDutyWeekHistory(previous) || previous.weekStart !== incoming.weekStart))) {
    throw new Error('Invalid or mismatched pharmacy week history');
  }
  const observations: DutyWeekObservation[] = [];
  const seen = new Set<string>();
  for (const observation of [...(previous?.observations || []), ...incoming.observations]) {
    const entries = observation.entries.filter((entry) => {
      const key = entryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (entries.length) observations.push({ ...structuredClone(observation), entries });
  }
  return { version: 1, weekStart: incoming.weekStart, observations };
}

/** Called at collection time, while the original atomic pair is still verifiable. */
export function observeDutyWeeks(catalogue: PharmacyCatalogueDataset, duties: PharmacyDutiesDataset, now = new Date()): DutyWeekHistory[] {
  const evaluation = getPharmacyReleaseEvaluation(duties, now, catalogue, { validateEntries: true });
  if (!evaluation.publishable || evaluation.state !== 'fresh') {
    throw new Error(`Cannot archive pharmacy duty weeks: release is ${evaluation.state}, publishable=${evaluation.publishable}`);
  }
  const pharmacies = new Map(catalogue.pharmacies.map((pharmacy) => [pharmacy.id, pharmacy]));
  const byWeek = new Map<string, DutyWeekHistoryEntry[]>();
  for (const duty of duties.duties) {
    if ((duty.status !== 'verified' && duty.status !== 'expired') || duty.coverageType !== 'region'
      || !DUTY_WEEK_REGIONS.some((region) => region.name === duty.coverageName)) continue;
    const pharmacy = pharmacies.get(duty.pharmacyId);
    if (!pharmacy) throw new Error(`Unresolved historical pharmacy: ${duty.pharmacyId}`);
    const entry = { duty: structuredClone(duty), pharmacy: { id: pharmacy.id, name: pharmacy.name, city: pharmacy.city, sourceUrl: pharmacy.sourceUrl } };
    const lastWeek = currentDutyWeekStart(new Date(Date.parse(duty.endsAt) - 1));
    for (let week = currentDutyWeekStart(new Date(duty.startsAt)); week <= lastWeek;) {
      const entries = byWeek.get(week) || [];
      entries.push(entry);
      byWeek.set(week, entries);
      const next = new Date(`${week}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 7);
      week = next.toISOString().slice(0, 10);
    }
  }
  return [...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, entries]) => {
    const history: DutyWeekHistory = { version: 1, weekStart, observations: [{
      fetchedAt: duties._fetchedAt!, catalogueFetchedAt: catalogue._fetchedAt!, releaseId: evaluation.releaseId!,
      snapshots: { catalogue: duties._release!.snapshots.catalogue.sha256, duties: duties._release!.snapshots.duties.sha256 }, entries,
    }] };
    if (!validateDutyWeekHistory(history)) throw new Error(`Invalid pharmacy history observation: ${weekStart}`);
    return history;
  });
}
