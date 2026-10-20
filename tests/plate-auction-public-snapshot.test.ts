import { gunzipSync, gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptsGzip,
  PLATE_AUCTION_PUBLISHED_SNAPSHOT_MAX_AGE_MS,
  PLATE_AUCTION_SNAPSHOT_OBJECT,
  publishPublicPlateAuctionSnapshot,
  getCachedPublicPlateAuctionSnapshotBody,
  getPublicPlateAuctionSnapshot,
  PLATE_AUCTION_SNAPSHOT_CACHE_MS,
  resetPublicPlateAuctionSnapshotCache,
} from "../functions/src/plateAuctions.js";

function makeDb({ auctions = [], sources = [], history = [] } = {}) {
  return {
    collection(name: string) {
      const rows =
        name === "plate_auctions_current"
          ? auctions
          : name === "plate_auction_sources"
            ? sources
            : history;
      return {
        limit: () => ({
          get: async () => ({
            docs: rows.map((value) => ({
              id: String(value.id),
              data: () => value,
            })),
          }),
        }),
        orderBy: () => ({
          limit: () => ({
            get: async () => ({
              docs: rows.map((value) => ({
                id: String(value.id),
                data: () => value,
              })),
            }),
          }),
        }),
      };
    },
  };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "zh-1",
  sourceKey: "ZH",
  canton: "Zurigo",
  platePrefix: "ZH",
  plateNumber: "1",
  normalizedPlate: "ZH1",
  auctionStatus: "active",
  officialAuctionUrl: "https://www.auktion.stva.zh.ch/",
  sourceFetchedAt: "2026-09-14T12:00:00.000Z",
  lastVerifiedAt: "2026-09-14T12:00:00.000Z",
  dataConfidence: "partial",
  rawSnapshotHash: "hash",
  ...overrides,
});

describe("public plate-auction snapshot source gating", () => {
  it("matches active sources case-insensitively", async () => {
    const snapshot = await getPublicPlateAuctionSnapshot(
      makeDb({ auctions: [row({ sourceKey: "zh", platePrefix: "zh" })] }) as never,
    );

    expect(snapshot.auctions).toHaveLength(1);
    expect(snapshot.auctions[0].sourceKey).toBe("zh");
  });

  it("does not resurrect rows or degraded status from a blocked source", async () => {
    const snapshot = await getPublicPlateAuctionSnapshot(
      makeDb({
        auctions: [
          row(),
          row({
            id: "ne-old",
            sourceKey: "NE",
            canton: "Neuchâtel",
            platePrefix: "NE",
            plateNumber: "1",
            normalizedPlate: "NE1",
            officialAuctionUrl: "https://www.ricardo.ch/de/shop/ENCHERES-PLAQUES-NE/offers/",
          }),
        ],
        sources: [
          {
            id: "ne",
            canton: "Neuchâtel",
            plateCode: "NE",
            officialUrl: "https://www.ricardo.ch/de/shop/ENCHERES-PLAQUES-NE/offers/",
            status: "degraded",
            rowCount: 1,
            errorCode: "source_disappeared",
          },
        ],
      }) as never,
    );

    expect(snapshot.auctions.map((auction) => auction.sourceKey)).toEqual([
      "ZH",
    ]);
    expect(snapshot.sources.ne).toMatchObject({
      status: "blocked",
      rowCount: 0,
    });
    expect(snapshot.sources.ne).not.toHaveProperty("errorCode");
  });
});

describe("public plate-auction snapshot cache", () => {
  beforeEach(() => {
    resetPublicPlateAuctionSnapshotCache();
  });

  // Counts builds: each one opens the current collection exactly once.
  function countingDb(options: Parameters<typeof makeDb>[0] = {}) {
    const db = makeDb(options);
    const counter = { builds: 0, fail: false };
    return {
      counter,
      db: {
        collection(name: string) {
          if (name === "plate_auctions_current") counter.builds += 1;
          if (counter.fail) throw new Error("firestore unavailable");
          return db.collection(name);
        },
      },
    };
  }

  it("shares one build between concurrent requests and reuses it within the TTL", async () => {
    const { db, counter } = countingDb({ auctions: [row()] });
    let clock = 1_000;
    const now = () => clock;
    const bodies = await Promise.all(
      Array.from({ length: 5 }, () => getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: null, now })),
    );
    expect(counter.builds).toBe(1);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0].body.toString("utf8")).auctions).toHaveLength(1);

    clock += PLATE_AUCTION_SNAPSHOT_CACHE_MS - 1;
    await getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: null, now });
    expect(counter.builds).toBe(1);

    clock += 1;
    await getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: null, now });
    expect(counter.builds).toBe(2);
  });

  it("does not cache a failed build", async () => {
    const { db, counter } = countingDb({ auctions: [row()] });
    counter.fail = true;
    await expect(getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: null })).rejects.toThrow("firestore unavailable");
    counter.fail = false;
    const { body } = await getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: null });
    expect(JSON.parse(body.toString("utf8")).auctions).toHaveLength(1);
    expect(counter.builds).toBe(2);
  });

  // Uncompressed, every answered call was ~16.5 MB of internet egress.
  it("keeps a gzip copy that decodes to the same body and is much smaller", async () => {
    const auctions = Array.from({ length: 200 }, (_, index) => row({ id: `zh-${index}`, plateNumber: String(index), normalizedPlate: `ZH${index}` }));
    const { db } = countingDb({ auctions });
    const { body, gzip } = await getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: null });
    expect(gunzipSync(gzip).equals(body)).toBe(true);
    expect(gzip.length * 5).toBeLessThan(body.length);
  });
});

