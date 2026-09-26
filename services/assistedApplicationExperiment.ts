import { useEffect, useState } from 'react';
import { Analytics } from './analytics';
import { getConfigValue } from './firebase';
import { ASSISTED_APPLICATION_PRICE_EUR_CENTS as SHARED_ASSISTED_APPLICATION_PRICE_EUR_CENTS } from '@/functions/src/assistedApplicationConstants.js';
import { isCrawlerVisitorAgent } from '@/functions/src/lib/returnVisit.js';
import { isLikelyBot } from './botPatterns';

export const ASSISTED_APPLICATION_PRICE_EUR_CENTS = SHARED_ASSISTED_APPLICATION_PRICE_EUR_CENTS;

/** Stable identifiers shared by the SPA funnel and its analytics queries. */
export const ASSISTED_APPLICATION_EXPERIMENT_ID = 'assisted-application-v2';
export const ASSISTED_APPLICATION_EXPERIMENT_RC_KEY = 'ASSISTED_APPLICATION_EXPERIMENT_VARIANT';
export const ASSISTED_APPLICATION_CONSENT_VERSION = 'assisted-application-v1';
export const ASSISTED_APPLICATION_VARIANTS = ['control', 'assisted_application', 'rewarded_ad'] as const;
export type AssistedApplicationVariant = (typeof ASSISTED_APPLICATION_VARIANTS)[number];

export const ASSISTED_APPLICATION_EVENT_NAMES = [
  'experiment_assigned',
  'job_apply_click',
  'assisted_application_offer_viewed',
  'rewarded_application_offer_requested',
  'assisted_application_choose_external',
  'assisted_application_choose_paid',
  'rewarded_application_offer_viewed',
  'rewarded_ad_opt_in',
  'rewarded_ad_granted',
  'rewarded_ad_unavailable',
  'rewarded_gpt_ready_timeout',
  'rewarded_application_access_granted',
  'rewarded_application_access_used',
  'rewarded_offerwall_released',
  'rewarded_offerwall_shown',
  'rewarded_offerwall_completed',
  'rewarded_offerwall_closed_without_reward',
  'rewarded_offerwall_not_shown',
  'rewarded_offerwall_timed_out',
  // GPT rewarded fallback of a released Offerwall that is late or never shows.
  'rewarded_offerwall_gpt_fallback_started',
  'rewarded_offerwall_gpt_fallback_shown',
  'rewarded_offerwall_gpt_fallback_granted',
  'rewarded_offerwall_gpt_fallback_aborted',
  'external_apply_redirected',
  'checkout_started',
  'checkout_completed',
  'checkout_failed',
  'consent_confirmed',
  'cv_upload_started',
  'cv_upload_completed',
  'cv_upload_failed',
  'manual_submission_queued',
  'manual_submission_completed',
  'manual_submission_blocked',
  'refund_issued',
] as const;

const ANONYMOUS_DISTINCT_ID_KEY = 'frontaliere_assisted_application_distinct_id';

/** FNV-1a gives a small, dependency-free, stable bucket for a distinct id. */
function hashDistinctId(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Resolve the fallback assignment for surfaces outside the job-board
 * sections. Those pages run only the requested subscription-vs-original A/B
 * test; the rewarded arm is reserved for the job-board sections (every
 * canton, the Switzerland aggregator, every locale: owner decision
 * 2026-09-26, which ended this A/B there) and is forced there by JobBoard
 * instead of being assigned here.
 */
export function resolveAssistedApplicationVariant(distinctId: string): AssistedApplicationVariant {
  const normalized = String(distinctId || '').trim();
  if (!normalized) return 'control';
  const bucket = hashDistinctId(normalized) % 100;
  return bucket < 50 ? 'control' : 'assisted_application';
}

export function normalizeAssistedApplicationVariant(value: unknown): AssistedApplicationVariant | null {
  return value === 'control' || value === 'assisted_application' || value === 'rewarded_ad' ? value : null;
}

function createAnonymousDistinctId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `anon-${crypto.randomUUID()}`;
    }
  } catch {
    // Fall through to the older-browser-safe value below.
  }
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Return a non-PII browser id used to keep the assignment sticky. */
export function getAssistedApplicationDistinctId(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const existing = window.localStorage.getItem(ANONYMOUS_DISTINCT_ID_KEY);
    if (existing) return existing;
    const created = createAnonymousDistinctId();
    window.localStorage.setItem(ANONYMOUS_DISTINCT_ID_KEY, created);
    return created;
  } catch {
    return null;
  }
}

