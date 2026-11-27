/**
 * orchestratorCronDispatch.js — Cloud Scheduler owns the crawler wave clock;
 * orchestrate-crawlers.yml stays the single dispatcher of the wave.
 *
 * Why not GitHub's `schedule:`. Measured on 2026-09-28 (last 20
 * `event=schedule` runs of every scheduled workflow, site and corpus, slots
 * since 09-14): orchestrate-crawlers.yml was created a median of 306 min late
 * for `0 9` and 148 min for `0 21`. Non-round minutes were just as late (site:
 * `:00` median 284 min, other minutes 301 min; corpus 287 vs 291), so moving
 * the minute does not fix the queue; the delay follows the UTC hour of the
 * slot (~5 h for 02-09 UTC, ~2.5 h for 16-21 UTC), and both repos show the
 * same pattern. The workflow_dispatch path used by dispatchTrafficCollection
 * (trafficSchedulerDispatch.js, #9548) creates the run about 6 s after the
 * Cloud Scheduler tick with the same `GITHUB_PAT` from Remote Config.
 *
 * The cadence and nominal slots remain 09:00 and 21:00 UTC. The native GitHub
 * cron is removed so a delayed cron cannot create a second wave. A second wave
 * is not harmless: it doubles the crawler work and the translate-pending
 * dispatches into an already saturated queue. The shared claim in
 * `workflow_dispatch_claims/<workflow>_<slot>` admits exactly one dispatch:
 * `acquired` posts, `in_flight` waits, `dispatched` is a duplicate, and an
 * expired lease is `reacquired` only after looking for the marked run.
 * The heartbeat opens an issue when a slot has no marked run.
 *
 * The shared contract normalizes `scheduleTime` to the minute, rejects a
 * Cloud Console force run whose current time is outside 09:00/21:00, and uses
 * the marker `[cloud-scheduler <slot ISO>]`; its 45 s lease is longer than the
 * 20 s POST timeout and shorter than the 60 s retry backoff in functions/index.js.
 *
 * group/delay_seconds/dry_run keep their workflow defaults: the two inputs
 * below only identify the Cloud Scheduler wave. The public crawler constants,
 * helpers and dispatch function remain exported through this adapter.
 */

import {
  CLAIM_COLLECTION as SHARED_CLAIM_COLLECTION,
  CLAIM_LEASE_MS as SHARED_CLAIM_LEASE_MS,
  DISPATCH_TIMEOUT_MS as SHARED_DISPATCH_TIMEOUT_MS,
  createFirestoreClaimStore,
  dispatchCloudSchedulerWorkflow,
} from './cloudSchedulerWorkflowDispatch.js';
import {
  CLOUD_SCHEDULER_TRIGGER_SOURCE,
  cloudSchedulerSchedule,
  isUtcSlot,
  schedulerRunMarker as sharedSchedulerRunMarker,
} from './cloudSchedulerWorkflowContract.js';

export const ORCHESTRATOR_WORKFLOW = 'orchestrate-crawlers.yml';
/** Nominal UTC slots, `HH:MM`. Kept in parity with the heartbeat by a test. */
export const ORCHESTRATOR_SLOTS_UTC = Object.freeze(['09:00', '21:00']);
/** Cloud Scheduler expression derived from the slots above (UTC). */
export const ORCHESTRATOR_CLOUD_SCHEDULE = cloudSchedulerSchedule(ORCHESTRATOR_SLOTS_UTC);
/** `trigger_source` input value; the workflow turns it into the run-name marker. */
export const ORCHESTRATOR_TRIGGER_SOURCE = CLOUD_SCHEDULER_TRIGGER_SOURCE;
export const CLAIM_COLLECTION = SHARED_CLAIM_COLLECTION;
export const CLAIM_LEASE_MS = SHARED_CLAIM_LEASE_MS;
export const DISPATCH_TIMEOUT_MS = SHARED_DISPATCH_TIMEOUT_MS;

/** Run-name marker of the slot's scheduler-dispatched, non-dry-run wave. */
export function schedulerRunMarker(slotIso) {
  return sharedSchedulerRunMarker(slotIso, ORCHESTRATOR_TRIGGER_SOURCE);
}

/** True only for one of the crawler's nominal UTC slots. */
export function isOrchestratorSlot(scheduledAt) {
  return isUtcSlot(scheduledAt, ORCHESTRATOR_SLOTS_UTC);
}

export async function dispatchOrchestrator(options = {}) {
  return dispatchCloudSchedulerWorkflow({
    ...options,
    workflow: ORCHESTRATOR_WORKFLOW,
    slotsUtc: ORCHESTRATOR_SLOTS_UTC,
    invalidSlotReason: 'not_orchestrator_slot',
    errorPrefix: 'orchestrator',
    triggerSource: ORCHESTRATOR_TRIGGER_SOURCE,
    inputs: ({ slotIso, triggerSource }) => ({ trigger_source: triggerSource, scheduled_slot: slotIso }),
  });
}

export { createFirestoreClaimStore };
