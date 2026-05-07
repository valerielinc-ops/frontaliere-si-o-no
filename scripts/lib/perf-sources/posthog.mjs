// PostHog HogQL — pageviews per pathname, newsletter-excluded.
// Optionally returns scroll-depth p50 if `$scroll_depth` events are tracked
// (best-effort; absent → null).

import { windowDates } from './safe.mjs';

/**
 * Returns { rows, perPath: Map<path, {pageviews, scrollP50}> } for paths
 * containing /articoli-frontaliere/.
 */
export async function fetchPostHogByPage({
  windowDays = 30,
  apiKey = process.env.POSTHOG_PERSONAL_API_KEY,
  projectId = process.env.POSTHOG_PROJECT_ID,
  host = process.env.POSTHOG_HOST || 'https://eu.posthog.com',
  fetchImpl = fetch,
} = {}) {
  if (!apiKey || !projectId) throw new Error('no POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID');
  const { start, end } = windowDates(windowDays);
  const url = `${host.replace(/\/$/, '')}/api/projects/${projectId}/query/`;

  const pageviewQuery = `
    SELECT properties.$pathname AS path, count() AS views
    FROM events
    WHERE event = '$pageview'
      AND (properties.utm_medium IS NULL OR properties.utm_medium != 'newsletter')
      AND properties.$pathname LIKE '%/articoli-frontaliere/%'
      AND timestamp >= toDateTime('${start} 00:00:00')
      AND timestamp <= toDateTime('${end} 23:59:59')
    GROUP BY path
    LIMIT 5000
  `.trim();

  // PostHog's $pageleave event exposes scroll under different property names
  // depending on the posthog-js version: $scroll_depth (oldest), then
  // $max_scroll_depth, then $max_scroll_y. We coalesce across all three so
  // the query keeps working through SDK upgrades. We also include our own
  // SPA-emitted property `percent_scrolled` (from services/analytics.ts:653)
  // which is logged as a `scroll_depth` event regardless of pageleave.
  const scrollQuery = `
    SELECT properties.$pathname AS path,
           quantile(0.5)(toFloat(coalesce(
             properties.$scroll_depth,
             properties.$max_scroll_depth,
             properties.$max_scroll_y,
             properties.percent_scrolled
           ))) AS scroll_p50
    FROM events
    WHERE event IN ('$pageleave', 'scroll_depth')
      AND (properties.utm_medium IS NULL OR properties.utm_medium != 'newsletter')
      AND properties.$pathname LIKE '%/articoli-frontaliere/%'
      AND coalesce(
        properties.$scroll_depth,
        properties.$max_scroll_depth,
        properties.$max_scroll_y,
        properties.percent_scrolled
      ) IS NOT NULL
      AND timestamp >= toDateTime('${start} 00:00:00')
      AND timestamp <= toDateTime('${end} 23:59:59')
    GROUP BY path
    LIMIT 5000
  `.trim();

  async function runHogql(query) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    });
    if (!res.ok) throw new Error(`posthog ${res.status}: ${await res.text()}`);
    return await res.json();
  }

  const pvRes = await runHogql(pageviewQuery);
  const pvRows = pvRes?.results || [];

  // Scroll query is optional — if it fails we just lose scrollP50.
  let scrollMap = new Map();
  try {
    const scRes = await runHogql(scrollQuery);
    for (const row of scRes?.results || []) {
      const [path, p50] = row;
      if (path) scrollMap.set(path, Number(p50));
    }
  } catch {
    // ignore — scroll_depth not tracked
  }

  const perPath = new Map();
  for (const row of pvRows) {
    const [path, views] = row;
    if (!path) continue;
    perPath.set(path, {
      pageviews: Number(views) || 0,
      scrollP50: scrollMap.has(path) ? Number(scrollMap.get(path).toFixed(3)) : null,
    });
  }
  return { rows: pvRows.length, perPath };
}
