import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import registry from '../data/plate-auction-sources-registry.json';
import { parseExpandedEcari } from '../scripts/plate-auctions/connectors/expanded.mjs';
import { collectPlateAuctions, PLATE_AUCTION_MISSING_GRACE_MS, recognizeCatalogueSales } from '../scripts/plate-auctions/ingest.mjs';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const previousRow = {
  id: 'gr-1', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', plateNumber: '1', normalizedPlate: 'GR1',
  listingType: 'auction', auctionStatus: 'active', currentBidChf: 500, endsAt: '2026-09-12T18:00:00.000Z',
  officialAuctionUrl: 'https://eauktion.gr.ch/', sourceFetchedAt: '2026-09-12T12:00:00.000Z', lastVerifiedAt: '2026-09-12T12:00:00.000Z', dataConfidence: 'partial', rawSnapshotHash: 'old',
};

describe('plate-auction ingest resilience', () => {
  it('closes an expired observation without manufacturing a final price', async () => {
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [] },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: [previousRow] },
      now: NOW,
    });
    const row = snapshot.auctions.find((auction) => auction.id === 'gr-1');
    expect(row).toMatchObject({ auctionStatus: 'closed', dataConfidence: 'partial', closedAt: previousRow.endsAt });
    expect(row).not.toHaveProperty('finalPriceChf');
    expect(snapshot.sources.gr).toMatchObject({
      status: 'degraded',
      rowCount: 1,
      errorCode: 'zero_rows',
      lastSuccessAt: '2026-09-12T12:00:00.000Z',
    });
  });

  it('records a vanished fixed-price plate as a sale that can never rank as a final', async () => {
    // A fixed-price catalogue has no "sold" flag: the canton drops the row.
    // 16'976 of 17'260 rows are fixed-price and carry `endsAt` in ZERO cases,
    // so closeExpiredObservation() could never close them and a sold plate
    // left the site with no record at all. This is the release boundary: the
    // price we keep is the last published ASKING price and must never satisfy
    // the finalsVerified predicate that guards the finals ranking.
    const plate = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200 + index,
      currentBidChf: undefined,
      endsAt: undefined,
      lastSeenAt: '2026-09-12T12:00:00.000Z',
      dataConfidence: 'verified',
    });
    // 60 published, 1 sells: band 59 >= 0.95*60, cap 1 <= max(3, 1) — a
    // healthy catalogue losing one row, which is what a sale looks like.
    const previousCatalogue = Array.from({ length: 60 }, (_unused, index) => plate(index));
    const stillListed = previousCatalogue.slice(1);
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => stillListed },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: previousCatalogue },
      now: NOW,
    });

    const sold = snapshot.history.find((auction) => auction.id === 'ur-0');
    expect(sold, 'the disappearance must be retained in history').toBeDefined();
    expect(sold).toMatchObject({
      auctionStatus: 'closed',
      disappearedFromCatalogue: true,
      lastAskingPriceChf: 4200,
    });
    expect(sold.closedAt).toBe('2026-09-12T12:00:00.000Z');
    // Sold rows leave the live catalogue.
    expect(snapshot.auctions.map((auction) => auction.id)).not.toContain('ur-0');

    // The boundary, asserted three ways so no single slip can open it.
    expect(sold.finalPriceChf, 'must never carry a final price').toBeUndefined();
    expect(sold.finalPriceVerifiedAt, 'must never carry a verified-final date').toBeUndefined();
    expect(sold.dataConfidence).not.toBe('verified');
    const satisfiesFinalsVerified = ['closed', 'sold', 'unsold'].includes(sold.auctionStatus)
      && sold.dataConfidence === 'verified'
      && typeof sold.finalPriceChf === 'number'
      && typeof sold.finalPriceVerifiedAt === 'string';
    expect(satisfiesFinalsVerified, 'a catalogue removal is not a witnessed final').toBe(false);
    expect(snapshot.counts.finalsVerified).toBe(0);
  });

  it('reports a rowCount that matches the rows the snapshot carries', async () => {
    // check-health.mjs fails the run when `rowCount` disagrees with the rows
    // present for that source, so the two must not be allowed to drift: a
    // carried row (expired auction, or a deadline-protected preserved row)
    // makes the fetched count differ from what the snapshot holds.
    const live = { ...previousRow, id: 'gr-live', normalizedPlate: 'GR500', endsAt: '2026-09-20T18:00:00.000Z' };
    const carried = { ...previousRow, id: 'gr-carried', normalizedPlate: 'GR501', endsAt: '2026-09-14T18:00:00.000Z' };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [live] },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: [live, carried] },
      now: NOW,
    });
    const rowsForSource = snapshot.auctions.filter(
      (auction) => String(auction.sourceKey || auction.platePrefix || '').toLowerCase() === 'gr',
    );
    expect(snapshot.sources.gr.rowCount).toBe(rowsForSource.length);
  });

  it('keeps a source degraded when the loss also includes a protected row', async () => {
    // One recognized sale must not launder an upstream anomaly into `active`:
    // a feed can lose a future-deadline row (which checkDisappearedSources
    // calls an anomaly) plus one fixed-price row, and pass band/cap.
    const fp = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200,
      currentBidChf: undefined,
      endsAt: undefined,
      dataConfidence: 'verified',
    });
    const timed = {
      ...fp(999),
      id: 'ur-timed',
      normalizedPlate: 'UR999',
      listingType: 'auction',
      endsAt: '2026-09-25T18:00:00.000Z',
    };
    const previousCatalogue = [...Array.from({ length: 60 }, (_unused, index) => fp(index)), timed];
    // ur-0 (a sale) and ur-timed (protected) both vanish: keep only fp1..fp59.
    const stillListed = previousCatalogue.slice(1, 60);
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => stillListed },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: previousCatalogue },
      now: NOW,
    });
    expect(snapshot.sources.ur).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared' });
    // The protected row is preserved, not sold.
    expect(snapshot.auctions.map((auction) => auction.id)).toContain('ur-timed');
    expect(snapshot.history.find((auction) => auction.id === 'ur-timed')).toBeUndefined();
  });

  it('never reads a malformed timed-auction row as a fixed-price sale', async () => {
    // An `auction` row whose endsAt is unparseable has no usable deadline, but
    // it is not a fixed-price catalogue entry and must not be stamped closed.
    const fp = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200,
      currentBidChf: undefined,
      endsAt: undefined,
      dataConfidence: 'verified',
    });
    const malformed = { ...fp(500), id: 'ur-bad', normalizedPlate: 'UR500', listingType: 'auction', endsAt: 'not-a-date' };
    const previousCatalogue = [...Array.from({ length: 60 }, (_unused, index) => fp(index)), malformed];
    const stillListed = previousCatalogue.slice(0, 60);
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => stillListed },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: previousCatalogue },
      now: NOW,
    });
    expect(snapshot.history.find((auction) => auction.id === 'ur-bad')).toBeUndefined();
    expect(snapshot.auctions.map((auction) => auction.id)).toContain('ur-bad');
  });

  it('drops the inherited active history instead of waiting for sales to evict it', async () => {
    // The committed history is 5'000 rows that are all still `active`, the
    // artefact of the window bug. Carried forward unfiltered they would
    // consume the whole cap and keep the invariant false for many runs.
    const staleActiveHistory = Array.from({ length: 12 }, (_unused, index) => ({
      ...previousRow,
      id: `gr-stale-${index}`,
      normalizedPlate: `GR${9000 + index}`,
      auctionStatus: 'active',
      endsAt: '2026-09-30T18:00:00.000Z',
    }));
    const live = { ...previousRow, id: 'gr-live', normalizedPlate: 'GR600', endsAt: '2026-09-30T18:00:00.000Z' };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [live] },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: [live], history: staleActiveHistory },
      now: NOW,
    });
    expect(snapshot.history.filter((auction) => ['active', 'upcoming'].includes(auction.auctionStatus))).toEqual([]);
    expect(snapshot.history.map((auction) => auction.id)).not.toContain('gr-stale-0');
  });

  it('omits the final-price keys entirely instead of setting them to undefined', async () => {
    // The same record is handed to a Firestore batch write by the Cloud
    // Functions pipeline, and Firestore rejects explicitly-undefined fields
    // unless ignoreUndefinedProperties is configured: the write would throw,
    // be swallowed as fetch_failed, and the recognized sale would be lost.
    const fp = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200,
      currentBidChf: undefined,
      endsAt: undefined,
      dataConfidence: 'verified',
      // A stale inherited value must be stripped, not carried through.
      finalPriceChf: 999,
      finalPriceVerifiedAt: '2026-01-01T00:00:00.000Z',
    });
    const previousCatalogue = Array.from({ length: 60 }, (_unused, index) => fp(index));
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => previousCatalogue.slice(1) },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: previousCatalogue },
      now: NOW,
    });
    const sold = snapshot.history.find((auction) => auction.id === 'ur-0');
    expect(sold).toBeDefined();
    // `not.toHaveProperty` is the point: present-and-undefined would pass a
    // `=== undefined` check while still breaking the Firestore write.
    expect(sold).not.toHaveProperty('finalPriceChf');
    expect(sold).not.toHaveProperty('finalPriceVerifiedAt');
    expect(Object.keys(sold)).not.toContain('finalPriceChf');
  });

  it('does not let accumulated closed rows starve the recognition band', async () => {
    // Closed observations are carried into the next run's `previous`, so
    // counting them in the denominator would tighten the 95% band every run
    // until a healthy feed was classified preserve-as-live and sales stopped
    // being recorded at all.
    const fp = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200,
      currentBidChf: undefined,
      endsAt: undefined,
      dataConfidence: 'verified',
    });
    const live = Array.from({ length: 40 }, (_unused, index) => fp(index));
    // 200 previously-closed rows dwarf the 40 live ones.
    const closed = Array.from({ length: 200 }, (_unused, index) => ({
      ...fp(1000 + index),
      auctionStatus: 'closed',
      closedAt: '2026-09-10T12:00:00.000Z',
      dataConfidence: 'partial',
    }));
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => live.slice(1) },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: [...live, ...closed] },
      now: NOW,
    });
    // 39 fetched vs 40 live passes the band; 39 vs 240 would not.
    const sold = snapshot.history.find((auction) => auction.id === 'ur-0');
    expect(sold, 'the sale must still be recognized despite the closed backlog').toBeDefined();
    expect(sold).toMatchObject({ auctionStatus: 'closed', disappearedFromCatalogue: true });
  });

  it('refuses to call a truncated catalogue a batch of sales', async () => {
    // Same source, same shape of row, but the PDF came back short. Reading
    // this as sales would stamp a fabricated sale date and price on half the
    // catalogue, so the decision must fail closed to preserve-as-live.
    const plate = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200 + index,
      currentBidChf: undefined,
      endsAt: undefined,
      dataConfidence: 'verified',
    });
    const previousCatalogue = Array.from({ length: 60 }, (_unused, index) => plate(index));
    const truncated = previousCatalogue.slice(0, 30);
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => truncated },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: previousCatalogue },
      now: NOW,
    });

    expect(snapshot.history.filter((auction) => auction.disappearedFromCatalogue)).toEqual([]);
    // Every row stays visible instead of being declared sold.
    expect(snapshot.auctions).toHaveLength(60);
    expect(snapshot.sources.ur).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared' });
  });

  it('keeps earlier history instead of letting the live catalogue evict it', async () => {
    // The old line concatenated the whole active catalogue before
    // `.slice(-5000)`, so with 17'260 live rows the window held nothing but
    // current rows and both previousHistory and the disappearance
    // observations were discarded on every run.
    const live = Array.from({ length: 120 }, (_unused, index) => ({
      ...previousRow,
      id: `gr-live-${index}`,
      plateNumber: String(1000 + index),
      normalizedPlate: `GR${1000 + index}`,
      endsAt: '2026-09-20T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    }));
    const olderHistory = [{
      ...previousRow,
      id: 'gr-ancient',
      normalizedPlate: 'GR777',
      auctionStatus: 'closed',
      closedAt: '2026-08-01T12:00:00.000Z',
      dataConfidence: 'partial',
    }];
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => live },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: live, history: olderHistory },
      now: NOW,
    });
    expect(snapshot.history.map((auction) => auction.id)).toContain('gr-ancient');
    expect(snapshot.history.filter((auction) => ['active', 'upcoming'].includes(auction.auctionStatus))).toEqual([]);
  });

  it('preserves the last good rows when a fetch fails', async () => {
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => { throw new Error('upstream unavailable'); } },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: [previousRow] },
      now: NOW,
    });
    expect(snapshot.auctions).toContainEqual(previousRow);
    expect(snapshot.sources.gr).toMatchObject({ status: 'degraded', errorCode: 'fetch_failed', rowCount: 1 });
  });

  it('preserves a non-expired row missing from a degraded non-empty feed', async () => {
    const replacement = {
      ...previousRow,
      id: 'gr-2',
      plateNumber: '2',
      normalizedPlate: 'GR2',
      currentBidChf: 700,
      endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [replacement] },
      previous: {
        generatedAt: '2026-09-12T12:00:00.000Z',
        auctions: [{ ...previousRow, endsAt: '2026-09-14T18:00:00.000Z' }],
      },
      now: NOW,
    });
    expect(snapshot.auctions.map((auction) => auction.id)).toEqual(['gr-2', 'gr-1']);
    // History holds what is no longer live. These rows were PRESERVED as live,
    // so they are a preservation case, not a sale, and must not enter history.
    expect(snapshot.history.filter((auction) => ['active', 'upcoming'].includes(auction.auctionStatus))).toEqual([]);
    expect(snapshot.sources.gr).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared', rowCount: 2 });
  });

  it('preserves all old live rows when a non-empty feed is flagged as incomplete', async () => {
    const replacement = {
      ...previousRow,
      id: 'gr-2',
      plateNumber: '2',
      normalizedPlate: 'GR2',
      currentBidChf: 700,
      endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [replacement] },
      previous: {
        generatedAt: '2026-09-12T12:00:00.000Z',
        auctions: [
          { ...previousRow, id: 'gr-1', endsAt: '2026-09-14T18:00:00.000Z' },
          { ...previousRow, id: 'gr-3', plateNumber: '3', normalizedPlate: 'GR3', endsAt: '2026-09-15T18:00:00.000Z' },
        ],
      },
      now: NOW,
    });
    expect(snapshot.auctions.map((auction) => auction.id)).toEqual(['gr-2', 'gr-1', 'gr-3']);
    expect(snapshot.history.filter((auction) => ['active', 'upcoming'].includes(auction.auctionStatus))).toEqual([]);
    expect(snapshot.sources.gr).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared', rowCount: 3 });
  });

  it('downgrades an incoherent fetched price before publishing the snapshot', async () => {
    const incoherent = {
      ...previousRow,
      id: 'gr-incoherent',
      plateNumber: '3',
      normalizedPlate: 'GR3',
      startingPriceChf: 1000,
      currentBidChf: 500,
      endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [incoherent] },
      previous: null,
      now: NOW,
    });
    expect(snapshot.auctions[0]).toMatchObject({ id: 'gr-incoherent', dataConfidence: 'conflicting' });
  });
});

