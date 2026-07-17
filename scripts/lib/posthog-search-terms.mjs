// scripts/lib/posthog-search-terms.mjs
//
// Fetch on-site `search` events (properties.search_term) from PostHog via
// HogQL. Extracted from scripts/profession-keyword-opportunities.mjs so
// scripts/mine-search-location-gaps.mjs (issue #4301) reuses the exact same
// query shape + auth handling instead of forking a second copy
// (AGENTS.md non-negotiable #6).
//
// Auth: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID / POSTHOG_HOST, loaded
// via `eval "$(GOOGLE_APPLICATION_CREDENTIALS=... node scripts/load-rc-env.mjs)"`.

/**
 * @param {object} [opts]
 * @param {number} [opts.windowDays=60] - rolling window, days.
 * @param {number} [opts.limit=1000] - max distinct terms returned.
 * @param {Function} [opts.fetchImpl=fetch]
 * @returns {Promise<Array<{term: string, count: number}>>}
 * @throws if POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID are missing, or
 *   the PostHog request fails — callers decide whether to degrade gracefully
 *   (catch + fall back) or let it abort a --skip-posthog-gated run.
 */
export async function fetchOnsiteSearchTerms({ windowDays = 60, limit = 1000, fetchImpl = fetch } = {}) {
  const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
  const PID = process.env.POSTHOG_PROJECT_ID;
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!KEY || !PID) {
    throw new Error(
      'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing — load via scripts/load-rc-env.mjs or pass --skip-posthog',
    );
  }
  const query = `
    SELECT lower(toString(properties.search_term)) AS term, count() AS n
    FROM events
    WHERE event = 'search'
      AND notEmpty(toString(properties.search_term))
      AND timestamp > now() - INTERVAL ${Math.max(1, Number(windowDays) || 60)} DAY
    GROUP BY term
    ORDER BY n DESC
    LIMIT ${Math.max(1, Number(limit) || 1000)}
  `.trim();
  const r = await fetchImpl(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`PostHog ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const json = await r.json();
  return (json.results || []).map(([term, n]) => ({ term: String(term), count: Number(n) || 0 }));
}
