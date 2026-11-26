import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWorkdayJobs } = vi.hoisted(() => ({
  fetchWorkdayJobs: vi.fn(),
}));

vi.mock("../scripts/lib/ats-clients/workday-client.mjs", () => ({ fetchWorkdayJobs }));

import { fetchAllSwissJobs } from "../scripts/update-hamilton-jobs.mjs";

afterEach(() => {
  vi.clearAllMocks();
});

describe("Hamilton Workday crawler transport", () => {
  it("uses the shared Workday iterator with the Swiss facet", async () => {
    const listings = [
      { title: "Swiss role 1", externalPath: "/job/Bonaduz/Role_1" },
      { title: "Swiss role 2", externalPath: "/job/Zurich/Role_2" },
    ];
    let options;
    fetchWorkdayJobs.mockImplementation(async function* (apiBase, receivedOptions) {
      expect(apiBase).toBe("https://wd3.myworkdaysite.com/wday/cxs/hamilton/hamilton_jobs");
      options = receivedOptions;
      receivedOptions.stats.endReason = "short-page";
      yield* listings;
    });

    await expect(fetchAllSwissJobs()).resolves.toEqual(listings);
    expect(options).toEqual(expect.objectContaining({
      appliedFacets: {
        locationCountry: ["187134fccb084a0ea9b4b95f23890dbe"],
      },
      pageSize: 20,
      maxPages: 100,
      minDelayMs: 500,
    }));
  });

  it("fails closed when the shared iterator stops after a later-page error", async () => {
    fetchWorkdayJobs.mockImplementation(async function* (_apiBase, receivedOptions) {
      yield { title: "Only the first page", externalPath: "/job/Bonaduz/Partial" };
      receivedOptions.stats.endReason = "page-error";
    });

    await expect(fetchAllSwissJobs()).rejects.toThrow(
      /pagination stopped without an explicit complete end condition \(page-error\).*refusing to publish a partial crawl/i,
    );
  });

  it("fails closed when pagination reaches the safety cap", async () => {
    fetchWorkdayJobs.mockImplementation(async function* (_apiBase, receivedOptions) {
      yield { title: "First page only", externalPath: "/job/Bonaduz/Cap" };
      receivedOptions.stats.endReason = "max-pages";
    });

    await expect(fetchAllSwissJobs()).rejects.toThrow(
      /pagination stopped without an explicit complete end condition \(max-pages\).*refusing to publish a partial crawl/i,
    );
  });
});
