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
  /** A source may explicitly publish a closed day instead of an interval. */
  isClosed?: boolean;
}

export type PharmacySourceType = 'official' | 'association' | 'pharmacy' | 'verified_partner' | 'directory';

export type PharmacyCountry = 'CH' | 'IT';

/** Status is field-level: an absent value is never rendered as if it were verified. */
export type PharmacyFieldStatus = 'verified' | 'not_published' | 'not_checked';

export interface PharmacyFieldSource {
  url: string;
  sourceType: PharmacySourceType;
  checkedAt: string;
  /** Required when the source is OpenStreetMap, whose derived data is ODbL. */
  license?: string;
}

export interface PharmacyDataAvailability {
  address?: PharmacyFieldStatus;
  phone?: PharmacyFieldStatus;
  website?: PharmacyFieldStatus;
  coordinates?: PharmacyFieldStatus;
  openingHours?: PharmacyFieldStatus;
  services?: PharmacyFieldStatus;
}

/**
 * A previously published detail URL that must keep resolving after an
 * official identity/locality correction. The importer records the old
 * province, city and slug so the build can emit a locale-aware redirect to
 * the current canonical page.
 */
export interface PharmacyUrlAlias {
  country: PharmacyCountry;
  province?: string;
  city: string;
  slug: string;
}

export interface Pharmacy {
  id: string;
  name: string;
  slug: string;
  address: string;
  postalCode: string;
  city: string;
  /** Present for Swiss records; Italian records use `province` and `region`. */
  canton?: string;
  country: PharmacyCountry;
  province?: string;
  region?: string;
  /** Stable identifier from the Italian Ministry of Health open dataset. */
  ministryId?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  website?: string;
  openingHours?: OpeningHours[];
  services?: string[];
  sourceUrl: string;
  sourceType: PharmacySourceType;
  lastVerifiedAt: string;
  /** Provenance for optional fields enriched from a second public source. */
  fieldSources?: Partial<Record<'address' | 'phone' | 'website' | 'coordinates' | 'openingHours' | 'services', PharmacyFieldSource>>;
  dataAvailability?: PharmacyDataAvailability;
  /** Historical detail URLs retained by the data pipeline for redirects. */
  urlAliases?: PharmacyUrlAlias[];
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

export interface PharmacyDutiesDataset {
  _source: string;
  _sourceRegions: string[];
  _fetchedAt: string | null;
  _lastSuccessfulFetchAt?: string | null;
  _errors: string[];
  _warnings: string[];
  _preservedRegions?: string[];
  duties: PharmacyDuty[];
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
  /** Canonical checked-in anagraphic snapshot when duties and identity use separate feeds. */
  anagraficaPath?: string;
  /** Official source URL for the canonical anagraphic snapshot. */
  anagraficaSourceUrl?: string;
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

/** Accept only absolute HTTPS URLs from public directory enrichment. */
export function safePharmacyUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

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

  if (typeof e.country === 'string' && !(['CH', 'IT'] as const).includes(e.country as PharmacyCountry)) {
    errors.push(`pharmacy[${index}]: invalid country "${e.country}" (expected "CH" or "IT")`);
  }

  if (e.country === 'CH' && (typeof e.canton !== 'string' || e.canton.trim() === '')) {
    errors.push(`pharmacy[${index}]: Swiss record must declare "canton"`);
  }
  if (e.country === 'IT' && (typeof e.province !== 'string' || !/^[A-Z]{2}$/.test(e.province))) {
    errors.push(`pharmacy[${index}]: Italian record must declare a two-letter "province"`);
  }

  for (const field of ['latitude', 'longitude'] as const) {
    if (e[field] !== undefined && (typeof e[field] !== 'number' || !Number.isFinite(e[field] as number))) {
      errors.push(`pharmacy[${index}]: invalid optional "${field}"`);
    }
  }

  if (e.dataAvailability !== undefined && (typeof e.dataAvailability !== 'object' || e.dataAvailability === null || Array.isArray(e.dataAvailability))) {
    errors.push(`pharmacy[${index}]: invalid optional "dataAvailability"`);
  }

  if (e.website !== undefined && !safePharmacyUrl(e.website)) {
    errors.push(`pharmacy[${index}]: invalid optional "website" (expected an absolute HTTPS URL)`);
  }

