import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FieldValue } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { chunkPlateAuctionWrites, PLATE_AUCTION_BATCH_SIZE } from '../functions/src/plateAuctionBatch.js';
import { PLATE_AUCTION_MISSING_GRACE_MS } from '../functions/src/plateAuctionQualityCore.js';
import { PLATE_AUCTION_COLLECTION, PLATE_AUCTION_SOURCE_COLLECTION, refreshPlateAuctions } from '../functions/src/plateAuctions.js';

const ECARI_NO_RUNNING_AUCTION = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ecari-no-running-auction.html'), 'utf8');

const GR_PARTIAL_FEED = `
  <div id="tabContent1"><table><tbody><tr class="L">
    <td><a onclick="openDetails(2230)"><div class="number">12219</div></a></td>
    <td class="amount">500</td><td class="amount">50</td><td class="amount">900</td>
    <td class="closingTime">2026/09/14 20:00:00</td><td>4</td>
  </tr></tbody></table></div>`;

function fakeFirestore(previousRows: Record<string, unknown>[]) {
  const deletes: string[] = [];
  const sourceSets: Array<{ id: string; value: Record<string, unknown> }> = [];
  const writes: Array<{ collection: string; id: string; value: Record<string, unknown> }> = [];
  const rowDocs = previousRows.map((row) => ({ id: String(row.id), data: () => row }));
  const collection = (name: string) => ({
    doc(id: string) {
      return {
        collection: name,
        id,
        async set(value: Record<string, unknown>) {
          if (name === PLATE_AUCTION_SOURCE_COLLECTION) sourceSets.push({ id, value });
        },
      };
    },
    where(field: string, _operator: string, value: unknown) {
      return { limit: () => ({ get: async () => ({ docs: rowDocs.filter((doc) => doc.data()[field] === value) }) }) };
    },
    limit() {
      return { get: async () => ({ docs: [] }) };
    },
  });
  return {
    db: {
      collection,
      batch() {
        return {
          set(ref: { collection: string; id: string }, value: Record<string, unknown>) {
            writes.push({ collection: ref.collection, id: ref.id, value });
          },
          delete(ref: { collection: string; id: string }) {
            if (ref.collection === PLATE_AUCTION_COLLECTION) deletes.push(ref.id);
          },
          async commit() {},
        };
      },
    },
    deletes,
    sourceSets,
    writes,
  };
}