describe('plate-auction ingest: a preserved loss converges instead of ratcheting', () => {
  // Relative dates only: what matters is the spacing between runs, not the day.
  const HOUR = 60 * 60 * 1000;
  const base = new Date();
  const at = (hours: number) => new Date(base.getTime() + hours * HOUR);
  const afterGrace = new Date(base.getTime() + PLATE_AUCTION_MISSING_GRACE_MS);
  const urPlate = (index: number, seenAt: Date) => ({
    id: `ur-${index}`,
    sourceKey: 'UR',
    canton: 'Uri',
    platePrefix: 'UR',
    plateNumber: String(index),
    normalizedPlate: `UR${index}`,
    listingType: 'fixed-price',
    auctionStatus: 'active',
    startingPriceChf: 300 + index,
    officialAuctionUrl: 'https://www.ur.ch/dienstleistungen/4046',
    sourceFetchedAt: seenAt.toISOString(),
    lastVerifiedAt: seenAt.toISOString(),
    lastSeenAt: seenAt.toISOString(),
    dataConfidence: 'partial',
    rawSnapshotHash: `ur-${index}`,
  });
  /** The first `listed` plates of one catalogue, as the upstream lists them at `seenAt`. */
  const catalogue = (listed: number, seenAt: Date) => Array.from({ length: listed }, (_unused, index) => urPlate(index, seenAt));
  // Each run reads the file the previous run wrote, so go through JSON.
  const run = async (previous: unknown, now: Date, listed: number) => JSON.parse(JSON.stringify(await collectPlateAuctions({
    selectedCantons: ['ur'],
    fetchers: { ur: async () => catalogue(listed, now) },
    previous,
    now,
  })));
  const firstPrevious = () => ({ generatedAt: at(-6).toISOString(), auctions: catalogue(460, at(-6)) });
  // A loss beyond UR's calibrated cap (5% of 460 = 23): the daily 13-plate
  // update is now read as sales directly (see the calibration tests below),
  // so the preserve/stamp/expire path is exercised with 30 missing rows.
  const vanishedIds = Array.from({ length: 30 }, (_unused, index) => `ur-${430 + index}`).sort();

  it('stops re-judging the same vanished rows once they were reported (UR 460 → 430 twice)', async () => {
    // Production, runs 35490328535 and 35995052505: `previous=460 fetched=447
    // vanished=13 cap=5 decision=preserve-as-live` on both, because the rows
    // preserved by the first run came back as `previous` and vanished again.
    // Replayed here with a loss the calibrated cap still blocks.
    const run1 = await run(firstPrevious(), at(0), 430);
    expect(run1.sources.ur).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared', rowCount: 460 });

    // Same upstream six hours later: the loss was already reported, the fetch
    // itself lost nothing, so the source must not stay degraded.
    const run2 = await run(run1, at(6), 430);
    expect(run2.sources.ur).toMatchObject({ status: 'active', rowCount: 460 });

    // The first run stamped the rows it preserved with its own time.
    const preserved1 = run1.auctions.filter((row: { missingSince?: string }) => row.missingSince);
    expect(preserved1.map((row: { id: string }) => row.id).sort()).toEqual(vanishedIds);
    expect(new Set(preserved1.map((row: { missingSince: string }) => row.missingSince))).toEqual(new Set([at(0).toISOString()]));
    // Inside the grace window the rows stay visible and keep their first stamp.
    const preserved2 = run2.auctions.filter((row: { missingSince?: string }) => row.missingSince);
    expect(preserved2.map((row: { missingSince: string }) => row.missingSince)).toEqual(Array(30).fill(at(0).toISOString()));
    expect(run2.history.filter((row: { disappearedFromCatalogue?: boolean }) => row.disappearedFromCatalogue)).toEqual([]);

    // Past the grace window a healthy fetch records the absence and the rows
    // leave the live catalogue — never with a final price.
    const run3 = await run(run2, afterGrace, 430);
    expect(run3.sources.ur).toMatchObject({ status: 'active', rowCount: 430 });
    expect(run3.auctions.filter((row: { missingSince?: string }) => row.missingSince)).toEqual([]);
    const recorded = run3.history.filter((row: { disappearedFromCatalogue?: boolean }) => row.disappearedFromCatalogue);
    expect(recorded.map((row: { id: string }) => row.id).sort()).toEqual(vanishedIds);
    for (const row of recorded) {
      expect(row).toMatchObject({ auctionStatus: 'closed', dataConfidence: 'partial', closedAt: at(-6).toISOString() });
      expect(row).not.toHaveProperty('finalPriceChf');
      expect(row).not.toHaveProperty('finalPriceVerifiedAt');
    }
    expect(run3.counts.finalsVerified).toBe(0);
  });

  it('judges a new sale on its own instead of adding it to the old ghosts', async () => {
    // Before, one more sale made it `vanished=14` against `previous=460` and
    // the guard blocked it too; LU's ghosts grew from 146 to 188 this way.
    const run1 = await run(firstPrevious(), at(0), 430);
    const run2 = await run(run1, at(6), 429);
    expect(run2.sources.ur).toMatchObject({ status: 'active', rowCount: 459 });
    const sold = run2.history.filter((row: { disappearedFromCatalogue?: boolean }) => row.disappearedFromCatalogue);
    expect(sold.map((row: { id: string }) => row.id)).toEqual(['ur-429']);
    expect(run2.auctions.filter((row: { missingSince?: string }) => row.missingSince)).toHaveLength(30);
  });

  it('never resolves an old absence on a run that may itself be truncated', async () => {
    const run1 = await run(firstPrevious(), at(0), 430);
    // Past the grace window, but this PDF came back less than half as long:
    // the guard trips again, and nothing already missing is declared gone.
    const run2 = await run(run1, afterGrace, 200);
    expect(run2.sources.ur).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared', rowCount: 460 });
    expect(run2.history.filter((row: { disappearedFromCatalogue?: boolean }) => row.disappearedFromCatalogue)).toEqual([]);
    const stamps = run2.auctions
      .filter((row: { missingSince?: string }) => row.missingSince)
      .reduce((count: Record<string, number>, row: { missingSince: string }) => ({ ...count, [row.missingSince]: (count[row.missingSince] || 0) + 1 }), {});
    expect(stamps).toEqual({ [at(0).toISOString()]: 30, [afterGrace.toISOString()]: 230 });
  });

  it('clears the stamp when a preserved row is listed again', async () => {
    const run1 = await run(firstPrevious(), at(0), 430);
    const run2 = await run(run1, at(6), 460);
    expect(run2.sources.ur).toMatchObject({ status: 'active', rowCount: 460 });
    expect(run2.auctions.filter((row: { missingSince?: string }) => row.missingSince)).toEqual([]);
    expect(run2.history).toEqual([]);
  });
});

