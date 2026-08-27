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

/**
 * One day's `pagePath` × `pageTitle` × `screenPageViews` report, the exact
 * shape scripts/lib/daily-top-content.mjs#rankCandidates expects.
 *
 * Shared by every GA4-ranked social poster (LinkedIn member, Instagram,
 * TikTok) — project rule: a helper duplicated literally in ≥2 files MUST
 * live in ONE shared module. Originally lived only in
 * post-to-linkedin-member.mjs.
 *
 * @param {string} day 'YYYY-MM-DD'
 * @param {{ propertyId?: string }} [opts]
 * @returns {Promise<Array<{path:string, title:string, views:number}>|null>} null on any failure
 */
export async function fetchGa4PageReport(day, { propertyId } = {}) {
  const token = await getServiceAccountToken(['https://www.googleapis.com/auth/analytics.readonly']);
  if (!token) return null;

  const raw = propertyId || process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  const property = raw.startsWith('properties/') ? raw : `properties/${raw}`;

  const res = await fetchRetry(
    `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: day, endDate: day }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10000,
      }),
    },
  );
  if (!res?.ok) {
    console.warn(`⚠️  GA4 runReport failed (${res?.status}) — nothing to post`);
    return null;
  }
  const data = await res.json();
  if (data.error) {
    console.warn(`⚠️  GA4 error: ${JSON.stringify(data.error).slice(0, 200)}`);
    return null;
  }
  return (data.rows || []).map((r) => ({
    path: r.dimensionValues?.[0]?.value || '',
    title: r.dimensionValues?.[1]?.value || '',
    views: parseInt(r.metricValues?.[0]?.value || '0', 10),
  }));
}
