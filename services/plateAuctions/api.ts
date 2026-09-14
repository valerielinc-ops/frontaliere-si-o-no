import { FUNCTIONS_BASE } from '@/services/functionsBase';
import { cdnDataUrl } from '@/services/cdnDataBase';
import { articlesApiBase } from '@/services/runtimeArticleResolution';
import type {
  PlateAuction,
  PlateAuctionSourceEntry,
  PlateAuctionSourceStatus,
} from './types';
import { validatePlateAuction } from './types';

export const PLATE_AUCTION_API_SCHEMA = 1;

export interface PlateAuctionSourceSnapshot extends PlateAuctionSourceEntry {
  lastFetchedAt?: string;
  lastSuccessAt?: string;
  rowCount: number;
  errorCode?: string;
}

export interface PlateAuctionApiSnapshot {
  schema: typeof PLATE_AUCTION_API_SCHEMA;
  generatedAt: string;
  sources: Record<string, PlateAuctionSourceSnapshot>;
  auctions: PlateAuction[];
  /** Sanitized observation history; optional for static snapshots. */
  history?: PlateAuction[];
  counts: {
    active: number;
    upcoming: number;
    closed: number;
    finalsVerified: number;
    cantonsWithData: number;
  };
}

export type PlateAuctionEditorialStatus = 'ready' | 'insufficient-data' | 'unavailable';

export interface PlateAuctionEditorialHighlight {
  plate: string;
  canton?: string;
  listingType?: string;
  status?: string;
  currentPriceChf?: number;
  bidCount?: number;
  endsAt?: string;
  officialUrl?: string;
  confidence?: string;
}

export interface PlateAuctionEditorialBlock {
  status?: PlateAuctionEditorialStatus;
  slug?: string;
  kind?: string;
  title: string;
  excerpt: string;
  paragraphs: string[];
  bullets?: string[];
  highlights?: PlateAuctionEditorialHighlight[];
}

