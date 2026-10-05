/**
 * jobgate — typed browser facade over services/jobGateExperimentCore.mjs.
 *
 * Holds the page-session assignment so telemetry emitters that have no React
 * context (Analytics.trackNewsletter) can tag the gate's subscribe event. No
 * imports beyond the pure core: services/analytics.ts imports this module, so
 * it must never import analytics or firebase back. The Remote Config loader
 * and React hook live in hooks/useJobGateExperiment.ts; the per-arm classes
 * JobBoard renders live in components/community/jobGateSkin.ts.
 *
 * Round 4 (`jobgate-v4`) tests the gate's visual treatment, copy unchanged
 * (round history and hypotheses: docs/AUTHGATE-HEADLINE-EXPERIMENT.md):
 *   control       — today's gate, byte-identical.
 *   navy_panel    — the gate becomes a dark navy panel, so it no longer
 *                   blends with the lavender employer card above it.
 *   spotlight     — white elevated card with an accent ring; the preview
 *                   fades into it; the email CTA is the only saturated
 *                   control and never looks disabled.
 *   actions_first — accent header band with the title, the sign-in buttons
 *                   right under it, explanation and benefits after them.
 */

import {
  JOBGATE_ARMS,
  JOBGATE_DEFAULT_ARMS_JSON,
  JOBGATE_EXPERIMENT_ID,
  JOBGATE_RC_KEYS,
  isJobGateNewsletterCta,
  jobGateSubscriberVariant,
  normalizeJobGateArm,
  parseJobGateWeights,
  pickJobGateArm,
  resolveJobGateAssignment as resolveCore,
  validateJobGateWeights,
} from './jobGateExperimentCore.mjs';

export {
  JOBGATE_ARMS,
  JOBGATE_DEFAULT_ARMS_JSON,
  JOBGATE_EXPERIMENT_ID,
  JOBGATE_RC_KEYS,
  isJobGateNewsletterCta,
  normalizeJobGateArm,
  parseJobGateWeights,
  pickJobGateArm,
  validateJobGateWeights,
};

export type JobGateArm = 'control' | 'navy_panel' | 'spotlight' | 'actions_first';

export interface JobGateAssignment {
  /** False until Remote Config answered (or the load timed out). */
  ready: boolean;
  /** True only when the visitor counts for the experiment and events carry its tags. */
  enrolled: boolean;
  /** Always `control` when not enrolled, so the render falls back to today's gate. */
  arm: JobGateArm;
}

export const JOBGATE_PENDING: JobGateAssignment = Object.freeze({ ready: false, enrolled: false, arm: 'control' });
export const JOBGATE_NOT_ENROLLED: JobGateAssignment = Object.freeze({ ready: true, enrolled: false, arm: 'control' });

export function resolveJobGateAssignment(input: {
  enabled?: unknown;
  arms?: unknown;
  force?: unknown;
  visitorId?: string | null;
}): JobGateAssignment {
  const resolved = resolveCore(input);
  if (!resolved.enrolled) return JOBGATE_NOT_ENROLLED;
  return { ready: true, enrolled: true, arm: resolved.arm as JobGateArm };
}

// ── Page-session state ─────────────────────────────────────────────────────

let activeAssignment: JobGateAssignment | null = null;

export function setActiveJobGateAssignment(assignment: JobGateAssignment | null): void {
  activeAssignment = assignment && assignment.enrolled ? assignment : null;
}

/** `{ experiment_id, variant }` for the enrolled visitor, or null (not enrolled / not resolved). */
export function getJobGateTelemetryParams(): { experiment_id: string; variant: JobGateArm } | null {
  return activeAssignment ? { experiment_id: JOBGATE_EXPERIMENT_ID, variant: activeAssignment.arm } : null;
}

/** `newsletter_subscribers.variant` for the enrolled visitor (`jobgate-v4:<arm>`), else null. */
export function getJobGateSubscriberVariant(assignment: JobGateAssignment | null = activeAssignment): string | null {
  return assignment && assignment.enrolled ? jobGateSubscriberVariant(assignment.arm) : null;
}

/**
 * Extra params for the gate's `newsletter` subscribe event. Only the JobBoard
 * gate CTAs are tagged; other `job_gate`-channel emitters stay untouched.
 */
export function jobGateNewsletterTags(sourceCta: string | undefined): { experiment_id: string; variant: string } | Record<string, never> {
  const params = getJobGateTelemetryParams();
  return params && isJobGateNewsletterCta(sourceCta) ? params : {};
}
