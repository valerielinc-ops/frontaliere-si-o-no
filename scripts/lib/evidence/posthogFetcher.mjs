// PostHog fetcher for the evidence layer — two signals per page:
//
//   - `newsletterSignups`: count of `newsletter_signup` events grouped by
//     source page path. Conversion signal (winner-def historic use).
//   - `pageviews`: count of `$pageview` events grouped by `$pathname`.
//     General traffic signal (artifact-shrink Fase 1 use): any URL with
//     a pageview in the window is treated as "has traffic" by
//     build-plugins/shared/trafficEvidenceFilter.ts and stays 'full'.
//
// Both signals merge into the same `pages` map keyed by pathname so
// downstream consumers that only check key-presence (the filter) and
// consumers that read `newsletterSignups` (winner-def, marquee) keep
// working with no schema change.
//
// Resilient: never throws, returns `{ pages, error? }`. If a sub-query
// fails its signal is omitted but the other one still lands; both
// errors collapse into a single `error` string.

/**
 * @param {object} options
 * @param {string} options.apiKey - POSTHOG_PERSONAL_API_KEY
 * @param {string} options.projectId - POSTHOG_PROJECT_ID
 * @param {string} [options.host='https://eu.posthog.com']
 * @param {string} options.startDate - YYYY-MM-DD
 * @param {string} options.endDate - YYYY-MM-DD
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<{pages: object, error?: string}>}
 */
export async function fetchPosthogPages({
  apiKey,
  projectId,
  host,
  startDate,
  endDate,
  fetchImpl = fetch,
} = {}) {
  const key = apiKey || process.env.POSTHOG_PERSONAL_API_KEY;
  const project = projectId || process.env.POSTHOG_PROJECT_ID;
  const hostBase = (host || process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!key || !project) {
    return { pages: {}, error: 'no POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID' };
  }

  const queryUrl = `${hostBase}/api/projects/${project}/query/`;
  const runQuery = async (hogql) => {
    const res = await fetchImpl(queryUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    });
    if (!res.ok) throw new Error(`posthog ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data?.results || [];
  };

  const normalizePath = (raw) => {
    if (!raw) return null;
    let p = String(raw);
    if (p.startsWith('http')) {
      try { p = new URL(p).pathname; } catch { return null; }
    }
    return p;
  };

  const pages = {};
  const errors = [];

  // ─── newsletter_signup (conversion signal — winner-def consumer) ──
  try {
    const signupQ = `
      SELECT coalesce(properties.$pathname, properties.$current_url) AS path,
             count() AS signups
      FROM events
      WHERE event = 'newsletter_signup'
        AND coalesce(properties.$pathname, properties.$current_url) IS NOT NULL
        AND timestamp >= toDateTime('${startDate} 00:00:00')
        AND timestamp <= toDateTime('${endDate} 23:59:59')
      GROUP BY path
      LIMIT 5000
    `.trim();
    for (const row of await runQuery(signupQ)) {
      const path = normalizePath(row[0]);
      if (!path) continue;
      const n = Number(row[1]) || 0;
      if (n < 1) continue;
      pages[path] = { ...(pages[path] || {}), newsletterSignups: n };
    }
  } catch (err) {
    errors.push(`signups: ${err.message}`);
  }

  // ─── $pageview (general traffic signal — filter consumer) ─────────
  // High-cardinality on a 200k-URL site so we cap at 100k rows; threshold
  // ≥1 view filters out crawler-only paths that the bot detection didn't
  // strip.
  try {
    const pageviewQ = `
      SELECT properties.$pathname AS path,
             count() AS pv
      FROM events
      WHERE event = '$pageview'
        AND properties.$pathname IS NOT NULL
        AND timestamp >= toDateTime('${startDate} 00:00:00')
        AND timestamp <= toDateTime('${endDate} 23:59:59')
      GROUP BY path
      ORDER BY pv DESC
      LIMIT 100000
    `.trim();
    for (const row of await runQuery(pageviewQ)) {
      const path = normalizePath(row[0]);
      if (!path) continue;
      const n = Number(row[1]) || 0;
      if (n < 1) continue;
      pages[path] = { ...(pages[path] || {}), pageviews: n };
    }
  } catch (err) {
    errors.push(`pageviews: ${err.message}`);
  }

  if (errors.length === 0) return { pages };
  if (errors.length === 2) return { pages: {}, error: errors.join(' | ') };
  // Partial: one feed worked, the other didn't. Return what we have +
  // surface the failure so the caller can decide whether to commit.
  return { pages, error: errors.join(' | ') };
}