export interface AssistedApplicationVariantResult {
  experimentId: string;
  variant: AssistedApplicationVariant;
  ready: boolean;
}

/**
 * Resolve the sticky assignment once Remote Config is available. Initial
 * render stays control, preserving the no-flash contract.
 */
export function useAssistedApplicationVariant(enabled = true): AssistedApplicationVariantResult {
  const [variant, setVariant] = useState<AssistedApplicationVariant>(enabled ? 'control' : 'rewarded_ad');
  const [ready, setReady] = useState(!enabled);
  const [assignmentEnabled, setAssignmentEnabled] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setVariant('rewarded_ad');
      setReady(true);
      setAssignmentEnabled(false);
      return undefined;
    }

    // A route transition can leave the previous route-only rewarded arm in
    // state for one render. Reset before Remote Config resolves so a surface
    // outside the job-board sections never exposes a stale rewarded treatment.
    setVariant('control');
    setReady(false);
    setAssignmentEnabled(true);

    let lastAssignment = '';
    let cancelled = false;

    const assign = async () => {
      const distinctId = getAssistedApplicationDistinctId();
      const configured = await getConfigValue(ASSISTED_APPLICATION_EXPERIMENT_RC_KEY).catch(() => '');
      if (cancelled) return;
      const flagged = normalizeAssistedApplicationVariant(configured.trim().toLowerCase());
      // `rewarded_ad` remains a route-level variant for the job-board sections;
      // a stale global value must fall back to the other-surface A/B split,
      // never turn every non-job-board visitor into the original arm.
      const resolved = flagged === 'rewarded_ad'
        ? resolveAssistedApplicationVariant(distinctId || '')
        : flagged ?? resolveAssistedApplicationVariant(distinctId || '');
      const assignmentKey = `${distinctId || 'unknown'}:${resolved}`;
      setVariant(resolved);
      setReady(true);

      if (assignmentKey === lastAssignment) return;
      lastAssignment = assignmentKey;
      // Exposure is emitted by JobBoard once a real external job detail is in
      // view, because only that surface has the required job/company context.
    };

    void assign();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Render the safe transition state immediately, before the effect above has
  // committed its reset after an enabled/disabled route change.
  const effectiveVariant = assignmentEnabled === enabled
    ? variant
    : enabled
      ? 'control'
      : 'rewarded_ad';
  const effectiveReady = assignmentEnabled === enabled ? ready : !enabled;

  return { experimentId: ASSISTED_APPLICATION_EXPERIMENT_ID, variant: effectiveVariant, ready: effectiveReady };
}

export interface AssistedApplicationEventContext {
  variant: AssistedApplicationVariant;
  jobId: string;
  companyId: string;
  [key: string]: unknown;
}

/**
 * Keep automated traffic out of the assisted-application funnel even if a
 * caller reaches an event path without going through JobBoard's UI gate.
 * Server-side rendering has no visitor identity, so it must not suppress
 * events from non-browser callers used by the admin/test surfaces.
 */
export function shouldSuppressAssistedApplicationEvent(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  return isCrawlerVisitorAgent(userAgent) || isLikelyBot();
}

/** Emit the shared funnel shape without sending PII or free-form job text. */
export function trackAssistedApplicationEvent(
  eventName: (typeof ASSISTED_APPLICATION_EVENT_NAMES)[number],
  context: AssistedApplicationEventContext,
): void {
  if (shouldSuppressAssistedApplicationEvent()) return;
  Analytics.trackExperimentEvent(eventName, {
    ...context,
    experiment_id: ASSISTED_APPLICATION_EXPERIMENT_ID,
    variant: context.variant,
    job_id: String(context.jobId),
    company_id: String(context.companyId),
  });
}
