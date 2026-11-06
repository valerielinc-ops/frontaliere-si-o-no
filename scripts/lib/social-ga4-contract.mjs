import { SOCIAL_UTM_SOURCE_BY_CHANNEL } from './social-channel-attribution.mjs';

/** Business events admitted to social-attribution reports, with their claims bounded. */
export const SOCIAL_GA4_ACTION_EVENTS = Object.freeze({
  job_qualified_session: 'qualified job-detail session event; deduplicated with sessionStorage when available, otherwise only within the active page lifetime',
  job_apply_handoff: 'external job-application destination click; not a completed application',
  newsletter_gate_subscribed: 'newsletter subscription confirmation event',
  checklist_completed: 'frontier checklist completion event',
  checkout_completed: 'assisted-application checkout completion event',
});

export const SOCIAL_GA4_ACTION_EVENT_CONTRACTS = Object.freeze({
  job_qualified_session: Object.freeze({
    funnelStage: 'qualified-job-detail-session',
    observedAction: 'the job-detail qualification event fired once per browser session when sessionStorage is available; the memory fallback only deduplicates within the active page lifetime',
    keyEventStatus: 'not-listed-in-repository-key-event-contract; live-property-state-not-queried',
    sessionKeyEventRateEligible: false,
    strongestClaim: 'a tagged cohort emitted a qualified job-detail session event; this is not a unique person, completed application, or employer-confirmed outcome',
  }),
  job_apply_handoff: Object.freeze({
    funnelStage: 'external-employer-handoff',
    observedAction: 'click from a job page to an employer destination',
    keyEventStatus: 'listed-in-repository-contract; live-property-state-not-queried',
    strongestClaim: 'an attributed hand-off event occurred; it is not a submitted application',
  }),
  newsletter_gate_subscribed: Object.freeze({
    funnelStage: 'newsletter-gate-subscription-signal',
    observedAction: 'the newsletter gate emitted its subscription event',
    keyEventStatus: 'not-listed-in-repository-key-event-contract; live-property-state-not-queried',
    strongestClaim: 'the event fired; it does not establish a unique subscriber or session',
  }),
  checklist_completed: Object.freeze({
    funnelStage: 'frontier-checklist-completion',
    observedAction: 'the checklist completion event fired',
    keyEventStatus: 'not-listed-in-repository-key-event-contract; live-property-state-not-queried',
    strongestClaim: 'the event fired; it does not establish a unique person or session',
  }),
  checkout_completed: Object.freeze({
    funnelStage: 'assisted-application-paid-order-completion-signal',
    observedAction: 'the client-side paid-order completion hook emitted checkout_completed',
    keyEventStatus: 'not-listed-in-repository-key-event-contract; live-property-state-not-queried',
    strongestClaim: 'a paid-order completion signal fired; it is not an authoritative order ledger',
  }),
});

export const SOCIAL_GA4_ACTION_EVENT_NAMES = Object.freeze(Object.keys(SOCIAL_GA4_ACTION_EVENTS));

export function isSocialGa4SessionKeyEventRateEligible(eventName) {
  return Object.hasOwn(SOCIAL_GA4_ACTION_EVENT_CONTRACTS, eventName)
    && SOCIAL_GA4_ACTION_EVENT_CONTRACTS[eventName].sessionKeyEventRateEligible !== false;
}

export const SOCIAL_GA4_EVENT_CONTRACT_VERSION = 1;
export const SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS = 30;
export const SOCIAL_GA4_DATA_LAG_DAYS = 2;

/** Shared event-scoped dimension contract used by the pack and weekly analytics bootstrap. */
export const FAQ_SEARCH_CATEGORY_GA4_DIMENSION = Object.freeze({
  parameterName: 'faq_category',
  displayName: 'FAQ Search Category',
  description: 'Closed FAQ search category; values are allowlisted and contain no free text',
});

/** Exact lowercase UTM source tokens emitted for social channel attribution. */
export const SOCIAL_GA4_CHANNEL_BY_UTM_SOURCE = Object.freeze({
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.facebook]: 'facebook',
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.instagram]: 'instagram',
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.linkedin]: 'linkedin-member',
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.reddit]: 'reddit',
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.telegram]: 'telegram',
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.threads]: 'threads',
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.tiktok]: 'tiktok',
  [SOCIAL_UTM_SOURCE_BY_CHANNEL.youtubeShorts]: 'youtube-shorts',
});

export const SOCIAL_GA4_CHANNELS = Object.freeze(Object.values(SOCIAL_GA4_CHANNEL_BY_UTM_SOURCE));
export const SOCIAL_GA4_SITE_OUTCOME_MINIMUM_DAYS = 25;
export const SOCIAL_GA4_SITE_OUTCOME_MINIMUM_SESSIONS = 100;
export const SOCIAL_GA4_SITE_OUTCOME_MAX_AGE_HOURS = 216;
