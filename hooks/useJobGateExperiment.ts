/**
 * jobgate-v3 — Remote Config loader + React hook for the job-detail auth gate.
 *
 * The browser never reads Remote Config directly: `getConfigValue` serves the
 * allowlisted keys from `getPublicConfig` (functions/src/publicConfigKeys.js)
 * with REMOTE_CONFIG_DEFAULTS as fallback (services/firebase.ts), and those
 * defaults keep the experiment OFF. The assignment is resolved once per page
 * session and shared by the hook and the subscriber write, so the same arm tags
 * the telemetry and the Firestore document.
 *
 * Fail-safe paths, all ending in "not enrolled, today's gate":
 *   - JOBGATE_EXPERIMENT_ENABLED missing/`false` (kill switch);
 *   - Remote Config slower than LOAD_TIMEOUT_MS or throwing;
 *   - no stable visitor id (storage blocked) and no forced arm;
 *   - crawlers/bots (the caller passes `bypass`).
 */

import { useEffect, useState } from 'react';
import { Analytics } from '@/services/analytics';
import { getAssistedApplicationDistinctId } from '@/services/assistedApplicationExperiment';
import { getConfigValue } from '@/services/firebase';
import {
  JOBGATE_EXPERIMENT_ID,
  JOBGATE_NOT_ENROLLED,
  JOBGATE_PENDING,
  JOBGATE_RC_KEYS,
  resolveJobGateAssignment,
  setActiveJobGateAssignment,
  type JobGateAssignment,
} from '@/services/jobGateExperiment';

/** Past this the page keeps today's gate for the whole session (no late flip). */
export const JOBGATE_LOAD_TIMEOUT_MS = 3000;

/** Remembers which arm already produced `experiment_assigned` for this browser. */
export const JOBGATE_ASSIGNED_STORAGE_KEY = 'frontaliere_jobgate_v3_assigned';

let assignmentPromise: Promise<JobGateAssignment> | null = null;
const assignedThisSession = new Set<string>();

async function readAssignment(): Promise<JobGateAssignment> {
  const [enabled, arms, force] = await Promise.all([
    getConfigValue(JOBGATE_RC_KEYS.enabled),
    getConfigValue(JOBGATE_RC_KEYS.arms),
    getConfigValue(JOBGATE_RC_KEYS.force),
  ]);
  return resolveJobGateAssignment({
    enabled,
    arms,
    force,
    // The same non-PII browser id the assisted-application split uses; the
    // experiment id salts the hash, so the two splits are independent.
    visitorId: getAssistedApplicationDistinctId(),
  });
}

/** Resolve (once per page session) and publish the assignment. Never rejects. */
export function loadJobGateAssignment(): Promise<JobGateAssignment> {
  if (assignmentPromise) return assignmentPromise;
  assignmentPromise = new Promise<JobGateAssignment>((resolve) => {
    const timer = setTimeout(() => resolve(JOBGATE_NOT_ENROLLED), JOBGATE_LOAD_TIMEOUT_MS);
    readAssignment()
      .then(resolve, () => resolve(JOBGATE_NOT_ENROLLED))
      .finally(() => clearTimeout(timer));
  }).then((assignment) => {
    setActiveJobGateAssignment(assignment);
    return assignment;
  });
  return assignmentPromise;
}

/**
 * The assignment the hook already started loading, or "not enrolled" when it
 * never did (crawler/bot bypass). The subscriber write awaits this instead of
 * starting its own load, so a bypassed visitor — shown today's gate and sending
 * untagged events — can never get a `jobgate-v3:*` document either.
 */
export function currentJobGateAssignment(): Promise<JobGateAssignment> {
  return assignmentPromise ?? Promise.resolve(JOBGATE_NOT_ENROLLED);
}

/** Test seam: forget the memoized assignment and the session exposure set. */
export function resetJobGateAssignmentForTests(): void {
  assignmentPromise = null;
  assignedThisSession.clear();
  setActiveJobGateAssignment(null);
}

/**
 * Emit `experiment_assigned` once per visitor (per arm) the first time an
 * enrolled visitor is shown the gate. Storage failures degrade to once per
 * page session instead of once per visit.
 */
export function recordJobGateExposure(assignment: JobGateAssignment): void {
  if (!assignment.enrolled) return;
  if (assignedThisSession.has(assignment.arm)) return;
  assignedThisSession.add(assignment.arm);
  try {
    if (window.localStorage.getItem(JOBGATE_ASSIGNED_STORAGE_KEY) === assignment.arm) return;
    window.localStorage.setItem(JOBGATE_ASSIGNED_STORAGE_KEY, assignment.arm);
  } catch {
    // Private mode / blocked storage: the session set above still dedupes.
  }
  Analytics.trackExperimentEvent('experiment_assigned', {
    experiment_id: JOBGATE_EXPERIMENT_ID,
    variant: assignment.arm,
  });
}

/**
 * The visitor's jobgate-v3 assignment. Starts at `JOBGATE_PENDING` (renders as
 * control, not enrolled) and settles once; `bypass` keeps crawlers and bots out.
 */
export function useJobGateExperiment(bypass = false): JobGateAssignment {
  const [assignment, setAssignment] = useState<JobGateAssignment>(JOBGATE_PENDING);

  useEffect(() => {
    if (bypass) {
      setAssignment(JOBGATE_NOT_ENROLLED);
      return undefined;
    }
    let cancelled = false;
    void loadJobGateAssignment().then((resolved) => {
      if (!cancelled) setAssignment(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [bypass]);

  return assignment;
}
