import { useEffect, useState } from 'react';
import { Analytics } from './analytics';
import { getDistinctId, getFeatureFlag, onFeatureFlags, registerSuperProperty } from './posthog';
import { ASSISTED_APPLICATION_PRICE_EUR_CENTS as SHARED_ASSISTED_APPLICATION_PRICE_EUR_CENTS } from '@/functions/src/assistedApplicationConstants.js';

export const ASSISTED_APPLICATION_PRICE_EUR_CENTS = SHARED_ASSISTED_APPLICATION_PRICE_EUR_CENTS;

/** Stable identifiers shared by the SPA funnel and its analytics queries. */
export const ASSISTED_APPLICATION_EXPERIMENT_ID = 'assisted-application-v1';
export const ASSISTED_APPLICATION_FLAG_KEY = ASSISTED_APPLICATION_EXPERIMENT_ID;
export const ASSISTED_APPLICATION_CONSENT_VERSION = 'assisted-application-v1';
export const ASSISTED_APPLICATION_VARIANTS = ['control', 'assisted_application'] as const;
export type AssistedApplicationVariant = (typeof ASSISTED_APPLICATION_VARIANTS)[number];

export const ASSISTED_APPLICATION_EVENT_NAMES = [
  'experiment_assigned',
  'job_apply_click',
  'assisted_application_offer_viewed',
  'assisted_application_choose_external',
  'assisted_application_choose_paid',
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
 * Resolve the fallback assignment. The treatment owns 40% of buckets; the
 * control owns the remaining 60%. PostHog's explicit flag wins when present,
 * while this path keeps the experiment usable during SDK/ad-blocker failure.
 */
export function resolveAssistedApplicationVariant(distinctId: string): AssistedApplicationVariant {
  const normalized = String(distinctId || '').trim();
  if (!normalized) return 'control';
  return hashDistinctId(normalized) % 100 < 40 ? 'assisted_application' : 'control';
}

export function normalizeAssistedApplicationVariant(value: unknown): AssistedApplicationVariant | null {
  return value === 'control' || value === 'assisted_application' ? value : null;
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

/** Return PostHog's id, or a non-PII browser id when PostHog is unavailable. */
export function getAssistedApplicationDistinctId(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const existing = window.localStorage.getItem(ANONYMOUS_DISTINCT_ID_KEY);
    if (existing) return existing;
    const posthogId = getDistinctId();
    if (posthogId) {
      window.localStorage.setItem(ANONYMOUS_DISTINCT_ID_KEY, posthogId);
      return posthogId;
    }
    const created = createAnonymousDistinctId();
    window.localStorage.setItem(ANONYMOUS_DISTINCT_ID_KEY, created);
    return created;
  } catch {
    return getDistinctId();
  }
}

export interface AssistedApplicationVariantResult {
  experimentId: string;
  variant: AssistedApplicationVariant;
  ready: boolean;
}

/**
 * Resolve the sticky assignment once flags are available. Initial render stays
 * control, matching the existing auth-gate experiment's no-flash contract.
 */
export function useAssistedApplicationVariant(): AssistedApplicationVariantResult {
  const [variant, setVariant] = useState<AssistedApplicationVariant>('control');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let lastAssignment = '';

    const assign = () => {
      const distinctId = getAssistedApplicationDistinctId();
      const flagged = normalizeAssistedApplicationVariant(getFeatureFlag(ASSISTED_APPLICATION_FLAG_KEY));
      const resolved = flagged ?? resolveAssistedApplicationVariant(distinctId || '');
      const assignmentKey = `${distinctId || 'unknown'}:${resolved}`;
      setVariant(resolved);
      setReady(true);
      registerSuperProperty('assisted_application_variant', resolved);

      if (assignmentKey === lastAssignment) return;
      lastAssignment = assignmentKey;
      // Exposure is emitted by JobBoard once a real external job detail is in
      // view, because only that surface has the required job/company context.
    };

    assign();
    const unsubscribe = onFeatureFlags(assign);
    return unsubscribe;
  }, []);

  return { experimentId: ASSISTED_APPLICATION_EXPERIMENT_ID, variant, ready };
}

export interface AssistedApplicationEventContext {
  variant: AssistedApplicationVariant;
  jobId: string;
  companyId: string;
  [key: string]: unknown;
}

/** Emit the shared funnel shape without sending PII or free-form job text. */
export function trackAssistedApplicationEvent(
  eventName: (typeof ASSISTED_APPLICATION_EVENT_NAMES)[number],
  context: AssistedApplicationEventContext,
): void {
  Analytics.trackEvent(eventName, {
    ...context,
    experiment_id: ASSISTED_APPLICATION_EXPERIMENT_ID,
    variant: context.variant,
    job_id: String(context.jobId),
    company_id: String(context.companyId),
  });
}
