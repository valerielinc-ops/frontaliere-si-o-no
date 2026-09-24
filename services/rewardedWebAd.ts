import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { GPT_ENABLED, getGptTag, initGptFramework } from '@/components/shared/GptAdSlot';
import { isLikelyBot } from '@/services/botPatterns';
import { Analytics } from '@/services/analytics';
import { getAdsConsent, isAdsConsentGranted } from '@/services/adsConsent';

/**
 * Dedicated Ad Manager rewarded unit for the job-board GPT request.
 *
 * Offerwall units belong to the Offerwall product flow and are not the
 * inventory target for a custom GPT rewarded slot. The unit accepts the
 * standard rewarded-web sizes, but sizes alone do not create demand or
 * guarantee a fill. Monetization must come from an eligible Google auction
 * source (for example a linked Ad Exchange property) or a paid reservation
 * line item; a configured ad unit with no eligible demand correctly returns
 * `slotRenderEnded.isEmpty`.
 */
export const ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH = '/23355151813/rewarded-application-video';

/** Format label shared by every rewarded telemetry event. */
export const REWARDED_WEB_AD_FORMAT = 'rewarded_web';

// Preloading starts on the job detail, but GPT can still be waiting on the
// script/auction when the dialog opens. Keep a bounded escape hatch without
// treating a slow auction as an immediate no-fill.
export const REWARDED_READY_TIMEOUT_MS = 15_000;

export type RewardedWebAdState = 'idle' | 'loading' | 'ready' | 'showing' | 'unavailable';

type RewardedWebEventType = 'started' | 'ready' | 'granted' | 'completed' | 'closed' | 'unavailable';

/** Who started a Google rewarded request. */
export type RewardedWebAdTrigger = 'preload' | 'candidate_click';

/**
 * Why a rewarded experience could not be shown. Each value answers a
 * different operational question, so they are never collapsed:
 * - `no_fill`: Google answered with an empty slot (`slotRenderEnded.isEmpty`).
 * - `ready_timeout`: the request was sent but Google emitted neither
 *   `rewardedSlotReady` nor an empty render in time.
 * - `gpt_unavailable`: GPT never ran (script blocked/not loaded) or does not
 *   support the rewarded format on this page.
 * - `consent_denied`: advertising consent is missing or denied, so no request
 *   was sent.
 * - `not_production` / `not_eligible`: the visitor is outside the rewarded
 *   eligibility (non-production host, bot, kill-switch).
 * - `slot_init_error`: GPT refused to define the slot (for example a second
 *   rewarded slot on the same page) or threw while wiring it.
 * - `display_error`: a ready ad could not be made visible.
 * - `slot_not_ready`: the caller tried to show a slot that was not ready.
 */
export type RewardedWebAdUnavailableReason =
  | 'no_fill'
  | 'ready_timeout'
  | 'gpt_unavailable'
  | 'consent_denied'
  | 'not_production'
  | 'not_eligible'
  | 'slot_init_error'
  | 'display_error'
  | 'slot_not_ready';

export interface RewardedWebAdIneligibility {
  reason: Extract<RewardedWebAdUnavailableReason, 'gpt_unavailable' | 'consent_denied' | 'not_production' | 'not_eligible'>;
  detail: string;
}

export interface RewardedWebAdEvent {
  type: RewardedWebEventType;
  requestId: number;
  sequence: number;
  granted?: boolean;
  reason?: RewardedWebAdUnavailableReason;
  detail?: string;
}

export interface RewardedWebAdSnapshot {
  state: RewardedWebAdState;
  requestId: number;
  lastEvent: RewardedWebAdEvent | null;
  events: RewardedWebAdEvent[];
}

interface RewardedWebAdResource {
  adUnitPath: string;
  requestId: number;
  trigger: RewardedWebAdTrigger;
  state: RewardedWebAdState;
  cancelled: boolean;
  granted: boolean;
  /** GPT executed our command queue callback (the library is loaded). */
  gptRan: boolean;
  readyEvent: any;
  slot: any;
  gpt: any;
  pubads: any;
  readyTimeout: number | null;
  handlers: {
    ready: ((event: any) => void) | null;
    renderEnded: ((event: any) => void) | null;
    granted: ((event: any) => void) | null;
    completed: ((event: any) => void) | null;
    closed: ((event: any) => void) | null;
  };
}

