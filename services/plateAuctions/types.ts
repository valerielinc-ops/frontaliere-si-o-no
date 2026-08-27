/**
 * Plate-auction domain types — shared contract between the per-canton
 * connectors (Ticino/Grigioni/Vallese) and the pages/classifiche that read
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

export type PlateAuctionDataConfidence = 'verified' | 'partial' | 'unverified' | 'conflicting';

export interface PlateAuction {
  id: string;
  canton: string;
  platePrefix: string;
  plateNumber: string;
  normalizedPlate: string;
  vehicleType?: PlateVehicleType;
  auctionStatus: PlateAuctionStatus;
  currentBidChf?: number;
  finalPriceChf?: number;
  bidCount?: number;
  minimumIncrementChf?: number;
  startsAt?: string;
  endsAt?: string;
  closedAt?: string;
  officialAuctionUrl: string;
  sourceFetchedAt: string;
  lastVerifiedAt: string;
  dataConfidence: PlateAuctionDataConfidence;
  rawSnapshotHash: string;
}

export type PlateAuctionAccessMethod = 'html-scrape' | 'json-api' | 'pdf' | 'rss' | 'manual';

export type PlateAuctionSourceStatus = 'unverified' | 'active' | 'blocked' | 'degraded';

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
const SOURCE_STATUSES: readonly PlateAuctionSourceStatus[] = ['unverified', 'active', 'blocked', 'degraded'];

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
  }
  if (typeof r.sources !== 'object' || r.sources === null || Array.isArray(r.sources)) {
    return [...errors, 'missing "sources" object'];
  }

  const sources = r.sources as Record<string, unknown>;
  if (Object.keys(sources).length === 0) {
    errors.push('"sources" has no entries');
  }
  for (const [key, entry] of Object.entries(sources)) {
    errors.push(...validatePlateAuctionSourceEntry(key, entry));
  }

  return errors;
}
