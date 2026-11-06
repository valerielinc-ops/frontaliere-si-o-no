/**
 * Retry only transport failures and server errors while probing the live site.
 *
 * Live validation is deliberately strict about 4xx responses: a missing or
 * malformed route is a product failure, not something a retry can repair.
 * Edge timeouts and 5xx responses are different. A Pages/Fastly edge can be
 * briefly unavailable while the deploy is settling, and a second request is
 * enough to distinguish that transient from a reproducible failure.
 */

export interface LiveRequestOptions {
  maxRedirects?: number;
  timeout?: number;
}

export interface LiveResponse {
  status(): number;
}

export type LiveGet = (url: string, options?: LiveRequestOptions) => Promise<LiveResponse>;

export const LIVE_REQUEST_ATTEMPTS = 2;
export const LIVE_REQUEST_RETRY_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

export async function getLiveWithRetry<T extends LiveResponse>(
  get: (url: string, options?: LiveRequestOptions) => Promise<T>,
  url: string,
  options?: LiveRequestOptions,
  retry: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(retry.attempts ?? LIVE_REQUEST_ATTEMPTS));
  const delayMs = Math.max(0, retry.delayMs ?? LIVE_REQUEST_RETRY_DELAY_MS);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await get(url, options);
      if (!isTransientStatus(response.status()) || attempt === attempts) return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await sleep(delayMs);
  }

  throw lastError instanceof Error ? lastError : new Error(`live request failed: ${url}`);
}
