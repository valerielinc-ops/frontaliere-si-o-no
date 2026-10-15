/**
 * Shared signatures for deploy jobs that ended without an application verdict.
 *
 * The timeout monitor and the deploy recovery path must agree on the same
 * evidence. A job conclusion alone is not enough: `cancelled` also describes
 * ordinary concurrency supersession, while a normal `failure` has a concluded
 * failing step. The only host-loss signature used here is a completed failed
 * job whose running step never received a conclusion.
 */

import { intFromEnv } from '../../lib/int-from-env.mjs';

export const TIMEOUT_ANNOTATION_RE = /exceeded[^.]*(maximum execution time|maximum number of minutes)/i;
export const TIMEOUT_JOB_CONCLUSIONS = new Set(['cancelled', 'timed_out']);
export const HOST_KILL_SETTLE_MS = intFromEnv('HOST_KILL_SETTLE_MS', 120_000);

const BUILD_LOCALE_JOB_RE = /^build-locale \(([^)\s]+)\)$/;

export function buildLocaleFromJobName(name) {
  const match = BUILD_LOCALE_JOB_RE.exec(String(name || ''));
  return match ? match[1] : null;
}

/**
 * Generic host-loss signature used by the periodic observer.
 *
 * @param {{status?: string, conclusion?: string|null, completed_at?: string|null, steps?: Array}} job
 * @param {number} nowMs
 * @param {number} settleMs
 * @returns {{stuck: Array, neverRan: Array}|null}
 */
export function detectHostKill(job, nowMs = Date.now(), settleMs = HOST_KILL_SETTLE_MS) {
  if (job?.conclusion !== 'failure' || job?.status !== 'completed') return null;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const stuck = steps.filter((step) => step?.status === 'in_progress');
  if (stuck.length === 0) return null;

  const completedAt = Date.parse(job.completed_at || '');
  if (Number.isFinite(completedAt) && nowMs - completedAt < settleMs) return null;

  const neverRan = steps.filter((step) => step?.status === 'queued' || step?.status === 'pending');
  return { stuck, neverRan };
}

/**
 * The exact timeout annotation GitHub adds for a job-level timeout.
 *
 * @param {Array} annotations
 * @returns {object|null}
 */
export function findTimeoutAnnotation(annotations) {
  if (!Array.isArray(annotations)) return null;
  return annotations.find((annotation) => TIMEOUT_ANNOTATION_RE.test(
    [annotation?.message, annotation?.title, annotation?.raw_details]
      .filter((value) => typeof value === 'string')
      .join('\n'),
  )) || null;
}

/**
 * @param {{status?: string, conclusion?: string|null, check_run_url?: string|null}} job
 * @param {Array} annotations
 * @returns {object|null}
 */
export function detectTimeout(job, annotations) {
  if (job?.status !== 'completed'
      || !TIMEOUT_JOB_CONCLUSIONS.has(String(job?.conclusion || ''))
      || !job?.check_run_url) return null;
  return findTimeoutAnnotation(annotations);
}

/**
 * Host-loss evidence specifically inside the locale's Build step. A host can
 * kill a later post-build step too, but that is not the recovery contract for
 * this path: rerunning it could repeat already-published side effects.
 *
 * @param {{name?: string, status?: string, conclusion?: string|null, steps?: Array}} job
 * @param {number} nowMs
 * @param {number} settleMs
 * @returns {{locale: string, buildStep: object, stuck: Array, neverRan: Array}|null}
 */
export function detectBuildLocaleHostKill(job, nowMs = Date.now(), settleMs = HOST_KILL_SETTLE_MS) {
  const locale = buildLocaleFromJobName(job?.name);
  if (!locale) return null;
  const kill = detectHostKill(job, nowMs, settleMs);
  if (!kill) return null;
  const buildStepName = `Build (BUILD_LOCALE=${locale})`;
  const buildStep = kill.stuck.find((step) => step?.name === buildStepName && step?.conclusion === null);
  if (!buildStep) return null;
  return { locale, buildStep, ...kill };
}

/**
 * Classify one build-locale job without treating a normal application failure
 * as transient infrastructure. The caller supplies annotations so this stays
 * pure and the recovery path can fail closed when they are unreadable.
 */
export function classifyBuildLocaleFailure(
  job,
  annotations = [],
  { nowMs = Date.now(), settleMs = HOST_KILL_SETTLE_MS } = {},
) {
  const locale = buildLocaleFromJobName(job?.name);
  if (!locale) return null;

  const hostKill = detectBuildLocaleHostKill(job, nowMs, settleMs);
  if (hostKill) return { kind: 'host-loss', locale, evidence: hostKill };

  const timeout = detectTimeout(job, annotations);
  if (timeout) return { kind: 'timeout', locale, evidence: timeout };

  return null;
}
