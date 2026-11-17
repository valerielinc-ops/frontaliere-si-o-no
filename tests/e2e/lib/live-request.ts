import { DEFAULT_LIVE_CHECK_USER_AGENT } from '../../../scripts/lib/live-link-check.mjs';

/**
 * Retry only transport failures and server errors while probing the live site.
 *
 * Live validation is deliberately strict about 4xx responses: a missing or
 * malformed route is a product failure, not something a retry can repair.
 * Publisher 44007052100 observed 503s on the `de` shard's company pages for
 * more than 9 minutes after publishing. Keep the six-attempt, 5 s phase 1,
 * then allow a 10-minute extended window for 5xx/transport failures. A
 * process-wide circuit breaker opens when that window expires with a 5xx, so
 * later requests in the same Playwright worker only pay phase 1.
 */

export interface LiveRequestOptions {
  headers?: Record<string, string>;
  maxRedirects?: number;
  timeout?: number;
}

export interface LiveResponse {
  status(): number;
}

export type LiveGet = (url: string, options?: LiveRequestOptions) => Promise<LiveResponse>;

export const LIVE_REQUEST_ATTEMPTS = 6;
export const LIVE_REQUEST_RETRY_DELAY_MS = 5_000;
export const LIVE_REQUEST_EXTENDED_DELAY_MS = 30_000;
export const LIVE_REQUEST_EXTENDED_BUDGET_MS = 10 * 60_000;

const LIVE_REQUEST_TIMEOUT_MARGIN_MS = 60_000;

let liveRequestExtendedCircuitOpen = false;

export function liveRequestTimeoutMs(perRequestTimeoutMs = 15_000): number {
  const requestTimeout = Math.max(0, perRequestTimeoutMs);
  const phaseOneMs =
    LIVE_REQUEST_ATTEMPTS * requestTimeout + (LIVE_REQUEST_ATTEMPTS - 1) * LIVE_REQUEST_RETRY_DELAY_MS;
  // The extended budget starts at the beginning of the whole request and
  // already includes phase 1; retain the full phase-one allowance here as a
  // conservative test timeout, then add one in-flight request and 60 s margin.
  return phaseOneMs + LIVE_REQUEST_EXTENDED_BUDGET_MS + requestTimeout + LIVE_REQUEST_TIMEOUT_MARGIN_MS;
}

export function resetLiveRequestCircuitForTests(): void {
  liveRequestExtendedCircuitOpen = false;
}

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
  const requestOptions = withDefaultUserAgent(options);
  const attempts = Math.max(1, Math.floor(retry.attempts ?? LIVE_REQUEST_ATTEMPTS));
  const delayMs = Math.max(0, retry.delayMs ?? LIVE_REQUEST_RETRY_DELAY_MS);
  const startedAt = Date.now();
  let lastOutcome: { type: 'response'; response: T } | { type: 'error'; error: unknown } | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await get(url, requestOptions);
      lastOutcome = { type: 'response', response };
      if (!isTransientStatus(response.status())) return response;
    } catch (error) {
      lastOutcome = { type: 'error', error };
    }

    if (attempt < attempts) await sleep(delayMs);
  }

  if (liveRequestExtendedCircuitOpen) return unwrapLastOutcome(lastOutcome, url);

  const deadline = startedAt + LIVE_REQUEST_EXTENDED_BUDGET_MS;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await sleep(Math.min(LIVE_REQUEST_EXTENDED_DELAY_MS, remainingMs));
    if (Date.now() >= deadline) break;

    try {
      const response = await get(url, requestOptions);
      lastOutcome = { type: 'response', response };
      if (!isTransientStatus(response.status())) return response;
    } catch (error) {
      lastOutcome = { type: 'error', error };
    }
  }

  if (lastOutcome?.type === 'response' && isTransientStatus(lastOutcome.response.status())) {
    liveRequestExtendedCircuitOpen = true;
  }

  return unwrapLastOutcome(lastOutcome, url);
}

function withDefaultUserAgent(options?: LiveRequestOptions): LiveRequestOptions {
  const headers = options?.headers ?? {};
  const hasUserAgent = Object.keys(headers).some((header) => header.toLowerCase() === 'user-agent');
  return {
    ...options,
    headers: hasUserAgent ? { ...headers } : { ...headers, 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT },
  };
}

function unwrapLastOutcome<T extends LiveResponse>(
  outcome: { type: 'response'; response: T } | { type: 'error'; error: unknown } | undefined,
  url: string,
): T {
  if (!outcome) throw new Error(`live request failed: ${url}`);
  if (outcome.type === 'response') return outcome.response;
  throw outcome.error;
}
