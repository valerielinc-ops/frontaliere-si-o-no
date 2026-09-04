// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  inspectCorpusRecoveryBatch,
  inspectCorpusRecoveryCrawler,
  nextCrawlerState,
  selectNewestCrawlerObservation,
} from "../../scripts/check-crawler-health.mjs";

const FIXTURE_DIR = resolve(
  import.meta.dirname,
  "../fixtures/crawler-health-corpus-recovery",
);
const NOW_MS = Date.parse("2026-09-01T06:30:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8"));
}

function payloadFetch(
  summary: Record<string, unknown>,
  slice: Record<string, unknown>,
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const payload = url.includes("jobs-crawler-summaries") ? summary : slice;
    return {
      ok: true,
      json: async () => structuredClone(payload),
    } as Response;
  });
}

function previousBrokenState(freshnessAt: string) {
  return {
    lastSuccessfulRunAt: "2026-08-24T21:48:49.067Z",
    lastNonZeroJobs: 2,
    consecutiveEmptyRuns: 4,
    consecutiveEmptyOkRuns: 4,
    status: "broken",
    _lastObservedJobs: 0,
    _lastObservedEmptyOk: false,
    _lastObservedFreshnessAt: freshnessAt,
  };
}

function siteObservation(
  summary = fixture("site-summary-stale.json"),
  slice = fixture("site-slice-stale.json"),
) {
  const generatedAt = String(summary.generatedAt);
  return {
    slug: "recruitingapp-2563",
    freshnessAt: generatedAt,
    freshnessSource: "summary",
    generatedAt,
    assembledAt: String(slice.assembledAt),
    jobCount: Number(summary.total),
    activeJobCount: Array.isArray(slice.jobs) ? slice.jobs.length : 0,
    discovered: summary.discovered ?? null,
    written: summary.written ?? null,
  };
}

