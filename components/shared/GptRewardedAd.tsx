import { useEffect, useRef, useState } from 'react';
import { Loader2, PlayCircle } from 'lucide-react';
import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { GPT_ENABLED, getGptTag, initGptFramework } from '@/components/shared/GptAdSlot';
import { isLikelyBot } from '@/services/botPatterns';
import { Analytics } from '@/services/analytics';
import { isAdsConsentGranted, onAdsConsentChange } from '@/services/adsConsent';

/** Dedicated manual GPT Rewarded Web unit (separate from codeless Offerwall). */
export const ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH = '/23355151813/rewarded-application-video';

export const REWARDED_READY_TIMEOUT_MS = 10_000;

type RewardedAdState = 'loading' | 'ready' | 'showing' | 'unavailable';

export interface GptRewardedAdProps {
  adUnitPath?: string;
  label: string;
  loadingLabel: string;
  showingLabel?: string;
  unavailableLabel: string;
  showUnavailableMessage?: boolean;
  enabled?: boolean;
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
  onOptIn,
  onReady,
  onVideoCompleted,
  onGranted,
  onClosed,
  onUnavailable,
}: GptRewardedAdProps) {
  const [state, setState] = useState<RewardedAdState>('loading');
  const [adsConsentTick, setAdsConsentTick] = useState(0);
  const slotRef = useRef<any>(null);
  const readyEventRef = useRef<any>(null);
  const grantedRef = useRef(false);
  const unavailableRef = useRef(false);
  const onReadyRef = useRef(onReady);
  const onVideoCompletedRef = useRef(onVideoCompleted);
  const onGrantedRef = useRef(onGranted);
  const onClosedRef = useRef(onClosed);
  const onUnavailableRef = useRef(onUnavailable);
  onReadyRef.current = onReady;
  onVideoCompletedRef.current = onVideoCompleted;
  onGrantedRef.current = onGranted;
  onClosedRef.current = onClosed;
  onUnavailableRef.current = onUnavailable;

  useEffect(() => onAdsConsentChange(() => setAdsConsentTick((tick) => tick + 1)), []);

  const active = GPT_ENABLED
    && enabled
    && typeof window !== 'undefined'
    && isAdSenseProductionHost(window.location.hostname)
    && !isLikelyBot()
    && isAdsConsentGranted();

  useEffect(() => {
    let cancelled = false;
    let readyTimeout: number | null = null;
    let slotReadyHandler: ((event: any) => void) | null = null;
    let slotGrantedHandler: ((event: any) => void) | null = null;
    let slotCompletedHandler: ((event: any) => void) | null = null;
    let slotClosedHandler: ((event: any) => void) | null = null;

    const track = (eventName: string, reason?: string) => {
      Analytics.trackExperimentEvent(eventName, {
        slot: adUnitPath,
        format: 'rewarded_web',
        ...(reason ? { reason } : {}),
      });
    };

    const markUnavailable = (reason: string) => {
      if (cancelled || unavailableRef.current) return;
      unavailableRef.current = true;
      if (readyTimeout !== null) {
        window.clearTimeout(readyTimeout);
        readyTimeout = null;
      }
      setState('unavailable');
      track('rewarded_web_unavailable', reason);
      onUnavailableRef.current?.();
    };

    function cleanupSlot() {
      try {
        const gt = getGptTag();
        const pubads = gt.pubads?.();
        if (slotReadyHandler) pubads?.removeEventListener('rewardedSlotReady', slotReadyHandler);
        if (slotGrantedHandler) pubads?.removeEventListener('rewardedSlotGranted', slotGrantedHandler);
        if (slotCompletedHandler) pubads?.removeEventListener('rewardedSlotVideoCompleted', slotCompletedHandler);
        if (slotClosedHandler) pubads?.removeEventListener('rewardedSlotClosed', slotClosedHandler);
        if (slotRef.current) {
          gt.destroySlots?.([slotRef.current]);
          slotRef.current = null;
        }
      } catch {
        // GPT teardown is best-effort during SPA navigation.
      }
    }

    if (!active) {
      setState('unavailable');
      onUnavailableRef.current?.();
      return () => { cancelled = true; };
    }

    setState('loading');
    grantedRef.current = false;
    unavailableRef.current = false;
    readyEventRef.current = null;
    track('rewarded_web_request');
    initGptFramework();
    const gt = getGptTag();

    // Arm this outside the GPT command queue. If the GPT script is blocked or
    // never drains `cmd`, the queued callback cannot resolve the UI on its own
    // and the visitor would remain stuck on an endless loading state.
    readyTimeout = window.setTimeout(() => markUnavailable('ready_timeout'), REWARDED_READY_TIMEOUT_MS);

    gt.cmd.push(() => {
      if (cancelled) return;
      try {
        const rewardedFormat = gt.enums?.OutOfPageFormat?.REWARDED;
        const pubads = gt.pubads?.();
        if (!rewardedFormat || typeof gt.defineOutOfPageSlot !== 'function' || !pubads) {
          markUnavailable('rewarded_format_unavailable');
          return;
        }

        const slot = gt.defineOutOfPageSlot(adUnitPath, rewardedFormat);
        if (!slot) {
          markUnavailable('slot_not_defined');
          return;
        }
        slotRef.current = slot;
        slot.addService(pubads);

        slotReadyHandler = (event: any) => {
          if (event?.slot !== slot || cancelled || unavailableRef.current) return;
          if (readyTimeout !== null) {
            window.clearTimeout(readyTimeout);
            readyTimeout = null;
          }
          readyEventRef.current = event;
          setState('ready');
          track('rewarded_web_ready');
          onReadyRef.current?.();
        };
        slotGrantedHandler = (event: any) => {
          if (event?.slot !== slot || cancelled || grantedRef.current) return;
          grantedRef.current = true;
          track('rewarded_web_granted');
          onGrantedRef.current();
        };
        slotCompletedHandler = (event: any) => {
          if (event?.slot !== slot || cancelled || unavailableRef.current) return;
          track('rewarded_web_video_completed');
          onVideoCompletedRef.current?.();
        };
        slotClosedHandler = (event: any) => {
          if (event?.slot !== slot || cancelled) return;
          track('rewarded_web_closed', grantedRef.current ? 'granted' : 'dismissed');
          onClosedRef.current?.(grantedRef.current);
          setState('unavailable');
          cleanupSlot();
        };

        pubads.addEventListener('rewardedSlotReady', slotReadyHandler);
        pubads.addEventListener('rewardedSlotGranted', slotGrantedHandler);
        pubads.addEventListener('rewardedSlotVideoCompleted', slotCompletedHandler);
        pubads.addEventListener('rewardedSlotClosed', slotClosedHandler);

        gt.display(slot);
      } catch {
        markUnavailable('gpt_error');
      }
    });

    return () => {
      cancelled = true;
      if (readyTimeout !== null) window.clearTimeout(readyTimeout);
      cleanupSlot();
    };
  }, [active, adUnitPath, adsConsentTick]);

  const handleOptIn = () => {
    if (state !== 'ready') return;
    const event = readyEventRef.current;
    if (!event || typeof event.makeRewardedVisible !== 'function') {
      setState('unavailable');
      onUnavailableRef.current?.();
      return;
    }
    onOptIn?.();
    setState('showing');
    Analytics.trackExperimentEvent('rewarded_web_started', { slot: adUnitPath, format: 'rewarded_web' });
    try {
      event.makeRewardedVisible();
    } catch {
      setState('unavailable');
      Analytics.trackExperimentEvent('rewarded_web_unavailable', {
        slot: adUnitPath,
        format: 'rewarded_web',
        reason: 'show_error',
      });
      onUnavailableRef.current?.();
    }
  };

  return (
    <div className="space-y-2">
      {(state === 'loading' || state === 'showing') && (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="flex min-h-[50px] items-center justify-center gap-2 rounded-stripe border border-edge bg-surface-raised px-4 py-3 text-sm font-semibold text-body"
        >
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {state === 'showing' ? showingLabel : loadingLabel}
        </div>
      )}
      {state === 'ready' && (
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
