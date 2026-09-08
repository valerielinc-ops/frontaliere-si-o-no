// Shared GA4/Google service-account auth + HTTP retry helpers.
// Canonical source for logic previously copy-pasted across
// analytics-report.mjs, setup-ga4-user-dimensions.mjs, user-value-report.mjs
// (AGENTS.md #6 — literal duplication extracted to prevent drift).
import { settledWindow } from './analytics-settled-window.mjs';

export const DEFAULT_GA4_PROPERTY_ID = 'properties/524485296';
export const GA4_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

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
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const authOptions = { scopes };
    // CI normally exposes a path, while the Remote Config loader exposes the
    // same credential as JSON. Keep both routes in the canonical helper so a
    // fallback cannot appear configured locally and disappear in Actions.
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      authOptions.credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }
    const auth = new GoogleAuth(authOptions);
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

export function ga4DateRange(windowDays, lagDays = 2, now = new Date()) {
  const { start, end } = settledWindow({
    days: Math.max(1, Number(windowDays) || 1),
    lagDays,
    now,
  });
  return {
    startDate: start,
    endDate: end,
  };
}

/** One injectable GA4 Data API request for monitor fallbacks. */
export async function runGa4Report({
  token,
  body,
  propertyId,
  fetchImpl = fetch,
} = {}) {
  if (!token) throw new Error('no service-account token');
  const raw = propertyId || process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  const property = raw.startsWith('properties/') ? raw : `properties/${raw}`;
  const res = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.error) throw new Error(`GA4: ${JSON.stringify(data.error).slice(0, 300)}`);
  return data;
}

function exactEventFilter(eventName) {
  return {
    filter: {
      fieldName: 'eventName',
      stringFilter: { value: eventName, matchType: 'EXACT' },
    },
  };
}

/**
 * Error events mirror Analytics.trackAppError(): app_error is preferred and
 * exception is the standard-event fallback. Empty `app_error` is not treated
 * as a healthy zero until the standard mirror has also been checked.
 */
export async function fetchGa4ErrorEntries({
  token,
  startDate,
  endDate,
  limit = 30,
  fetchImpl = fetch,
} = {}) {
  const base = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'customEvent:error_type' },
      { name: 'customEvent:error_message' },
      { name: 'pagePath' },
    ],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit,
  };
  let lastError;
  for (const eventName of ['app_error', 'exception']) {
    try {
      const data = await runGa4Report({
        token,
        fetchImpl,
        body: { ...base, dimensionFilter: exactEventFilter(eventName) },
      });
      const rows = (data.rows || []).map((row) => ({
        type: row.dimensionValues?.[0]?.value || eventName,
        message: row.dimensionValues?.[1]?.value || '',
        sampleUrl: row.dimensionValues?.[2]?.value || '',
        count: Number(row.metricValues?.[0]?.value || 0),
        sessions: Number(row.metricValues?.[1]?.value || 0),
        sampleExceptionList: [],
      }));
      if (rows.length) return rows;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

export async function fetchGa4SearchTerms({
  token,
  startDate,
  endDate,
  limit = 1000,
  fetchImpl = fetch,
} = {}) {
  const data = await runGa4Report({
    token,
    fetchImpl,
    body: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'searchTerm' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: exactEventFilter('search'),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit,
    },
  });
  return (data.rows || [])
    .map((row) => ({
      term: row.dimensionValues?.[0]?.value || '',
      count: Number(row.metricValues?.[0]?.value || 0),
      users: Number(row.metricValues?.[1]?.value || 0),
    }))
    .filter((row) => row.term && row.term !== '(not set)');
}

/**
 * Return page-level web-vitals observations. `metric_value` is recorded by
 * services/webVitals.ts in thousandths for CLS and milliseconds otherwise.
 * The caller computes its own p75/threshold, preserving the monitor's unit.
 */
export async function fetchGa4WebVitals({
  token,
  startDate,
  endDate,
  limit = 100000,
  fetchImpl = fetch,
} = {}) {
  const data = await runGa4Report({
    token,
    fetchImpl,
    body: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'pagePath' },
        { name: 'customEvent:metric_name' },
        { name: 'customEvent:metric_value' },
        // GA4's built-in deviceCategory is queryable without registering the
        // app's device_type event parameter as a custom dimension.
        { name: 'deviceCategory' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: exactEventFilter('web_vitals'),
      limit,
    },
  });
  return (data.rows || []).flatMap((row) => {
    const path = row.dimensionValues?.[0]?.value || '';
    const metric = row.dimensionValues?.[1]?.value || '';
    const rawValue = Number(row.dimensionValues?.[2]?.value);
    const device = String(row.dimensionValues?.[3]?.value || '').toLowerCase();
    const count = Number(row.metricValues?.[0]?.value || 0);
    if (!path || !metric || !Number.isFinite(rawValue) || count <= 0) return [];
    return [{
      path,
      metric,
      value: metric === 'CLS' ? rawValue / 1000 : rawValue,
      device,
      count,
    }];
  });
}

export function weightedQuantile(observations, quantile) {
  const ordered = observations.slice().sort((a, b) => a.value - b.value);
  const total = ordered.reduce((sum, item) => sum + item.count, 0);
  if (!total) return null;
  const target = total * quantile;
  let cumulative = 0;
  for (const item of ordered) {
    cumulative += item.count;
    if (cumulative >= target) return item.value;
  }
  return ordered.at(-1).value;
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
