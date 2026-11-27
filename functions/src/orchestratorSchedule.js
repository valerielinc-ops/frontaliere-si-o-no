import { cloudSchedulerSchedule } from './cloudSchedulerWorkflowContract.js';

/** Nominal crawler slots, in UTC, shared by Functions, the admin panel and the heartbeat. */
export const ORCHESTRATOR_SLOTS_UTC = Object.freeze(['09:00', '21:00']);
/** Cloud Scheduler expression derived from ORCHESTRATOR_SLOTS_UTC. */
export const ORCHESTRATOR_CLOUD_SCHEDULE = cloudSchedulerSchedule(ORCHESTRATOR_SLOTS_UTC);