describe('plate-auction Firestore batching', () => {
  it('keeps every commit below Firestore’s 500-write limit', () => {
    const writes = Array.from({ length: 1001 }, (_, index) => ({ id: index }));
    const chunks = chunkPlateAuctionWrites(writes);
    expect(PLATE_AUCTION_BATCH_SIZE).toBeLessThan(500);
    expect(chunks.map((chunk) => chunk.length)).toEqual([400, 400, 201]);
    expect(chunks.flat()).toEqual(writes);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(400);
  });

  it('rejects an invalid batch size instead of risking an oversized commit', () => {
    expect(() => chunkPlateAuctionWrites([], 501)).toThrow(RangeError);
    expect(() => chunkPlateAuctionWrites([], 0)).toThrow(RangeError);
  });

  it('retires the rows of a source the registry no longer marks active', async () => {
    // Zeroing the source document while leaving its rows behind is the trap:
    // getPublicPlateAuctionSnapshot filters them out today, so nothing leaks,
    // but a re-activation would then serve days-old bids before the first
    // successful fetch. The delete must happen, and only for the blocked source.
    const firestore = fakeFirestore([
      {
        id: 'ti-stale', sourceKey: 'TI', canton: 'Ticino', platePrefix: 'TI',
        normalizedPlate: 'TI1', auctionStatus: 'active', currentBidChf: 400,
        endsAt: '2026-09-20T18:00:00.000Z', sourceFetchedAt: '2026-09-15T06:00:00.000Z',
        lastVerifiedAt: '2026-09-15T06:00:00.000Z', dataConfidence: 'partial',
        firstSeenAt: '2026-09-15T06:00:00.000Z',
      },
      {
        id: 'gr-live', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR',
        normalizedPlate: 'GR1', auctionStatus: 'active', currentBidChf: 500,
        endsAt: '2026-09-20T18:00:00.000Z', sourceFetchedAt: '2026-09-15T06:00:00.000Z',
        lastVerifiedAt: '2026-09-15T06:00:00.000Z', dataConfidence: 'partial',
        firstSeenAt: '2026-09-15T06:00:00.000Z',
      },
    ]);

    const result = await refreshPlateAuctions({
      db: firestore.db as never,
      fetcher: async () => '',
      now: new Date('2026-09-18T12:00:00.000Z'),
    });

    expect(firestore.deletes).toContain('ti-stale');
    expect(firestore.deletes).not.toContain('gr-live');
    expect(result.summaries.ti).toMatchObject({ status: 'blocked', rowCount: 0 });
  });

  it('keeps a live row when the Cloud Function sees a partial non-empty feed', async () => {
    const firestore = fakeFirestore([{
      id: 'gr-old', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', normalizedPlate: 'GR1',
      auctionStatus: 'active', currentBidChf: 400, endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: '2026-09-12T12:00:00.000Z', lastVerifiedAt: '2026-09-12T12:00:00.000Z',
      dataConfidence: 'partial', firstSeenAt: '2026-09-12T12:00:00.000Z',
    }]);
    const result = await refreshPlateAuctions({
      db: firestore.db as never,
      fetcher: async (url) => url.includes('eauktion.gr.ch') ? GR_PARTIAL_FEED : '',
      now: new Date('2026-09-13T12:00:00.000Z'),
    });
    expect(firestore.deletes).not.toContain('gr-old');
    expect(firestore.sourceSets.find((entry) => entry.id === 'gr')).toMatchObject({
      value: { status: 'degraded', errorCode: 'source_disappeared' },
    });
    // TI is no longer fetched at all: its registry status is `blocked`, so the
    // collector skips the connector and publishes the registry state instead of
    // a `zero_rows` degradation it never measured.
    expect(firestore.sourceSets.find((entry) => entry.id === 'ti')).toMatchObject({
      value: { status: 'blocked', rowCount: 0, errorCode: null },
    });
    expect(result.summaries.gr).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared' });
    expect(result.summaries.ti).toMatchObject({ status: 'blocked', rowCount: 0 });
    const agMetadata = firestore.sourceSets.find((entry) => entry.id === 'ag')?.value;
    expect(agMetadata).toMatchObject({
      officialUrl: 'https://www.auktion-ag.ch',
      parserVersion: '1.1.0',
    });
    expect(agMetadata?.availableFields).not.toContain('startingPriceChf');
  });

  it('closes expired rows even when the upstream feed returns zero rows', async () => {
    const firestore = fakeFirestore([{
      id: 'gr-expired', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', normalizedPlate: 'GR2',
      auctionStatus: 'active', currentBidChf: 1200, endsAt: '2026-09-13T11:00:00.000Z',
      sourceFetchedAt: '2026-09-13T10:00:00.000Z', lastVerifiedAt: '2026-09-13T10:00:00.000Z',
      dataConfidence: 'partial',
    }]);
    const result = await refreshPlateAuctions({
      db: firestore.db as never,
      fetcher: async () => '',
      now: new Date('2026-09-13T12:00:00.000Z'),
    });
    expect(result.summaries.gr).toMatchObject({ status: 'degraded', rowCount: 0, closedExpired: 1 });
    expect(firestore.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: PLATE_AUCTION_COLLECTION, id: 'gr-expired', value: expect.objectContaining({ auctionStatus: 'closed', closedAt: '2026-09-13T11:00:00.000Z' }) }),
      expect.objectContaining({ collection: 'plate_auctions_history', id: expect.stringContaining('gr-expired-'), value: expect.objectContaining({ auctionStatus: 'closed' }) }),
    ]));
  });
});

/**
 * A Firestore that remembers between runs: merges, deletes and the
 * FieldValue.delete() sentinel are applied, so a second refresh reads what
 * the first one wrote — which is exactly where the ratchet lived.
 */
