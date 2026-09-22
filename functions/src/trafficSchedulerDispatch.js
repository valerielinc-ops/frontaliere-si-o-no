import { GITHUB_API, getRepoConfig } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';

export const TRAFFIC_SCHEDULER_WORKFLOW = 'traffic-scheduler.yml';

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('scheduledAt must be a valid date');
  return date;
}

/**
 * Keep the existing UTC collection calendar while moving its clock from the
 * delayed GitHub scheduler to Cloud Scheduler.
 */
export function isTrafficCollectionSlot(scheduledAt) {
  const date = validDate(scheduledAt);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const weekend = day === 0 || day === 6;

  if (weekend) return minute === 0 && [6, 10, 14, 18].includes(hour);
  if (minute !== 0 && minute !== 30) return false;
  return (hour >= 4 && hour <= 7)
    || (hour === 11 && minute === 0)
    || (hour >= 14 && hour <= 17);
}

export async function dispatchTrafficScheduler({
  scheduledAt = new Date(),
  fetchImpl = fetch,
  getRepoConfigImpl = getRepoConfig,
} = {}) {
  const slot = validDate(scheduledAt);
  if (!isTrafficCollectionSlot(slot)) {
    return { dispatched: false, reason: 'not_collection_slot', scheduledAt: slot.toISOString() };
  }

  const { pat, owner, repo } = await getRepoConfigImpl();
  if (!pat) throw new Error('github_pat_not_configured');

  const response = await fetchImpl(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${TRAFFIC_SCHEDULER_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: githubApiHeaders(pat, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`traffic_scheduler_dispatch_failed:${response.status}:${body.slice(0, 200)}`);
  }
  return { dispatched: true, scheduledAt: slot.toISOString(), status: response.status };
}
