import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, PlayCircle } from 'lucide-react';
import { onAdsConsentChange } from '@/services/adsConsent';
import {
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  disposeRewardedWebAd,
  getRewardedWebAdSnapshot,
  isRewardedWebAdEligible,
  preloadRewardedWebAd,
  showRewardedWebAd,
  subscribeRewardedWebAd,
} from '@/services/rewardedWebAd';

export { ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH, REWARDED_READY_TIMEOUT_MS } from '@/services/rewardedWebAd';

export interface GptRewardedAdProps {
  adUnitPath?: string;
  label: string;
  loadingLabel: string;
  showingLabel?: string;
  unavailableLabel: string;
  showUnavailableMessage?: boolean;
  enabled?: boolean;
  /**
   * Start as soon as the preloaded slot is ready. The caller must only enable
   * this after the user has already opted into the rewarded flow.
   */
  autoStart?: boolean;
  onOptIn?: () => void;
  onReady?: () => void;
  onVideoCompleted?: () => void;
  onGranted: () => void;
  onClosed?: (granted: boolean) => void;
  onUnavailable?: () => void;
}

/**
 * Opt-in GPT Rewarded Web ad.
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
  onOptIn,
  onReady,
  onVideoCompleted,
  onGranted,
  onClosed,
  onUnavailable,
}: GptRewardedAdProps) {
  const [adsConsentTick, setAdsConsentTick] = useState(0);
  const requestIdRef = useRef(0);
  const lastEventSequenceRef = useRef(0);
  const autoStartRequestIdRef = useRef(0);
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

  useEffect(() => onAdsConsentChange(() => setAdsConsentTick((tick) => tick + 1)), []);

  const active = isRewardedWebAdEligible(enabled);
  const snapshot = useSyncExternalStore(
    subscribeRewardedWebAd,
    getRewardedWebAdSnapshot,
    getRewardedWebAdSnapshot,
  );
  const state = snapshot.state === 'idle' ? 'loading' : snapshot.state;

  useEffect(() => {
    if (!active) {
      disposeRewardedWebAd(adUnitPath);
      onUnavailableRef.current?.();
      requestIdRef.current = 0;
      autoStartRequestIdRef.current = 0;
      return;
    }
    requestIdRef.current = preloadRewardedWebAd(adUnitPath, { retryUnavailable: true });
  }, [active, adUnitPath, adsConsentTick]);

  useEffect(() => {
    const pendingEvents = snapshot.events.filter(
      (event) => event.requestId === requestIdRef.current && event.sequence > lastEventSequenceRef.current,
    );
    pendingEvents.forEach((event) => {
      lastEventSequenceRef.current = event.sequence;
      if (event.type === 'ready') onReadyRef.current?.();
      if (event.type === 'granted') onGrantedRef.current();
      if (event.type === 'completed') onVideoCompletedRef.current?.();
      if (event.type === 'closed') onClosedRef.current?.(!!event.granted);
      if (event.type === 'unavailable') onUnavailableRef.current?.();
    });
  }, [snapshot.events]);

  useEffect(() => {
    if (!autoStart || state !== 'ready') return;
    const requestId = requestIdRef.current;
    if (!requestId || autoStartRequestIdRef.current === requestId) return;

    autoStartRequestIdRef.current = requestId;
    onOptInRef.current?.();
    try {
      showRewardedWebAd(adUnitPath);
    } catch {
      onUnavailableRef.current?.();
    }
  }, [adUnitPath, autoStart, state, snapshot.requestId]);

  const handleOptIn = () => {
    if (state !== 'ready') return;
    onOptInRef.current?.();
    try {
      showRewardedWebAd(adUnitPath);
    } catch {
      onUnavailableRef.current?.();
    }
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
