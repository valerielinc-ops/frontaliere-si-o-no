/**
 * Typed site wrapper for the runtime-neutral plate-auction quality policy.
 * The implementation lives in `functions/src/plateAuctionQualityCore.js` so
 * ingest, scheduled refreshes and the TypeScript tests cannot drift.
 */

import {
  checkPlateAuctionQuality as checkPlateAuctionQualityCore,
  derivePlateAuctionDataConfidence as derivePlateAuctionDataConfidenceCore,
} from '../../functions/src/plateAuctionQualityCore.js';
import type { PlateAuction, PlateAuctionDataConfidence } from './types';

export type PlateAuctionQualityIssueCode =
  | 'duplicate-plate'
  | 'incoherent-price'
  | 'deadline-passed'
  | 'non-numeric-field'
  | 'source-changed'
  | 'invalid-date'
  | 'invalid-date-order'
  | 'stale-fetch'
  | 'source-disappeared'
  | 'zero-row-anomaly'
  | 'missing-final';

export interface PlateAuctionQualityIssue {
  id: string;
  code: PlateAuctionQualityIssueCode;
  message: string;
}

/**
 * Runs every data-quality check over a fetch batch. `previousById` is the
 * prior fetch's records by `id`, used by source-change/disappearance checks.
 */
export function checkPlateAuctionQuality(
  auctions: readonly PlateAuction[],
  previousById?: ReadonlyMap<string, PlateAuction>,
  now: Date = new Date(),
): PlateAuctionQualityIssue[] {
  return checkPlateAuctionQualityCore(auctions, previousById, now) as PlateAuctionQualityIssue[];
}

/**
 * Any conflicting issue wins and prevents a record from entering a ranking;
 * other issues downgrade it to partial. A clean verified record stays
 * verified.
 */
export function derivePlateAuctionDataConfidence(
  current: PlateAuctionDataConfidence,
  issuesForId: readonly PlateAuctionQualityIssue[],
): PlateAuctionDataConfidence {
  return derivePlateAuctionDataConfidenceCore(current, issuesForId) as PlateAuctionDataConfidence;
}
