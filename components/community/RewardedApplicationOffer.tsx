import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import GptRewardedAd, { type GptRewardedAdCallbackInfo } from '@/components/shared/GptRewardedAd';
import AssistedApplicationOffer from '@/components/community/AssistedApplicationOffer';
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
  revealStagedOfferwall,
  type OfferwallAppearTimeoutDecision,
  type OfferwallGateStatus,
  type OfferwallReleaseResult,
} from '@/services/offerwallClickGate';
import {
  markOfferwallResume,
  offerwallConsentState,
  offerwallGateWaitMs,
  planOfferwallClick,
  waitForOfferwallGate,
  type OfferwallClickPlan,
  type OfferwallConsentState,
} from '@/services/offerwallRecovery';
import { isAdsConsentMessageOnScreen, onAdsConsentChange, reopenAdsConsentMessage } from '@/services/adsConsent';
import {
  trackAssistedApplicationEvent,
} from '@/services/assistedApplicationExperiment';
import { useTranslation } from '@/services/i18n';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import { canOpenTabWithoutClick, hasTransientUserActivation, usesWebKitPopupPolicy } from '@/services/userActivation';
import {
  markHandoffOpened,
  markHandoffRoute,
  recordHandoffGrant,
  scheduleHandoffReceiptFlush,
} from '@/services/rewardedHandoffLedger';
import { collectAdVisibility, watchReturnToTab } from '@/services/adVisibilitySnapshot';
import { usePopupSlot } from '@/hooks/usePopupSlot';

const SURFACE = 'job_detail_rewarded_inline';
const TRIGGER = 'candidate_click';
/** The same click, reopened by JobBoard after the recovery reload. */
const RESUME_TRIGGER = 'offerwall_resume';
const POPUP_SLOT_ID = 'rewarded-application-offer';
const OFFERWALL_PROVIDER = 'adsense_offerwall';
const OFFERWALL_FORMAT = 'offerwall';
/** `trigger` of the paid choice shown before the Offerwall. */
const CHOICE_TRIGGER = 'offerwall_first';

/**
 * How long Google's reopened consent message has to come on screen. It opens
 * in about 0.2 s live; when it does not (no consent framework for the
 * visitor's region, Funding Choices blocked) the click goes on without it.
 */
export const CONSENT_MESSAGE_APPEAR_MS = 3000;
/**
 * After the consent message closes, how long its answer may take to reach the
 * ad-consent gate (the CMP bridge writes it on `useractioncomplete`) before
 * the message counts as closed without one.
 */
export const CONSENT_DECISION_GRACE_MS = 2000;

/**
 * How long the neutral loading screen waits for the GPT rewarded slot before
 * the click goes straight to the employer. JobBoard preloads the slot when
 * the job detail opens, so by the "Candidati" click it is usually ready
 * already and this only bounds a slow auction. 4 s keeps the unexplained
 * spinner well within the budget the Offerwall path accepts
 * (OFFERWALL_APPEAR_TIMEOUT_MS = 10 s); a slower slot costs one impression,
 * never a visitor staring at a spinner. The service's own
 * REWARDED_READY_TIMEOUT_MS (15 s) stays as the backstop behind it.
 */
export const GPT_OPT_IN_READY_TIMEOUT_MS = 4000;

/**
 * Delay of the ads snapshot after Google's Offerwall is on screen: whatever
 * Google does to the page's ads when it renders has happened by then.
 */
