import { describe, expect, it } from "vitest";
import { getPublicPlateAuctionSnapshot } from "../functions/src/plateAuctions.js";

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
