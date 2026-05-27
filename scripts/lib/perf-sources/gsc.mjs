// GSC search-analytics fetcher. Uses the Firebase service-account JSON
// (FIREBASE_SERVICE_ACCOUNT_JSON env or a file path written by the workflow)
// to mint an OAuth2 token via google-auth-library.
//
// Returns Map<pathname, { clicks, impressions, ctr, position }> for paths
// inside /articoli-frontaliere/. GSC is naturally newsletter-free
// (organic-only).

import { windowDates } from './safe.mjs';

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const SITE_DOMAIN = 'frontaliereticino.ch';

async function getServiceAccountToken({ fetchImpl = fetch } = {}) {
  // 1) Inline JSON via env (workflow writes it to /tmp and points
  //    GOOGLE_APPLICATION_CREDENTIALS at the file). Either path works.
  // 2) GoogleAuth() picks up GOOGLE_APPLICATION_CREDENTIALS automatically.
  // We never inline-decode the JSON ourselves — google-auth-library handles it.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return null;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Fallback: write the inline JSON to a tmp file. Workflow normally does
    // this — we only do it if it didn't.
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

async function gscQuery(token, body, fetchImpl = fetch) {
  const site = `sc-domain:${SITE_DOMAIN}`;
  const encoded = encodeURIComponent(site);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return await res.json();
  // Fall back to URL-prefix property
  const fallbackEncoded = encodeURIComponent(`https://${SITE_DOMAIN}/`);
  const fallbackUrl = `https://www.googleapis.com/webmasters/v3/sites/${fallbackEncoded}/searchAnalytics/query`;
  const r2 = await fetchImpl(fallbackUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r2.ok) throw new Error(`gsc ${r2.status}: ${await r2.text()}`);
  return await r2.json();
}

/**
 * Fetch per-page metrics for /articoli-frontaliere/ pages, last `windowDays`.
 * Returns { rows, perPath: Map<pathname, {clicks, impressions, ctr, position}> }.
 */
export async function fetchGscByPage({ windowDays = 30, fetchImpl = fetch, getTokenImpl = getServiceAccountToken } = {}) {
  const token = await getTokenImpl({ fetchImpl });
  if (!token) throw new Error('no service-account token (set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)');
  const { start, end } = windowDates(windowDays);
  const data = await gscQuery(
    token,
    {
      startDate: start,
      endDate: end,
      dimensions: ['page'],
      dimensionFilterGroups: [
        {
          filters: [
            { dimension: 'page', operator: 'contains', expression: '/articoli-frontaliere/' },
          ],
        },
      ],
      rowLimit: 25000,
    },
    fetchImpl,
  );
  const rows = data.rows || [];
  const perPath = new Map();
  for (const r of rows) {
    const page = r.keys?.[0] || '';
    let pathname;
    try {
      pathname = new URL(page).pathname;
    } catch {
      continue;
    }
    perPath.set(pathname, {
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr ?? null,
      position: r.position ?? null,
    });
  }
  return { rows: rows.length, perPath };
}