function statefulFirestore(initial: Record<string, unknown>[] = []) {
  type Doc = Record<string, unknown>;
  const stores: Record<string, Map<string, Doc>> = {
    [PLATE_AUCTION_COLLECTION]: new Map(initial.map((row) => [String(row.id), { ...row }])),
    [PLATE_AUCTION_SOURCE_COLLECTION]: new Map(),
    plate_auctions_history: new Map(),
  };
  const store = (name: string) => (stores[name] ||= new Map());
  const isDelete = (value: unknown) => value instanceof FieldValue && value.isEqual(FieldValue.delete());
  const apply = (name: string, id: string, value: Doc, merge: boolean) => {
    const next: Doc = merge ? { ...(store(name).get(id) || {}) } : {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (isDelete(fieldValue)) {
        if (!merge) throw new Error('FieldValue.delete() cannot be used with set() without merge');
        delete next[field];
      } else next[field] = fieldValue;
    }
    store(name).set(id, next);
  };
  const collection = (name: string) => ({
    doc: (id: string) => ({
      collection: name,
      id,
      async set(value: Doc, options?: { merge?: boolean }) { apply(name, id, value, options?.merge === true); },
    }),
    where: (field: string, _operator: string, value: unknown) => ({
      limit: () => ({
        get: async () => ({
          docs: [...store(name).entries()]
            .filter(([, doc]) => doc[field] === value)
            .map(([id, doc]) => ({ id, data: () => ({ ...doc }) })),
        }),
      }),
    }),
    limit: () => ({ get: async () => ({ docs: [] }) }),
  });
  return {
    db: {
      collection,
      batch() {
        const operations: Array<() => void> = [];
        return {
          set(ref: { collection: string; id: string }, value: Doc, options?: { merge?: boolean }) {
            operations.push(() => apply(ref.collection, ref.id, value, options?.merge === true));
          },
          delete(ref: { collection: string; id: string }) {
            operations.push(() => { store(ref.collection).delete(ref.id); });
          },
          async commit() { for (const operation of operations) operation(); },
        };
      },
    },
    current: stores[PLATE_AUCTION_COLLECTION],
    history: stores.plate_auctions_history,
    sources: stores[PLATE_AUCTION_SOURCE_COLLECTION],
  };
}

describe('plate-auction Firestore pipeline: a preserved loss converges instead of ratcheting', () => {
  // Relative dates only: what matters is the spacing between runs.
  const HOUR = 60 * 60 * 1000;
  const base = new Date();
  const at = (hours: number) => new Date(base.getTime() + hours * HOUR);
  const afterGrace = new Date(base.getTime() + PLATE_AUCTION_MISSING_GRACE_MS);
  // The SO eCari catalogue's fixed-price tab: rows without a deadline, the
  // only kind a disappearance can be read as a sale for.
  const soFixedPricePage = (plates: number[]) => `
    <div id="tabContent1"><table><tbody></tbody></table></div>
    <div id="tabContent3"><table><tbody>${plates.map((plate) => `
      <tr class="L"><td><a onclick="openDetails(${plate})"><div class="number">${plate}</div></a></td><td class="amount">${300 + plate}</td></tr>`).join('')}
    </tbody></table></div>`;
  const plates = (count: number) => Array.from({ length: count }, (_unused, index) => 100 + index);
  const refresh = (firestore: ReturnType<typeof statefulFirestore>, now: Date, listed: number[]) => refreshPlateAuctions({
    db: firestore.db as never,
    fetcher: async (url: string) => (url.includes('eauktion.so.ch') ? soFixedPricePage(listed) : ''),
    now,
  });
  const vanishedIds = ['so-fixed-116', 'so-fixed-117', 'so-fixed-118', 'so-fixed-119'];
  const stamped = (firestore: ReturnType<typeof statefulFirestore>) => [...firestore.current.values()]
    .filter((doc) => doc.sourceKey === 'SO' && doc.missingSince !== undefined);

  it('reports a sudden loss once, then records it after the grace window', async () => {
    const firestore = statefulFirestore();
    await refresh(firestore, at(-6), plates(20));
    // 20 → 16: four vanish against a cap of three, so the guard trips.
    const run1 = await refresh(firestore, at(0), plates(16));
    expect(run1.summaries.so).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared' });
    expect(stamped(firestore).map((doc) => doc.id).sort()).toEqual(vanishedIds);
    for (const doc of stamped(firestore)) expect(doc).toMatchObject({ auctionStatus: 'active', missingSince: at(0).toISOString() });

    // Same catalogue six hours later. Before, the four ghosts were judged
    // again with the same numbers and the source never left `degraded`.
    const run2 = await refresh(firestore, at(6), plates(16));
    expect(run2.summaries.so).toMatchObject({ status: 'active', rowCount: 16 });
    expect(stamped(firestore).map((doc) => doc.missingSince)).toEqual(Array(4).fill(at(0).toISOString()));
    expect([...firestore.history.values()].filter((doc) => doc.disappearedFromCatalogue)).toEqual([]);

    const run3 = await refresh(firestore, afterGrace, plates(16));
    expect(run3.summaries.so).toMatchObject({ status: 'active', rowCount: 16 });
    for (const id of vanishedIds) {
      const doc = firestore.current.get(id);
      expect(doc, id).toMatchObject({ auctionStatus: 'closed', disappearedFromCatalogue: true, dataConfidence: 'partial' });
      expect(doc, id).not.toHaveProperty('finalPriceChf');
      expect(doc, id).not.toHaveProperty('finalPriceVerifiedAt');
    }
    const recorded = [...firestore.history.values()].filter((doc) => doc.disappearedFromCatalogue);
    expect(recorded.map((doc) => doc.id).sort()).toEqual(vanishedIds);
  });

  it('never resolves an old absence on a run that may itself be truncated', async () => {
    const firestore = statefulFirestore();
    await refresh(firestore, at(-6), plates(20));
    await refresh(firestore, at(0), plates(16));
    // Past the grace window, but the page came back half as long.
    const run2 = await refresh(firestore, afterGrace, plates(8));
    expect(run2.summaries.so).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared' });
    expect([...firestore.history.values()].filter((doc) => doc.disappearedFromCatalogue)).toEqual([]);
    const stamps = stamped(firestore).reduce<Record<string, number>>((count, doc) => ({
      ...count, [String(doc.missingSince)]: (count[String(doc.missingSince)] || 0) + 1,
    }), {});
    expect(stamps).toEqual({ [at(0).toISOString()]: 4, [afterGrace.toISOString()]: 8 });
  });

  it('deletes the stamp when a preserved row is listed again', async () => {
    const firestore = statefulFirestore();
    await refresh(firestore, at(-6), plates(20));
    await refresh(firestore, at(0), plates(16));
    const run2 = await refresh(firestore, at(6), plates(20));
    expect(run2.summaries.so).toMatchObject({ status: 'active', rowCount: 20 });
    expect(stamped(firestore)).toEqual([]);
    for (const id of vanishedIds) expect(firestore.current.get(id)).not.toHaveProperty('missingSince');
  });
});

