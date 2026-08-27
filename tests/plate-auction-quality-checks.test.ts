import { describe, expect, it } from 'vitest';

import {
  checkPlateAuctionQuality,
  derivePlateAuctionDataConfidence,
} from '../services/plateAuctions/qualityChecks';
import type { PlateAuction } from '../services/plateAuctions/types';

/**
 * Data-quality checks (#6360, residuo #4854 — "Controlli qualità dato") run
 * on synthetic fixtures: no connector produces real `PlateAuction` records
 * yet (every source in the registry is still `unverified`), so this suite is
 * the observer that guards the check logic itself ahead of live data.
 */

const NOW = new Date('2026-08-27T12:00:00.000Z');

function makeAuction(overrides: Partial<PlateAuction> = {}): PlateAuction {
  return {
    id: 'ti-2026-001',
    canton: 'Ticino',
    platePrefix: 'TI',
    plateNumber: '123456',
    normalizedPlate: 'TI123456',
    auctionStatus: 'active',
    officialAuctionUrl: 'https://www.ti.ch/aste/ti-2026-001',
    sourceFetchedAt: '2026-08-27T00:00:00.000Z',
    lastVerifiedAt: '2026-08-27T00:00:00.000Z',
    dataConfidence: 'verified',
    rawSnapshotHash: 'hash-a',
    ...overrides,
  };
}

describe('checkPlateAuctionQuality', () => {
  it('returns no issues for a clean batch', () => {
    const issues = checkPlateAuctionQuality([makeAuction()], undefined, NOW);
    expect(issues).toEqual([]);
  });

  it('flags a plate number duplicated across two active records', () => {
    const a = makeAuction({ id: 'ti-2026-001' });
    const b = makeAuction({ id: 'ti-2026-002' });
    const issues = checkPlateAuctionQuality([a, b], undefined, NOW);
    expect(issues.filter((i) => i.code === 'duplicate-plate')).toHaveLength(2);
    expect(issues.map((i) => i.id).sort()).toEqual(['ti-2026-001', 'ti-2026-002']);
  });

  it('does not flag the same plate when one record is already closed', () => {
    const a = makeAuction({ id: 'ti-2026-001', auctionStatus: 'sold' });
    const b = makeAuction({ id: 'ti-2026-002', auctionStatus: 'active' });
    const issues = checkPlateAuctionQuality([a, b], undefined, NOW);
    expect(issues.filter((i) => i.code === 'duplicate-plate')).toEqual([]);
  });

  it('flags a final price lower than the current bid', () => {
    const auction = makeAuction({ currentBidChf: 500, finalPriceChf: 200 });
    const issues = checkPlateAuctionQuality([auction], undefined, NOW);
    expect(issues).toEqual([
      expect.objectContaining({ id: auction.id, code: 'incoherent-price' }),
    ]);
  });

  it('flags a negative bid amount', () => {
    const auction = makeAuction({ currentBidChf: -10 });
    const issues = checkPlateAuctionQuality([auction], undefined, NOW);
    expect(issues.some((i) => i.code === 'incoherent-price')).toBe(true);
  });

  it('flags an endsAt in the past while status is still active', () => {
    const auction = makeAuction({ auctionStatus: 'active', endsAt: '2026-08-20T00:00:00.000Z' });
    const issues = checkPlateAuctionQuality([auction], undefined, NOW);
    expect(issues).toEqual([
      expect.objectContaining({ id: auction.id, code: 'deadline-passed' }),
    ]);
  });

  it('does not flag a past endsAt once the auction is closed', () => {
    const auction = makeAuction({ auctionStatus: 'closed', endsAt: '2026-08-20T00:00:00.000Z' });
    const issues = checkPlateAuctionQuality([auction], undefined, NOW);
    expect(issues.filter((i) => i.code === 'deadline-passed')).toEqual([]);
  });

  it('flags a non-finite numeric field', () => {
    const auction = makeAuction({ bidCount: Number.NaN });
    const issues = checkPlateAuctionQuality([auction], undefined, NOW);
    expect(issues).toEqual([
      expect.objectContaining({ id: auction.id, code: 'non-numeric-field' }),
    ]);
  });

  it('flags a source identity change between fetches with a different snapshot hash', () => {
    const previous = makeAuction({ rawSnapshotHash: 'hash-a', officialAuctionUrl: 'https://www.ti.ch/aste/old' });
    const next = makeAuction({ rawSnapshotHash: 'hash-b', officialAuctionUrl: 'https://www.ti.ch/aste/new' });
    const issues = checkPlateAuctionQuality(
      [next],
      new Map([[previous.id, previous]]),
      NOW,
    );
    expect(issues).toEqual([
      expect.objectContaining({ id: next.id, code: 'source-changed' }),
    ]);
  });

  it('does not flag a changed hash when the identity fields are unchanged', () => {
    const previous = makeAuction({ rawSnapshotHash: 'hash-a', currentBidChf: 100 });
    const next = makeAuction({ rawSnapshotHash: 'hash-b', currentBidChf: 150 });
    const issues = checkPlateAuctionQuality(
      [next],
      new Map([[previous.id, previous]]),
      NOW,
    );
    expect(issues.filter((i) => i.code === 'source-changed')).toEqual([]);
  });

  it('skips the source-changed check when no previous batch is given', () => {
    const auction = makeAuction();
    const issues = checkPlateAuctionQuality([auction], undefined, NOW);
    expect(issues.filter((i) => i.code === 'source-changed')).toEqual([]);
  });
});

describe('derivePlateAuctionDataConfidence', () => {
  it('keeps the current confidence when there are no issues', () => {
    expect(derivePlateAuctionDataConfidence('verified', [])).toBe('verified');
  });

  it('downgrades to "conflicting" on an incoherent-price issue', () => {
    const confidence = derivePlateAuctionDataConfidence('verified', [
      { id: 'x', code: 'incoherent-price', message: 'x' },
    ]);
    expect(confidence).toBe('conflicting');
  });

  it('downgrades to "conflicting" on a source-changed issue', () => {
    const confidence = derivePlateAuctionDataConfidence('verified', [
      { id: 'x', code: 'source-changed', message: 'x' },
    ]);
    expect(confidence).toBe('conflicting');
  });

  it('downgrades to "partial" on a non-conflicting issue', () => {
    const confidence = derivePlateAuctionDataConfidence('verified', [
      { id: 'x', code: 'deadline-passed', message: 'x' },
    ]);
    expect(confidence).toBe('partial');
  });

  it('prefers "conflicting" when both a conflicting and a partial issue are present', () => {
    const confidence = derivePlateAuctionDataConfidence('verified', [
      { id: 'x', code: 'deadline-passed', message: 'x' },
      { id: 'x', code: 'incoherent-price', message: 'x' },
    ]);
    expect(confidence).toBe('conflicting');
  });
});
