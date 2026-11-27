/**
 * Shared identity contract for workflows whose clock is Cloud Scheduler.
 *
 * Cloud Scheduler can deliver a tick with seconds/fractions, and it can retry
 * or deliver the same tick twice. Every consumer therefore normalizes
 * `scheduleTime` to the UTC minute before using it as the Firestore claim key,
 * the `scheduled_slot` input, the run-name marker and the heartbeat identity.
 * A Cloud Console "force run" carries the current `scheduleTime`: unless that
 * instant belongs to a configured nominal slot, the dispatcher refuses it so a
 * hand-fired run cannot create an extra wave.
 *
 * The marker is deliberately shared with the heartbeat and the retry lookup:
 * `[cloud-scheduler <slot ISO>]`. The claim lease is 45 s, longer than the
 * 20 s GitHub POST/lookup timeout and shorter than the 60 s Cloud Scheduler
 * retry backoff configured by the registered functions.
 */
import { normalizeOrchestratorSlot } from './lib/orchestratorSlot.js';

export const CLOUD_SCHEDULER_TRIGGER_SOURCE = 'cloud-scheduler';
export const SCHEDULER_RUN_MARKER_PREFIX = `[${CLOUD_SCHEDULER_TRIGGER_SOURCE} `;
export const CLAIM_COLLECTION = 'workflow_dispatch_claims';
export const CLAIM_LEASE_MS = 45_000;
export const DISPATCH_TIMEOUT_MS = 20_000;

/** Run-name marker shared by every Cloud Scheduler-owned workflow dispatch. */
export function schedulerRunMarker(slotIso, triggerSource = CLOUD_SCHEDULER_TRIGGER_SOURCE) {
  return `[${triggerSource} ${slotIso}]`;
}

function parseUtcSlot(raw) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!match) throw new TypeError(`UTC slot must look like HH:MM, got "${raw}"`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new RangeError(`UTC slot out of range: "${raw}"`);
  return { hour, minute, label: `${match[1]}:${match[2]}` };
}

/** Derive a fixed-minute Cloud Scheduler cron expression from nominal UTC slots. */
export function cloudSchedulerSchedule(slotsUtc) {
  if (!Array.isArray(slotsUtc) || slotsUtc.length === 0) {
    throw new RangeError('at least one UTC slot is required');
  }
  const parsed = slotsUtc.map(parseUtcSlot);
  const minutes = new Set(parsed.map(({ minute }) => minute));
  if (minutes.size !== 1) throw new RangeError('all UTC slots must share one minute');
  const hours = [...new Set(parsed.map(({ hour }) => hour))].sort((left, right) => left - right);
  return `${[...minutes][0]} ${hours.join(',')} * * *`;
}

/** True only when a timestamp falls on one of the configured nominal UTC slots. */
export function isUtcSlot(scheduledAt, slotsUtc) {
  const date = normalizeOrchestratorSlot(scheduledAt);
  const label = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  return slotsUtc.some((slot) => parseUtcSlot(slot).label === label);
}
