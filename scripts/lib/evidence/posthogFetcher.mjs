// PostHog fetcher for the evidence layer — counts `newsletter_signup`
// events grouped by source page path. Resilient: never throws, returns
// `{ pages, error? }`.
//
// Total tolerance: winner-def is traffic-only, so a PostHog outage doesn't
// block selection — the `posthog` block becomes `{}` and downstream consumers
// treat it as "no signal".

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
  try {
    const key = apiKey || process.env.POSTHOG_PERSONAL_API_KEY;
    const project = projectId || process.env.POSTHOG_PROJECT_ID;
    const hostBase = (host || process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
    if (!key || !project) throw new Error('no POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID');

    const url = `${hostBase}/api/projects/${project}/query/`;

    // HogQL: count newsletter_signup events grouped by source page path.
    // We use $current_url first (set on the event itself) and fall back to
    // the most-recent prior $pageview's $pathname when the signup event
    // doesn't carry a URL property.
    const query = `
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

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    });
    if (!res.ok) throw new Error(`posthog ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const rows = data?.results || [];

    const pages = {};
    for (const row of rows) {
      const [rawPath, signups] = row;
      if (!rawPath) continue;
      // Normalise to pathname only (strip host if a full URL slipped in).
      let path = rawPath;
      if (path.startsWith('http')) {
        try {
          path = new URL(path).pathname;
        } catch {
          continue;
        }
      }
      const n = Number(signups) || 0;
      if (n < 1) continue;
      pages[path] = { newsletterSignups: n };
    }
    return { pages };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    return { pages: {}, error: reason };
  }
}