describe('plate-auction Firestore pipeline: an eCari page that says no auction is running', () => {
  const HOUR = 60 * 60 * 1000;
  const base = new Date();
  const at = (hours: number) => new Date(base.getTime() + hours * HOUR);
  const endedNwAuction = {
    id: 'nw-1491', sourceKey: 'NW', canton: 'Nidvaldo', platePrefix: 'NW', plateNumber: '1491', normalizedPlate: 'NW1491',
    listingType: 'auction', auctionStatus: 'active', startingPriceChf: 500, endsAt: at(-72).toISOString(),
    officialAuctionUrl: 'https://ecarinwprod.ilz.info/ecari-auction/', sourceFetchedAt: at(-80).toISOString(),
    lastVerifiedAt: at(-80).toISOString(), dataConfidence: 'partial', firstSeenAt: at(-150).toISOString(),
  };
  const refresh = (firestore: ReturnType<typeof statefulFirestore>, page: string) => refreshPlateAuctions({
    db: firestore.db as never,
    fetcher: async (url: string) => (url.includes('ecarinwprod.ilz.info') ? page : ''),
    now: at(0),
  });

  it('marks the source healthy and archives the ended rows', async () => {
    const firestore = statefulFirestore([endedNwAuction]);
    const result = await refresh(firestore, ECARI_NO_RUNNING_AUCTION);
    expect(result.summaries.nw).toMatchObject({ status: 'active', rowCount: 0 });
    expect(firestore.sources.get('nw')).toMatchObject({ status: 'active', errorCode: null, lastSuccessAt: at(0).toISOString() });
    expect(firestore.current.get('nw-1491')).toMatchObject({ auctionStatus: 'closed', closedAt: at(-72).toISOString() });
    expect([...firestore.history.keys()].some((id) => id.startsWith('nw-1491-'))).toBe(true);
  });

  it('keeps `zero_rows` for the same page without the explicit label', async () => {
    const firestore = statefulFirestore([endedNwAuction]);
    const result = await refresh(firestore, ECARI_NO_RUNNING_AUCTION.replaceAll('Keine laufende Versteigerung', ''));
    expect(result.summaries.nw).toMatchObject({ status: 'degraded', rowCount: 0 });
    expect(firestore.sources.get('nw')).toMatchObject({ status: 'degraded', errorCode: 'zero_rows' });
  });
});
