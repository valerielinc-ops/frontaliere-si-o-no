/**
 * Primary job-alert dispatch at 05:00 UTC. The native 12:07 UTC slot remains
 * the same-day safety net, but a second full primary run is not harmless: it
 * repeats the expensive Firestore reads and relies on a per-UTC-day guard
 * whose protection must live in the state it reads, not in cron spacing.
 *
 * `workflow_dispatch` defaults `dry_run` to true in send-job-alerts.yml, so
 * this adapter explicitly sends `dry_run: 'false'`; otherwise the Cloud
 * Scheduler invocation would build alerts without sending them. Claim, lease,
 * marked-run lookup, force-run rejection and marker construction are shared
 * with the crawler adapter.
 */
import { dispatchCloudSchedulerWorkflow } from './cloudSchedulerWorkflowDispatch.js';
import {
  CLOUD_SCHEDULER_TRIGGER_SOURCE,
  isUtcSlot,
  schedulerRunMarker as sharedSchedulerRunMarker,
} from './cloudSchedulerWorkflowContract.js';
import {
  JOB_ALERT_PRIMARY_CLOUD_SCHEDULE,
  JOB_ALERT_PRIMARY_SLOT_ID,
  JOB_ALERT_PRIMARY_SLOT_UTC,
  JOB_ALERT_WORKFLOW,
} from './jobAlertSchedule.js';

export {
  JOB_ALERT_PRIMARY_CLOUD_SCHEDULE,
  JOB_ALERT_PRIMARY_SLOT_ID,
  JOB_ALERT_PRIMARY_SLOT_UTC,
  JOB_ALERT_WORKFLOW,
} from './jobAlertSchedule.js';

export const JOB_ALERT_TRIGGER_SOURCE = CLOUD_SCHEDULER_TRIGGER_SOURCE;

export function isJobAlertPrimarySlot(scheduledAt) {
  return isUtcSlot(scheduledAt, [JOB_ALERT_PRIMARY_SLOT_UTC]);
}

export function schedulerRunMarker(slotIso) {
  return sharedSchedulerRunMarker(slotIso, JOB_ALERT_TRIGGER_SOURCE);
}

export const jobAlertSchedulerRunMarker = schedulerRunMarker;

export async function dispatchJobAlerts(options = {}) {
  return dispatchCloudSchedulerWorkflow({
    ...options,
    workflow: JOB_ALERT_WORKFLOW,
    slotsUtc: [JOB_ALERT_PRIMARY_SLOT_UTC],
    invalidSlotReason: 'not_job_alert_primary_slot',
    errorPrefix: 'job_alert',
    triggerSource: JOB_ALERT_TRIGGER_SOURCE,
    inputs: ({ slotIso, triggerSource }) => ({
      dry_run: 'false',
      trigger_source: triggerSource,
      scheduled_slot: slotIso,
    }),
  });
}