export interface PlateAuctionEditorialSnapshot {
  schema: 1;
  generatedAt: string;
  status: PlateAuctionEditorialStatus;
  source: {
    upstreamGeneratedAt: string | null;
    currentRows: number;
    historyRows: number;
    finalRows: number;
    cantons: number;
    errorCode?: string;
  };
  evergreen: Record<string, PlateAuctionEditorialBlock>;
  weekly: Record<string, PlateAuctionEditorialBlock>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Public response allow-list. In particular, no source-local bidder/winner
 * field is ever passed to React, even if a future connector accidentally
 * includes it in Firestore or its JSON response.
 */
export function sanitizePublicPlateAuction(value: unknown): PlateAuction | null {
  if (!isRecord(value)) return null;
  const candidate: PlateAuction = {
    id: String(value.id || ''),
    ...(value.sourceKey ? { sourceKey: String(value.sourceKey) } : {}),
    ...(value.sourceRecordId ? { sourceRecordId: String(value.sourceRecordId) } : {}),
    canton: String(value.canton || ''),
    platePrefix: String(value.platePrefix || ''),
    plateNumber: String(value.plateNumber || ''),
    normalizedPlate: String(value.normalizedPlate || ''),
    ...(value.listingType ? { listingType: value.listingType as PlateAuction['listingType'] } : {}),
    ...(value.vehicleType ? { vehicleType: value.vehicleType as PlateAuction['vehicleType'] } : {}),
    auctionStatus: value.auctionStatus as PlateAuction['auctionStatus'],
    ...(finiteOrUndefined(value.currentBidChf) !== undefined ? { currentBidChf: value.currentBidChf as number } : {}),
    ...(finiteOrUndefined(value.startingPriceChf) !== undefined ? { startingPriceChf: value.startingPriceChf as number } : {}),
    ...(finiteOrUndefined(value.finalPriceChf) !== undefined ? { finalPriceChf: value.finalPriceChf as number } : {}),
    ...(finiteOrUndefined(value.bidCount) !== undefined ? { bidCount: value.bidCount as number } : {}),
    ...(finiteOrUndefined(value.minimumIncrementChf) !== undefined ? { minimumIncrementChf: value.minimumIncrementChf as number } : {}),
    ...(value.startsAt ? { startsAt: String(value.startsAt) } : {}),
    ...(value.endsAt ? { endsAt: String(value.endsAt) } : {}),
    ...(value.closedAt ? { closedAt: String(value.closedAt) } : {}),
    officialAuctionUrl: String(value.officialAuctionUrl || ''),
    ...(value.officialDetailUrl ? { officialDetailUrl: String(value.officialDetailUrl) } : {}),
    sourceFetchedAt: String(value.sourceFetchedAt || ''),
    lastVerifiedAt: String(value.lastVerifiedAt || ''),
    ...(value.firstSeenAt ? { firstSeenAt: String(value.firstSeenAt) } : {}),
    ...(value.lastSeenAt ? { lastSeenAt: String(value.lastSeenAt) } : {}),
    ...(value.finalPriceVerifiedAt ? { finalPriceVerifiedAt: String(value.finalPriceVerifiedAt) } : {}),
    ...(value.sourceCategory ? { sourceCategory: String(value.sourceCategory) } : {}),
    ...(value.platePattern ? { platePattern: String(value.platePattern) } : {}),
    dataConfidence: value.dataConfidence as PlateAuction['dataConfidence'],
    rawSnapshotHash: String(value.rawSnapshotHash || ''),
  };
  return validatePlateAuction(candidate).length === 0 ? candidate : null;
}

function sanitizeSource(value: unknown): PlateAuctionSourceSnapshot | null {
  if (!isRecord(value)) return null;
  const required = ['canton', 'plateCode', 'officialUrl', 'accessMethod', 'fetchFrequency', 'timezone', 'parserVersion', 'rateLimit', 'termsOfUse', 'owner', 'status'];
  if (required.some((key) => typeof value[key] !== 'string')) return null;
  if (!/^https:\/\//i.test(value.officialUrl as string)) return null;
  const status = value.status as PlateAuctionSourceStatus;
  if (!['unverified', 'active', 'degraded', 'blocked', 'not-discovered', 'no-public-auction'].includes(status)) return null;
  if (!['html-scrape', 'json-api', 'pdf', 'rss', 'manual'].includes(value.accessMethod as string)) return null;
  const rowCount = finiteOrUndefined(value.rowCount);
  if (rowCount === undefined || rowCount < 0) return null;
  return {
    canton: value.canton as string,
    plateCode: value.plateCode as string,
    officialUrl: value.officialUrl as string,
    accessMethod: value.accessMethod as PlateAuctionSourceEntry['accessMethod'],
    fetchFrequency: value.fetchFrequency as string,
    timezone: value.timezone as string,
    parserVersion: value.parserVersion as string,
    availableFields: Array.isArray(value.availableFields) ? value.availableFields.filter((field): field is string => typeof field === 'string') : [],
    rateLimit: value.rateLimit as string,
    termsOfUse: value.termsOfUse as string,
    owner: value.owner as string,
    status,
    rowCount,
    ...(typeof value.lastFetchedAt === 'string' ? { lastFetchedAt: value.lastFetchedAt } : {}),
    ...(typeof value.lastSuccessAt === 'string' ? { lastSuccessAt: value.lastSuccessAt } : {}),
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
  };
}

function sanitizeEditorialBlock(value: unknown, { weekly = false } = {}): PlateAuctionEditorialBlock | null {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.excerpt !== 'string') return null;
  const paragraphs = Array.isArray(value.paragraphs) ? value.paragraphs.filter((item): item is string => typeof item === 'string') : [];
  if (paragraphs.length === 0) return null;
  const block: PlateAuctionEditorialBlock = {
    title: value.title,
    excerpt: value.excerpt,
    paragraphs,
    ...(typeof value.slug === 'string' ? { slug: value.slug } : {}),
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(Array.isArray(value.bullets) ? { bullets: value.bullets.filter((item): item is string => typeof item === 'string') } : {}),
  };
  if (weekly) {
    const status = value.status;
    if (status !== undefined && status !== 'ready' && status !== 'insufficient-data' && status !== 'unavailable') return null;
    block.status = status as PlateAuctionEditorialStatus | undefined;
    block.highlights = Array.isArray(value.highlights)
      ? value.highlights.filter(isRecord).map((item) => ({
        plate: typeof item.plate === 'string' ? item.plate : '',
        ...(typeof item.canton === 'string' ? { canton: item.canton } : {}),
        ...(typeof item.listingType === 'string' ? { listingType: item.listingType } : {}),
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        ...(finiteOrUndefined(item.currentPriceChf) !== undefined ? { currentPriceChf: finiteOrUndefined(item.currentPriceChf) } : {}),
        ...(finiteOrUndefined(item.bidCount) !== undefined ? { bidCount: finiteOrUndefined(item.bidCount) } : {}),
        ...(typeof item.endsAt === 'string' ? { endsAt: item.endsAt } : {}),
        ...(typeof item.officialUrl === 'string' && item.officialUrl.startsWith('https://') ? { officialUrl: item.officialUrl } : {}),
        ...(typeof item.confidence === 'string' ? { confidence: item.confidence } : {}),
      })).filter((item) => item.plate.length > 0)
      : [];
  }
  return block;
}

export function parsePlateAuctionEditorialSnapshot(value: unknown): PlateAuctionEditorialSnapshot | null {
  if (!isRecord(value) || value.schema !== PLATE_AUCTION_API_SCHEMA || typeof value.generatedAt !== 'string') return null;
  if (value.status !== 'ready' && value.status !== 'insufficient-data' && value.status !== 'unavailable') return null;
  if (!isRecord(value.source)) return null;
  const currentRows = finiteOrUndefined(value.source.currentRows);
  const historyRows = finiteOrUndefined(value.source.historyRows);
  const finalRows = finiteOrUndefined(value.source.finalRows);
  const cantons = finiteOrUndefined(value.source.cantons);
  if ([currentRows, historyRows, finalRows, cantons].some((item) => item === undefined || item < 0)) return null;
  const evergreen: Record<string, PlateAuctionEditorialBlock> = {};
  const weekly: Record<string, PlateAuctionEditorialBlock> = {};
  for (const [locale, raw] of Object.entries(isRecord(value.evergreen) ? value.evergreen : {})) {
    const block = sanitizeEditorialBlock(raw);
    if (block) evergreen[locale] = block;
  }
  for (const [locale, raw] of Object.entries(isRecord(value.weekly) ? value.weekly : {})) {
    const block = sanitizeEditorialBlock(raw, { weekly: true });
    if (block) weekly[locale] = block;
  }
  if (Object.keys(evergreen).length === 0 || Object.keys(weekly).length === 0) return null;
  return {
    schema: 1,
    generatedAt: value.generatedAt,
    status: value.status,
    source: {
      upstreamGeneratedAt: typeof value.source.upstreamGeneratedAt === 'string' ? value.source.upstreamGeneratedAt : null,
      currentRows,
      historyRows,
      finalRows,
      cantons,
      ...(typeof value.source.errorCode === 'string' ? { errorCode: value.source.errorCode } : {}),
    },
    evergreen,
    weekly,
  };
}

export function parsePlateAuctionApiSnapshot(value: unknown): PlateAuctionApiSnapshot {
  if (!isRecord(value) || value.schema !== PLATE_AUCTION_API_SCHEMA || typeof value.generatedAt !== 'string') {
    throw new Error('Invalid plate-auction API schema');
  }
  const auctions = Array.isArray(value.auctions)
    ? value.auctions.map(sanitizePublicPlateAuction).filter((item): item is PlateAuction => item !== null)
    : [];
  const history = Array.isArray(value.history)
    ? value.history.map(sanitizePublicPlateAuction).filter((item): item is PlateAuction => item !== null)
    : undefined;
  const sources: Record<string, PlateAuctionSourceSnapshot> = {};
  if (isRecord(value.sources)) {
    for (const [key, raw] of Object.entries(value.sources)) {
      const source = sanitizeSource(raw);
      if (source) sources[key] = source;
    }
  }
  const counts = {
    active: auctions.filter((auction) => auction.auctionStatus === 'active').length,
    upcoming: auctions.filter((auction) => auction.auctionStatus === 'upcoming').length,
    closed: auctions.filter((auction) => ['closed', 'sold', 'unsold'].includes(auction.auctionStatus)).length,
    finalsVerified: auctions.filter((auction) => ['closed', 'sold', 'unsold'].includes(auction.auctionStatus)
      && typeof auction.finalPriceChf === 'number'
      && auction.dataConfidence === 'verified'
      && typeof auction.finalPriceVerifiedAt === 'string').length,
    cantonsWithData: new Set(auctions.map((auction) => auction.sourceKey || auction.platePrefix)).size,
  };
  return { schema: PLATE_AUCTION_API_SCHEMA, generatedAt: value.generatedAt, sources, auctions, ...(history ? { history } : {}), counts };
}

export async function fetchPlateAuctionSnapshot(): Promise<PlateAuctionApiSnapshot> {
  const urls = [
    `${FUNCTIONS_BASE}/getPlateAuctions`,
    cdnDataUrl('/data/plate-auctions.json'),
  ];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parsePlateAuctionApiSnapshot(await response.json());
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Plate-auction data unavailable: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

/** Optional corpus companion; failure never blocks the live catalogue. */
export async function fetchPlateAuctionEditorialSnapshot(): Promise<PlateAuctionEditorialSnapshot | null> {
  try {
    const response = await fetch(`${articlesApiBase()}/plate-auction-editorial.json`, { cache: 'no-store' });
    if (!response.ok) return null;
    return parsePlateAuctionEditorialSnapshot(await response.json());
  } catch {
    return null;
  }
}