const listeners = new Set<() => void>();
let activeResource: RewardedWebAdResource | null = null;
let requestSequence = 0;
let eventSequence = 0;
// Set when a request timed out before GPT ever ran (blocked or failed
// script). A later click then fails fast instead of waiting the full timeout
// again for a library that is not coming.
let gptLoadFailed = false;
let snapshot: RewardedWebAdSnapshot = {
  state: 'idle',
  requestId: 0,
  lastEvent: null,
  events: [],
};

function notify(next: RewardedWebAdSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function publish(
  resource: RewardedWebAdResource,
  state: RewardedWebAdState,
  event?: Omit<RewardedWebAdEvent, 'requestId' | 'sequence'>,
): void {
  if (activeResource !== resource) return;
  const nextEvent = event
    ? { ...event, requestId: resource.requestId, sequence: ++eventSequence }
    : null;
  notify({
    state,
    requestId: resource.requestId,
    lastEvent: nextEvent || snapshot.lastEvent,
    events: nextEvent ? [...snapshot.events, nextEvent].slice(-20) : snapshot.events,
  });
}

function track(
  eventName: string,
  resource: RewardedWebAdResource,
  params: { reason?: string; detail?: string } = {},
): void {
  Analytics.trackExperimentEvent(eventName, {
    slot: resource.adUnitPath,
    format: REWARDED_WEB_AD_FORMAT,
    request_id: resource.requestId,
    trigger: resource.trigger,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.detail ? { detail: params.detail } : {}),
  });
}

export function isRewardedWebAdEligible(enabled = true): boolean {
  return getRewardedWebAdIneligibility(enabled) === null;
}

/** The first eligibility rule that blocks a rewarded request, if any. */
export function getRewardedWebAdIneligibility(enabled = true): RewardedWebAdIneligibility | null {
  if (!GPT_ENABLED) return { reason: 'gpt_unavailable', detail: 'gpt_disabled' };
  if (!enabled) return { reason: 'not_eligible', detail: 'disabled' };
  if (typeof window === 'undefined') return { reason: 'not_production', detail: 'not_browser' };
  if (!isAdSenseProductionHost(window.location.hostname)) return { reason: 'not_production', detail: 'unsupported_host' };
  if (isLikelyBot()) return { reason: 'not_eligible', detail: 'bot' };
  if (!isAdsConsentGranted()) {
    return { reason: 'consent_denied', detail: getAdsConsent() === 'denied' ? 'denied' : 'missing' };
  }
  return null;
}

function destroyResource(resource: RewardedWebAdResource): void {
  resource.cancelled = true;
  if (resource.readyTimeout !== null && typeof window !== 'undefined') {
    window.clearTimeout(resource.readyTimeout);
    resource.readyTimeout = null;
  }
  try {
    if (resource.pubads) {
      if (resource.handlers.ready) resource.pubads.removeEventListener('rewardedSlotReady', resource.handlers.ready);
      if (resource.handlers.renderEnded) resource.pubads.removeEventListener('slotRenderEnded', resource.handlers.renderEnded);
      if (resource.handlers.granted) resource.pubads.removeEventListener('rewardedSlotGranted', resource.handlers.granted);
      if (resource.handlers.completed) resource.pubads.removeEventListener('rewardedSlotVideoCompleted', resource.handlers.completed);
      if (resource.handlers.closed) resource.pubads.removeEventListener('rewardedSlotClosed', resource.handlers.closed);
    }
    if (resource.slot) resource.gpt?.destroySlots?.([resource.slot]);
  } catch {
    // GPT teardown is best-effort during SPA navigation or consent changes.
  }
  resource.slot = null;
  resource.readyEvent = null;
  resource.handlers.ready = null;
  resource.handlers.renderEnded = null;
  resource.handlers.granted = null;
  resource.handlers.completed = null;
  resource.handlers.closed = null;
}

function markUnavailable(
  resource: RewardedWebAdResource,
  reason: RewardedWebAdUnavailableReason,
  detail?: string,
): void {
  if (activeResource !== resource || resource.cancelled || resource.state === 'unavailable') return;
  resource.state = 'unavailable';
  track('rewarded_web_unavailable', resource, { reason, detail });
  publish(resource, 'unavailable', { type: 'unavailable', reason, ...(detail ? { detail } : {}) });
  destroyResource(resource);
}