describe('plate-auction ingest: per-canton sale calibration', () => {
  // `previous / fetched / vanished` as logged by the production runs of
  // 2026-09-19 → 2026-09-25 (`[collectPlateAuctions:<key>] sale-recognition`).
  // Each of these is one healthy daily update of the canton's list.
  it.each([
    ['lu', 141, 130, 11],
    ['lu', 146, 124, 22],
    ['lu', 125, 133, 13],
    ['ur', 460, 447, 13],
    ['gl', 28, 22, 6],
    ['gl', 26, 21, 5],
    ['ai', 38, 32, 6],
    ['ai', 30, 32, 6],
  ])('%s: previous=%i fetched=%i vanished=%i is a daily update, read as sales', (sourceKey, previousCount, fetchedCount, vanishedCount) => {
    expect(recognizeCatalogueSales({ sourceKey, previousCount, fetchedCount, vanishedCount })).toMatchObject({ recognized: true, blockedBy: [] });
  });

  it.each([
    // A file cut in half still trips the band for every calibrated canton.
    ['lu', 141, 70, 71],
    ['ur', 460, 230, 230],
    ['gl', 28, 14, 14],
    ['ai', 38, 19, 19],
    // Without an override the global knob is unchanged (1% / 95%, floor 3).
    ['sh', 36, 30, 6],
    ['bs', 16339, 16000, 339],
  ])('%s: previous=%i fetched=%i vanished=%i stays preserved', (sourceKey, previousCount, fetchedCount, vanishedCount) => {
    expect(recognizeCatalogueSales({ sourceKey, previousCount, fetchedCount, vanishedCount }).recognized).toBe(false);
  });

  it('keeps LU active through its daily update instead of reporting it degraded', async () => {
    const HOUR = 60 * 60 * 1000;
    const now = new Date();
    const seenAt = new Date(now.getTime() - 6 * HOUR);
    const luPlate = (index: number, at: Date) => ({
      id: `lu-${index}`,
      sourceKey: 'LU',
      canton: 'Lucerna',
      platePrefix: 'LU',
      plateNumber: String(index),
      normalizedPlate: `LU${index}`,
      listingType: 'fixed-price',
      auctionStatus: 'active',
      startingPriceChf: 300 + index,
      officialAuctionUrl: 'https://strassenverkehrsamt.lu.ch/',
      sourceFetchedAt: at.toISOString(),
      lastVerifiedAt: at.toISOString(),
      lastSeenAt: at.toISOString(),
      dataConfidence: 'partial',
      rawSnapshotHash: `lu-${index}`,
    });
    const catalogue = (listed: number, at: Date) => Array.from({ length: listed }, (_unused, index) => luPlate(index, at));
    // Production 2026-09-25: previous=141 fetched=130 vanished=11.
    const snapshot = JSON.parse(JSON.stringify(await collectPlateAuctions({
      selectedCantons: ['lu'],
      fetchers: { lu: async () => catalogue(130, now) },
      previous: { generatedAt: seenAt.toISOString(), auctions: catalogue(141, seenAt) },
      now,
    })));
    expect(snapshot.sources.lu).toMatchObject({ status: 'active', rowCount: 130 });
    const sold = snapshot.history.filter((row: { disappearedFromCatalogue?: boolean }) => row.disappearedFromCatalogue);
    expect(sold).toHaveLength(11);
    for (const row of sold) {
      expect(row).not.toHaveProperty('finalPriceChf');
      expect(row).not.toHaveProperty('finalPriceVerifiedAt');
    }
    expect(snapshot.auctions.filter((row: { missingSince?: string }) => row.missingSince)).toEqual([]);
  });
});

