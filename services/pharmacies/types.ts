/**
 * Pharmacy/pharmacy-duty domain types — shared contract between the future
 * per-canton connectors and the pages/hub that will read
 * `data/pharmacy-sources-registry.json`. `Pharmacy`/`PharmacyDuty` are lifted
 * verbatim from #6173 → "Modello dati proposto"; no pharmacy or duty data is
 * stored in the registry itself, only source configuration (#6397).
 */

export interface OpeningHours {
  dayOfWeek: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  opens: string;
  closes: string;
}

export type PharmacySourceType = 'official' | 'association' | 'pharmacy' | 'verified_partner' | 'directory';

export interface Pharmacy {
  id: string;
  name: string;
  slug: string;
  address: string;
  postalCode: string;
  city: string;
  canton: string;
  country: 'CH';
  latitude?: number;
  longitude?: number;
  phone?: string;
  website?: string;
  openingHours?: OpeningHours[];
  services?: string[];
  sourceUrl: string;
  sourceType: PharmacySourceType;
  lastVerifiedAt: string;
}

export type PharmacyDutyCoverageType = 'city' | 'district' | 'region' | 'canton';
export type PharmacyDutyType = 'day' | 'night' | 'weekend' | 'holiday' | '24h';
export type PharmacyDutyStatus = 'verified' | 'pending_review' | 'expired' | 'conflicting';
export type PharmacyDutySourceType = 'official' | 'association' | 'pharmacy' | 'verified_partner';

export interface PharmacyDuty {
  id: string;
  pharmacyId: string;
  coverageType: PharmacyDutyCoverageType;
  coverageName: string;
  startsAt: string;
  endsAt: string;
  dutyType: PharmacyDutyType;
  status: PharmacyDutyStatus;
  sourceUrl: string;
  sourceType: PharmacyDutySourceType;
  fetchedAt: string;
  verifiedAt?: string;
}

export type PharmacySourceAccessMethod = 'html-scrape' | 'json-api' | 'pdf' | 'rss' | 'manual';

export type PharmacySourceStatus = 'unverified' | 'active' | 'blocked' | 'degraded';

export interface PharmacySourceEntry {
  canton: string;
  officialSourceUrl: string;
  accessMethod: PharmacySourceAccessMethod;
  fetchFrequency: string;
  timezone: string;
  sourceType: PharmacySourceType;
  owner: string;
  status: PharmacySourceStatus;
  /** Free-text discovery notes (e.g. what's still unconfirmed for this canton). */
  notes?: string;
  /** ISO date/time the source config itself was last human-verified against the live site (distinct from `fetchedAt` on a `Pharmacy`/`PharmacyDuty` record, which is per-fetch). Optional: not every entry has been re-verified since creation. */
  lastVerifiedAt?: string;
  /** ISO date/time of the most recent successful fetch from `officialSourceUrl` by a connector. Optional: unset until a connector exists for this canton. */
  sourceFetchedAt?: string;
}

export interface PharmacySourcesRegistry {
  generatedAt: string;
  sources: Record<string, PharmacySourceEntry>;
}

/**
 * `/farmacie/` national coverage hub, per locale (#6399). Source of truth for
 * `build-plugins/pharmacyHubPlugin.ts`, which emits the page, and for
 * `services/router.ts`, which mirrors these four literals in its
 * `staticOverlay` routing (same pattern as `COMMUNICATIONS_PAGE_PATH` in
 * `services/communicationChannels.ts` — kept out of the build-only plugin
 * file so this lightweight domain module is what the client bundle pulls in).
 */
export const PHARMACY_HUB_PATH: Readonly<Record<'it' | 'en' | 'de' | 'fr', string>> = Object.freeze({
  it: '/farmacie/',
  en: '/en/pharmacies/',
  de: '/de/apotheken/',
  fr: '/fr/pharmacies/',
});

const REQUIRED_STRING_FIELDS: readonly (keyof PharmacySourceEntry)[] = [
  'canton',
  'officialSourceUrl',
  'accessMethod',
  'fetchFrequency',
  'timezone',
  'sourceType',
  'owner',
  'status',
];

