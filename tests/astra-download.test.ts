import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAstraDownload } from "../scripts/lib/astra-download.mjs";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function abortError(message: string) {
  return Object.assign(new Error(message), { name: "AbortError" });
}

describe("fetchAstraDownload", () => {
  it("restarts the GET when a 200 body stalls after headers", async () => {
    let attempt = 0;
    global.fetch = vi.fn((_url: unknown, options: RequestInit = {}) => {
      attempt += 1;
      if (attempt === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            options.signal?.addEventListener("abort", () => controller.error(abortError("body stalled")), { once: true });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.resolve(new Response("recovered", { status: 200 }));
    }) as typeof fetch;

    await expect(
      fetchAstraDownload(
        "https://astra.test/file.tsv",
        {},
        { timeout: 10, retries: 1, retryBaseMs: 0, label: "ASTRA test" },
        (response) => response.text(),
      ),
    ).resolves.toBe("recovered");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("restarts the GET when the 200 body rejects with ECONNRESET", async () => {
    let attempt = 0;
    global.fetch = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.resolve(new Response("recovered", { status: 200 }));
    }) as typeof fetch;

    await expect(
      fetchAstraDownload(
        "https://astra.test/file.tsv",
        {},
        { timeout: 1_000, retries: 1, retryBaseMs: 0, label: "ASTRA test" },
        (response) => response.text(),
      ),
    ).resolves.toBe("recovered");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