describe('plate-auction ingest: an eCari page that says no auction is running', () => {
  const HOUR = 60 * 60 * 1000;
  const base = new Date();
  const at = (hours: number) => new Date(base.getTime() + hours * HOUR);
  const EMPTY_PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ecari-no-running-auction.html'), 'utf8');
  const NW_URL = 'https://ecarinwprod.ilz.info/ecari-auction/';
  const nwRow = (id: string, overrides: Record<string, unknown>) => ({
    id,
    sourceKey: 'NW',
    canton: 'Nidvaldo',
    platePrefix: 'NW',
    plateNumber: id.replace(/\D/g, ''),
    normalizedPlate: `NW${id.replace(/\D/g, '')}`,
    listingType: 'auction',
    auctionStatus: 'active',
    startingPriceChf: 500,
    officialAuctionUrl: NW_URL,
    sourceFetchedAt: at(-80).toISOString(),
    lastVerifiedAt: at(-80).toISOString(),
    dataConfidence: 'partial',
    rawSnapshotHash: id,
    ...overrides,
  });
  // Production on 2026-09-24: every NW row had ended (21 rows, closed by
  // their deadline) and the page printed only its empty labels.
  const endedRound = () => [
    ...Array.from({ length: 3 }, (_unused, index) => nwRow(`nw-${1488 + index}`, {
      auctionStatus: 'closed', endsAt: at(-72).toISOString(), closedAt: at(-72).toISOString(),
    })),
    nwRow('nw-1491', { endsAt: at(-72).toISOString() }),
  ];
  const run = async (previous: unknown, now: Date, page: string) => JSON.parse(JSON.stringify(await collectPlateAuctions({
    selectedCantons: ['nw'],
    fetchers: { nw: async () => parseExpandedEcari('nw', page, { fetchedAt: now.toISOString() }) },
    previous,
    now,
  })));

  it('reports a finished round as a healthy empty catalogue, archiving the ended rows', async () => {
    const snapshot = await run({ generatedAt: at(-6).toISOString(), auctions: endedRound() }, at(0), EMPTY_PAGE);
    expect(snapshot.sources.nw).toMatchObject({ status: 'active', rowCount: 4, lastSuccessAt: at(0).toISOString() });
    expect(snapshot.sources.nw.errorCode).toBeUndefined();
    const rows = snapshot.auctions.filter((row: { sourceKey: string }) => row.sourceKey === 'NW');
    expect(rows.map((row: { auctionStatus: string }) => row.auctionStatus)).toEqual(['closed', 'closed', 'closed', 'closed']);
    expect(rows.find((row: { id: string }) => row.id === 'nw-1491')).toMatchObject({ closedAt: at(-72).toISOString() });
  });

  it('keeps `zero_rows` for the same page without the explicit label', async () => {
    const shell = EMPTY_PAGE.replaceAll('Keine laufende Versteigerung', '');
    const snapshot = await run({ generatedAt: at(-6).toISOString(), auctions: endedRound() }, at(0), shell);
    expect(snapshot.sources.nw).toMatchObject({ status: 'degraded', errorCode: 'zero_rows', rowCount: 4 });
  });

  it('judges a listing that vanished behind the empty label, and never retires it on an empty page', async () => {
    // A fixed-price row with no deadline: the empty page is no evidence that
    // it sold, so it is reported once, preserved, and left to a later page
    // that lists something to measure against.
    const fixed = nwRow('nw-fixed-77', { listingType: 'fixed-price' });
    const previous = { generatedAt: at(-6).toISOString(), auctions: [...endedRound(), fixed] };
    const run1 = await run(previous, at(0), EMPTY_PAGE);
    expect(run1.sources.nw).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared', rowCount: 5 });
    expect(run1.auctions.find((row: { id: string }) => row.id === 'nw-fixed-77')).toMatchObject({ auctionStatus: 'active', missingSince: at(0).toISOString() });

    const run2 = await run(run1, at(6), EMPTY_PAGE);
    expect(run2.sources.nw).toMatchObject({ status: 'active', rowCount: 5 });

    const afterGrace = new Date(at(0).getTime() + PLATE_AUCTION_MISSING_GRACE_MS);
    const run3 = await run(run2, afterGrace, EMPTY_PAGE);
    expect(run3.sources.nw).toMatchObject({ status: 'active', rowCount: 5 });
    expect(run3.history.filter((row: { disappearedFromCatalogue?: boolean }) => row.disappearedFromCatalogue)).toEqual([]);
  });
});

