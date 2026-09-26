import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, PlayCircle } from 'lucide-react';
import { onAdsConsentChange } from '@/services/adsConsent';
import {
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  disposeRewardedWebAd,
  getRewardedWebAdIneligibility,
  getRewardedWebAdSnapshot,
  isRewardedWebAdEligible,
  requestRewardedWebAd,
  showRewardedWebAd,
  subscribeRewardedWebAd,
} from '@/services/rewardedWebAd';

export { ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH, REWARDED_READY_TIMEOUT_MS } from '@/services/rewardedWebAd';

/** Correlation data passed with every rewarded lifecycle callback. */
export interface GptRewardedAdCallbackInfo {
  /** Id of the Google request, shared with the `rewarded_web_*` telemetry. */
  requestId: number;
  /** Sub-cause of an unavailable outcome, when known. */
  detail?: string;
}

export interface GptRewardedAdProps {
  adUnitPath?: string;
  label: string;
  loadingLabel: string;
  showingLabel?: string;
  unavailableLabel: string;
  showUnavailableMessage?: boolean;
  enabled?: boolean;
  /**
   * Make the ad visible as soon as GPT emits `rewardedSlotReady`. Only for a
   * caller whose own UI already disclosed the video and obtained the
   * visitor's explicit opt-in to it (Google rewarded policy: clear value
   * exchange, user-initiated). RewardedApplicationOffer does not use it since
   * 2026-09-26: its loading screen deliberately does not mention a video, so
   * it shows this component's button instead.
   */
  autoStart?: boolean;
  /**
   * Retry only after the visitor explicitly asks to retry a dismissed ad.
   * Each mount and each retry token backs exactly one Google request: the
   * component never re-requests on its own after a no-fill or a timeout.
   */
  retryToken?: number;
  onOptIn?: (info: GptRewardedAdCallbackInfo) => void;
  onReady?: (info: GptRewardedAdCallbackInfo) => void;
  onVideoCompleted?: (info: GptRewardedAdCallbackInfo) => void;
  onGranted: (info: GptRewardedAdCallbackInfo) => void;
  onClosed?: (granted: boolean, info: GptRewardedAdCallbackInfo) => void;
  onUnavailable?: (reason: string, info: GptRewardedAdCallbackInfo) => void;
}

/**
 * GPT Rewarded Web ad.
 *
 * GPT reports the reward, while the caller owns the entitlement and the
 * destination redirect. The lifecycle events are intentionally sent through
 * Firebase Analytics only: this is experiment telemetry, not PostHog data.
 */
