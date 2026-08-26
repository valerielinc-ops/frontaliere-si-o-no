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
 * Fetch per-page metrics for pages whose path contains `pathContains`
 * (default `/articoli-frontaliere/`, the original single-family use case),
 * last `windowDays`. Returns
 * { rows, perPath: Map<pathname, {clicks, impressions, ctr, position}> }.
 *
 * `pathContains` lets callers reuse this same GSC client for other template
 * families (e.g. `/guida-frontaliere/`, `/tasse-e-pensione/`) instead of
 * duplicating the OAuth2 + searchAnalytics/query plumbing — see
 * scripts/lib/seo-ctr-curve.mjs for the family registry that drives this.
 *
 * `pathContains` also accepts an ARRAY of substrings — one query PER entry,
 * results merged into a single `perPath` map. Verified empirically against
 * the live API (issue #5964): the Search Console API ANDs multiple `contains`
 * filters on the same dimension regardless of whether they sit in separate
 * `dimensionFilterGroups` groups or together in one group's `filters` array —
 * there is no request shape that ORs them. A page whose path contains
 * "/foo/" can never also contain "/bar/", so any single-request shape
 * silently returned zero rows for every family with 2+ `pathAliases` (the
 * original code put each expression in its own group). Separate requests
 * merged client-side is the only way to get the union; safe here because
 * each locale alias is a disjoint path prefix, so no page can be double
 * counted across requests. Used for families whose template is reachable
 * under multiple locale-specific URL slugs, not just one path (see
 * `familyPathPrefixes()` in scripts/lib/seo-ctr-curve.mjs, issue #5961).
 *
 * `pathContains = null` fetches ALL indexed pages site-wide (no filter) —
 * used by the family-discovery pass in scripts/monitor-seo-ctr-by-template.mjs
 * to find high-volume families that aren't in the registry yet.
 */
const ROW_LIMIT = 25000;
const MAX_PAGES = 10;

export async function fetchGscByPage({
  windowDays = 30,
  pathContains = '/articoli-frontaliere/',
  fetchImpl = fetch,
  getTokenImpl = getServiceAccountToken,
} = {}) {
  const token = await getTokenImpl({ fetchImpl });
  if (!token) throw new Error('no service-account token (set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)');
  const { start, end } = windowDates(windowDays);
  // One query per alias (see the OR-across-aliases note above) — `null`
  // means the unfiltered site-wide discovery query, a single "expression".
  const expressions = pathContains === null ? [null] : Array.isArray(pathContains) ? pathContains : [pathContains];
  const perPath = new Map();
  let totalRows = 0;
  for (const expression of expressions) {
    // `rowLimit` alone caps a Search Analytics response at 25 000 rows with no
    // "there is more" signal — a single request looks complete regardless of
    // real row count. Safe when `expression` scopes to one family/alias (well
    // under 25k), but the `expression = null` site-wide discovery query has
    // no such bound and GSC's default ordering is clicks-descending, which
    // would silently truncate exactly the high-impression/low-CTR tail this
    // discovery pass exists to surface. Paginate via `startRow` for both
    // cases; a short page (< ROW_LIMIT rows) is the reliable end-of-data
    // signal, mirroring scripts/refresh-indexed-cluster-urls.mjs:fetchGsc.
    let startRow = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await gscQuery(
        token,
        {
          startDate: start,
          endDate: end,
          dimensions: ['page'],
          ...(expression
            ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression }] }] }
            : {}),
          rowLimit: ROW_LIMIT,
          startRow,
        },
        fetchImpl,
      );
      const pageRows = data.rows || [];
      totalRows += pageRows.length;
      for (const r of pageRows) {
        const page = r.keys?.[0] || '';
        let pathname;
        try {
          pathname = new URL(page).pathname;
        } catch {
          continue;
        }
        // `set()` (not skip-if-present): if the same page ever matches two
        // aliases it's the same page/date-range row either way, last write
        // is a no-op in practice, never a double count in `totalRows`'s
        // caller-facing `perPath.size`.
        perPath.set(pathname, {
          clicks: r.clicks || 0,
          impressions: r.impressions || 0,
          ctr: r.ctr ?? null,
          position: r.position ?? null,
        });
      }
      if (pageRows.length < ROW_LIMIT) break;
      startRow += pageRows.length;
    }
  }
  return { rows: totalRows, perPath };
}
