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
  it("does not resurrect rows or degraded status from a blocked source", async () => {
    const snapshot = await getPublicPlateAuctionSnapshot(
      makeDb({
        auctions: [
          row(),
          row({
            id: "ti-old",
            sourceKey: "TI",
            canton: "Ticino",
            platePrefix: "TI",
            plateNumber: "1",
            normalizedPlate: "TI1",
            officialAuctionUrl: "https://www.carieauktion.ti.ch/ecari-auktion/",
          }),
        ],
        sources: [
          {
            id: "ti",
            canton: "Ticino",
            plateCode: "TI",
            officialUrl: "https://www.ti.ch/sportello/targhe",
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
    expect(snapshot.sources.ti).toMatchObject({
      status: "blocked",
      rowCount: 0,
    });
    expect(snapshot.sources.ti).not.toHaveProperty("errorCode");
  });
});
