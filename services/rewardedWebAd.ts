import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { GPT_ENABLED, getGptTag, initGptFramework } from '@/components/shared/GptAdSlot';
import { isLikelyBot } from '@/services/botPatterns';
import { Analytics } from '@/services/analytics';
import { isAdsConsentGranted } from '@/services/adsConsent';

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

// Preloading starts on the job detail, but GPT can still be waiting on the
// script/auction when the dialog opens. Keep a bounded escape hatch without
// treating a slow auction as an immediate no-fill.
export const REWARDED_READY_TIMEOUT_MS = 15_000;

export type RewardedWebAdState = 'idle' | 'loading' | 'ready' | 'showing' | 'unavailable';

type RewardedWebEventType = 'started' | 'ready' | 'granted' | 'completed' | 'closed' | 'unavailable';

export type RewardedWebAdEligibilityReason =
  | 'gpt_disabled'
  | 'disabled'
  | 'not_browser'
  | 'unsupported_host'
  | 'bot'
  | 'consent_required';

export interface RewardedWebAdEvent {
  type: RewardedWebEventType;
  requestId: number;
  sequence: number;
  granted?: boolean;
  reason?: string;
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
  state: RewardedWebAdState;
  cancelled: boolean;
  granted: boolean;
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

function track(eventName: string, adUnitPath: string, reason?: string): void {
  Analytics.trackExperimentEvent(eventName, {
    slot: adUnitPath,
    format: 'rewarded_web',
    ...(reason ? { reason } : {}),
  });
}

export function isRewardedWebAdEligible(enabled = true): boolean {
  return getRewardedWebAdEligibilityReason(enabled) === null;
}

export function getRewardedWebAdEligibilityReason(
  enabled = true,
): RewardedWebAdEligibilityReason | null {
  if (!GPT_ENABLED) return 'gpt_disabled';
  if (!enabled) return 'disabled';
  if (typeof window === 'undefined') return 'not_browser';
  if (!isAdSenseProductionHost(window.location.hostname)) return 'unsupported_host';
  if (isLikelyBot()) return 'bot';
  if (!isAdsConsentGranted()) return 'consent_required';
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
  resource.handlers.granted = null;
  resource.handlers.completed = null;
  resource.handlers.closed = null;
}

function markUnavailable(resource: RewardedWebAdResource, reason: string): void {
  if (activeResource !== resource || resource.cancelled || resource.state === 'unavailable') return;
  resource.state = 'unavailable';
  track('rewarded_web_unavailable', resource.adUnitPath, reason);
  publish(resource, 'unavailable', { type: 'unavailable', reason });
  destroyResource(resource);
}

export function getRewardedWebAdSnapshot(): RewardedWebAdSnapshot {
  return snapshot;
}

export function subscribeRewardedWebAd(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Start one rewarded request before the user opens the offer dialog.
 *
 * GPT's rewarded web API prefetches the creative after display(). Keeping the
 * slot in this page-level resource lets the dialog consume an already-ready
 * event instead of starting the ten-second request budget after the click.
 * The singleton is deliberate: Ad Manager does not support concurrent
 * rewarded requests on the same page.
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
    destroyResource(existing);
  } else if (existing) {
    destroyResource(existing);
  }

  const requestId = ++requestSequence;
  const resource: RewardedWebAdResource = {
    adUnitPath,
    requestId,
    state: 'loading',
    cancelled: false,
    granted: false,
    readyEvent: null,
    slot: null,
    gpt: null,
    pubads: null,
    readyTimeout: null,
    handlers: { ready: null, renderEnded: null, granted: null, completed: null, closed: null },
  };
  activeResource = resource;
  notify({ state: 'loading', requestId, lastEvent: null, events: [] });
  track('rewarded_web_request', adUnitPath);
  initGptFramework();
  const gt = getGptTag();
  resource.gpt = gt;
  resource.readyTimeout = window.setTimeout(
    () => markUnavailable(resource, 'ready_timeout'),
    REWARDED_READY_TIMEOUT_MS,
  );

  try {
    gt.cmd.push(() => {
      if (activeResource !== resource || resource.cancelled) return;
      try {
        const rewardedFormat = gt.enums?.OutOfPageFormat?.REWARDED;
        const pubads = gt.pubads?.();
        if (!rewardedFormat || typeof gt.defineOutOfPageSlot !== 'function' || !pubads) {
          markUnavailable(resource, 'rewarded_format_unavailable');
          return;
        }

        const slot = gt.defineOutOfPageSlot(adUnitPath, rewardedFormat);
        if (!slot) {
          markUnavailable(resource, 'slot_not_defined');
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
          track('rewarded_web_ready', adUnitPath);
          publish(resource, 'ready', { type: 'ready' });
        };
        resource.handlers.renderEnded = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled) return;
          if (event?.isEmpty) markUnavailable(resource, 'no_fill');
        };
        resource.handlers.granted = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled || resource.granted) return;
          resource.granted = true;
          track('rewarded_web_granted', adUnitPath);
          publish(resource, resource.state, { type: 'granted' });
        };
        resource.handlers.completed = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled) return;
          // `rewardedSlotGranted` is the authoritative reward signal for web.
          // Google can grant display demand after its view-time threshold, so
          // not every rewarded experience emits a video-completed event.
          // Keep this event as optional telemetry for callers that want it.
          track('rewarded_web_video_completed', adUnitPath);
          publish(resource, resource.state, { type: 'completed' });
        };
        resource.handlers.closed = (event: any) => {
          if (event?.slot !== slot || activeResource !== resource || resource.cancelled) return;
          const granted = resource.granted;
          track('rewarded_web_closed', adUnitPath, granted ? 'granted' : 'dismissed');
          resource.state = 'unavailable';
          publish(resource, 'unavailable', { type: 'closed', granted });
          destroyResource(resource);
        };

        pubads.addEventListener('rewardedSlotReady', resource.handlers.ready);
        pubads.addEventListener('slotRenderEnded', resource.handlers.renderEnded);
        pubads.addEventListener('rewardedSlotGranted', resource.handlers.granted);
        pubads.addEventListener('rewardedSlotVideoCompleted', resource.handlers.completed);
        pubads.addEventListener('rewardedSlotClosed', resource.handlers.closed);
        gt.display(slot);
      } catch {
        markUnavailable(resource, 'gpt_error');
      }
    });
  } catch {
    markUnavailable(resource, 'gpt_queue_error');
  }

  return requestId;
}

export function showRewardedWebAd(adUnitPath = ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH): boolean {
  const resource = activeResource;
  if (!resource || resource.adUnitPath !== adUnitPath || resource.state !== 'ready') return false;
  if (!resource.readyEvent || typeof resource.readyEvent.makeRewardedVisible !== 'function') {
    markUnavailable(resource, 'show_error');
    return false;
  }
  resource.state = 'showing';
  track('rewarded_web_started', adUnitPath);
  publish(resource, 'showing', { type: 'started' });
  try {
    const shown = resource.readyEvent.makeRewardedVisible();
    if (shown === false) {
      markUnavailable(resource, 'show_not_visible');
      return false;
    }
    return true;
  } catch {
    markUnavailable(resource, 'show_error');
    return false;
  }
}

export function disposeRewardedWebAd(adUnitPath = ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH): void {
  const resource = activeResource;
  if (!resource || resource.adUnitPath !== adUnitPath) return;
  destroyResource(resource);
  activeResource = null;
  notify({ state: 'idle', requestId: resource.requestId, lastEvent: null, events: [] });
}