describe('check-health publication gate', () => {
  // These run the real script, because the thing under test is exactly its
  // exit/output contract with the workflow. `PLATE_AUCTION_OUTPUT` keeps the
  // committed snapshot untouched and `GITHUB_OUTPUT` captures the flag the
  // workflow reads.
  const runCheckHealth = (snapshot: unknown, args: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'plate-health-'));
    const snapshotPath = join(dir, 'plate-auctions.json');
    const githubOutput = join(dir, 'github-output');
    writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
    writeFileSync(githubOutput, '', 'utf8');
    const result = spawnSync(
      process.execPath,
      ['scripts/plate-auctions/check-health.mjs', ...args],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        encoding: 'utf8',
        env: { ...process.env, PLATE_AUCTION_OUTPUT: snapshotPath, GITHUB_OUTPUT: githubOutput },
      },
    );
    return {
      status: result.status,
      summary: JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))),
      githubOutput: readFileSync(githubOutput, 'utf8'),
    };
  };

  /** A snapshot the gate accepts, built from the registry it validates against. */
  const healthySnapshot = () => {
    const auctions: Record<string, unknown>[] = [];
    const sources: Record<string, unknown> = {};
    for (const [key, source] of Object.entries<Record<string, unknown>>(registry.sources)) {
      const active = source.status === 'active';
      if (active) {
        auctions.push({
          id: `${key}-1`,
          sourceKey: String(source.plateCode),
          platePrefix: String(source.plateCode),
          normalizedPlate: `${source.plateCode}1`,
          auctionStatus: 'active',
        });
      }
      sources[key] = {
        ...source,
        rowCount: active ? 1 : 0,
        lastCheckedAt: '2026-09-19T06:00:00.000Z',
        ...(active
          ? { lastFetchedAt: '2026-09-19T06:00:00.000Z', lastSuccessAt: '2026-09-19T06:00:00.000Z' }
          : {}),
      };
    }
    return {
      schema: 1,
      complete: true,
      generatedAt: '2026-09-19T06:00:00.000Z',
      sources,
      auctions,
      counts: { active: auctions.length, upcoming: 0, closed: 0, finalsVerified: 0, cantonsWithData: auctions.length },
    };
  };

  it('accepts a snapshot in which every source is healthy', () => {
    const { status, summary, githubOutput } = runCheckHealth(healthySnapshot());
    expect(summary.errors).toEqual([]);
    expect(githubOutput).toContain('blocking=false');
    expect(githubOutput).toContain('health_failed=false');
    expect(status).toBe(0);
  });

  it('keeps the run red but still clears the commit when one source is degraded', () => {
    // This is the loop this gate used to create: `lu` reported
    // `source_disappeared` on 2026-09-19 while its fetch had just returned 133
    // rows against a baseline of 125, the red skipped the commit, and the
    // skipped commit left `previous` frozen at 2026-09-15T06:58:44.350Z — so
    // the next run compared a live catalogue against an even older baseline.
    // A degraded source must fail the run WITHOUT freezing the other 25.
    const snapshot = healthySnapshot();
    const degraded = snapshot.sources.lu as Record<string, unknown>;
    degraded.status = 'degraded';
    degraded.errorCode = 'source_disappeared';

    const { status, summary, githubOutput } = runCheckHealth(snapshot);
    expect(summary.errors.join('\n')).toContain('lu: snapshot status degraded');
    expect(summary.blockingErrors).toEqual([]);
    expect(githubOutput).toContain('blocking=false');
    expect(githubOutput).toContain('health_failed=true');
    expect(status).toBe(1);
  });

  it('rejects valid JSON null before running structural checks', () => {
    const { status, summary, githubOutput } = runCheckHealth(null);
    expect(summary.blockingErrors).toContain('snapshot must be a JSON object');
    expect(githubOutput).toContain('blocking=true');
    expect(status).toBe(1);
  });

  it('blocks an active source whose published catalogue is empty', () => {
    const snapshot = healthySnapshot();
    snapshot.auctions = snapshot.auctions.filter(
      (row) => String(row.sourceKey).toLowerCase() !== 'gr',
    );
    (snapshot.sources.gr as Record<string, unknown>).rowCount = 0;
    snapshot.counts.active -= 1;

    const { status, summary, githubOutput } = runCheckHealth(snapshot);
    expect(summary.blockingErrors).toContain('gr: active source returned no rows');
    expect(githubOutput).toContain('blocking=true');
    expect(status).toBe(1);
  });

  it('blocks the commit when the snapshot contradicts itself', () => {
    // A rowCount that disagrees with the rows present is not a statement about
    // an upstream source: the file itself is wrong, so publishing it could
    // serve numbers that match nothing. This one must stop the commit.
    const snapshot = healthySnapshot();
    (snapshot.sources.gr as Record<string, unknown>).rowCount = 99;

    const { status, summary, githubOutput } = runCheckHealth(snapshot);
    expect(summary.blockingErrors.join('\n')).toContain('gr: rowCount 99 does not match 1 snapshot rows');
    expect(githubOutput).toContain('blocking=true');
    expect(status).toBe(1);
  });

  it('lets --blocking-only ignore a degraded source but still refuse a broken file', () => {
    // The push-retry regenerate command uses this flag: it must republish after
    // losing a race even though a source is degraded, and must still refuse a
    // self-contradictory snapshot.
    const degradedOnly = healthySnapshot();
    (degradedOnly.sources.lu as Record<string, unknown>).status = 'degraded';
    expect(runCheckHealth(degradedOnly, ['--blocking-only']).status).toBe(0);

    const contradictory = healthySnapshot();
    (contradictory.sources.gr as Record<string, unknown>).rowCount = 99;
    expect(runCheckHealth(contradictory, ['--blocking-only']).status).toBe(1);
  });

  it('propagates source-health errors from push-retry regeneration', () => {
    const workflow = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/refresh-plate-auctions.yml'),
      'utf8',
    );
    expect(workflow).toContain('check-health.mjs --blocking-only');
    expect(workflow).toContain("steps.health.outcome == 'failure'");
    expect(workflow).not.toContain('steps.commit.outputs.health_failed');
  });
});
