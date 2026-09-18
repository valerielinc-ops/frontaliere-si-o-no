import { useEffect, useRef, useState } from 'react';
import { Loader2, PlayCircle } from 'lucide-react';
import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { GPT_ENABLED, getGptTag, initGptFramework } from '@/components/shared/GptAdSlot';
import { isLikelyBot, trackAdEvent } from '@/services/adAnalytics';
import { isAdsConsentGranted, onAdsConsentChange } from '@/services/adsConsent';

export const ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH = '/23355151813/assisted-application-rewarded';

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
 * Opt-in GPT rewarded web ad. The caller owns the actual reward; GPT only
 * reports that the visitor earned it. This keeps the destination and the
 * twelve-hour entitlement outside the ad provider's iframe.
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
    let closeTimer: number | null = null;
    let slotReadyHandler: ((event: any) => void) | null = null;
    let slotGrantedHandler: ((event: any) => void) | null = null;
    let slotCompletedHandler: ((event: any) => void) | null = null;
    let slotClosedHandler: ((event: any) => void) | null = null;

    const markUnavailable = (reason: string) => {
      if (cancelled || unavailableRef.current) return;
      unavailableRef.current = true;
      setState('unavailable');
      trackAdEvent('rewarded_ad_unavailable', { slot: adUnitPath, format: 'rewarded', network: 'gpt', reason });
      onUnavailableRef.current?.();
    };

    if (!active) {
      setState('unavailable');
      return () => { cancelled = true; };
    }

    setState('loading');
    grantedRef.current = false;
    unavailableRef.current = false;
    readyEventRef.current = null;
    trackAdEvent('rewarded_ad_request', { slot: adUnitPath, format: 'rewarded', network: 'gpt' });
    initGptFramework();
    const gt = getGptTag();

    const cleanupSlot = () => {
      try {
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

    gt.cmd.push(() => {
      if (cancelled) return;
      try {
        const rewardedFormat = gt.enums?.OutOfPageFormat?.REWARDED;
        if (!rewardedFormat || typeof gt.defineOutOfPageSlot !== 'function') {
          markUnavailable('rewarded_format_unavailable');
          return;
        }

        const slot = gt.defineOutOfPageSlot(adUnitPath, rewardedFormat);
        if (!slot) {
          markUnavailable('slot_not_defined');
          return;
        }
        slotRef.current = slot;
        slot.addService(gt.pubads());

        slotReadyHandler = (event: any) => {
          if (event?.slot !== slot || cancelled) return;
          if (closeTimer !== null) {
            window.clearTimeout(closeTimer);
            closeTimer = null;
          }
          readyEventRef.current = event;
          setState('ready');
          trackAdEvent('rewarded_ad_ready', { slot: adUnitPath, format: 'rewarded', network: 'gpt' });
          onReadyRef.current?.();
        };
        slotGrantedHandler = (event: any) => {
          if (event?.slot !== slot || cancelled || grantedRef.current) return;
          grantedRef.current = true;
          trackAdEvent('rewarded_ad_granted', { slot: adUnitPath, format: 'rewarded', network: 'gpt' });
          onGrantedRef.current();
        };
        slotCompletedHandler = (event: any) => {
          if (event?.slot !== slot || cancelled) return;
          trackAdEvent('rewarded_ad_video_completed', { slot: adUnitPath, format: 'rewarded', network: 'gpt' });
        };
        slotClosedHandler = (event: any) => {
          if (event?.slot !== slot || cancelled) return;
          trackAdEvent('rewarded_ad_closed', { slot: adUnitPath, format: 'rewarded', network: 'gpt', reason: grantedRef.current ? 'granted' : 'dismissed' });
          onClosedRef.current?.(grantedRef.current);
          cleanupSlot();
        };

        const pubads = gt.pubads();
        pubads.addEventListener('rewardedSlotReady', slotReadyHandler);
        pubads.addEventListener('rewardedSlotGranted', slotGrantedHandler);
        pubads.addEventListener('rewardedSlotVideoCompleted', slotCompletedHandler);
        pubads.addEventListener('rewardedSlotClosed', slotClosedHandler);
        // A blocked GPT request may never emit a lifecycle event. Keep the
        // secondary direct-link fallback usable instead of leaving a spinner.
        closeTimer = window.setTimeout(() => markUnavailable('ready_timeout'), 10000);
        gt.display(slot);
      } catch {
        markUnavailable('gpt_error');
      }
    });

    return () => {
      cancelled = true;
      if (closeTimer !== null) window.clearTimeout(closeTimer);
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
    trackAdEvent('rewarded_ad_started', { slot: adUnitPath, format: 'rewarded', network: 'gpt' });
    try {
      event.makeRewardedVisible();
    } catch {
      setState('unavailable');
      trackAdEvent('rewarded_ad_unavailable', { slot: adUnitPath, format: 'rewarded', network: 'gpt', reason: 'show_error' });
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
