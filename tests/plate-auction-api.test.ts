import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPlateAuctionSnapshot, parsePlateAuctionApiSnapshot, parsePlateAuctionEditorialSnapshot, sanitizePublicPlateAuction } from '../services/plateAuctions/api';

const base = {
  id: 'zh-43423', sourceKey: 'ZH', canton: 'Zurigo', platePrefix: 'ZH', plateNumber: '626', normalizedPlate: 'ZH626',
  auctionStatus: 'active', officialAuctionUrl: 'https://example.test/auction', sourceFetchedAt: '2026-09-13T12:00:00.000Z', lastVerifiedAt: '2026-09-13T12:00:00.000Z', dataConfidence: 'partial', rawSnapshotHash: 'abc123', currentBidChf: 1000,
};

describe('plate-auction public API contract', () => {
  it('drops bidder/winner fields at the public allow-list boundary', () => {
    const result = sanitizePublicPlateAuction({ ...base, bidder: 'private', winnerName: 'private', lastBidder: 'private' });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('bidder');
    expect(result).not.toHaveProperty('winnerName');
    expect(result).not.toHaveProperty('lastBidder');
  });

  it('recomputes counts and accepts a sanitized observation history', () => {
    const snapshot = parsePlateAuctionApiSnapshot({
      schema: 1,
      generatedAt: '2026-09-13T12:00:00.000Z',
      sources: {},
      auctions: [base],
      history: [{ ...base, currentBidChf: 900 }],
    });
    expect(snapshot.counts).toEqual({ active: 1, upcoming: 0, closed: 0, finalsVerified: 0, cantonsWithData: 1 });
    expect(snapshot.history).toHaveLength(1);
  });

  it('counts only closed records with a verified final price', () => {
    const snapshot = parsePlateAuctionApiSnapshot({
      schema: 1,
      generatedAt: '2026-09-13T12:00:00.000Z',
      sources: {},
      auctions: [
        { ...base, id: 'active-with-final-field', finalPriceChf: 5000, dataConfidence: 'verified' },
        { ...base, id: 'sold-verified', auctionStatus: 'sold', finalPriceChf: 5000, finalPriceVerifiedAt: '2026-09-13T12:00:00.000Z', dataConfidence: 'verified' },
      ],
    });
    expect(snapshot.counts.finalsVerified).toBe(1);
  });

  it('rejects a snapshot explicitly marked incomplete', () => {
    expect(() => parsePlateAuctionApiSnapshot({
      schema: 1,
      complete: false,
      generatedAt: '2026-09-13T12:00:00.000Z',
      sources: {},
      auctions: [],
    })).toThrow('Incomplete plate-auction snapshot');
  });

  it('accepts the corpus editorial companion through its own allow-list', () => {
    const block = { title: 'Guide', excerpt: 'Summary', paragraphs: ['One paragraph'], bullets: ['One point'] };
    const weekly = { ...block, status: 'ready', highlights: [{ plate: 'GR 7', currentPriceChf: 700, officialUrl: 'https://example.test/auction', bidderName: 'private' }] };
    const editorial = parsePlateAuctionEditorialSnapshot({
      schema: 1,
      generatedAt: '2026-09-13T12:00:00.000Z',
      status: 'ready',
      source: { upstreamGeneratedAt: null, currentRows: 1, historyRows: 0, finalRows: 0, cantons: 1 },
      evergreen: { it: block },
      weekly: { it: weekly },
    });
    expect(editorial?.weekly.it.highlights?.[0]).not.toHaveProperty('bidderName');
    expect(editorial?.weekly.it.highlights?.[0].plate).toBe('GR 7');
  });
});

describe('plate-auction snapshot source order', () => {
  const snapshot = { schema: 1, complete: true, generatedAt: '2026-09-13T12:00:00.000Z', sources: {}, auctions: [base] };
  const respond = (status: number, body: unknown = snapshot) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // One uncached function build is ~22'700 billed Firestore reads: every page
  // view must be served by the static CDN snapshot, never by the function.
  it('reads the static snapshot and never calls the function when it is served', async () => {
    const fetchMock = vi.fn(async () => respond(200));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPlateAuctionSnapshot();
    expect(result.auctions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/data\/plate-auctions\.json$/);
  });

  it('falls back to the function only when the static snapshot fails', async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url).endsWith('/data/plate-auctions.json') ? respond(404, {}) : respond(200)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPlateAuctionSnapshot();
    expect(result.auctions).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/data/plate-auctions.json',
      'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPlateAuctions',
    ]);
  });
});
