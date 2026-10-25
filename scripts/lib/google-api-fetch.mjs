const DEFAULT_GOOGLE_API_FETCH_TIMEOUT_MS = 30_000;
const MAX_GOOGLE_API_FETCH_TIMEOUT_MS = 120_000;

const configuredTimeout = Number(process.env.GOOGLE_API_FETCH_TIMEOUT_MS);
export const GOOGLE_API_FETCH_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? Math.min(Math.floor(configuredTimeout), MAX_GOOGLE_API_FETCH_TIMEOUT_MS)
  : DEFAULT_GOOGLE_API_FETCH_TIMEOUT_MS;

export function fetchGoogleApi(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(GOOGLE_API_FETCH_TIMEOUT_MS),
  });
}
