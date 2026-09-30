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

/**
 * Owner decision 2026-09-29: on the rewarded job-board arm, when the Offerwall
 * and its GPT fallback cannot be LOADED, offer the 0,99 € assisted
 * application (with the free external path next to it) instead of silently
 * redirecting. Remote Config flag, local default OFF (services/firebase.ts).
 */
export const ASSISTED_APPLICATION_OFFERWALL_FALLBACK_RC_KEY = 'ASSISTED_APPLICATION_OFFERWALL_FALLBACK';

/**
 * `onUnavailable` reasons of RewardedApplicationOffer that mean "no ad could be
 * loaded or shown". Deliberate user choices are NOT here: closing the
 * Offerwall (`offerwall_closed_without_reward`), declining the ad consent card
 * (`ad_consent_missing`) or having refused ads in the CMP (`consent_denied`);
 * nor non-production / ineligible runs.
 */
export const OFFERWALL_LOAD_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'offerwall_not_shown',
  'no_fill',
  'ready_timeout',
  'gpt_ready_timeout',
  'gpt_unavailable',
  'slot_init_error',
  'display_error',
  'slot_not_ready',
]);

export function isOfferwallLoadFailure(reason: unknown): boolean {
  return typeof reason === 'string' && OFFERWALL_LOAD_FAILURE_REASONS.has(reason);
}

/**
 * `onUnavailable` reasons of a visitor who refused the ad (owner decision
 * 2026-09-29: they get the paid offer too): ads refused in the CMP, the
 * consent card declined, or the Offerwall closed without its reward.
 */
export const OFFERWALL_AD_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'consent_denied',
  'ad_consent_missing',
  'offerwall_closed_without_reward',
]);

/**
 * The paid offer replaces the direct hand-off when no ad could be loaded or
 * the visitor refused it. Ineligible and non-production runs (bots, dev
 * hosts) keep the direct hand-off.
 */
export function shouldOfferPaidFallback(reason: unknown): boolean {
  return isOfferwallLoadFailure(reason)
    || (typeof reason === 'string' && OFFERWALL_AD_REFUSAL_REASONS.has(reason));
}

export function parseOfferwallFallbackFlag(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

/** Read once per mount; any failure keeps the fallback off. */
export function useOfferwallPaidFallback(enabled = true): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setActive(false);
      return undefined;
    }
    let cancelled = false;
    getConfigValue(ASSISTED_APPLICATION_OFFERWALL_FALLBACK_RC_KEY)
      .then((value) => { if (!cancelled) setActive(parseOfferwallFallbackFlag(value)); })
      .catch(() => { if (!cancelled) setActive(false); });
    return () => { cancelled = true; };
  }, [enabled]);
  return active;
}
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
  // Offerwall recovery (services/offerwallRecovery.ts): the reload that resumes
  // the click, the resumed click, and the consent card.
  'rewarded_offerwall_reload',
  'rewarded_application_offer_resumed',
  'rewarded_offerwall_consent_reopened',
  'rewarded_offerwall_consent_decided',
  'rewarded_offerwall_consent_declined',
  'external_apply_redirected',
  // New-tab hand-off after the reward (RewardedApplicationOffer). Distinct
  // names instead of a parameter: GA4 reads them without a custom dimension.
  // `auto`: opened at once inside the click's activation; `shown`: the "open"
  // card; `clicked`: its button; `unconfirmed`: no new tab took the foreground
  // (blocked popup), so the card came back.
  'rewarded_application_handoff_auto',
  'rewarded_application_handoff_shown',
  'rewarded_application_handoff_clicked',
  'rewarded_application_handoff_unconfirmed',
  // Snapshots of the page's ads (services/adVisibilitySnapshot.ts): at the
  // click, 1.5 s after Google's Offerwall is on screen, and when the visitor
  // comes back to the tab after the employer's page opened. Metrics
  // ads_total / ads_visible / anchor_visible.
  'rewarded_offer_ads_open',
  'rewarded_offer_ads_offerwall',
  'rewarded_offer_ads_return',
  // The Offerwall/GPT chain failed to load and the paid offer opened instead.
  'offerwall_paid_fallback_offered',
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
