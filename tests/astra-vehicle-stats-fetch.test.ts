import { describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  isRetryableFetchError,
} from "../scripts/lib/astra-vehicle-stats-fetch.mjs";

function response(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
  };
}

describe("ASTRA upstream fetch retry", () => {
  it("retries transient network failures with fresh request options", async () => {
    const requestOptions = vi.fn(() => ({ signal: {} }));
    const sleep = vi.fn(async () => {});
    let calls = 0;

    const result = await fetchWithRetry("https://example.test/data", requestOptions, {
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("fetch failed");
        return response(200);
      },
      sleepImpl: sleep,
      baseDelayMs: 10,
    });

    expect(result.status).toBe(200);
    expect(calls).toBe(3);
    expect(requestOptions).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("retries transient HTTP responses but leaves permanent responses to the caller", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;

    const result = await fetchWithRetry("https://example.test/data", {}, {
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? response(503) : response(200);
      },
      sleepImpl: sleep,
      baseDelayMs: 10,
    });

    expect(result.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();

    const permanent = await fetchWithRetry("https://example.test/data", {}, {
      fetchImpl: async () => response(404),
      sleepImpl: sleep,
    });
    expect(permanent.status).toBe(404);
  });

  it("fails closed with the attempt context after transient failures are exhausted", async () => {
    await expect(
      fetchWithRetry("https://example.test/data", {}, {
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
        sleepImpl: async () => {},
        baseDelayMs: 0,
      }),
    ).rejects.toThrow(/failed after 3 attempt\(s\): TypeError: fetch failed/);
  });

  it("does not classify parser errors as retryable network failures", () => {
    expect(isRetryableFetchError(new Error("invalid TSV"))).toBe(false);
    expect(isRetryableFetchError(new TypeError("fetch failed"))).toBe(true);
  });
});
