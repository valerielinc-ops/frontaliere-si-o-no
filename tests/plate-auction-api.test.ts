import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPlateAuctionSnapshot, parsePlateAuctionApiSnapshot, PLATE_AUCTION_STATIC_MAX_AGE_MS, parsePlateAuctionEditorialSnapshot, sanitizePublicPlateAuction } from '../services/plateAuctions/api';

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
  const FUNCTION_URL = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPlateAuctions';
  const NOW = Date.parse('2026-10-01T18:00:00.000Z');
  const snapshotAt = (generatedAt: string, id = base.id) => ({ schema: 1, complete: true, generatedAt, sources: {}, auctions: [{ ...base, id }] });
  const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const isStatic = (url: unknown) => String(url).endsWith('/data/plate-auctions.json');

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // One uncached function build is ~22'700 billed Firestore reads plus ~17 MB
  // of egress: a fresh static snapshot must serve the page on its own.
  it('reads a fresh static snapshot and never calls the function', async () => {
    const fetchMock = vi.fn(async () => respond(200, snapshotAt('2026-10-01T05:58:27.416Z')));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPlateAuctionSnapshot(NOW);
    expect(result.generatedAt).toBe('2026-10-01T05:58:27.416Z');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/data\/plate-auctions\.json$/);
  });

  it('prefers the function when the static snapshot is older than the max age', async () => {
    const staleAt = new Date(NOW - PLATE_AUCTION_STATIC_MAX_AGE_MS - 60 * 60 * 1000).toISOString();
    const freshAt = new Date(NOW).toISOString();
    const fetchMock = vi.fn(async (url: unknown) => (isStatic(url) ? respond(200, snapshotAt(staleAt, 'zh-static')) : respond(200, snapshotAt(freshAt, 'zh-function'))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPlateAuctionSnapshot(NOW);
    expect(result.generatedAt).toBe(freshAt);
    expect(result.auctions[0].id).toBe('zh-function');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/data/plate-auctions.json', FUNCTION_URL]);
  });

  // A future generatedAt made now - generatedAt negative and passed the bound.
  it('treats a static snapshot dated in the future as not fresh', async () => {
    const futureAt = new Date(NOW + 90 * 24 * 60 * 60 * 1000).toISOString();
    const freshAt = new Date(NOW - 60 * 1000).toISOString();
    const fetchMock = vi.fn(async (url: unknown) => (isStatic(url) ? respond(200, snapshotAt(futureAt, 'zh-static')) : respond(200, snapshotAt(freshAt, 'zh-function'))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPlateAuctionSnapshot(NOW);
    expect(result.auctions[0].id).toBe('zh-function');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/data/plate-auctions.json', FUNCTION_URL]);
  });

  it('keeps the stale static snapshot when the function fails too', async () => {
    const staleAt = new Date(NOW - PLATE_AUCTION_STATIC_MAX_AGE_MS - 1).toISOString();
    const fetchMock = vi.fn(async (url: unknown) => (isStatic(url) ? respond(200, snapshotAt(staleAt)) : respond(503, {})));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPlateAuctionSnapshot(NOW);
    expect(result.generatedAt).toBe(staleAt);
  });

  it('falls back to the function when the static snapshot fails', async () => {
    const fetchMock = vi.fn(async (url: unknown) => (isStatic(url) ? respond(404, {}) : respond(200, snapshotAt('2026-10-01T17:50:00.000Z'))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPlateAuctionSnapshot(NOW);
    expect(result.generatedAt).toBe('2026-10-01T17:50:00.000Z');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/data/plate-auctions.json', FUNCTION_URL]);
  });

  it('fails only when neither source answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(503, {})));
    await expect(fetchPlateAuctionSnapshot(NOW)).rejects.toThrow('Plate-auction data unavailable: HTTP 503');
  });
});
