/**
 * Generic exactly-once admission for a Cloud Scheduler-owned workflow.
 *
 * The GitHub workflow-dispatch POST is not idempotent, so every
 * `workflow_<normalized-slot>` owns one Firestore claim in
 * `workflow_dispatch_claims`:
 *  - a new claim is `acquired` and may POST;
 *  - a live lease returns `in_flight`;
 *  - a confirmed claim returns `dispatched`/`duplicate`;
 *  - an expired lease returns `reacquired`, but first looks up the marked run
 *    before retrying, because the previous POST may have been accepted while
 *    its response was lost.
 *
 * The workflow, nominal slots, trigger inputs and error prefix are parameters;
 * claim, lease, marker and retry behavior stay in this module for crawler and
 * job-alert dispatchers alike.
 */
import { GITHUB_API, getRepoConfig } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';
import {
  CLAIM_COLLECTION,
  CLAIM_LEASE_MS,
  CLOUD_SCHEDULER_TRIGGER_SOURCE,
  DISPATCH_TIMEOUT_MS,
  isUtcSlot,
  schedulerRunMarker,
} from './cloudSchedulerWorkflowContract.js';
import { normalizeOrchestratorSlot } from './lib/orchestratorSlot.js';

export { CLAIM_COLLECTION, CLAIM_LEASE_MS, DISPATCH_TIMEOUT_MS } from './cloudSchedulerWorkflowContract.js';

/**
 * Firestore-backed claim store shared by every Cloud Scheduler workflow
 * dispatcher. `acquire` is transactional, so concurrent deliveries cannot
 * both acquire the same `workflow_<slot>` claim.
 */
export async function createFirestoreClaimStore({
  claimCollection = CLAIM_COLLECTION,
  claimLeaseMs = CLAIM_LEASE_MS,
} = {}) {
  const { getAdminDb } = await import('./newsletterResendWebhookCore.js');
  const db = getAdminDb();
  const ref = (key) => db.collection(claimCollection).doc(key);
  return {
    async acquire(key, nowMs) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(key));
        if (!snap.exists) {
          tx.create(ref(key), { status: 'pending', attempts: 1, leaseUntilMs: nowMs + claimLeaseMs, createdAtMs: nowMs });
          return 'acquired';
        }
        const data = snap.data() || {};
        if (data.status === 'dispatched') return 'dispatched';
        if (Number(data.leaseUntilMs) > nowMs) return 'in_flight';
        tx.update(ref(key), { attempts: Number(data.attempts || 0) + 1, leaseUntilMs: nowMs + claimLeaseMs });
        return 'reacquired';
      });
    },
    async markDispatched(key, nowMs, detail = {}) {
      await ref(key).set({ status: 'dispatched', dispatchedAtMs: nowMs, ...detail }, { merge: true });
    },
  };
}

/**
 * Does GitHub already hold the marked run of this workflow slot? The marker is
 * the only evidence accepted after an expired lease; an unmarked manual or
 * dry-run dispatch must not suppress the scheduler retry.
 */
async function findMarkedWorkflowRun({
  fetchImpl,
  pat,
  owner,
  repo,
  workflow,
  slotIso,
  triggerSource,
  errorPrefix,
}) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs`
    + `?event=workflow_dispatch&created=${encodeURIComponent(`>=${slotIso}`)}&per_page=50`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: githubApiHeaders(pat),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${errorPrefix}_run_lookup_failed:${response.status}`);
  const body = await response.json();
  if (!body || !Array.isArray(body.workflow_runs)) throw new Error(`${errorPrefix}_run_lookup_invalid`);
  const marker = schedulerRunMarker(slotIso, triggerSource);
  return body.workflow_runs.find((run) => String(run?.display_title ?? '').includes(marker)) ?? null;
}

/**
 * Dispatch one Cloud Scheduler-owned workflow slot with a Firestore claim.
 * `inputs` is the workflow-specific part; claim, retry lookup and marker
 * recognition remain in this single implementation for crawler and job alerts.
 */
export async function dispatchCloudSchedulerWorkflow({
  workflow,
  slotsUtc,
  invalidSlotReason,
  errorPrefix,
  scheduledAt = new Date(),
  triggerSource = CLOUD_SCHEDULER_TRIGGER_SOURCE,
  fetchImpl = fetch,
  getRepoConfigImpl = getRepoConfig,
  claimStore,
  now = () => Date.now(),
  inputs = ({ slotIso, triggerSource: source }) => ({ trigger_source: source, scheduled_slot: slotIso }),
} = {}) {
  // Seconds/fractions from Cloud Scheduler are not part of slot identity.
  // The minute is shared by Firestore, GitHub and the heartbeat.
  const slot = normalizeOrchestratorSlot(scheduledAt);
  const slotIso = slot.toISOString();
  if (!isUtcSlot(slot, slotsUtc)) {
    return { dispatched: false, reason: invalidSlotReason, scheduledAt: slotIso };
  }

  const store = claimStore ?? await createFirestoreClaimStore();
  const key = `${workflow}_${slotIso}`;
  const claim = await store.acquire(key, now());
  if (claim === 'dispatched') return { dispatched: false, reason: 'duplicate', scheduledAt: slotIso };
  if (claim === 'in_flight') return { dispatched: false, reason: 'in_flight', scheduledAt: slotIso };

  const { pat, owner, repo } = await getRepoConfigImpl();
  if (!pat) throw new Error('github_pat_not_configured');

  if (claim === 'reacquired') {
    // The previous attempt may have been accepted with its response lost.
    const existing = await findMarkedWorkflowRun({
      fetchImpl,
      pat,
      owner,
      repo,
      workflow,
      slotIso,
      triggerSource,
      errorPrefix,
    });
    if (existing) {
      await store.markDispatched(key, now(), { runId: existing.id ?? null });
      return { dispatched: false, reason: 'duplicate', scheduledAt: slotIso, runId: existing.id ?? null };
    }
  }

  const response = await fetchImpl(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: githubApiHeaders(pat, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: 'main', inputs: inputs({ slotIso, triggerSource }) }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${errorPrefix}_dispatch_failed:${response.status}:${body.slice(0, 200)}`);
  }
  try {
    await store.markDispatched(key, now());
  } catch (error) {
    // The workflow is already dispatched; a retry will find its marked run.
    console.warn(`[dispatch:${errorPrefix}] claim not confirmed`, error instanceof Error ? error.message : String(error));
  }
  return { dispatched: true, scheduledAt: slotIso, status: response.status };
}
