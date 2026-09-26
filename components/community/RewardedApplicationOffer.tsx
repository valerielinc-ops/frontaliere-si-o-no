import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import GptRewardedAd, { type GptRewardedAdCallbackInfo } from '@/components/shared/GptRewardedAd';
import { useApplicationOfferBackdropDismiss } from '@/components/community/useApplicationOfferBackdropDismiss';
import {
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  REWARDED_WEB_AD_FORMAT,
  disposeRewardedWebAd,
  isRewardedWebAdEligible,
} from '@/services/rewardedWebAd';
import {
  grantRewardedApplicationAccess,
  REWARDED_APPLICATION_ACCESS_TTL_HOURS,
} from '@/services/rewardedApplicationAccess';
import {
  offerwallGateStatus,
  releaseHeldOfferwall,
  type OfferwallAppearTimeoutDecision,
  type OfferwallGateStatus,
  type OfferwallReleaseResult,
} from '@/services/offerwallClickGate';
import {
  trackAssistedApplicationEvent,
} from '@/services/assistedApplicationExperiment';
import { useTranslation } from '@/services/i18n';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import { usePopupSlot } from '@/hooks/usePopupSlot';

const SURFACE = 'job_detail_rewarded_inline';
const TRIGGER = 'candidate_click';
const POPUP_SLOT_ID = 'rewarded-application-offer';
const OFFERWALL_PROVIDER = 'adsense_offerwall';
const OFFERWALL_FORMAT = 'offerwall';

/**
 * How long the neutral loading screen waits for the GPT rewarded slot before
 * the click goes straight to the employer. JobBoard preloads the slot when
 * the job detail opens, so by the "Candidati" click it is usually ready
 * already and this only bounds a slow auction. 4 s keeps the unexplained
 * spinner within the budget the Offerwall path already accepts
 * (OFFERWALL_APPEAR_TIMEOUT_MS = 5 s, 2.0-2.8 s live); a slower slot costs one
 * impression, never a visitor staring at a spinner. The service's own
 * REWARDED_READY_TIMEOUT_MS (15 s) stays as the backstop behind it.
 */
export const GPT_OPT_IN_READY_TIMEOUT_MS = 4000;

/**
 * Longest job title quoted in this overlay's own copy; a longer one is cut
 * with an ellipsis so the loading line and the opt-in title stay short.
 */
export const REWARDED_OFFER_TITLE_MAX_CHARS = 60;

/** Collapse whitespace and shorten a job title for the overlay copy. */
export function shortenRewardedOfferJobTitle(title: string | null | undefined): string {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= REWARDED_OFFER_TITLE_MAX_CHARS) return clean;
  return `${chars.slice(0, REWARDED_OFFER_TITLE_MAX_CHARS - 1).join('').trimEnd()}…`;
}

/**
 * `offerwall`: the held AdSense Offerwall has been released and may render.
 * When it is late (OFFERWALL_SLOW_MS) a GPT rewarded slot is prepared,
 * hidden, as its fallback; at the appear timeout the offer moves to `gpt`
 * or `gpt_ready` while a late Offerwall is still followed.
 * `offerwall_visible`: it is on screen, so this overlay steps out of its way.
 * `offerwall_verifying`: it closed; waiting for Google's entitlement.
 * `offerwall_done`: reward granted, the visitor is on the way to the employer.
 * `gpt`: no Offerwall was released for this click; the GPT slot is loading.
 * `gpt_ready`: the GPT slot is ready; the visitor is asked to opt in.
 * `gpt_retry`: the GPT video was closed before its reward.
 * `gpt_done`: GPT reward granted, the visitor is on the way to the employer.
 */
type OfferPhase =
  | 'offerwall'
  | 'offerwall_visible'
  | 'offerwall_verifying'
  | 'offerwall_done'
  | 'gpt'
  | 'gpt_ready'
  | 'gpt_retry'
  | 'gpt_done';

/** Phases in which Escape or the backdrop may dismiss: nothing irrevocable is in flight. */
const DISMISSIBLE_PHASES: ReadonlySet<OfferPhase> = new Set(['gpt', 'gpt_ready', 'gpt_retry']);

