// Shared GA4/Google service-account auth + HTTP retry helpers.
// Canonical source for logic previously copy-pasted across
// analytics-report.mjs, setup-ga4-user-dimensions.mjs, user-value-report.mjs
// (AGENTS.md #6 — literal duplication extracted to prevent drift).

export const DEFAULT_GA4_PROPERTY_ID = 'properties/524485296';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchRetry(url, options = {}, retries = 2, timeoutMs = 0) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const fetchOptions = { ...options };
      if (timeoutMs > 0) {
        fetchOptions.signal = AbortSignal.timeout(timeoutMs);
      }
      const res = await fetch(url, fetchOptions);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
        const delay = res.status === 429 ? 10000 * attempt : 2000 * attempt;
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt <= retries) {
        await sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

// logInfo/logError default to console; callers with their own gated logger
// (e.g. analytics-report.mjs's --json-aware log()) can inject theirs so
// output-suppression behavior is preserved.
export async function getServiceAccountToken(scopes, { logInfo = console.log, logError = console.error } = {}) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes });
    const client = await auth.getClient();
    // Log SA email for diagnostics (not a secret — it's a public GCP identifier)
    if (client.email) logInfo(`ℹ️  Using service account: ${client.email}`);
    const { token } = await client.getAccessToken();
    return token;
  } catch (e) {
    logError(`⚠️  Service account auth failed: ${e.message}`);
    return null;
  }
}