  if (e.urlAliases !== undefined && (!Array.isArray(e.urlAliases) || e.urlAliases.some((alias) => {
    if (typeof alias !== 'object' || alias === null || Array.isArray(alias)) return true;
    const candidate = alias as Record<string, unknown>;
    return !['CH', 'IT'].includes(String(candidate.country))
      || typeof candidate.city !== 'string'
      || !candidate.city.trim()
      || typeof candidate.slug !== 'string'
      || !candidate.slug.trim();
  }))) {
    errors.push(`pharmacy[${index}]: invalid optional "urlAliases"`);
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
  const seenSlugs = new Set<string>();
  pharmacies.forEach((entry, index) => {
    errors.push(...validatePharmacy(index, entry));
    const id = (entry as Record<string, unknown> | null)?.id;
    if (typeof id === 'string' && id) {
      if (seenIds.has(id)) errors.push(`pharmacy[${index}]: duplicate id "${id}"`);
      seenIds.add(id);
    }
    const slug = (entry as Record<string, unknown> | null)?.slug;
    if (typeof slug === 'string' && slug) {
      if (seenSlugs.has(slug)) errors.push(`pharmacy[${index}]: duplicate slug "${slug}"`);
      seenSlugs.add(slug);
    }
  });
  return errors;
}

const REQUIRED_DUTY_STRING_FIELDS: readonly (keyof PharmacyDuty)[] = [
  'id',
  'pharmacyId',
  'coverageType',
  'coverageName',
  'startsAt',
  'endsAt',
  'dutyType',
  'status',
  'sourceUrl',
  'sourceType',
  'fetchedAt',
];
const DUTY_COVERAGE_TYPES: readonly PharmacyDutyCoverageType[] = ['city', 'district', 'region', 'canton'];
const DUTY_TYPES: readonly PharmacyDutyType[] = ['day', 'night', 'weekend', 'holiday', '24h'];
const DUTY_STATUSES: readonly PharmacyDutyStatus[] = ['verified', 'pending_review', 'expired', 'conflicting'];
const DUTY_SOURCE_TYPES: readonly PharmacyDutySourceType[] = ['official', 'association', 'pharmacy', 'verified_partner'];

export function validatePharmacyDuty(index: number | string, entry: unknown): string[] {
  const errors: string[] = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`duty[${index}]: entry is not an object`];
  }
  const e = entry as Record<string, unknown>;
  for (const field of REQUIRED_DUTY_STRING_FIELDS) {
    if (typeof e[field] !== 'string' || (e[field] as string).trim() === '') {
      errors.push(`duty[${index}]: missing or empty required field "${field}"`);
    }
  }
  if (typeof e.coverageType === 'string' && !DUTY_COVERAGE_TYPES.includes(e.coverageType as PharmacyDutyCoverageType)) {
    errors.push(`duty[${index}]: invalid coverageType "${e.coverageType}"`);
  }
  if (typeof e.dutyType === 'string' && !DUTY_TYPES.includes(e.dutyType as PharmacyDutyType)) {
    errors.push(`duty[${index}]: invalid dutyType "${e.dutyType}"`);
  }
  if (typeof e.status === 'string' && !DUTY_STATUSES.includes(e.status as PharmacyDutyStatus)) {
    errors.push(`duty[${index}]: invalid status "${e.status}"`);
  }
  if (typeof e.sourceType === 'string' && !DUTY_SOURCE_TYPES.includes(e.sourceType as PharmacyDutySourceType)) {
    errors.push(`duty[${index}]: invalid sourceType "${e.sourceType}"`);
  }
  const starts = typeof e.startsAt === 'string' ? Date.parse(e.startsAt) : NaN;
  const ends = typeof e.endsAt === 'string' ? Date.parse(e.endsAt) : NaN;
  if (!Number.isFinite(starts)) errors.push(`duty[${index}]: invalid startsAt`);
  if (!Number.isFinite(ends)) errors.push(`duty[${index}]: invalid endsAt`);
  if (Number.isFinite(starts) && Number.isFinite(ends) && ends <= starts) {
    errors.push(`duty[${index}]: endsAt must be after startsAt`);
  }
  return errors;
}

export function validatePharmacyDutyList(duties: unknown): string[] {
  if (!Array.isArray(duties)) return ['duties: expected an array'];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  duties.forEach((entry, index) => {
    errors.push(...validatePharmacyDuty(index, entry));
    const id = (entry as Record<string, unknown> | null)?.id;
    if (typeof id === 'string' && id) {
      if (seenIds.has(id)) errors.push(`duty[${index}]: duplicate id "${id}"`);
      seenIds.add(id);
    }
  });
  return errors;
}

export function validatePharmacyDutiesDataset(dataset: unknown): string[] {
  if (typeof dataset !== 'object' || dataset === null || Array.isArray(dataset)) {
    return ['dataset is not an object'];
  }
  const d = dataset as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of ['_source', '_errors', '_warnings', 'duties'] as const) {
    if (!(field in d)) errors.push(`dataset: missing "${field}"`);
  }
  if (typeof d._source !== 'string' || d._source.trim() === '') errors.push('dataset: invalid "_source"');
  if (!Array.isArray(d._errors)) errors.push('dataset: "_errors" must be an array');
  if (!Array.isArray(d._warnings)) errors.push('dataset: "_warnings" must be an array');
  errors.push(...validatePharmacyDutyList(d.duties));
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