const ACCESS_METHODS: readonly PharmacySourceAccessMethod[] = ['html-scrape', 'json-api', 'pdf', 'rss', 'manual'];
const SOURCE_TYPES: readonly PharmacySourceType[] = [
  'official',
  'association',
  'pharmacy',
  'verified_partner',
  'directory',
];
const SOURCE_STATUSES: readonly PharmacySourceStatus[] = ['unverified', 'active', 'blocked', 'degraded'];

/**
 * Validates a `PharmacySourceEntry` shape, returning the list of problems
 * found (empty = valid). Deliberately permissive on unknown extra fields —
 * it exists to catch incomplete entries, not to police the schema.
 */
export function validatePharmacySourceEntry(key: string, entry: unknown): string[] {
  const errors: string[] = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`${key}: entry is not an object`];
  }
  const e = entry as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof e[field] !== 'string' || (e[field] as string).trim() === '') {
      errors.push(`${key}: missing or empty required field "${field}"`);
    }
  }

  if (typeof e.accessMethod === 'string' && !ACCESS_METHODS.includes(e.accessMethod as PharmacySourceAccessMethod)) {
    errors.push(`${key}: invalid accessMethod "${e.accessMethod}"`);
  }

  if (typeof e.sourceType === 'string' && !SOURCE_TYPES.includes(e.sourceType as PharmacySourceType)) {
    errors.push(`${key}: invalid sourceType "${e.sourceType}"`);
  }

  if (typeof e.status === 'string' && !SOURCE_STATUSES.includes(e.status as PharmacySourceStatus)) {
    errors.push(`${key}: invalid status "${e.status}"`);
  }

  return errors;
}

const REQUIRED_PHARMACY_STRING_FIELDS: readonly (keyof Pharmacy)[] = [
  'id',
  'name',
  'slug',
  'address',
  'postalCode',
  'city',
  'canton',
  'country',
  'sourceUrl',
  'sourceType',
  'lastVerifiedAt',
];

/**
 * Validates a `Pharmacy` shape, returning the list of problems found (empty
 * = valid). Deliberately permissive on unknown extra fields.
 */
export function validatePharmacy(index: number | string, entry: unknown): string[] {
  const errors: string[] = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`pharmacy[${index}]: entry is not an object`];
  }
  const e = entry as Record<string, unknown>;

  for (const field of REQUIRED_PHARMACY_STRING_FIELDS) {
    if (typeof e[field] !== 'string' || (e[field] as string).trim() === '') {
      errors.push(`pharmacy[${index}]: missing or empty required field "${field}"`);
    }
  }

  if (typeof e.country === 'string' && e.country !== 'CH') {
    errors.push(`pharmacy[${index}]: invalid country "${e.country}" (expected "CH")`);
  }

  return errors;
}

/**
 * Validates a full list of `Pharmacy` records, returning the list of
 * problems found across every entry (empty = valid).
 */
export function validatePharmacyList(pharmacies: unknown): string[] {
  if (!Array.isArray(pharmacies)) {
    return ['pharmacies: expected an array'];
  }
  const errors: string[] = [];
  const seenIds = new Set<string>();
  pharmacies.forEach((entry, index) => {
    errors.push(...validatePharmacy(index, entry));
    const id = (entry as Record<string, unknown> | null)?.id;
    if (typeof id === 'string' && id) {
      if (seenIds.has(id)) errors.push(`pharmacy[${index}]: duplicate id "${id}"`);
      seenIds.add(id);
    }
  });
  return errors;
}

/**
 * Validates a full `PharmacySourcesRegistry` file, returning the list of
 * problems found across every entry (empty = valid).
 */
export function validatePharmacySourcesRegistry(registry: unknown): string[] {
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
    return ['registry is not an object'];
  }
  const r = registry as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof r.generatedAt !== 'string' || r.generatedAt.trim() === '') {
    errors.push('missing or empty "generatedAt"');
  }
  if (typeof r.sources !== 'object' || r.sources === null || Array.isArray(r.sources)) {
    return [...errors, 'missing "sources" object'];
  }

  const sources = r.sources as Record<string, unknown>;
  if (Object.keys(sources).length === 0) {
    errors.push('"sources" has no entries');
  }
  for (const [key, entry] of Object.entries(sources)) {
    errors.push(...validatePharmacySourceEntry(key, entry));
  }

  return errors;
}