export function getRewardedWebAdSnapshot(): RewardedWebAdSnapshot {
  return snapshot;
}

export function subscribeRewardedWebAd(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function startRequest(adUnitPath: string, trigger: RewardedWebAdTrigger): number {
  if (activeResource) destroyResource(activeResource);

  const requestId = ++requestSequence;
  const resource: RewardedWebAdResource = {
    adUnitPath,
    requestId,
    trigger,
    state: 'loading',
    cancelled: false,
    granted: false,
    gptRan: false,
    readyEvent: null,
    slot: null,
    gpt: null,
    pubads: null,
    readyTimeout: null,
    handlers: { ready: null, renderEnded: null, granted: null, completed: null, closed: null },
  };
  activeResource = resource;
  notify({ state: 'loading', requestId, lastEvent: null, events: [] });
  track('rewarded_web_request', resource);
  initGptFramework();
  const gt = getGptTag();
  resource.gpt = gt;

  if (gptLoadFailed && gt.apiReady !== true) {
    markUnavailable(resource, 'gpt_unavailable', 'gpt_not_loaded');
    return requestId;
  }

  resource.readyTimeout = window.setTimeout(() => {
    resource.readyTimeout = null;
    if (!resource.gptRan) {
      gptLoadFailed = true;
      markUnavailable(resource, 'gpt_unavailable', 'gpt_not_loaded');
      return;
    }
    markUnavailable(resource, 'ready_timeout');
  }, REWARDED_READY_TIMEOUT_MS);

  try {
    gt.cmd.push(() => {
      if (activeResource !== resource || resource.cancelled) return;
      resource.gptRan = true;
      gptLoadFailed = false;
      try {
        const rewardedFormat = gt.enums?.OutOfPageFormat?.REWARDED;
        const pubads = gt.pubads?.();
        if (!rewardedFormat || typeof gt.defineOutOfPageSlot !== 'function' || !pubads) {
          markUnavailable(resource, 'gpt_unavailable', 'rewarded_format_unsupported');
          return;
        }

        // GPT returns null when the page cannot host a rewarded slot, including
        // when another rewarded slot is still defined on the same page.
        const slot = gt.defineOutOfPageSlot(adUnitPath, rewardedFormat);
        if (!slot) {
          markUnavailable(resource, 'slot_init_error', 'slot_not_defined');
          return;
        }
        resource.slot = slot;
        resource.pubads = pubads;
        slot.addService(pubads);

        resource.handlers.ready = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled) return;
          if (resource.readyTimeout !== null) {
            window.clearTimeout(resource.readyTimeout);
            resource.readyTimeout = null;
          }
          resource.readyEvent = event;
          resource.state = 'ready';
          track('rewarded_web_ready', resource);
          publish(resource, 'ready', { type: 'ready' });
        };
        resource.handlers.renderEnded = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled) return;
          if (event?.isEmpty) markUnavailable(resource, 'no_fill', 'slot_render_empty');
        };
        resource.handlers.granted = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled || resource.granted) return;
          resource.granted = true;
          track('rewarded_web_granted', resource);
          publish(resource, resource.state, { type: 'granted' });
        };
        resource.handlers.completed = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled) return;
          // `rewardedSlotGranted` is the authoritative reward signal for web.
          // Google can grant display demand after its view-time threshold, so
          // not every rewarded experience emits a video-completed event.
          // Keep this event as optional telemetry for callers that want it.
          track('rewarded_web_video_completed', resource);
          publish(resource, resource.state, { type: 'completed' });
        };
        resource.handlers.closed = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled) return;
          const granted = resource.granted;
          track('rewarded_web_closed', resource, { reason: granted ? 'granted' : 'video_closed_before_reward' });
          resource.state = 'unavailable';
          publish(resource, 'unavailable', { type: 'closed', granted });
          destroyResource(resource);
        };

        // Every listener is registered before display(): GPT can emit
        // rewardedSlotReady quickly once the cached response arrives.
        pubads.addEventListener('rewardedSlotReady', resource.handlers.ready);
        pubads.addEventListener('slotRenderEnded', resource.handlers.renderEnded);
        pubads.addEventListener('rewardedSlotGranted', resource.handlers.granted);
        pubads.addEventListener('rewardedSlotVideoCompleted', resource.handlers.completed);
        pubads.addEventListener('rewardedSlotClosed', resource.handlers.closed);
        gt.display(slot);
      } catch {
        markUnavailable(resource, 'slot_init_error', 'gpt_threw');
      }
    });
  } catch {
    markUnavailable(resource, 'gpt_unavailable', 'gpt_queue_error');
  }

  return requestId;
}