describe("acceptsGzip", () => {
  it("accepts gzip only when the client names it with a non-zero quality", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("deflate, br")).toBe(false);
    expect(acceptsGzip("*")).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });
});

describe("published plate-auction snapshot (Cloud Storage)", () => {
  beforeEach(() => {
    resetPublicPlateAuctionSnapshotCache();
  });

  const NOW = Date.parse("2026-10-02T06:00:00.000Z");
  const published = (generatedAt: string) => gzipSync(Buffer.from(JSON.stringify({ schema: 1, complete: true, generatedAt, sources: {}, auctions: [row({ id: "zh-published" })] })));
  const bucketWith = (download: () => Promise<[Buffer]>) => ({ file: (name: string) => ({ name, download }) });
  function countingDb() {
    const counter = { builds: 0 };
    const db = makeDb({ auctions: [row({ id: "zh-firestore" })] });
    return { counter, db: { collection(name: string) { if (name === "plate_auctions_current") counter.builds += 1; return db.collection(name); } } };
  }

  // On 2026-10-02 the calls left were minutes apart and rebuilt from Firestore
  // on cold instances, ~22'700 reads each: a fresh published object must serve
  // without touching Firestore.
  it("serves a fresh published object without reading Firestore", async () => {
    const { db, counter } = countingDb();
    const bucket = bucketWith(async () => [published("2026-10-02T05:49:00.000Z")]);
    const { body, gzip } = await getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: bucket as never, now: () => NOW });
    expect(counter.builds).toBe(0);
    expect(JSON.parse(body.toString("utf8")).auctions[0].id).toBe("zh-published");
    expect(gunzipSync(gzip).equals(body)).toBe(true);
  });

  it("rebuilds from Firestore when the object is stale, dated in the future, missing or corrupt", async () => {
    const cases: Array<() => Promise<[Buffer]>> = [
      async () => [published(new Date(NOW - PLATE_AUCTION_PUBLISHED_SNAPSHOT_MAX_AGE_MS - 1).toISOString())],
      async () => [published("2027-01-01T00:00:00.000Z")],
      async () => { throw Object.assign(new Error("No such object"), { code: 404 }); },
      async () => [Buffer.from("not gzip")],
    ];
    for (const download of cases) {
      resetPublicPlateAuctionSnapshotCache();
      const { db, counter } = countingDb();
      const { body } = await getCachedPublicPlateAuctionSnapshotBody({ db: db as never, bucket: bucketWith(download) as never, now: () => NOW });
      expect(counter.builds).toBe(1);
      expect(JSON.parse(body.toString("utf8")).auctions[0].id).toBe("zh-firestore");
    }
  });

  it("publishes a gzip object that decodes to the public snapshot", async () => {
    const saved: Array<{ name: string; data: Buffer; options: Record<string, unknown> }> = [];
    const bucket = { file: (name: string) => ({ save: async (data: Buffer, options: Record<string, unknown>) => { saved.push({ name, data, options }); } }) };
    const result = await publishPublicPlateAuctionSnapshot({ db: makeDb({ auctions: [row()] }) as never, bucket: bucket as never });
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe(PLATE_AUCTION_SNAPSHOT_OBJECT);
    expect(saved[0].options).toMatchObject({ contentType: "application/gzip" });
    const decoded = JSON.parse(gunzipSync(saved[0].data).toString("utf8"));
    expect(decoded.auctions).toHaveLength(1);
    expect(result).toMatchObject({ auctions: 1, bytes: saved[0].data.length, generatedAt: decoded.generatedAt });
  });
});

