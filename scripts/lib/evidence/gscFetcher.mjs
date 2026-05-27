// GSC fetcher for the evidence layer — aggregates by query, with a second
// pass to attach the top landing-page URL per query. Resilient: never throws,
// returns `{ queries, orphanQueries, error? }`.
//
// Auth: Firebase service-account JSON (FIREBASE_SERVICE_ACCOUNT_JSON or
// GOOGLE_APPLICATION_CREDENTIALS). The Firebase SA doubles as a GSC
// credential in this project (see project memory).

import {
  GSC_MIN_IMP,
  ORPHAN_MAX_CTR,
  ORPHAN_MIN_IMP,
  ORPHAN_MIN_POS,
  SITE_DOMAIN,
} from './constants.mjs';

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

async function getServiceAccountToken() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('no service-account credentials (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)');
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), `firebase-sa-${process.pid}.json`);
    fs.writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
  }
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function gscQuery(token, body, fetchImpl) {
  const site = `sc-domain:${SITE_DOMAIN}`;
  const encoded = encodeURIComponent(site);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return await res.json();
  const fallback = encodeURIComponent(`https://${SITE_DOMAIN}/`);
  const fallbackUrl = `https://www.googleapis.com/webmasters/v3/sites/${fallback}/searchAnalytics/query`;
  const r2 = await fetchImpl(fallbackUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r2.ok) throw new Error(`gsc ${r2.status}: ${await r2.text()}`);
  return await r2.json();
}

/**
 * Pull the path component off a GSC `page` value.
 * GSC may return either an absolute URL (URL-prefix property) or a path
 * (sc-domain). We accept both.
 */
function pathFromGscPage(value) {
  if (!value) return '';
  if (value.startsWith('/')) return value;
  try {
    return new URL(value).pathname;
  } catch {
    return '';
  }
}

/**
 * Fetch GSC search analytics aggregated per query, paginated.
 * @param {object} options
 * @param {string} options.startDate - ISO8601 date (YYYY-MM-DD)
 * @param {string} options.endDate - ISO8601 date
 * @param {number} [options.rowLimit=25000]
 * @param {Function} [options.fetchImpl=fetch]
 * @param {Function} [options.getTokenImpl=getServiceAccountToken]
 * @returns {Promise<{queries: object, orphanQueries: array, error?: string}>}
 */
export async function fetchGscQueries({
  startDate,
  endDate,
  rowLimit = 25000,
  fetchImpl = fetch,
  getTokenImpl = getServiceAccountToken,
} = {}) {
  try {
    const token = await getTokenImpl();
    if (!token) throw new Error('no service-account token');

    // Pass 1 — query-only aggregation. Paginate via startRow.
    const queryAgg = new Map();
    let startRow = 0;
    while (true) {
      const data = await gscQuery(
        token,
        {
          startDate,
          endDate,
          dimensions: ['query'],
          rowLimit,
          startRow,
        },
        fetchImpl,
      );
      const rows = data.rows || [];
      for (const r of rows) {
        const q = (r.keys?.[0] || '').toLowerCase();
        if (!q) continue;
        const imp = r.impressions || 0;
        if (imp < GSC_MIN_IMP) continue;
        queryAgg.set(q, {
          imp,
          clicks: r.clicks || 0,
          pos: r.position ?? 0,
          ctr: r.ctr ?? 0,
        });
      }
      if (rows.length < rowLimit) break;
      startRow += rowLimit;
      // Hard ceiling to keep memory bounded — 250k rows is far past anything realistic.
      if (startRow >= rowLimit * 10) break;
    }

    // Pass 2 — query+page to identify each query's top landing page.
    // We re-paginate; only keep top-imp page per query.
    const topPagePerQuery = new Map();
    startRow = 0;
    while (true) {
      const data = await gscQuery(
        token,
        {
          startDate,
          endDate,
          dimensions: ['query', 'page'],
          rowLimit,
          startRow,
        },
        fetchImpl,
      );
      const rows = data.rows || [];
      for (const r of rows) {
        const q = (r.keys?.[0] || '').toLowerCase();
        if (!q || !queryAgg.has(q)) continue;
        const path = pathFromGscPage(r.keys?.[1] || '');
        if (!path) continue;
        const imp = r.impressions || 0;
        const prev = topPagePerQuery.get(q);
        if (!prev || imp > prev.imp) topPagePerQuery.set(q, { path, imp });
      }
      if (rows.length < rowLimit) break;
      startRow += rowLimit;
      if (startRow >= rowLimit * 10) break;
    }

    const queries = {};
    const orphanQueries = [];
    for (const [q, agg] of queryAgg) {
      const top = topPagePerQuery.get(q);
      const topLandingPage = top ? top.path : '';
      queries[q] = {
        imp: agg.imp,
        clicks: agg.clicks,
        pos: Number(agg.pos.toFixed(2)),
        ctr: Number(agg.ctr.toFixed(4)),
        topLandingPage,
      };
      if (
        agg.imp >= ORPHAN_MIN_IMP
        && agg.pos >= ORPHAN_MIN_POS
        && agg.ctr <= ORPHAN_MAX_CTR
      ) {
        orphanQueries.push({
          query: q,
          imp: agg.imp,
          clicks: agg.clicks,
          pos: Number(agg.pos.toFixed(2)),
          topLandingPage,
        });
      }
    }
    return { queries, orphanQueries };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    return { queries: {}, orphanQueries: [], error: reason };
  }
}
