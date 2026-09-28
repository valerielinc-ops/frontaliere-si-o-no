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
 * issue when a slot has no marked run.
 *
 * EXACTLY ONE WAVE PER SLOT. The dispatch POST is not idempotent and Cloud
 * Scheduler retries a failed invocation (and may deliver one twice), while a
 * second full wave is not harmless: it doubles the crawl and the
 * translate-pending dispatches into a saturated queue. So every slot owns a
 * Firestore claim (`workflow_dispatch_claims/<workflow>_<slot>`):
 *  - the first invocation creates it with a short lease and POSTs;
 *  - an invocation that finds a live lease does nothing (`in_flight`);
 *  - one that finds `dispatched` does nothing (`duplicate`);
 *  - one that finds an expired lease (the previous attempt threw, or lost the
 *    response) first asks GitHub whether the slot's MARKED run already exists
 *    — the marker `[cloud-scheduler <slot>]` is the run-name the workflow
 *    derives from the dispatch inputs — and only POSTs when it does not.
 * The lease (45 s) is longer than the POST timeout (20 s) and shorter than the
 * retry backoff (60 s, functions/index.js).
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
/** `trigger_source` input value; the workflow turns it into the run-name marker. */
export const ORCHESTRATOR_TRIGGER_SOURCE = 'cloud-scheduler';
export const CLAIM_COLLECTION = 'workflow_dispatch_claims';
export const CLAIM_LEASE_MS = 45_000;
export const DISPATCH_TIMEOUT_MS = 20_000;

/** Run-name marker of the slot's scheduler-dispatched, non-dry-run wave. */
export function schedulerRunMarker(slotIso) {
  return `[${ORCHESTRATOR_TRIGGER_SOURCE} ${slotIso}]`;
}

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

/**
 * Firestore-backed claim store. `acquire` returns one of `acquired` (new
 * claim), `reacquired` (expired lease of an unconfirmed attempt), `in_flight`
 * or `dispatched`; the read-modify-write runs in a transaction, so two
 * concurrent invocations cannot both acquire.
 */
export async function createFirestoreClaimStore() {
  const { getAdminDb } = await import('./newsletterResendWebhookCore.js');
  const db = getAdminDb();
  const ref = (key) => db.collection(CLAIM_COLLECTION).doc(key);
  return {
    async acquire(key, nowMs) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(key));
        if (!snap.exists) {
          tx.create(ref(key), { status: 'pending', attempts: 1, leaseUntilMs: nowMs + CLAIM_LEASE_MS, createdAtMs: nowMs });
          return 'acquired';
        }
        const data = snap.data() || {};
        if (data.status === 'dispatched') return 'dispatched';
        if (Number(data.leaseUntilMs) > nowMs) return 'in_flight';
        tx.update(ref(key), { attempts: Number(data.attempts || 0) + 1, leaseUntilMs: nowMs + CLAIM_LEASE_MS });
        return 'reacquired';
      });
    },
    async markDispatched(key, nowMs, detail = {}) {
      await ref(key).set({ status: 'dispatched', dispatchedAtMs: nowMs, ...detail }, { merge: true });
    },
  };
}

/** Does GitHub already hold the marked run of this slot? */
async function findSlotRun({ fetchImpl, pat, owner, repo, slotIso }) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${ORCHESTRATOR_WORKFLOW}/runs`
    + `?event=workflow_dispatch&created=${encodeURIComponent(`>=${slotIso}`)}&per_page=50`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: githubApiHeaders(pat),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`orchestrator_run_lookup_failed:${response.status}`);
  const body = await response.json();
  if (!body || !Array.isArray(body.workflow_runs)) throw new Error('orchestrator_run_lookup_invalid');
  const marker = schedulerRunMarker(slotIso);
  return body.workflow_runs.find((run) => String(run?.display_title ?? '').includes(marker)) ?? null;
}

export async function dispatchOrchestrator({
  scheduledAt = new Date(),
  fetchImpl = fetch,
  getRepoConfigImpl = getRepoConfig,
  claimStore,
  now = () => Date.now(),
} = {}) {
  const slot = toValidDate(scheduledAt);
  const slotIso = slot.toISOString();
  if (!isOrchestratorSlot(slot)) {
    return { dispatched: false, reason: 'not_orchestrator_slot', scheduledAt: slotIso };
  }

  const store = claimStore ?? await createFirestoreClaimStore();
  const key = `${ORCHESTRATOR_WORKFLOW}_${slotIso}`;
  const claim = await store.acquire(key, now());
  if (claim === 'dispatched') return { dispatched: false, reason: 'duplicate', scheduledAt: slotIso };
  if (claim === 'in_flight') return { dispatched: false, reason: 'in_flight', scheduledAt: slotIso };

  const { pat, owner, repo } = await getRepoConfigImpl();
  if (!pat) throw new Error('github_pat_not_configured');

  if (claim === 'reacquired') {
    // The previous attempt may have been accepted with its response lost.
    const existing = await findSlotRun({ fetchImpl, pat, owner, repo, slotIso });
    if (existing) {
      await store.markDispatched(key, now(), { runId: existing.id ?? null });
      return { dispatched: false, reason: 'duplicate', scheduledAt: slotIso, runId: existing.id ?? null };
    }
  }

  // group/delay_seconds/dry_run keep their defaults: the same wave the
  // scheduled run used to dispatch. The two inputs below only name the run.
  const response = await fetchImpl(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${ORCHESTRATOR_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: githubApiHeaders(pat, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        ref: 'main',
        inputs: { trigger_source: ORCHESTRATOR_TRIGGER_SOURCE, scheduled_slot: slotIso },
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`orchestrator_dispatch_failed:${response.status}:${body.slice(0, 200)}`);
  }
  try {
    await store.markDispatched(key, now());
  } catch (error) {
    // The wave is already dispatched; a retry would find the marked run.
    console.warn('[dispatchOrchestrator] claim not confirmed', error instanceof Error ? error.message : String(error));
  }
  return { dispatched: true, scheduledAt: slotIso, status: response.status };
}
