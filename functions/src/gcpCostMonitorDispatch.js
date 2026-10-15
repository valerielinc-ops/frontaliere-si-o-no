/**
 * gcpCostMonitorDispatch.js — Cloud Scheduler owns the clock of the GCP cost
 * monitor; monitor-gcp-costs.yml stays the single place that measures and
 * writes the issue.
 *
 * Why not GitHub's `schedule:` alone. The native cron `23 7 * * *` of
 * monitor-gcp-costs.yml was created at 13:57:12Z on 2026-10-02 (+6 h 34 min)
 * and at 12:37:31Z on 2026-10-03 (+5 h 14 min): the same schedule-dispatch
 * backlog measured in orchestratorCronDispatch.js. With one late check a day,
 * a cost leak that starts right after the check is reported up to ~30 hours
 * later; in September 2026 the leak cost ~30 CHF a day. The workflow_dispatch
 * path (same `GITHUB_PAT` from Remote Config as dispatchTrafficCollection)
 * creates the run seconds after the Cloud Scheduler tick.
 *
 * No slot claim, unlike the crawler wave: the monitor is idempotent. It reads
 * a rolling 24-hour window and keeps one stable-title issue (commented while a
 * driver is over its threshold, closed when every driver is back under), so a
 * repeated or forced dispatch costs one short run and writes no duplicate. The
 * native cron stays in the workflow as an independent safety net: its clock
 * does not depend on the GCP project this monitor watches.
 *
 * No `inputs`: `dry_run` defaults to `false`, so the run writes the issue.
 */

import { GITHUB_API, getRepoConfig } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';

export const GCP_COST_MONITOR_WORKFLOW = 'monitor-gcp-costs.yml';
/** Nominal UTC slots, `HH:MM`: every 6 hours, on the minute of the native cron. */
export const GCP_COST_MONITOR_SLOTS_UTC = Object.freeze(['01:23', '07:23', '13:23', '19:23']);
/** Cloud Scheduler expression of the slots above (UTC). */
export const GCP_COST_MONITOR_CLOUD_SCHEDULE = '23 1,7,13,19 * * *';

export async function dispatchGcpCostMonitorWorkflow({
  scheduledAt = new Date(),
  fetchImpl = fetch,
  getRepoConfigImpl = getRepoConfig,
} = {}) {
  const parsed = new Date(scheduledAt);
  const slotIso = (Number.isNaN(parsed.getTime()) ? new Date() : parsed).toISOString();

  const { pat, owner, repo } = await getRepoConfigImpl();
  if (!pat) throw new Error('github_pat_not_configured');

  const response = await fetchImpl(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${GCP_COST_MONITOR_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: githubApiHeaders(pat, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`gcp_cost_monitor_dispatch_failed:${response.status}:${body.slice(0, 200)}`);
  }
  return { dispatched: true, scheduledAt: slotIso, status: response.status };
}