/**
 * Start one rewarded request before the user opens the offer dialog.
 *
 * GPT's rewarded web API prefetches the creative after display(). Keeping the
 * slot in this page-level resource lets the dialog consume an already-ready
 * event instead of starting the request budget after the click. The
 * singleton is deliberate: Ad Manager does not support concurrent rewarded
 * requests on the same page. A finished request is not restarted here unless
 * the caller asks for it: the click-time `requestRewardedWebAd()` owns the
 * fresh auction.
 */
export function preloadRewardedWebAd(
  adUnitPath = ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  options: { retryUnavailable?: boolean } = {},
): number {
  if (!isRewardedWebAdEligible()) {
    if (activeResource?.adUnitPath === adUnitPath) disposeRewardedWebAd(adUnitPath);
    return 0;
  }

  const existing = activeResource;
  if (existing?.adUnitPath === adUnitPath) {
    if (existing.state === 'loading' || existing.state === 'ready' || existing.state === 'showing') {
      return existing.requestId;
    }
    if (existing.state === 'unavailable' && !options.retryUnavailable) {
      return existing.requestId;
    }
  }

  return startRequest(adUnitPath, 'preload');
}

/**
 * The Google request that backs one click on "Candidati".
 *
 * A preloaded request that is still pending or already ready is the click's
 * request: reusing it is what lets the video open immediately. A request that
 * already ended (no-fill, timeout, a video that was closed) belongs to an
 * earlier moment and must not decide this click, so exactly one fresh auction
 * starts here. Callers invoke this once per click; it never retries by itself.
 */
export function requestRewardedWebAd(adUnitPath = ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH): number {
  if (!isRewardedWebAdEligible()) {
    if (activeResource?.adUnitPath === adUnitPath) disposeRewardedWebAd(adUnitPath);
    return 0;
  }

  const existing = activeResource;
  if (existing?.adUnitPath === adUnitPath && (existing.state === 'loading' || existing.state === 'ready')) {
    return existing.requestId;
  }

  return startRequest(adUnitPath, 'candidate_click');
}

export type RewardedWebAdShowResult =
  | 'shown'
  | Extract<RewardedWebAdUnavailableReason, 'display_error' | 'slot_not_ready'>;

export function showRewardedWebAd(adUnitPath = ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH): RewardedWebAdShowResult {
  const resource = activeResource;
  if (!resource || resource.adUnitPath !== adUnitPath || resource.state !== 'ready') return 'slot_not_ready';
  if (!resource.readyEvent || typeof resource.readyEvent.makeRewardedVisible !== 'function') {
    markUnavailable(resource, 'display_error', 'missing_make_visible');
    return 'display_error';
  }
  resource.state = 'showing';
  track('rewarded_web_started', resource);
  publish(resource, 'showing', { type: 'started' });
  try {
    // GPT documents makeRewardedVisible() as void; an explicit `false` from a
    // shimmed or future build is still treated as a refusal to show.
    const shown = resource.readyEvent.makeRewardedVisible();
    if (shown === false) {
      markUnavailable(resource, 'display_error', 'make_visible_refused');
      return 'display_error';
    }
    return 'shown';
  } catch {
    markUnavailable(resource, 'display_error', 'make_visible_threw');
    return 'display_error';
  }
}

export function disposeRewardedWebAd(adUnitPath = ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH): void {
  const resource = activeResource;
  if (!resource || resource.adUnitPath !== adUnitPath) return;
  destroyResource(resource);
  activeResource = null;
  notify({ state: 'idle', requestId: resource.requestId, lastEvent: null, events: [] });
}

/** Test-only reset of the module state that `disposeRewardedWebAd()` keeps. */
export function resetRewardedWebAdForTests(): void {
  if (activeResource) destroyResource(activeResource);
  activeResource = null;
  gptLoadFailed = false;
  notify({ state: 'idle', requestId: 0, lastEvent: null, events: [] });
}
