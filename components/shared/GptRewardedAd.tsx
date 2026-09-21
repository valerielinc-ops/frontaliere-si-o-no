import { useEffect, useRef, useState } from 'react';
import { Loader2, PlayCircle } from 'lucide-react';
import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { GPT_ENABLED, getGptTag, initGptFramework } from '@/components/shared/GptAdSlot';
import { isLikelyBot } from '@/services/botPatterns';
import { Analytics } from '@/services/analytics';
import { isAdsConsentGranted, onAdsConsentChange } from '@/services/adsConsent';

/**
 * The rewarded unit already selected by the published Offerwall message.
 * Reusing it keeps GAM demand and reporting on the inventory Google has
 * already validated for rewarded ads; the page owns only the GPT lifecycle.
 */
export const ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH = '/23355151813/Offerwall-Ad-Unit-5b9baedaa76b805f';

type RewardedAdState = 'loading' | 'ready' | 'showing' | 'unavailable';

export interface GptRewardedAdProps {
  adUnitPath?: string;
  label: string;
  loadingLabel: string;
  unavailableLabel: string;
  enabled?: boolean;
  onOptIn?: () => void;
  onReady?: () => void;
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
  unavailableLabel,
  enabled = true,
  onOptIn,
  onReady,
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
  const onGrantedRef = useRef(onGranted);
  const onClosedRef = useRef(onClosed);
  const onUnavailableRef = useRef(onUnavailable);
  onReadyRef.current = onReady;
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

    const cleanupSlot = () => {
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
    };

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
          if (event?.slot !== slot || cancelled) return;
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
          if (event?.slot !== slot || cancelled) return;
          track('rewarded_web_video_completed');
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

        // A blocked or empty GPT request may never emit a lifecycle event.
        readyTimeout = window.setTimeout(() => markUnavailable('ready_timeout'), 10000);
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
      <button
        type="button"
        onClick={handleOptIn}
        disabled={state !== 'ready'}
        aria-busy={state === 'loading' || state === 'showing'}
        className="inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="assisted-application-offer-rewarded"
      >
        {(state === 'loading' || state === 'showing') && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {state === 'ready' && <PlayCircle className="h-4 w-4" aria-hidden="true" />}
        {state === 'loading' ? loadingLabel : state === 'showing' ? loadingLabel : label}
      </button>
      {state === 'unavailable' && <p role="status" className="text-xs leading-relaxed text-muted">{unavailableLabel}</p>}
    </div>
  );
}
