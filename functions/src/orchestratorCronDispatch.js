/**
 * orchestratorCronDispatch.js — Cloud Scheduler owns the clock of the crawler
 * wave; orchestrate-crawlers.yml stays the single dispatcher of the wave.
 *
 * Why not GitHub's `schedule:`. Measured on 2026-09-28 (last 20
 * `event=schedule` runs of every scheduled workflow, site and corpus, slots
 * since 09-14): orchestrate-crawlers.yml was created a median of 306 min late
 * for `0 9` and 148 min for `0 21`. Non-round minutes are just as late (site:
 * `:00` median 284 min, other minutes 301 min; corpus 287 vs 291), so moving
 * the minute off `:00` does not help; the delay follows the UTC hour of the
 * slot (~5 h for 02-09 UTC, ~2.5 h for 16-21 UTC) and both repos alike. The
 * workflow_dispatch path used by dispatchTrafficCollection
 * (trafficSchedulerDispatch.js, #9548) creates the run ~6 s after the Cloud
 * Scheduler tick, with the same `GITHUB_PAT` from Remote Config.
 *
 * Same cadence, same nominal slots as before (09:00 and 21:00 UTC): only the
 * clock changes. The GitHub cron is removed from the workflow so the wave is
 * never dispatched twice; scripts/ci/orchestrator-heartbeat.mjs still opens an
 * issue when a slot has no run.
 */

import { GITHUB_API, getRepoConfig } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';
// Same scheduledAt validation as the traffic relay (one copy, no drift).
import { toValidDate } from './lib/trafficCollectionCalendar.js';

export const ORCHESTRATOR_WORKFLOW = 'orchestrate-crawlers.yml';
/** Nominal UTC slots, `HH:MM`. Kept in parity with the heartbeat by a test. */
export const ORCHESTRATOR_SLOTS_UTC = Object.freeze(['09:00', '21:00']);
/** Cloud Scheduler expression derived from the slots above (UTC). */
export const ORCHESTRATOR_CLOUD_SCHEDULE = '0 9,21 * * *';

/**
 * True only for a nominal slot. A Cloud Console "force run" carries the current
 * time as scheduleTime and is therefore refused: an extra crawler wave is not a
 * harmless retry (it doubles the crawl and the translate-pending dispatches).
 */
export function isOrchestratorSlot(scheduledAt) {
  const date = toValidDate(scheduledAt);
  const label = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  return ORCHESTRATOR_SLOTS_UTC.includes(label);
}

export async function dispatchOrchestrator({
  scheduledAt = new Date(),
  fetchImpl = fetch,
  getRepoConfigImpl = getRepoConfig,
} = {}) {
  const slot = toValidDate(scheduledAt);
  if (!isOrchestratorSlot(slot)) {
    return { dispatched: false, reason: 'not_orchestrator_slot', scheduledAt: slot.toISOString() };
  }

  const { pat, owner, repo } = await getRepoConfigImpl();
  if (!pat) throw new Error('github_pat_not_configured');

  // Default inputs (group=all, delay_seconds=60, dry_run=false): the same wave
  // the scheduled run used to dispatch.
  const response = await fetchImpl(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${ORCHESTRATOR_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: githubApiHeaders(pat, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`orchestrator_dispatch_failed:${response.status}:${body.slice(0, 200)}`);
  }
  return { dispatched: true, scheduledAt: slot.toISOString(), status: response.status };
}