export default function GptRewardedAd({
  adUnitPath = ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  label,
  loadingLabel,
  showingLabel = loadingLabel,
  unavailableLabel,
  showUnavailableMessage = true,
  enabled = true,
  autoStart = false,
  retryToken = 0,
  onOptIn,
  onReady,
  onVideoCompleted,
  onGranted,
  onClosed,
  onUnavailable,
}: GptRewardedAdProps) {
  const [adsConsentTick, setAdsConsentTick] = useState(0);
  const requestIdRef = useRef(0);
  const requestedTokenRef = useRef<number | null>(null);
  const lastEventSequenceRef = useRef(0);
  const autoShownRequestIdRef = useRef(0);
  const unavailableNotifiedRequestIdRef = useRef<number | null>(null);
  const onOptInRef = useRef(onOptIn);
  const onReadyRef = useRef(onReady);
  const onVideoCompletedRef = useRef(onVideoCompleted);
  const onGrantedRef = useRef(onGranted);
  const onClosedRef = useRef(onClosed);
  const onUnavailableRef = useRef(onUnavailable);
  onOptInRef.current = onOptIn;
  onReadyRef.current = onReady;
  onVideoCompletedRef.current = onVideoCompleted;
  onGrantedRef.current = onGranted;
  onClosedRef.current = onClosed;
  onUnavailableRef.current = onUnavailable;

  const notifyUnavailable = useCallback((reason: string, detail?: string) => {
    const requestId = requestIdRef.current;
    if (unavailableNotifiedRequestIdRef.current === requestId) return;
    unavailableNotifiedRequestIdRef.current = requestId;
    onUnavailableRef.current?.(reason, { requestId, ...(detail ? { detail } : {}) });
  }, []);

  useEffect(() => onAdsConsentChange(() => setAdsConsentTick((tick) => tick + 1)), []);

  const active = isRewardedWebAdEligible(enabled);
  const snapshot = useSyncExternalStore(
    subscribeRewardedWebAd,
    getRewardedWebAdSnapshot,
    getRewardedWebAdSnapshot,
  );
  // Until this mount owns a request, a finished snapshot belongs to an
  // earlier request and must not render as this click's outcome.
  const ownsSnapshot = requestIdRef.current !== 0 && snapshot.requestId === requestIdRef.current;
  const state = ownsSnapshot
    ? (snapshot.state === 'idle' ? 'loading' : snapshot.state)
    : (snapshot.state === 'ready' ? 'ready' : 'loading');

  useEffect(() => {
    const ineligibility = getRewardedWebAdIneligibility(enabled);
    if (ineligibility) {
      disposeRewardedWebAd(adUnitPath);
      requestIdRef.current = 0;
      autoShownRequestIdRef.current = 0;
      notifyUnavailable(ineligibility.reason, ineligibility.detail);
      return;
    }
    // One Google request per mount and per explicit retry. A consent tick or a
    // re-render must not turn a no-fill into an automatic second auction.
    if (requestedTokenRef.current === retryToken && requestIdRef.current) return;
    requestedTokenRef.current = retryToken;
    requestIdRef.current = requestRewardedWebAd(adUnitPath);
    if (!requestIdRef.current) notifyUnavailable('not_eligible', 'request_refused');
  }, [active, adUnitPath, adsConsentTick, enabled, notifyUnavailable, retryToken]);

  useEffect(() => {
    const pendingEvents = snapshot.events.filter(
      (event) => event.requestId === requestIdRef.current && event.sequence > lastEventSequenceRef.current,
    );
    pendingEvents.forEach((event) => {
      lastEventSequenceRef.current = event.sequence;
      const info: GptRewardedAdCallbackInfo = { requestId: event.requestId };
      if (event.type === 'ready') onReadyRef.current?.(info);
      if (event.type === 'granted') onGrantedRef.current(info);
      if (event.type === 'completed') onVideoCompletedRef.current?.(info);
      if (event.type === 'closed') onClosedRef.current?.(!!event.granted, info);
      if (event.type === 'unavailable') notifyUnavailable(event.reason ?? 'unavailable', event.detail);
    });
  }, [snapshot.events, notifyUnavailable]);

  const show = useCallback(() => {
    const requestId = requestIdRef.current;
    onOptInRef.current?.({ requestId });
    try {
      const result = showRewardedWebAd(adUnitPath);
      // A display error is published by the service with its detail and
      // reaches the caller through the event stream above.
      if (result === 'slot_not_ready') notifyUnavailable('slot_not_ready');
    } catch {
      notifyUnavailable('display_error', 'show_threw');
    }
  }, [adUnitPath, notifyUnavailable]);

  useEffect(() => {
    if (!autoStart || state !== 'ready') return;
    const requestId = requestIdRef.current;
    if (!requestId || autoShownRequestIdRef.current === requestId) return;
    autoShownRequestIdRef.current = requestId;
    show();
  }, [autoStart, show, state, snapshot.requestId]);

  const handleOptIn = () => {
    if (state !== 'ready') return;
    show();
  };

  return (
    <div className="space-y-2">
      {(state === 'loading' || state === 'showing' || (autoStart && state === 'ready')) && (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="flex min-h-[50px] items-center justify-center gap-2 rounded-stripe border border-edge bg-surface-raised px-4 py-3 text-sm font-semibold text-body"
        >
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {state === 'showing' || (autoStart && state === 'ready') ? showingLabel : loadingLabel}
        </div>
      )}
      {state === 'ready' && !autoStart && (
        <button
          type="button"
          onClick={handleOptIn}
          aria-busy="false"
          className="inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          data-testid="assisted-application-offer-rewarded"
        >
          <PlayCircle className="h-4 w-4" aria-hidden="true" />
          {label}
        </button>
      )}
      {state === 'unavailable' && showUnavailableMessage && (
        <p role="status" className="text-xs leading-relaxed text-muted">{unavailableLabel}</p>
      )}
    </div>
  );
}
