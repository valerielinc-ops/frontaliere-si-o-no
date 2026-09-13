/**
 * Plate-auction domain types — shared contract between the per-canton
 * connectors (Grigioni/Vallese/Zurigo, with Ticino explicitly blocked) and the pages/classifiche that read
 * `data/plate-auction-sources-registry.json`. See #4854 → "Modello dati" for
 * the origin of `PlateAuction`; no auction data (prices, plates, winners) is
 * stored in the registry itself, only source configuration.
 */

export type PlateVehicleType = 'car' | 'motorcycle' | 'trailer' | 'other';

export type PlateAuctionStatus =
  | 'upcoming'
  | 'active'
  | 'closed'
  | 'sold'
  | 'unsold'
  | 'cancelled'
  | 'unknown';

/** The public catalogue may contain more than a live auction. */
export type PlateAuctionListingType =
  | 'auction'
  | 'fixed-price'
  | 'wanted'
  | 'future-registration';

export type PlateAuctionDataConfidence = 'verified' | 'partial' | 'unverified' | 'conflicting';

export interface PlateAuction {
  id: string;
  /** Stable source key, normally the canton BFS code in upper case. */
  sourceKey?: string;
  /** Identifier assigned by the canton platform, when the platform exposes one. */
  sourceRecordId?: string;
  canton: string;
  platePrefix: string;
  plateNumber: string;
  normalizedPlate: string;
  listingType?: PlateAuctionListingType;
  vehicleType?: PlateVehicleType;
  auctionStatus: PlateAuctionStatus;
  currentBidChf?: number;
  startingPriceChf?: number;
  finalPriceChf?: number;
  bidCount?: number;
  minimumIncrementChf?: number;
  startsAt?: string;
  endsAt?: string;
  closedAt?: string;
  officialAuctionUrl: string;
  /** Detail URL, distinct from the list/entry URL when available. */
  officialDetailUrl?: string;
  sourceFetchedAt: string;
  lastVerifiedAt: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** Set only after a closed result is read from an official source. */
  finalPriceVerifiedAt?: string;
  /** Optional source-local category or pattern, never a free-text bidder field. */
  sourceCategory?: string;
  platePattern?: string;
  dataConfidence: PlateAuctionDataConfidence;
  rawSnapshotHash: string;
}

export type PlateAuctionAccessMethod = 'html-scrape' | 'json-api' | 'pdf' | 'rss' | 'manual';

export type PlateAuctionSourceStatus =
  | 'unverified'
  | 'active'
  | 'blocked'
  | 'degraded'
  | 'not-discovered'
  | 'no-public-auction';

export interface PlateAuctionSourceEntry {
  canton: string;
  plateCode: string;
  officialUrl: string;
  accessMethod: PlateAuctionAccessMethod;
  fetchFrequency: string;
  timezone: string;
  parserVersion: string;
  availableFields: string[];
  rateLimit: string;
  termsOfUse: string;
  owner: string;
  status: PlateAuctionSourceStatus;
  /** Free-text discovery notes (e.g. what Fase 0 — AGENTS.md/#4854 — still needs to confirm). */
  notes?: string;
}

export interface PlateAuctionSourcesRegistry {
  generatedAt: string;
  sources: Record<string, PlateAuctionSourceEntry>;
}

const REQUIRED_STRING_FIELDS: readonly (keyof PlateAuctionSourceEntry)[] = [
  'canton',
  'plateCode',
  'officialUrl',
  'accessMethod',
  'fetchFrequency',
  'timezone',
  'parserVersion',
  'rateLimit',
  'termsOfUse',
  'owner',
  'status',
];

const ACCESS_METHODS: readonly PlateAuctionAccessMethod[] = ['html-scrape', 'json-api', 'pdf', 'rss', 'manual'];
const SOURCE_STATUSES: readonly PlateAuctionSourceStatus[] = [
  'unverified',
  'active',
  'blocked',
  'degraded',
  'not-discovered',
  'no-public-auction',
];

/**
 * Validates a `PlateAuctionSourceEntry` shape, returning the list of problems
 * found (empty = valid). Deliberately permissive on unknown extra fields —
 * it exists to catch incomplete entries, not to police the schema.
 */
export function validatePlateAuctionSourceEntry(key: string, entry: unknown): string[] {
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

  if (!Array.isArray(e.availableFields) || !e.availableFields.every((f) => typeof f === 'string')) {
    errors.push(`${key}: "availableFields" must be a string array`);
  }

  if (typeof e.accessMethod === 'string' && !ACCESS_METHODS.includes(e.accessMethod as PlateAuctionAccessMethod)) {
    errors.push(`${key}: invalid accessMethod "${e.accessMethod}"`);
  }

  if (typeof e.status === 'string' && !SOURCE_STATUSES.includes(e.status as PlateAuctionSourceStatus)) {
    errors.push(`${key}: invalid status "${e.status}"`);
  }

  return errors;
}

const REQUIRED_PLATE_AUCTION_STRING_FIELDS: readonly (keyof PlateAuction)[] = [
  'id',
  'canton',
  'platePrefix',
  'plateNumber',
  'normalizedPlate',
  'auctionStatus',
  'officialAuctionUrl',
  'sourceFetchedAt',
  'lastVerifiedAt',
  'dataConfidence',
  'rawSnapshotHash',
];

const AUCTION_STATUSES: readonly PlateAuctionStatus[] = [
  'upcoming',
  'active',
  'closed',
  'sold',
  'unsold',
  'cancelled',
  'unknown',
];