/** Why no Offerwall was waiting for this click (tracked before the GPT path). */
const NOT_HELD_REASON: Record<Exclude<OfferwallGateStatus, 'held'>, string> = {
  suppressed: 'no_consent_decision',
  off_board: 'off_board_page',
  released: 'already_released',
  absent: 'not_held',
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * `t()` interpolates with String.prototype.replace, where `$&`, `$1`... in the
 * replacement are patterns: escape `$` so a title is always inserted verbatim.
 */
const replacementSafe = (value: string) => value.replace(/\$/g, '$$$$');

export interface RewardedApplicationOfferProps {
  jobId: string;
  companyId: string;
  companyName: string;
  jobTitle: string;
  onContinue: () => void;
  onUnavailable: (reason: string) => void;
  onDismiss?: () => void;
}

/**
 * Same-page rewarded application step, presented as a loading screen
 * (owner decision 2026-09-26): the "Candidati" click opens a neutral overlay,
 * the AdSense Offerwall (whose own text explains the video) takes the screen,
 * and the reward sends the visitor on to the employer with no further click.
 * Only the GPT fallback shows copy of its own: a GPT rewarded ad needs an
 * explicit opt-in with a clear value exchange, so it never starts by itself.
 * The GPT path runs when no Offerwall was held for the page view, and as the
 * fallback of a released Offerwall that does not appear (the AdSense
 * experiment keeps a "no message" holdout of visitors): the slot is prepared
 * while the Offerwall is late and offered at its appear timeout, and an
 * Offerwall that still appears before the video starts takes over again.
 * Every text is localized and names the job (the Offerwall's own text is
 * Google's and cannot take parameters).
 *
 * The job detail remains the canonical page. This overlay only appears after
 * a visitor asks to apply; it never owns a URL, SEO metadata,
 * JobPosting data, or a crawler-specific branch.
 */
export default function RewardedApplicationOffer({
  jobId,
  companyId,
  companyName,
  jobTitle,
  onContinue,
  onUnavailable,
  onDismiss,
}: RewardedApplicationOfferProps) {
  const { t } = useTranslation();
  const [retryToken, setRetryToken] = useState(0);
  // The AdSense Offerwall is the site's only rewarded demand: when Funding
  // Choices holds one for this page view, the click releases it first.
  const [initialGateStatus] = useState(() => offerwallGateStatus());
  const [phase, setPhase] = useState<OfferPhase>(() => (initialGateStatus === 'held' ? 'offerwall' : 'gpt'));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const grantedRef = useRef(false);
  // Set once the GPT path has handed the click to the employer (no-fill or
  // ready timeout): later callbacks from that request must not act on it.
  const gptSettledRef = useRef(false);
  const openedAtRef = useRef(now());
  const mountedRef = useRef(true);
  const offerwallStartedRef = useRef(false);
  // Late-Offerwall fallback: the GPT slot prepared (hidden) while the
  // released Offerwall has not appeared yet, then offered at its timeout.
  const [fallbackPreparing, setFallbackPreparing] = useState(false);
  const fallbackStartedRef = useRef(false);
  const fallbackEndedRef = useRef(false);
  const fallbackReadyRef = useRef(false);
  const fallbackShownRef = useRef(false);
  const gptVideoStartedRef = useRef(false);
  const appearTimeoutTrackedRef = useRef(false);
  const offerwallWatchRef = useRef<AbortController | null>(null);
  const loadingRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dismissFromBackdrop = useApplicationOfferBackdropDismiss(onDismiss);

  // Shared shape of every rewarded event of this offer: the job context, the
  // ad inventory, and the Google request id that joins it to the
  // `rewarded_web_*` lifecycle telemetry.
  const eventContext = (info?: GptRewardedAdCallbackInfo) => ({
    variant: 'rewarded_ad' as const,
    jobId,
    companyId,
    surface: SURFACE,
    trigger: TRIGGER,
    ad_unit: ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
    format: REWARDED_WEB_AD_FORMAT,
    ms_since_click: Math.round(now() - openedAtRef.current),
    ...(info?.requestId ? { request_id: info.requestId } : {}),
  });

  const offerwallContext = () => ({
    ...eventContext(),
    ad_unit: OFFERWALL_PROVIDER,
    format: OFFERWALL_FORMAT,
    provider: OFFERWALL_PROVIDER,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // A late-Offerwall watch must not outlive the offer.
      offerwallWatchRef.current?.abort();
    };
  }, []);

  const fallbackActive = () => fallbackStartedRef.current && !fallbackEndedRef.current;
  // The fallback stepped aside before its video started (the Offerwall took
  // over, or the slot failed early): its GPT callbacks no longer count.
  const fallbackDiscarded = () => fallbackStartedRef.current && fallbackEndedRef.current && !gptVideoStartedRef.current;

  // Escape and the backdrop close the overlay only while nothing irrevocable
  // is in flight. The neutral loading screen of the late-Offerwall fallback
  // is not one of those moments: the released Offerwall may still render.
  const canDismissNow = () => DISMISSIBLE_PHASES.has(phaseRef.current)
    && !(phaseRef.current === 'gpt' && fallbackActive());

  // The fallback stops being an option: tear its slot down (unless its video
  // already ran) and say why.
  const abortFallback = (reason: string, extra: Record<string, unknown> = {}) => {
    if (!fallbackActive()) return;
    fallbackEndedRef.current = true;
    setFallbackPreparing(false);
    if (!gptVideoStartedRef.current) disposeRewardedWebAd(ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH);
    trackAssistedApplicationEvent('rewarded_offerwall_gpt_fallback_aborted', {
      ...eventContext(),
      reason,
      ...extra,
    });
  };

  // The opt-in card of the fallback is on screen for the first time.
  const markFallbackShown = () => {
    if (!fallbackActive() || fallbackShownRef.current) return;
    fallbackShownRef.current = true;
    trackAssistedApplicationEvent('rewarded_offerwall_gpt_fallback_shown', eventContext());
  };

  useEffect(() => {
    trackAssistedApplicationEvent('rewarded_application_offer_viewed', eventContext());
    // The offer is viewed once per mount; the context is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, jobId]);

  // Hold the popup queue for the whole offer: a queued popup (newsletter,
  // prompts) must not cover or hide the Google video while it plays. The
  // offer itself stays on screen whatever the queue answers.
  usePopupSlot(POPUP_SLOT_ID, POPUP_PRIORITY.REWARDED_APPLICATION_OFFER);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Escape is harmless: it closes the overlay only while nothing
    // irrevocable is in flight. A released Offerwall cannot be taken back,
    // and its own appear timeout (5 s) or the redirect ends that screen.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && canDismissNow()) onDismiss?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onDismiss]);

  // Take focus off the "Candidati" button behind the overlay: onto the status
  // line while loading, onto the card when it asks for a choice.
  useEffect(() => {
    if (phase === 'offerwall_visible') return;
    const target = phase === 'gpt_ready' || phase === 'gpt_retry' ? cardRef.current : loadingRef.current;
    target?.focus({ preventScroll: true });
  }, [phase]);

  const handleBackdropClick: typeof dismissFromBackdrop = (event) => {
    if (canDismissNow()) dismissFromBackdrop(event);
  };

  // Only Google's rewardedSlotGranted reaches this handler (directly, or via
  // the granted bit of the close event that follows it). The reward is the
  // end of the step: the visitor goes on to the employer with no further click.
  const handleGranted = (info?: GptRewardedAdCallbackInfo) => {
    if (grantedRef.current || gptSettledRef.current || fallbackDiscarded()) return;
    grantedRef.current = true;
    const accessExpiresAt = grantRewardedApplicationAccess();
    setPhase('gpt_done');
    trackAssistedApplicationEvent('rewarded_ad_granted', eventContext(info));
    if (fallbackActive()) {
      trackAssistedApplicationEvent('rewarded_offerwall_gpt_fallback_granted', eventContext(info));
    }
    trackAssistedApplicationEvent('rewarded_application_access_granted', {
      ...eventContext(info),
      access_expires_at: accessExpiresAt,
      access_ttl_hours: REWARDED_APPLICATION_ACCESS_TTL_HOURS,
    });
    onContinue();
  };

  // `completed` means Funding Choices granted the Offerwall's reward
  // (entitlement cookie, usually while its thank-you screen is still up):
  // grant the access like a GPT grant and go on to the application at once.
  // The rewarded choice inside Google's dialog was the visitor's action; no
  // further click is asked here.
  const handleOfferwallCompleted = (result: Extract<OfferwallReleaseResult, { outcome: 'completed' }>) => {
    if (grantedRef.current) return;
    grantedRef.current = true;
    const accessExpiresAt = grantRewardedApplicationAccess();
    setPhase('offerwall_done');
    trackAssistedApplicationEvent('rewarded_offerwall_completed', {
      ...offerwallContext(),
      shown_ms: result.shownMs,
      ...(result.closedMs !== null ? { closed_ms: result.closedMs } : {}),
      completed_ms: result.completedMs,
      completion_signal: result.signal,
      fc_root: result.root,
    });
    trackAssistedApplicationEvent('rewarded_application_access_granted', {
      ...offerwallContext(),
      access_expires_at: accessExpiresAt,
      access_ttl_hours: REWARDED_APPLICATION_ACCESS_TTL_HOURS,
    });
    onContinue();
  };

  useEffect(() => {
    if (initialGateStatus === 'held') return;
    trackAssistedApplicationEvent('rewarded_offerwall_not_shown', {
      ...offerwallContext(),
      reason: NOT_HELD_REASON[initialGateStatus],
    });
    // Once per offer: the gate status is read when the click opens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'offerwall' || offerwallStartedRef.current) return;
    offerwallStartedRef.current = true;
    trackAssistedApplicationEvent('rewarded_offerwall_released', offerwallContext());
    const watch = typeof AbortController !== 'undefined' ? new AbortController() : null;
    offerwallWatchRef.current = watch;
    void releaseHeldOfferwall({
      ...(watch ? { signal: watch.signal } : {}),
      // The Offerwall is late: prepare the GPT fallback, hidden, so it can be
      // offered at the appear timeout without a further wait.
      onSlow: ({ elapsedMs }) => {
        if (!mountedRef.current || phaseRef.current !== 'offerwall' || fallbackStartedRef.current) return;
        // Bots, missing ad consent, non-production hosts: no GPT request.
        if (!isRewardedWebAdEligible()) return;
        fallbackStartedRef.current = true;
        setFallbackPreparing(true);
        trackAssistedApplicationEvent('rewarded_offerwall_gpt_fallback_started', {
          ...eventContext(),
          offerwall_wait_ms: elapsedMs,
        });
      },
      onAppearTimeout: (): OfferwallAppearTimeoutDecision => {
        appearTimeoutTrackedRef.current = true;
        trackAssistedApplicationEvent('rewarded_offerwall_not_shown', {
          ...offerwallContext(),
          reason: 'appear_timeout',
        });
        if (!mountedRef.current || !fallbackActive()) return 'resolve';
        // Keep following a late Offerwall while the fallback is offered. A
        // slot already ready becomes the opt-in card now; otherwise the `gpt`
        // loading phase gives it GPT_OPT_IN_READY_TIMEOUT_MS more.
        setFallbackPreparing(false);
        if (fallbackReadyRef.current) {
          setPhase('gpt_ready');
          markFallbackShown();
        } else {
          setPhase('gpt');
        }
        return 'keep_watching';
      },
      onShown: ({ shownMs, root }) => {
        if (!mountedRef.current) return;
        // Google's Offerwall won the race: the GPT fallback (prepared, or
        // offered but not started) steps aside for it.
        if (fallbackActive()) {
          abortFallback(phaseRef.current === 'offerwall' ? 'offerwall_shown' : 'offerwall_shown_late', {
            offerwall_shown_ms: shownMs,
          });
        }
        setPhase('offerwall_visible');
        trackAssistedApplicationEvent('rewarded_offerwall_shown', {
          ...offerwallContext(),
          shown_ms: shownMs,
          fc_root: root,
        });
      },
      onClosed: () => {
        if (!mountedRef.current) return;
        setPhase('offerwall_verifying');
      },
      onStalled: ({ shownMs, root }) => {
        // Telemetry only: the observer keeps following the Offerwall, and
        // time on screen never counts as a reward.
        trackAssistedApplicationEvent('rewarded_offerwall_timed_out', {
          ...offerwallContext(),
          shown_ms: shownMs,
          fc_root: root,
        });
      },
    }).then((result) => {
      if (!mountedRef.current) return;
      if (result.outcome === 'completed') {
        handleOfferwallCompleted(result);
        return;
      }
      // The watch was ended by this offer (its GPT fallback video started,
      // or the fallback handed off): nothing more on the Offerwall side.
      if (result.outcome === 'not_shown' && result.reason === 'aborted') return;
      if (result.outcome === 'closed_without_reward') {
        // Closed with no entitlement from Google: nothing to unlock, and no
        // second ad after this one. Direct employer hand-off.
        trackAssistedApplicationEvent('rewarded_offerwall_closed_without_reward', {
          ...offerwallContext(),
          shown_ms: result.shownMs,
          closed_ms: result.closedMs,
          fc_root: result.root,
        });
        onUnavailable('offerwall_closed_without_reward');
        return;
      }
      if (!(result.reason === 'appear_timeout' && appearTimeoutTrackedRef.current)) {
        trackAssistedApplicationEvent('rewarded_offerwall_not_shown', {
          ...offerwallContext(),
          reason: result.reason,
        });
      }
      if (result.reason === 'appear_timeout') {
        // Released but not rendered in time (Google's frequency, experiment
        // group, or access already granted) and no GPT fallback to offer
        // (ineligible, or its slot already failed): direct employer hand-off,
        // which leaves this page.
        onUnavailable('offerwall_not_shown');
        return;
      }
      // Nothing was released for this click: the GPT request runs as before.
      setPhase('gpt');
    });
    // Runs once per offer; the context is read at release time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleUnavailable = (reason = 'unavailable', info?: GptRewardedAdCallbackInfo) => {
    // A fallback that already stepped aside reports nothing more.
    if (gptSettledRef.current || grantedRef.current || fallbackDiscarded()) return;
    const gptDetail = { gpt_reason: reason, ...(info?.detail ? { detail: info.detail } : {}) };
    if (fallbackActive() && phaseRef.current === 'offerwall') {
      // The prepared fallback failed before the appear timeout: drop it and
      // keep waiting for the Offerwall, whose timeout then hands off as usual.
      abortFallback('gpt_unavailable', gptDetail);
      return;
    }
    gptSettledRef.current = true;
    if (fallbackActive()) {
      abortFallback('gpt_unavailable', gptDetail);
      offerwallWatchRef.current?.abort();
    }
    trackAssistedApplicationEvent('rewarded_ad_unavailable', {
      ...eventContext(info),
      reason,
      ...(info?.detail ? { detail: info.detail } : {}),
      handoff: 'direct_external',
    });
    // There is no monetizable impression when Google returns no-fill or the
    // request is ineligible. Do not ask the visitor to reload the same empty
    // auction: report the reason and let the parent perform the direct,
    // same-tab employer hand-off.
    onUnavailable(reason);
  };

  // Bound the neutral loading screen of the GPT path (see
  // GPT_OPT_IN_READY_TIMEOUT_MS). Each retry gets its own budget.
  useEffect(() => {
    if (phase !== 'gpt') return undefined;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current || phaseRef.current !== 'gpt' || gptSettledRef.current) return;
      trackAssistedApplicationEvent('rewarded_gpt_ready_timeout', {
        ...eventContext(),
        timeout_ms: GPT_OPT_IN_READY_TIMEOUT_MS,
      });
      handleUnavailable('gpt_ready_timeout');
    }, GPT_OPT_IN_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // The budget restarts only with the loading phase or a retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, retryToken]);

  const handleReady = () => {
    if (gptSettledRef.current || grantedRef.current || fallbackDiscarded()) return;
    if (phaseRef.current === 'offerwall') {
      // Prepared fallback: remembered, offered only at the appear timeout.
      if (fallbackActive()) fallbackReadyRef.current = true;
      return;
    }
    if (phaseRef.current !== 'gpt') return;
    setPhase('gpt_ready');
    markFallbackShown();
  };

  // The visitor chose the GPT video: from here on a late Offerwall must not
  // take over, so its watch ends.
  const handleOptIn = (info: GptRewardedAdCallbackInfo) => {
    gptVideoStartedRef.current = true;
    if (fallbackActive()) offerwallWatchRef.current?.abort();
    trackAssistedApplicationEvent('rewarded_ad_opt_in', eventContext(info));
  };

  const handleVideoCompleted = () => {
    // Google documents rewardedSlotGranted as the authoritative web reward.
    // Video completion is optional telemetry and must never unlock the CTA.
  };

  const handleClosed = (grantedByEvent: boolean, info?: GptRewardedAdCallbackInfo) => {
    if (fallbackDiscarded()) return;
    // `grantedByEvent` is true only when rewardedSlotGranted already fired for
    // this request; it just guards against the close being delivered first.
    if (grantedByEvent && !grantedRef.current) {
      handleGranted(info);
    }
    if (grantedByEvent || grantedRef.current || gptSettledRef.current) {
      return;
    }
    // No reward: the application stays locked. The visitor may choose to
    // watch again, but nothing retries on their behalf.
    setPhase('gpt_retry');
    trackAssistedApplicationEvent('rewarded_ad_unavailable', {
      ...eventContext(info),
      reason: 'video_closed_before_reward',
      handoff: 'none',
    });
  };

  const retry = () => {
    grantedRef.current = false;
    setRetryToken((token) => token + 1);
    setPhase('gpt');
  };

  const gptMounted = phase === 'gpt' || phase === 'gpt_ready' || (phase === 'offerwall' && fallbackPreparing);
  const shortTitle = replacementSafe(shortenRewardedOfferJobTitle(jobTitle));
  const titled = (key: string, genericKey: string) => (shortTitle ? t(key, { jobTitle: shortTitle }) : t(genericKey));
  // Neutral copy: the loading screen never mentions ads, videos or Google.
  const loadingLabel = titled('jobBoard.rewardedOffer.loadingJob', 'jobBoard.rewardedOffer.loading');
  const redirectLabel = titled('jobBoard.rewardedOffer.redirectJob', 'jobBoard.rewardedOffer.redirect');
  const optInTitle = titled('jobBoard.rewardedOffer.optInTitleJob', 'jobBoard.rewardedOffer.optInTitle');
  // The GPT grant unlocks the same site access as the Offerwall reward.
  const optInSubtitle = t(
    REWARDED_APPLICATION_ACCESS_TTL_HOURS === 1
      ? 'jobBoard.rewardedOffer.optInSubtitleOne'
      : 'jobBoard.rewardedOffer.optInSubtitleOther',
    { hours: REWARDED_APPLICATION_ACCESS_TTL_HOURS },
  );
  const closeLabel = t('jobBoard.rewardedOffer.close');
  const loadingText = phase === 'offerwall_done' || phase === 'gpt_done' ? redirectLabel : loadingLabel;
  const showLoading = phase !== 'gpt_ready' && phase !== 'gpt_retry';

  const cardClass = 'w-full max-w-sm space-y-4 rounded-stripe border border-edge bg-surface p-5 shadow-stripe-lg focus:outline-none';
  const secondaryButtonClass = 'inline-flex min-h-[44px] w-full items-center justify-center rounded-stripe px-4 py-2 text-sm font-semibold text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2';

  const overlay = (
    <div
      className="fixed inset-0 z-[1000] isolate flex min-h-[100dvh] items-center justify-center bg-black/55 px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] backdrop-blur-sm"
      onClick={handleBackdropClick}
      data-testid="rewarded-application-offer"
    >
      {showLoading && (
        <div
          ref={loadingRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="flex items-center gap-3 rounded-stripe border border-edge bg-surface px-5 py-4 shadow-stripe-lg focus:outline-none"
          data-testid="rewarded-application-loading"
        >
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden="true" />
          <p className="text-sm font-semibold text-heading">{loadingText}</p>
        </div>
      )}

      {gptMounted && (
        // Mounted from the loading phase on, so the GPT request survives the
        // switch to the opt-in card; hidden until the slot is ready.
        <div
          ref={cardRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rewarded-application-offer-title"
          className={phase === 'gpt_ready' ? cardClass : 'hidden'}
          data-testid="rewarded-application-opt-in"
        >
          <div>
            <p className="text-xs font-semibold text-accent">{companyName}</p>
            <h2 id="rewarded-application-offer-title" className="mt-1 text-base font-semibold font-display text-heading">
              {optInTitle}
            </h2>
            <p className="mt-1 text-sm text-body" data-testid="rewarded-application-opt-in-subtitle">
              {optInSubtitle}
            </p>
          </div>
          <GptRewardedAd
            label={t('jobBoard.rewardedOffer.watch')}
            loadingLabel={loadingLabel}
            showingLabel={t('jobBoard.rewardedOffer.playing')}
            unavailableLabel={t('jobBoard.rewardedOffer.unavailable')}
            showUnavailableMessage={false}
            retryToken={retryToken}
            onReady={handleReady}
            onOptIn={handleOptIn}
            onGranted={handleGranted}
            onVideoCompleted={handleVideoCompleted}
            onClosed={handleClosed}
            onUnavailable={handleUnavailable}
          />
          <button
            type="button"
            onClick={onDismiss}
            className={secondaryButtonClass}
            data-testid="rewarded-application-offer-close"
          >
            {closeLabel}
          </button>
        </div>
      )}

      {phase === 'gpt_retry' && (
        <div
          ref={cardRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rewarded-application-offer-retry-title"
          className={cardClass}
          data-testid="rewarded-application-retry"
        >
          <p id="rewarded-application-offer-retry-title" className="text-sm leading-relaxed text-body">
            {t('jobBoard.rewardedOffer.retryText')}
          </p>
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('jobBoard.rewardedOffer.retry')}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className={secondaryButtonClass}
            data-testid="rewarded-application-offer-close"
          >
            {closeLabel}
          </button>
        </div>
      )}
    </div>
  );

  // The Google Offerwall is its own full-page dialog: while it is on screen
  // this overlay must not sit on top of it or take its clicks.
  if (phase === 'offerwall_visible') return null;

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
