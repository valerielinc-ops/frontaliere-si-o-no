/**
 * Data-quality checks for `PlateAuction` records (#6360, residuo #4854 —
 * "Controlli qualità dato"). Pure functions over already-parsed records: no
 * connector produces live data yet (see `data/plate-auction-sources-registry.json`,
 * every source still `unverified`), so this operates on whatever a future
 * connector fetch batch will look like and is exercised by synthetic
 * fixtures in tests until then.
 */

import type { PlateAuction, PlateAuctionDataConfidence } from './types';

export type PlateAuctionQualityIssueCode =
  | 'duplicate-plate'
  | 'incoherent-price'
  | 'deadline-passed'
  | 'non-numeric-field'
  | 'source-changed';

export interface PlateAuctionQualityIssue {
  id: string;
  code: PlateAuctionQualityIssueCode;
  message: string;
}

const ACTIVE_STATUSES = new Set<PlateAuction['auctionStatus']>(['upcoming', 'active']);

/** Codes that indicate the record can no longer be trusted as-is. */
const CONFLICTING_CODES = new Set<PlateAuctionQualityIssueCode>(['incoherent-price', 'source-changed']);

const NUMERIC_FIELDS: readonly (keyof PlateAuction)[] = [
  'currentBidChf',
  'finalPriceChf',
  'bidCount',
  'minimumIncrementChf',
];

function checkNonNumericFields(auction: PlateAuction): PlateAuctionQualityIssue[] {
  const issues: PlateAuctionQualityIssue[] = [];
  for (const field of NUMERIC_FIELDS) {
    const value = auction[field];
    if (value !== undefined && !Number.isFinite(value as number)) {
      issues.push({
        id: auction.id,
        code: 'non-numeric-field',
        message: `${auction.id}: field "${field}" is not a finite number (${String(value)})`,
      });
    }
  }
  return issues;
}

function checkIncoherentPrice(auction: PlateAuction): PlateAuctionQualityIssue[] {
  const issues: PlateAuctionQualityIssue[] = [];
  const { currentBidChf, finalPriceChf, minimumIncrementChf, id } = auction;

  if (typeof currentBidChf === 'number' && currentBidChf < 0) {
    issues.push({ id, code: 'incoherent-price', message: `${id}: currentBidChf is negative (${currentBidChf})` });
  }
  if (typeof finalPriceChf === 'number' && finalPriceChf < 0) {
    issues.push({ id, code: 'incoherent-price', message: `${id}: finalPriceChf is negative (${finalPriceChf})` });
  }
  if (typeof minimumIncrementChf === 'number' && minimumIncrementChf < 0) {
    issues.push({
      id,
      code: 'incoherent-price',
      message: `${id}: minimumIncrementChf is negative (${minimumIncrementChf})`,
    });
  }
  if (typeof currentBidChf === 'number' && typeof finalPriceChf === 'number' && finalPriceChf < currentBidChf) {
    issues.push({
      id,
      code: 'incoherent-price',
      message: `${id}: finalPriceChf (${finalPriceChf}) is lower than currentBidChf (${currentBidChf})`,
    });
  }

  return issues;
}

function checkDeadlinePassed(auction: PlateAuction, now: Date): PlateAuctionQualityIssue[] {
  if (!auction.endsAt || !ACTIVE_STATUSES.has(auction.auctionStatus)) {
    return [];
  }
  const endsAt = new Date(auction.endsAt);
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() >= now.getTime()) {
    return [];
  }
  return [
    {
      id: auction.id,
      code: 'deadline-passed',
      message: `${auction.id}: endsAt (${auction.endsAt}) is in the past but auctionStatus is still "${auction.auctionStatus}"`,
    },
  ];
}

function checkDuplicatePlates(auctions: readonly PlateAuction[]): PlateAuctionQualityIssue[] {
  const byPlate = new Map<string, PlateAuction[]>();
  for (const auction of auctions) {
    if (!ACTIVE_STATUSES.has(auction.auctionStatus)) continue;
    const key = `${auction.canton}:${auction.normalizedPlate}`;
    const group = byPlate.get(key) ?? [];
    group.push(auction);
    byPlate.set(key, group);
  }

  const issues: PlateAuctionQualityIssue[] = [];
  for (const group of byPlate.values()) {
    if (group.length < 2) continue;
    const ids = group.map((a) => a.id).sort();
    for (const auction of group) {
      issues.push({
        id: auction.id,
        code: 'duplicate-plate',
        message: `${auction.id}: plate "${auction.normalizedPlate}" (${auction.canton}) has ${group.length} active records: ${ids.join(', ')}`,
      });
    }
  }
  return issues;
}

function checkSourceChanged(auction: PlateAuction, previous: PlateAuction | undefined): PlateAuctionQualityIssue[] {
  if (!previous || previous.rawSnapshotHash === auction.rawSnapshotHash) {
    return [];
  }
  const identityChanged =
    previous.canton !== auction.canton ||
    previous.normalizedPlate !== auction.normalizedPlate ||
    previous.officialAuctionUrl !== auction.officialAuctionUrl;
  if (!identityChanged) {
    return [];
  }
  return [
    {
      id: auction.id,
      code: 'source-changed',
      message: `${auction.id}: source identity changed between fetches (was ${previous.canton}/${previous.normalizedPlate}/${previous.officialAuctionUrl}, now ${auction.canton}/${auction.normalizedPlate}/${auction.officialAuctionUrl})`,
    },
  ];
}

/**
 * Runs every data-quality check over a fetch batch. `previousById` is the
 * prior fetch's records by `id`, used only by the `source-changed` check —
 * omit it to skip that check (e.g. first fetch ever).
 */
export function checkPlateAuctionQuality(
  auctions: readonly PlateAuction[],
  previousById?: ReadonlyMap<string, PlateAuction>,
  now: Date = new Date(),
): PlateAuctionQualityIssue[] {
  const issues: PlateAuctionQualityIssue[] = [...checkDuplicatePlates(auctions)];

  for (const auction of auctions) {
    issues.push(...checkNonNumericFields(auction));
    issues.push(...checkIncoherentPrice(auction));
    issues.push(...checkDeadlinePassed(auction, now));
    if (previousById) {
      issues.push(...checkSourceChanged(auction, previousById.get(auction.id)));
    }
  }

  return issues;
}

/**
 * Derives the `dataConfidence` a record should carry given the issues found
 * for it: any `CONFLICTING_CODES` hit wins as `conflicting`, any other issue
 * downgrades to `partial`, no issues leave `dataConfidence` untouched (a
 * `verified` record without complaints stays `verified`).
 */
export function derivePlateAuctionDataConfidence(
  current: PlateAuctionDataConfidence,
  issuesForId: readonly PlateAuctionQualityIssue[],
): PlateAuctionDataConfidence {
  if (issuesForId.length === 0) {
    return current;
  }
  if (issuesForId.some((issue) => CONFLICTING_CODES.has(issue.code))) {
    return 'conflicting';
  }
  return 'partial';
}
