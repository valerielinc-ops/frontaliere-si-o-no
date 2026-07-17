// Generic PostHog HogQL client — shared by all scripts that need to POST a
// HogQL query. Auth resolved from opts or process.env.
//
// Extracted from inline copies in:
//   scripts/monitor-cls-posthog.mjs, scripts/diagnose-app-errors.mjs,
//   scripts/diagnose-calc-funnel.mjs, scripts/employer-traffic-report.mjs,
//   scripts/enrich-employer-contacts.mjs, scripts/fetch-thin-page-promotions.mjs,
//   scripts/investigate-calc-funnel-drop.mjs, scripts/posthog-error-issue-sync.mjs,
//   scripts/query-authgate-experiment.mjs, scripts/refresh-indexed-cluster-urls.mjs,
//   scripts/refresh-noslash-keep.mjs, scripts/revenue-monitor.mjs,
//   scripts/triage-app-errors.mjs, scripts/build-employer-insights.mjs
//
// Ref: issue #4320

/**
 * Run an arbitrary HogQL query against PostHog.
 *
 * @param {string} query - HogQL query string
 * @param {object} [opts]
 * @param {string} [opts.apiKey]   - defaults to POSTHOG_PERSONAL_API_KEY
 * @param {string} [opts.projectId] - defaults to POSTHOG_PROJECT_ID
 * @param {string} [opts.host]     - defaults to POSTHOG_HOST or https://eu.posthog.com
 * @param {Function} [opts.fetchImpl] - injectable fetch (for tests)
 * @returns {Promise<object>} - raw PostHog response (includes `.results`)
 * @throws {Error} if credentials are missing or PostHog returns a non-2xx status
 */
export async function runHogQL(
  query,
  {
    apiKey = process.env.POSTHOG_PERSONAL_API_KEY,
    projectId = process.env.POSTHOG_PROJECT_ID,
    host = process.env.POSTHOG_HOST || 'https://eu.posthog.com',
    fetchImpl = fetch,
  } = {},
) {
  if (!apiKey || !projectId) {
    throw new Error('POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing');
  }
  const url = `${host.replace(/\/$/, '')}/api/projects/${projectId}/query/`;
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) {
    throw new Error(`posthog ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  return r.json();
}
