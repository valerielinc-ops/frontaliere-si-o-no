const DEFAULT_GOOGLE_API_FETCH_TIMEOUT_MS = 30_000;
const MAX_GOOGLE_API_FETCH_TIMEOUT_MS = 120_000;

export function normalizeGoogleApiFetchTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GOOGLE_API_FETCH_TIMEOUT_MS;
  const floored = Math.floor(parsed);
  return floored > 0
    ? Math.min(floored, MAX_GOOGLE_API_FETCH_TIMEOUT_MS)
    : DEFAULT_GOOGLE_API_FETCH_TIMEOUT_MS;
}

export const GOOGLE_API_FETCH_TIMEOUT_MS = normalizeGoogleApiFetchTimeout(
  process.env.GOOGLE_API_FETCH_TIMEOUT_MS,
);

export function fetchGoogleApi(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(GOOGLE_API_FETCH_TIMEOUT_MS),
  });
}