const DATA_CONFIDENCES: readonly PlateAuctionDataConfidence[] = [
  'verified',
  'partial',
  'unverified',
  'conflicting',
];

const OPTIONAL_NUMBER_FIELDS: readonly (keyof PlateAuction)[] = [
  'currentBidChf',
  'startingPriceChf',
  'finalPriceChf',
  'bidCount',
  'minimumIncrementChf',
];

const LISTING_TYPES: readonly PlateAuctionListingType[] = [
  'auction',
  'fixed-price',
  'wanted',
  'future-registration',
];

const VEHICLE_TYPES: readonly PlateVehicleType[] = ['car', 'motorcycle', 'trailer', 'other'];

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

/**
 * Validates a single connector-produced `PlateAuction` snapshot, returning
 * the list of problems found (empty = valid). Used by per-canton connector
 * tests (e.g. `tests/plate-auction-connector-vs.test.ts`) so a schema drift
 * in one connector's output fails loudly instead of silently reaching the
 * pages/classifiche that read it.
 */
export function validatePlateAuction(entry: unknown): string[] {
  const errors: string[] = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return ['entry is not an object'];
  }
  const e = entry as Record<string, unknown>;

  for (const field of REQUIRED_PLATE_AUCTION_STRING_FIELDS) {
    if (typeof e[field] !== 'string' || (e[field] as string).trim() === '') {
      errors.push(`missing or empty required field "${String(field)}"`);
    }
  }

  if (typeof e.auctionStatus === 'string' && !AUCTION_STATUSES.includes(e.auctionStatus as PlateAuctionStatus)) {
    errors.push(`invalid auctionStatus "${e.auctionStatus}"`);
  }

  if (
    typeof e.dataConfidence === 'string' &&
    !DATA_CONFIDENCES.includes(e.dataConfidence as PlateAuctionDataConfidence)
  ) {
    errors.push(`invalid dataConfidence "${e.dataConfidence}"`);
  }

  if (e.listingType !== undefined && (typeof e.listingType !== 'string' || !LISTING_TYPES.includes(e.listingType as PlateAuctionListingType))) {
    errors.push(`invalid listingType "${String(e.listingType)}"`);
  }
  if (e.vehicleType !== undefined && (typeof e.vehicleType !== 'string' || !VEHICLE_TYPES.includes(e.vehicleType as PlateVehicleType))) {
    errors.push(`invalid vehicleType "${String(e.vehicleType)}"`);
  }

  for (const field of OPTIONAL_NUMBER_FIELDS) {
    if (e[field] !== undefined && (typeof e[field] !== 'number' || !Number.isFinite(e[field] as number) || (e[field] as number) < 0)) {
      errors.push(`"${String(field)}" must be a finite non-negative number when present`);
    }
  }

  for (const field of ['sourceFetchedAt', 'lastVerifiedAt', 'startsAt', 'endsAt', 'closedAt', 'firstSeenAt', 'lastSeenAt', 'finalPriceVerifiedAt'] as const) {
    if (e[field] !== undefined && !isIsoDate(e[field])) errors.push(`"${field}" must be an ISO-compatible date when present`);
  }

  if (typeof e.officialAuctionUrl === 'string' && !/^https:\/\//i.test(e.officialAuctionUrl)) {
    errors.push('"officialAuctionUrl" must use https');
  }
  if (e.officialDetailUrl !== undefined && (typeof e.officialDetailUrl !== 'string' || !/^https:\/\//i.test(e.officialDetailUrl))) {
    errors.push('"officialDetailUrl" must use https when present');
  }
  if (typeof e.platePrefix === 'string' && typeof e.plateNumber === 'string' && typeof e.normalizedPlate === 'string') {
    const expected = `${e.platePrefix}${e.plateNumber}`.replace(/\s+/g, '').toUpperCase();
    if (e.normalizedPlate.replace(/\s+/g, '').toUpperCase() !== expected) {
      errors.push('"normalizedPlate" must match platePrefix + plateNumber');
    }
  }

  return errors;
}

/**
 * Validates a full `PlateAuctionSourcesRegistry` file, returning the list of
 * problems found across every entry (empty = valid).
 */
export function validatePlateAuctionSourcesRegistry(registry: unknown): string[] {
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
    return ['registry is not an object'];
  }
  const r = registry as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof r.generatedAt !== 'string' || r.generatedAt.trim() === '') {
    errors.push('missing or empty "generatedAt"');
  } else if (Number.isNaN(Date.parse(r.generatedAt))) {
    errors.push('"generatedAt" must be an ISO-compatible date');
  }
  if (typeof r.sources !== 'object' || r.sources === null || Array.isArray(r.sources)) {
    return [...errors, 'missing "sources" object'];
  }

  const sources = r.sources as Record<string, unknown>;
  if (Object.keys(sources).length === 0) {
    errors.push('"sources" has no entries');
  }
  const cantonCodes = new Set<string>();
  for (const [key, entry] of Object.entries(sources)) {
    errors.push(...validatePlateAuctionSourceEntry(key, entry));
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const code = String((entry as Record<string, unknown>).plateCode || '').trim().toUpperCase();
      if (code) {
        if (cantonCodes.has(code)) errors.push(`${key}: duplicate plateCode "${code}"`);
        cantonCodes.add(code);
      }
      const url = String((entry as Record<string, unknown>).officialUrl || '');
      if (url && !/^https:\/\//i.test(url)) errors.push(`${key}: officialUrl must use https`);
    }
  }

  return errors;
}
