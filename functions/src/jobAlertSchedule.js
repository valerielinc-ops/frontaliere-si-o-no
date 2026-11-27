import { cloudSchedulerSchedule } from './cloudSchedulerWorkflowContract.js';

export const JOB_ALERT_WORKFLOW = 'send-job-alerts.yml';
/** The single primary job-alert slot owned by Cloud Scheduler, in UTC. */
export const JOB_ALERT_PRIMARY_SLOT_UTC = '05:00';
/** Derived from JOB_ALERT_PRIMARY_SLOT_UTC so the time has one source of truth. */
export const JOB_ALERT_PRIMARY_CLOUD_SCHEDULE = cloudSchedulerSchedule([JOB_ALERT_PRIMARY_SLOT_UTC]);
/** Stable handoff identity; it does not change when the clock moves. */
export const JOB_ALERT_PRIMARY_SLOT_ID = 'job-alert-primary';

/**
 * First primary slot that the heartbeat is allowed to judge. This is fixed
 * ahead of the merge so the already-running heartbeat does not treat the
 * historical 05:00 slot as a failed dispatch before this function exists.
 * If deployment slips past this instant, move the value forward to the first
 * slot that can actually be served before the heartbeat reaches it.
 */
export const JOB_ALERT_PRIMARY_INTRODUCED_AT = '2026-11-28T05:00:00Z';
