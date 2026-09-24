import { GITHUB_API, getRepoConfig } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';
import { isTrafficCollectionSlot, toValidDate } from './lib/trafficCollectionCalendar.js';

export const TRAFFIC_SCHEDULER_WORKFLOW = 'traffic-scheduler.yml';

// Il calendario vive in un modulo senza dipendenze perché lo riusa anche il
// controllo di freschezza (scripts/check-border-data-health.mjs), che gira senza
// `npm ci` e non può caricare firebase-admin.
export { isTrafficCollectionSlot };

export async function dispatchTrafficScheduler({
  scheduledAt = new Date(),
  fetchImpl = fetch,
  getRepoConfigImpl = getRepoConfig,
} = {}) {
  const slot = toValidDate(scheduledAt);
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
