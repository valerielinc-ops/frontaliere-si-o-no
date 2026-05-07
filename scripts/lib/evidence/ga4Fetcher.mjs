// GA4 fetcher for the evidence layer — runReport on `pagePath`, returns
// per-page sessions and engagement time. Resilient: never throws, returns
// `{ pages, error? }`.
//
// Auth: same Firebase SA as GSC; verifies the SA has GA4 viewer access.
// On 403 we return a clear actionable error string.
//
// Cluster attribution: uses `classifyByRegex` from cluster-classifier-prompt.mjs
// against the known headline (when slug matches a blog-meta-it.ts entry) or
// against the slug itself as a fallback. Articles that don't match a known
// slug fall back to `'generic'`.

import { GA4_MIN_SESSIONS } from './constants.mjs';
import { classifyByRegex } from '../cluster-classifier-prompt.mjs';

const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

async function getToken() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('no service-account credentials');
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

function normalizePropertyId(raw) {
  if (!raw) return null;
  return raw.startsWith('properties/') ? raw : `properties/${raw}`;
}

/**
 * Look up an article's headline + cluster from blog-meta-it map (preloaded).
 * Slug derived from pagePath.
 */
function attachClusterFromPath(pagePath, blogMetaIt) {
  // Path convention: GA4 reports paths exactly as the browser saw them.
  // Articles live under `/articoli-frontaliere/<slug>/` (trailing slash —
  // matches index.html resolution on GitHub Pages). We accept both.
  const m = pagePath.match(/\/articoli-frontaliere\/([^/?#]+)/);
  if (!m) return 'generic';
  const slug = m[1];
  const headlineKey = `blog.article.${slug}.title`;
  const headline = blogMetaIt?.[headlineKey];
  if (headline) return classifyByRegex(headline);
  // Fallback: classify on slug tokens.
  return classifyByRegex(slug.replace(/-/g, ' '));
}

/**
 * Best-effort: load the Italian blog-meta map so we can attach cluster + headline.
 * Returns `{}` on any error (cluster attribution then falls back to 'generic').
 */
async function loadBlogMetaIt() {
  try {
    const url = new URL('../../../services/locales/blog-meta-it.ts', import.meta.url);
    const fs = await import('node:fs');
    if (!fs.existsSync(url)) return {};
    const text = fs.readFileSync(url, 'utf8');
    // Extract `'<key>': '<value>'` pairs with simple regex; values may contain
    // escaped apostrophes. We don't need values for cluster lookup — just keys
    // mapped to title strings. The TS source uses single-quoted string
    // literals exclusively.
    const entries = {};
    const re = /'(blog\.article\.[a-z0-9-]+\.title)': '((?:\\'|[^'])*)'/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      entries[match[1]] = match[2].replace(/\\'/g, "'");
    }
    return entries;
  } catch {
    return {};
  }
}

/**
 * Best-effort: load the published-date map from data/blog-articles-data.ts.
 * Returns Map<slug, ISO8601 date>.
 */
async function loadPublishedDates() {
  try {
    const url = new URL('../../../data/blog-articles-data.ts', import.meta.url);
    const fs = await import('node:fs');
    if (!fs.existsSync(url)) return new Map();
    const text = fs.readFileSync(url, 'utf8');
    const out = new Map();
    // Match `id: 'slug',` then later `date: '2026-01-15',` within the same
    // object. Article objects span multiple lines so we use a non-greedy
    // window of ~600 chars between them.
    const re = /id:\s*'([a-z0-9-]+)',[\s\S]{0,600}?date:\s*'(\d{4}-\d{2}-\d{2})'/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.set(m[1], m[2]);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Fetch per-page sessions + engagement, last `startDate..endDate` window.
 * Newsletter-sourced sessions are excluded so we measure SEO traffic only.
 * @param {object} options
 * @param {string} options.propertyId - GA4 property id (with or without `properties/` prefix)
 * @param {string} options.startDate - YYYY-MM-DD
 * @param {string} options.endDate - YYYY-MM-DD
 * @param {Function} [options.fetchImpl=fetch]
 * @param {Function} [options.getTokenImpl=getToken]
 * @returns {Promise<{pages: object, error?: string}>}
 */
export async function fetchGa4Pages({
  propertyId,
  startDate,
  endDate,
  fetchImpl = fetch,
  getTokenImpl = getToken,
} = {}) {
  try {
    const property = normalizePropertyId(propertyId || process.env.GA4_PROPERTY_ID);
    if (!property) throw new Error('no GA4_PROPERTY_ID');
    const token = await getTokenImpl();
    if (!token) throw new Error('no service-account token');

    const blogMetaIt = await loadBlogMetaIt();
    const publishedDates = await loadPublishedDates();

    const url = `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`;
    const requestBody = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'sessions' },
        { name: 'userEngagementDuration' },
        { name: 'screenPageViews' },
      ],
      dimensionFilter: {
        notExpression: {
          filter: {
            fieldName: 'sessionMedium',
            stringFilter: { value: 'newsletter', matchType: 'EXACT' },
          },
        },
      },
      limit: 100000,
    };

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (res.status === 403) {
      const text = await res.text();
      return {
        pages: {},
        error: `GA4 access denied — service account needs Viewer role on property (${text.slice(0, 200)})`,
      };
    }
    if (!res.ok) throw new Error(`ga4 ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const rows = data.rows || [];

    const pages = {};
    for (const r of rows) {
      const path = r.dimensionValues?.[0]?.value || '';
      if (!path) continue;
      const sessions = Number(r.metricValues?.[0]?.value || 0);
      if (sessions < GA4_MIN_SESSIONS) continue;
      const engageDur = Number(r.metricValues?.[1]?.value || 0);
      const engageTime = sessions > 0 ? Number((engageDur / sessions).toFixed(2)) : 0;
      const cluster = attachClusterFromPath(path, blogMetaIt);
      const slugMatch = path.match(/\/articoli-frontaliere\/([^/?#]+)/);
      const slug = slugMatch ? slugMatch[1] : null;
      const publishedAt = slug && publishedDates.has(slug) ? publishedDates.get(slug) : null;
      pages[path] = {
        sessions,
        engageTime,
        publishedAt,
        cluster,
      };
    }
    return { pages };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    return { pages: {}, error: reason };
  }
}