export const OFFERWALL_ADS_SNAPSHOT_DELAY_MS = 1500;

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
 * `checking`: Funding Choices is still loading, or only scheduled, and has not
 * reached the gate; the click waits for it (offerwallGateWaitMs).
 * `reloading`: only a fresh page load can hold the Offerwall; the page reloads
 * and JobBoard resumes this click.
 * `consent`: the visitor has not answered the consent message, and no ad can
 * be served without an answer: Google's message opens at once (owner decision
 * 2026-10-03, no card of ours before it). Any answer goes on to the
 * Offerwall; a message that does not appear, or closes unanswered, goes on
 * without the video.
 * `choice`: the paid application is offered first (`paidChoice`), with the
 * Offerwall released hidden behind it (a staged release); the free path
 * reveals it and goes on as `offerwall`.
 * `offerwall`: the held AdSense Offerwall has been released and may render.
 * When it is late (OFFERWALL_SLOW_MS) a GPT rewarded slot is prepared,
 * hidden, as its fallback; at the appear timeout the offer moves to `gpt`
 * or `gpt_ready` while a late Offerwall is still followed.
 * `offerwall_visible`: it is on screen, so this overlay steps out of its way.
 * `offerwall_verifying`: it closed; waiting for Google's entitlement.
 * `offerwall_done`: reward granted, the employer is opening in a new tab.
 * `gpt`: no Offerwall was released for this click; the GPT slot is loading.
 * `gpt_ready`: the GPT slot is ready; the visitor is asked to opt in.
 * `gpt_retry`: the GPT video was closed before its reward.
 * `gpt_done`: GPT reward granted, the employer is opening in a new tab.
 * `direct_done`: no ad (unavailable or refused, paid fallback off); the
 * parent is opening the employer in a new tab and keeps the offer until
 * that tab takes the foreground.
 * `handoff`: the new tab waits for the visitor's click on the "open"
 * button: reward granted without a click's activation left on the page,
 * or a new tab (after a reward or a direct hand-off) the browser blocked.
 *
 * While the GPT rewarded video is off (GPT_REWARDED_ENABLED in
 * components/shared/GptAdSlot.tsx) no fallback slot is prepared and `gpt`
 * ends at once as unavailable: the parent offers the paid application or
 * hands off to the employer, with no request and no wait.
 */
type OfferPhase =
  | 'checking'
  | 'reloading'
  | 'consent'
  | 'choice'
  | 'offerwall'
  | 'offerwall_visible'
  | 'offerwall_verifying'
  | 'offerwall_done'
  | 'gpt'
  | 'gpt_ready'
  | 'gpt_retry'
  | 'gpt_done'
  | 'direct_done'
  | 'handoff';

/**
 * Phases in which Escape or the backdrop may dismiss: nothing irrevocable is
 * in flight. In `handoff` the access is already granted, so a later
 * "Candidati" click goes straight to the employer.
 */
const DISMISSIBLE_PHASES: ReadonlySet<OfferPhase> = new Set(['consent', 'choice', 'gpt', 'gpt_ready', 'gpt_retry', 'handoff']);

/** Why no Offerwall was waiting for this click (tracked before the GPT path). */
const NOT_HELD_REASON: Record<Exclude<OfferwallGateStatus, 'held'>, string> = {
  suppressed: 'no_consent_decision',
  off_board: 'off_board_page',
  released: 'already_released',
  absent: 'not_held',
};

/** How the click will get to the Offerwall, decided from the gate and the ad consent. */
interface GateDecision {
  plan: OfferwallClickPlan;
  status: OfferwallGateStatus;
  consent: OfferwallConsentState;
}

const PHASE_FOR_PLAN: Record<OfferwallClickPlan, OfferPhase> = {
  offerwall: 'offerwall',
  consent: 'consent',
  reload: 'reloading',
  gpt: 'gpt',
};