describe("crawler-health corpus recovery evidence", () => {
  it("recovers #6660 from the newer corpus run while the site summary is stale", async () => {
    const site = siteObservation();
    const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
      baseUrl: "https://fixtures.invalid/data",
      fetchImpl: payloadFetch(
        fixture("corpus-summary-current.json"),
        fixture("corpus-slice-current.json"),
      ),
    });

    const selected = selectNewestCrawlerObservation(site, corpus, NOW_MS);
    expect(selected.freshnessSource).toBe("corpus-summary");
    expect(selected.jobCount).toBe(3);

    const { status, state } = nextCrawlerState(
      previousBrokenState(site.freshnessAt),
      selected,
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe("healthy");
    expect(state.consecutiveEmptyRuns).toBe(0);
    expect(state.lastNonZeroJobs).toBe(3);
  });

  it("does not hide a genuine newer zero published by the corpus", async () => {
    const site = siteObservation();
    const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
      baseUrl: "https://fixtures.invalid/data",
      fetchImpl: payloadFetch(
        fixture("corpus-summary-current-zero.json"),
        fixture("corpus-slice-current-zero.json"),
      ),
    });
    const selected = selectNewestCrawlerObservation(site, corpus, NOW_MS);

    const { status, state } = nextCrawlerState(
      {
        ...previousBrokenState(site.freshnessAt),
        consecutiveEmptyRuns: 2,
        consecutiveEmptyOkRuns: 2,
      },
      selected,
      NOW_ISO,
      NOW_MS,
    );
    expect(selected.jobCount).toBe(0);
    expect(status).toBe("broken");
    expect(state.consecutiveEmptyRuns).toBe(3);
  });

  it("keeps a newer site zero authoritative over an older corpus non-zero", async () => {
    const newerSiteSummary = {
      ...fixture("site-summary-stale.json"),
      generatedAt: "2026-09-01T01:00:00.000Z",
      total: 0,
    };
    const site = siteObservation(newerSiteSummary);
    const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
      baseUrl: "https://fixtures.invalid/data",
      fetchImpl: payloadFetch(
        fixture("corpus-summary-current.json"),
        fixture("corpus-slice-current.json"),
      ),
    });

    const selected = selectNewestCrawlerObservation(site, corpus, NOW_MS);
    expect(selected).toBe(site);
    expect(selected.jobCount).toBe(0);
  });

  it("rejects a future-dated corpus payload instead of suppressing the site alert", async () => {
    const site = siteObservation();
    const futureSummary = {
      ...fixture("corpus-summary-current.json"),
      generatedAt: "2026-09-01T07:00:01.000Z",
    };
    const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
      baseUrl: "https://fixtures.invalid/data",
      fetchImpl: payloadFetch(
        futureSummary,
        fixture("corpus-slice-current.json"),
      ),
    });

    expect(selectNewestCrawlerObservation(site, corpus, NOW_MS)).toBe(site);
  });

  it("fails closed to the site observation when corpus HTTP recovery is unavailable", async () => {
    const site = siteObservation();
    const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
      baseUrl: "https://fixtures.invalid/data",
      fetchImpl: vi.fn(async () => ({ ok: false }) as Response),
    });

    expect(corpus).toBeNull();
    expect(selectNewestCrawlerObservation(site, corpus, NOW_MS)).toBe(site);
  });

  it("rejects a corpus summary without a non-negative integer total", async () => {
    const malformed = {
      ...fixture("corpus-summary-current.json"),
      total: "not-a-count",
    };
    const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
      baseUrl: "https://fixtures.invalid/data",
      fetchImpl: payloadFetch(malformed, fixture("corpus-slice-current.json")),
    });

    expect(corpus).toBeNull();
  });

  it.each([null, true, "3"])(
    "rejects coercible but non-numeric total=%j",
    async (total) => {
      const malformed = {
        ...fixture("corpus-summary-current.json"),
        total,
      };
      const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
        baseUrl: "https://fixtures.invalid/data",
        fetchImpl: payloadFetch(
          malformed,
          fixture("corpus-slice-current.json"),
        ),
      });

      expect(corpus).toBeNull();
    },
  );

  it.each(["missing", "mismatched"])(
    "rejects a summary with a %s crawler key",
    async (variant) => {
      const malformed = fixture("corpus-summary-current.json");
      if (variant === "missing") delete malformed.key;
      else malformed.key = "another-crawler";
      const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
        baseUrl: "https://fixtures.invalid/data",
        fetchImpl: payloadFetch(
          malformed,
          fixture("corpus-slice-current.json"),
        ),
      });

      expect(corpus).toBeNull();
    },
  );

  it("does not coerce boolean discovery metadata into an auto-filter signal", async () => {
    const malformedMetadata = {
      ...fixture("corpus-summary-current-zero.json"),
      discovered: true,
      written: "0",
    };
    const corpus = await inspectCorpusRecoveryCrawler("recruitingapp-2563", {
      baseUrl: "https://fixtures.invalid/data",
      fetchImpl: payloadFetch(
        malformedMetadata,
        fixture("corpus-slice-current-zero.json"),
      ),
    });

    expect(corpus?.discovered).toBeNull();
    expect(corpus?.written).toBeNull();
    const { status, state } = nextCrawlerState(
      {
        ...previousBrokenState(siteObservation().freshnessAt),
        consecutiveEmptyRuns: 2,
        consecutiveEmptyOkRuns: 2,
      },
      corpus,
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe("broken");
    expect(state._autoFilteredEmpty).toBe(false);
  });

  it("returns site-authoritative fallback promptly when all corpus fetches hang", async () => {
    const hangingFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const startedAt = Date.now();
    const results = await inspectCorpusRecoveryBatch(
      ["crawler-one", "crawler-two", "crawler-three"],
      {
        baseUrl: "https://fixtures.invalid/data",
        fetchImpl: hangingFetch,
        concurrency: 2,
        deadlineMs: 20,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(hangingFetch).toHaveBeenCalledTimes(4);
    expect(results.size).toBe(0);
  });
});