/** Why the Offerwall cannot be released for this click (event `reason`). */
function notShownReason({ status, consent }: GateDecision): string {
  if (consent === 'none' && status !== 'absent') return 'no_consent_decision';
  return status === 'held' ? 'release_refused' : NOT_HELD_REASON[status];
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * `t()` interpolates with String.prototype.replace, where `$&`, `$1`... in the
 * replacement are patterns: escape `$` so a title is always inserted verbatim.
 */
const replacementSafe = (value: string) => value.replace(/\$/g, '$$$$');

/** Second argument of `onUnavailable`, passed only when it is true. */
export interface RewardedOfferUnavailableInfo {
  /**
   * The visitor already saw the paid choice and took the free path: no
   * second paid offer, the click goes to the employer.
   */
  paidOfferShown: boolean;
}

export interface RewardedOfferPaidChoice {
  onChoosePaid: () => void | Promise<void>;
  paidLoading?: boolean;
  error?: string | null;
}

export interface RewardedApplicationOfferProps {
  jobId: string;
  companyId: string;
  companyName: string;
  jobTitle: string;
  /**
   * Opens the employer in a new tab. It may resolve `false` when no new tab
   * took the foreground (a popup the browser blocked): the offer then shows
   * its "open" card again and waits for a click.
   */
  onContinue: () => void | Promise<boolean>;
  /**
   * No ad for this click. When the parent opens the employer in a new tab
   * itself it returns whether that tab took the foreground, and keeps the
   * offer mounted meanwhile: `false` brings the "open" card (no-reward
   * copy), whose click calls `onContinue`.
   */
  onUnavailable: (reason: string, info?: RewardedOfferUnavailableInfo) => void | Promise<boolean>;
  onDismiss?: () => void;
  /**
   * The paid application comes first (owner decision 2026-10-03): when the
   * Offerwall is held for the click, the offer shows this choice and releases
   * the Offerwall hidden behind it, so the free path reveals it with no wait.
   * Read when the offer opens. Without it the Offerwall is released on screen
   * at once, as before.
   */
  paidChoice?: RewardedOfferPaidChoice;
  /** This offer reopens a click after the recovery reload: never reload again. */
  resumed?: boolean;
  /**
   * The access is already granted and no click activation is left (a click
   * resumed after the recovery reload): no ad, only the "open" card, whose
   * click opens the new tab.
   */
  startInHandoff?: boolean;
  /**
   * Reload the page to resume this click (the resume marker is already set).
   * Without it the offer never reloads and takes the GPT path instead.
   */
  onReload?: () => void;
}

/**
 * Same-page rewarded application step, presented as a loading screen
 * (owner decision 2026-09-26): the "Candidati" click opens a neutral overlay,
 * the AdSense Offerwall (whose own text explains the video) takes the screen,
 * and the reward opens the employer in a new tab, so the visitor keeps the
 * site (owner decision 2026-09-29): at once while the page still holds a
 * click's activation, otherwise from one "open" click, since a browser blocks
 * a new tab opened without one.
 * Only the GPT fallback shows copy of its own: a GPT rewarded ad needs an
 * explicit opt-in with a clear value exchange, so it never starts by itself.
 * The GPT path runs when no Offerwall was held for the page view, and as the
 * fallback of a released Offerwall that does not appear: the slot is prepared
 * while the Offerwall is late and offered at its appear timeout, and an
 * Offerwall that still appears before the video starts takes over again.
 * Before any of that, a click the gate cannot serve as it is gets the
 * recovery of services/offerwallRecovery.ts: a short wait while Funding
 * Choices loads, the consent question for a visitor who has not answered it,
 * or one reload that resumes the click where only a fresh page load can hold
 * the Offerwall.
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
  resumed = false,
  onReload,
  startInHandoff = false,
  paidChoice,
}: RewardedApplicationOfferProps) {
  const { t } = useTranslation();
  const [retryToken, setRetryToken] = useState(0);
  // A resumed click never reloads again, and without a reload handler there is
  // nothing to resume the click with.
  const canReload = Boolean(onReload) && !resumed;
  const decideFor = (status: OfferwallGateStatus): GateDecision => {
    const consent = offerwallConsentState();
    return { plan: planOfferwallClick(status, consent, { canReload }), status, consent };
  };
  // The paid choice is decided when the click opens the offer; the latest
  // props (loading, error) are what it shows.
  const [choiceFirst] = useState(() => Boolean(paidChoice));
  const lastPaidChoiceRef = useRef<RewardedOfferPaidChoice | undefined>(paidChoice);
  if (paidChoice) lastPaidChoiceRef.current = paidChoice;
  const phaseFor = (decision: GateDecision): OfferPhase => (
    decision.plan === 'offerwall' && choiceFirst ? 'choice' : PHASE_FOR_PLAN[decision.plan]
  );
  // The AdSense Offerwall is the site's only rewarded demand: when Funding
  // Choices holds one for this page view, the click releases it first. A gate
  // that Funding Choices has not reached yet is waited for; anything else is
  // decided at once, so a held Offerwall is still released in the click's render.
  const [initialDecision] = useState<GateDecision | null>(() => {
    if (startInHandoff) return null;
    const status = offerwallGateStatus();
    if (status === 'absent' && offerwallGateWaitMs(resumed) > 0) return null;
    return decideFor(status);
  });
  const [phase, setPhase] = useState<OfferPhase>(() => {
    if (startInHandoff) return 'handoff';
    return initialDecision ? phaseFor(initialDecision) : 'checking';
  });
  const decisionRef = useRef<GateDecision | null>(initialDecision);
  const notShownTrackedRef = useRef(false);
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
  // Staged release behind the paid choice: the hidden Offerwall is complete,
  // or the release did not happen (gate no longer held).
  const stagedReadyRef = useRef(false);
  const stageFailedRef = useRef(false);
  // The paid choice was on screen: a later failure goes to the employer.
  const paidOfferShownRef = useRef(false);
  const offerwallWatchRef = useRef<AbortController | null>(null);
  const offerwallAdsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offerwallAdsSentRef = useRef(false);
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
    trigger: resumed ? RESUME_TRIGGER : TRIGGER,
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
    ...(decisionRef.current
      ? { gate_status: decisionRef.current.status, consent_state: decisionRef.current.consent }
      : {}),
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // A late-Offerwall watch must not outlive the offer.
      offerwallWatchRef.current?.abort();
      if (offerwallAdsTimerRef.current) clearTimeout(offerwallAdsTimerRef.current);
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

  // One snapshot of the page's ads per Offerwall, taken while it is still on
  // screen: 1.5 s after it appears, or at once when it closes or grants its
  // reward before that, so a quick close never measures the page after the
  // Offerwall is gone.
  const sendOfferwallAdsSnapshot = () => {
    if (offerwallAdsTimerRef.current) {
      clearTimeout(offerwallAdsTimerRef.current);
      offerwallAdsTimerRef.current = null;
    }
    if (offerwallAdsSentRef.current || !mountedRef.current) return;
    offerwallAdsSentRef.current = true;
    trackAssistedApplicationEvent('rewarded_offer_ads_offerwall', { ...offerwallContext(), ...collectAdVisibility() });
  };
  const flushOfferwallAdsSnapshot = () => {
    if (offerwallAdsTimerRef.current) sendOfferwallAdsSnapshot();
  };

  useEffect(() => {
    // An access already granted shows no ad offer, only the "open" card.
    if (startInHandoff) {
      trackAssistedApplicationEvent('rewarded_application_handoff_shown', {
        ...eventContext(),
        handoff_reason: 'resume_entitlement',
      });
      return;
    }
    trackAssistedApplicationEvent('rewarded_application_offer_viewed', eventContext());
    // Baseline of the page's ads at the click (services/adVisibilitySnapshot.ts).
    trackAssistedApplicationEvent('rewarded_offer_ads_open', { ...eventContext(), ...collectAdVisibility() });
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
    // The paid choice focuses its own close button.
    if (phase === 'offerwall_visible' || phase === 'choice') return;
    const target = phase === 'gpt_ready' || phase === 'gpt_retry' || phase === 'handoff'
      ? cardRef.current
      : loadingRef.current;
    target?.focus({ preventScroll: true });
  }, [phase]);

  const handleBackdropClick: typeof dismissFromBackdrop = (event) => {
    if (canDismissNow()) dismissFromBackdrop(event);
  };

  // The reward is the end of the step: the employer opens in a new tab. The
  // browser allows it only while the page holds a click's activation, so
  // without one the `handoff` card asks for that click instead. A browser can
  // still block the tab with the activation reported (Safari is the doubt):
  // when the parent sees no new tab take the foreground, the card comes back.
  const handoffDoneRef = useRef(false);
  const handoffPhaseRef = useRef<'offerwall_done' | 'gpt_done' | 'direct_done'>('gpt_done');
  // The card's copy: access unlocked by a reward, or a direct hand-off.
  const [handoffKind, setHandoffKind] = useState<'reward' | 'direct'>('reward');
  const handoffContext = () => (handoffPhaseRef.current === 'offerwall_done' ? offerwallContext() : eventContext());
  // The grant's record in the delivery-safe receipt ledger (null without a grant).
  const grantIdRef = useRef<string | null>(null);
  const showHandoff = (reason: 'no_activation' | 'webkit_popup_policy' | 'tab_not_opened') => {
    trackAssistedApplicationEvent('rewarded_application_handoff_shown', { ...handoffContext(), handoff_reason: reason });
    markHandoffRoute(grantIdRef.current, reason === 'tab_not_opened' ? 'blocked' : 'card');
    setPhase('handoff');
  };
  const openApplication = (mode: 'auto' | 'click') => {
    if (handoffDoneRef.current) return;
    handoffDoneRef.current = true;
    trackAssistedApplicationEvent(
      mode === 'auto' ? 'rewarded_application_handoff_auto' : 'rewarded_application_handoff_clicked',
      handoffContext(),
    );
    if (mode === 'auto') markHandoffRoute(grantIdRef.current, 'auto');
    setPhase(handoffPhaseRef.current);
    // The page's ads when the visitor comes back from the employer's tab: the
    // new tab exists to keep this page and its ads (and the vignette on return).
    const returnContext = handoffContext();
    watchReturnToTab(() => {
      trackAssistedApplicationEvent('rewarded_offer_ads_return', { ...returnContext, ...collectAdVisibility() });
    });
    const opened = onContinue();
    if (!(opened instanceof Promise)) return;
    const grantId = grantIdRef.current;
    void opened.then((ok) => {
      if (ok) markHandoffOpened(grantId);
      if (ok || !mountedRef.current) return;
      trackAssistedApplicationEvent('rewarded_application_handoff_unconfirmed', { ...handoffContext(), handoff_mode: mode });
      handoffDoneRef.current = false;
      showHandoff('tab_not_opened');
    });
  };
  // WebKit browsers block a tab opened from the reward's timer even with the
  // click's activation reported (services/userActivation.ts): they get the
  // "open" card at once instead of a blocked popup and a 1.5 s wait.
  const continueAfterReward = (donePhase: 'offerwall_done' | 'gpt_done') => {
    handoffPhaseRef.current = donePhase;
    if (canOpenTabWithoutClick()) {
      openApplication('auto');
      return;
    }
    showHandoff(hasTransientUserActivation() && usesWebKitPopupPolicy() ? 'webkit_popup_policy' : 'no_activation');
  };

  // No ad for this click: the parent offers the paid application or hands
  // off to the employer. A new tab it opens keeps this offer on screen until
  // the tab takes the foreground; a blocked one brings the "open" card, so
  // the visitor never loses the employer silently. Reported once: the parent
  // may keep the offer mounted while later callbacks still arrive.
  const unavailableReportedRef = useRef(false);
  const reportUnavailable = (reason: string) => {
    if (unavailableReportedRef.current) return;
    unavailableReportedRef.current = true;
    const opened = paidOfferShownRef.current
      ? onUnavailable(reason, { paidOfferShown: true })
      : onUnavailable(reason);
    if (!(opened instanceof Promise)) return;
    handoffDoneRef.current = true;
    handoffPhaseRef.current = 'direct_done';
    setHandoffKind('direct');
    setPhase('direct_done');
    void opened.then((ok) => {
      if (ok || !mountedRef.current) return;
      trackAssistedApplicationEvent('rewarded_application_direct_unconfirmed', {
        ...eventContext(),
        handoff_mode: 'direct_external',
        reason,
      });
      handoffDoneRef.current = false;
      showHandoff('tab_not_opened');
    });
  };

  // Only Google's rewardedSlotGranted reaches this handler (directly, or via
  // the granted bit of the close event that follows it).
  const handleGranted = (info?: GptRewardedAdCallbackInfo) => {
    if (grantedRef.current || gptSettledRef.current || fallbackDiscarded()) return;
    grantedRef.current = true;
    const accessExpiresAt = grantRewardedApplicationAccess();
    grantIdRef.current = recordHandoffGrant({ jobId, companyId, path: 'gpt' });
    scheduleHandoffReceiptFlush();
    trackAssistedApplicationEvent('rewarded_ad_granted', eventContext(info));
    if (fallbackActive()) {
      trackAssistedApplicationEvent('rewarded_offerwall_gpt_fallback_granted', eventContext(info));
    }
    trackAssistedApplicationEvent('rewarded_application_access_granted', {
      ...eventContext(info),
      access_expires_at: accessExpiresAt,
      access_ttl_hours: REWARDED_APPLICATION_ACCESS_TTL_HOURS,
    });
    continueAfterReward('gpt_done');
  };

  // `completed` means Funding Choices granted the Offerwall's reward
  // (entitlement cookie, usually while its thank-you screen is still up):
  // grant the access like a GPT grant and go on to the application, in a new
  // tab (continueAfterReward).
  const handleOfferwallCompleted = (result: Extract<OfferwallReleaseResult, { outcome: 'completed' }>) => {
    if (grantedRef.current) return;
    grantedRef.current = true;
    // Before the hand-off opens the employer's tab and hides this page.
    flushOfferwallAdsSnapshot();
    const accessExpiresAt = grantRewardedApplicationAccess();
    grantIdRef.current = recordHandoffGrant({ jobId, companyId, path: 'offerwall' });
    scheduleHandoffReceiptFlush();
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
    continueAfterReward('offerwall_done');
  };

  // The pre-release `not_shown` is reported once per offer, however the
  // decision ends (a consent granted later does not report it again).
  const reportNotReleased = (decision: GateDecision) => {
    if (notShownTrackedRef.current) return;
    notShownTrackedRef.current = true;
    trackAssistedApplicationEvent('rewarded_offerwall_not_shown', {
      ...offerwallContext(),
      reason: notShownReason(decision),
    });
  };

  // Act on a decision whose phase is already set.
  const applyDecision = (decision: GateDecision) => {
    decisionRef.current = decision;
    if (decision.plan === 'offerwall') return;
    if (decision.plan === 'reload' && decision.status !== 'held') {
      const reason = NOT_HELD_REASON[decision.status];
      if (onReload && markOfferwallResume(jobId, {
        reason,
        gate_status: decision.status,
        consent_state: decision.consent,
      })) {
        // Best effort: an event sent this close to the reload usually does
        // not reach GA4. The resumed click reports the same context
        // (`rewarded_application_offer_resumed`).
        trackAssistedApplicationEvent('rewarded_offerwall_reload', {
          ...offerwallContext(),
          reason,
        });
        onReload();
        return;
      }
      // No session storage for the resume marker: a reload would lose the click.
      reportNotReleased(decision);
      setPhase('gpt');
      return;
    }
    reportNotReleased(decision);
  };

  useEffect(() => {
    // An access already granted needs no gate decision and no ad.
    if (startInHandoff) return undefined;
    if (initialDecision) {
      applyDecision(initialDecision);
      return undefined;
    }
    const watch = typeof AbortController !== 'undefined' ? new AbortController() : null;
    void waitForOfferwallGate(
      offerwallGateWaitMs(resumed),
      watch ? { signal: watch.signal } : {},
    ).then((status) => {
      if (!mountedRef.current || watch?.signal.aborted) return;
      const decision = decideFor(status);
      setPhase(phaseFor(decision));
      applyDecision(decision);
    });
    return () => watch?.abort();
    // Decided once per offer, when the click opens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The consent choice stays optional: without an answer the application
  // opens without the video. `reason`: the message never came on screen, or
  // closed without an answer.
  const declineConsent = (reason: 'message_not_shown' | 'message_closed') => {
    if (!mountedRef.current || phaseRef.current !== 'consent' || unavailableReportedRef.current) return;
    trackAssistedApplicationEvent('rewarded_offerwall_consent_declined', { ...offerwallContext(), reason });
    reportUnavailable('ad_consent_missing');
  };

  // Google's consent message opens at once, with no card of ours before it
  // (owner decision 2026-10-03): 65% of the visitors who got the card went
  // on without the video. Any answer, a refusal included, lets Google serve
  // the Offerwall (Limited Ads after a refusal): the call held since the load
  // renders it (2.2 s live after a grant); without a held call the click
  // takes the reload.
  useEffect(() => {
    if (phase !== 'consent') return undefined;
    trackAssistedApplicationEvent('rewarded_offerwall_consent_reopened', offerwallContext());
    reopenAdsConsentMessage();
    const openedAt = Date.now();
    let seen = false;
    let closedAt: number | null = null;
    const timer = window.setInterval(() => {
      if (!mountedRef.current || phaseRef.current !== 'consent') return;
      if (isAdsConsentMessageOnScreen()) {
        seen = true;
        closedAt = null;
        return;
      }
      const nowMs = Date.now();
      if (!seen) {
        if (nowMs - openedAt < CONSENT_MESSAGE_APPEAR_MS) return;
        window.clearInterval(timer);
        declineConsent('message_not_shown');
        return;
      }
      if (closedAt === null) {
        closedAt = nowMs;
        return;
      }
      if (nowMs - closedAt < CONSENT_DECISION_GRACE_MS) return;
      window.clearInterval(timer);
      declineConsent('message_closed');
    }, 200);
    const unsubscribe = onAdsConsentChange((value) => {
      if (value === null || !mountedRef.current || phaseRef.current !== 'consent') return;
      const decision = decideFor(offerwallGateStatus());
      trackAssistedApplicationEvent('rewarded_offerwall_consent_decided', {
        ...offerwallContext(),
        gate_status: decision.status,
        consent_state: decision.consent,
      });
      setPhase(phaseFor(decision));
      applyDecision(decision);
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
    // Opened once per consent phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if ((phase !== 'offerwall' && phase !== 'choice') || offerwallStartedRef.current) return;
    offerwallStartedRef.current = true;
    trackAssistedApplicationEvent('rewarded_offerwall_released', offerwallContext());
    const watch = typeof AbortController !== 'undefined' ? new AbortController() : null;
    offerwallWatchRef.current = watch;
    void releaseHeldOfferwall({
      ...(watch ? { signal: watch.signal } : {}),
      // Behind the paid choice the Offerwall renders hidden; the free path
      // reveals it (chooseFree). Nothing times out before that.
      staged: phase === 'choice',
      onStaged: ({ elapsedMs, root }) => {
        if (!mountedRef.current) return;
        stagedReadyRef.current = true;
        trackAssistedApplicationEvent('rewarded_offerwall_staged', {
          ...offerwallContext(),
          shown_ms: elapsedMs,
          fc_root: root,
        });
      },
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
        // Once the visitor opted in to the GPT video, GPT is authoritative:
        // a late Offerwall report (a callback already queued, or a browser
        // without AbortController) must not take this flow over.
        if (gptVideoStartedRef.current) return;
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
        // The page's ads once Google's Offerwall is on screen, against the
        // click's baseline (rewarded_offer_ads_open).
        if (!offerwallAdsSentRef.current && !offerwallAdsTimerRef.current) {
          offerwallAdsTimerRef.current = setTimeout(sendOfferwallAdsSnapshot, OFFERWALL_ADS_SNAPSHOT_DELAY_MS);
        }
      },
      onClosed: () => {
        if (!mountedRef.current || gptVideoStartedRef.current) return;
        flushOfferwallAdsSnapshot();
        setPhase('offerwall_verifying');
      },
      onStalled: ({ shownMs, root }) => {
        // Telemetry only: the observer keeps following the Offerwall, and
        // time on screen never counts as a reward. After the GPT opt-in a
        // late Offerwall is not this offer's flow: no stall to report.
        if (gptVideoStartedRef.current) return;
        trackAssistedApplicationEvent('rewarded_offerwall_timed_out', {
          ...offerwallContext(),
          shown_ms: shownMs,
          fc_root: root,
        });
      },
    }).then((result) => {
      if (!mountedRef.current) return;
      // After the GPT opt-in the GPT flow is the only one: no Offerwall
      // outcome (a late one, when the watch could not be aborted) acts on it.
      if (gptVideoStartedRef.current) return;
      if (result.outcome === 'completed') {
        handleOfferwallCompleted(result);
        return;
      }
      // The watch was ended by this offer (its GPT fallback video started,
      // or the fallback handed off): nothing more on the Offerwall side.
      if (result.outcome === 'not_shown' && result.reason === 'aborted') return;
      // The staged release did not happen (the gate was no longer held): the
      // paid choice stays up, and the free path goes on without the Offerwall.
      if (phaseRef.current === 'choice' && result.outcome === 'not_shown') {
        stageFailedRef.current = true;
        trackAssistedApplicationEvent('rewarded_offerwall_not_shown', {
          ...offerwallContext(),
          reason: result.reason,
        });
        return;
      }
      if (result.outcome === 'closed_without_reward') {
        // Closed with no entitlement from Google: nothing to unlock, and no
        // second ad after this one. The parent offers the paid application
        // (or, with that fallback off, hands off to the employer).
        trackAssistedApplicationEvent('rewarded_offerwall_closed_without_reward', {
          ...offerwallContext(),
          shown_ms: result.shownMs,
          closed_ms: result.closedMs,
          fc_root: result.root,
        });
        reportUnavailable('offerwall_closed_without_reward');
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
        // (ineligible, or its slot already failed): the parent offers the
        // paid application, or hands off to the employer.
        reportUnavailable('offerwall_not_shown');
        return;
      }
      // Nothing was released for this click: the GPT request runs as before.
      setPhase('gpt');
    });
    // Runs once per offer; the context is read at release time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase === 'choice') paidOfferShownRef.current = true;
  }, [phase]);

  // The free path of the paid choice: the staged Offerwall comes on screen
  // (at once when it is complete, otherwise as soon as Google renders it).
  const chooseFree = () => {
    if (!mountedRef.current || phaseRef.current !== 'choice') return;
    trackAssistedApplicationEvent('assisted_application_choose_external', {
      ...offerwallContext(),
      reason: stageFailedRef.current
        ? 'offerwall_unavailable'
        : stagedReadyRef.current ? 'offerwall_ready' : 'offerwall_pending',
    });
    if (stageFailedRef.current) {
      setPhase('gpt');
      return;
    }
    setPhase('offerwall');
    revealStagedOfferwall();
  };

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
    // auction: report the reason and let the parent offer the paid
    // application or hand off to the employer.
    reportUnavailable(reason);
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
  const handoffTitle = handoffKind === 'direct'
    ? titled('jobBoard.rewardedOffer.handoffDirectTitleJob', 'jobBoard.rewardedOffer.handoffDirectTitle')
    : titled('jobBoard.rewardedOffer.handoffTitleJob', 'jobBoard.rewardedOffer.handoffTitle');
  const handoffText = t(handoffKind === 'direct' ? 'jobBoard.rewardedOffer.handoffDirectText' : 'jobBoard.rewardedOffer.handoffText');
  const loadingText = phase === 'offerwall_done' || phase === 'gpt_done' || phase === 'direct_done' ? redirectLabel : loadingLabel;
  // Under Google's consent message too: its own dialog covers the page.
  const showLoading = phase !== 'gpt_ready' && phase !== 'gpt_retry' && phase !== 'handoff';

  const cardClass = 'w-full max-w-sm space-y-4 rounded-stripe border border-edge bg-surface p-5 shadow-stripe-lg focus:outline-none';
  const primaryButtonClass = 'inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2';
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
            className={primaryButtonClass}
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

      {phase === 'handoff' && (
        <div
          ref={cardRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rewarded-application-handoff-title"
          aria-describedby="rewarded-application-handoff-text"
          className={cardClass}
          data-testid="rewarded-application-handoff"
        >
          <div>
            <p className="text-xs font-semibold text-accent">{companyName}</p>
            <h2 id="rewarded-application-handoff-title" className="mt-1 text-base font-semibold font-display text-heading">
              {handoffTitle}
            </h2>
            <p id="rewarded-application-handoff-text" className="mt-1 text-sm leading-relaxed text-body">
              {handoffText}
            </p>
          </div>
          <button
            type="button"
            onClick={() => openApplication('click')}
            className={primaryButtonClass}
            data-testid="rewarded-application-handoff-open"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {t('jobBoard.rewardedOffer.handoffOpen')}
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

  // The paid choice is the whole screen; this offer keeps the body scroll
  // lock and Escape (DISMISSIBLE_PHASES) while it is up.
  const choice = lastPaidChoiceRef.current;
  if (phase === 'choice' && choice) {
    return (
      <AssistedApplicationOffer
        embedded
        jobId={jobId}
        companyId={companyId}
        companyName={companyName}
        jobTitle={jobTitle}
        variant="rewarded_ad"
        trigger={CHOICE_TRIGGER}
        externalLabel={t('jobBoard.assisted.externalCtaVideo')}
        onChooseExternal={chooseFree}
        onChoosePaid={choice.onChoosePaid}
        onClose={() => onDismiss?.()}
        paidLoading={choice.paidLoading}
        error={choice.error}
      />
    );
  }

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
