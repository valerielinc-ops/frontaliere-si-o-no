import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import GptRewardedAd, { type GptRewardedAdCallbackInfo } from '@/components/shared/GptRewardedAd';
import { useApplicationOfferBackdropDismiss } from '@/components/community/useApplicationOfferBackdropDismiss';
import {
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  REWARDED_WEB_AD_FORMAT,
} from '@/services/rewardedWebAd';
import {
  grantRewardedApplicationAccess,
} from '@/services/rewardedApplicationAccess';
import {
  offerwallGateStatus,
  releaseHeldOfferwall,
  type OfferwallGateStatus,
  type OfferwallReleaseResult,
} from '@/services/offerwallClickGate';
import {
  trackAssistedApplicationEvent,
} from '@/services/assistedApplicationExperiment';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import { usePopupSlot } from '@/hooks/usePopupSlot';

const SURFACE = 'job_detail_rewarded_inline';
const TRIGGER = 'candidate_click';
const POPUP_SLOT_ID = 'rewarded-application-offer';
const OFFERWALL_PROVIDER = 'adsense_offerwall';
const OFFERWALL_FORMAT = 'offerwall';

/**
 * `offerwall`: the held AdSense Offerwall has been released and may render.
 * `offerwall_visible`: it is on screen, so this dialog steps out of its way.
 * `offerwall_verifying`: it closed; waiting for Google's entitlement.
 * `offerwall_done`: reward granted, the visitor is on the way to the employer.
 * `gpt`: no Offerwall was released for this click; the GPT request runs.
 */
type OfferPhase = 'offerwall' | 'offerwall_visible' | 'offerwall_verifying' | 'offerwall_done' | 'gpt';

/** Why no Offerwall was waiting for this click (tracked before the GPT path). */
const NOT_HELD_REASON: Record<Exclude<OfferwallGateStatus, 'held'>, string> = {
  suppressed: 'no_consent_decision',
  released: 'already_released',
  absent: 'not_held',
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
 * Same-page rewarded application step.
 *
 * The job detail remains the canonical page. This dialog only appears after
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
  const [rewarded, setRewarded] = useState(false);
  const [retryRequired, setRetryRequired] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // The AdSense Offerwall is the site's only rewarded demand: when Funding
  // Choices holds one for this page view, the click releases it first.
  const [initialGateStatus] = useState(() => offerwallGateStatus());
  const [phase, setPhase] = useState<OfferPhase>(() => (initialGateStatus === 'held' ? 'offerwall' : 'gpt'));
  const grantedRef = useRef(false);
  const openedAtRef = useRef(now());
  const mountedRef = useRef(true);
  const offerwallStartedRef = useRef(false);
  const handleBackdropClick = useApplicationOfferBackdropDismiss(onDismiss);

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
    };
  }, []);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onDismiss]);

  // Only Google's rewardedSlotGranted reaches this handler (directly, or via
  // the granted bit of the close event that follows it).
  const handleGranted = (info?: GptRewardedAdCallbackInfo) => {
    if (grantedRef.current) return;
    grantedRef.current = true;
    const accessExpiresAt = grantRewardedApplicationAccess();
    setRewarded(true);
    trackAssistedApplicationEvent('rewarded_ad_granted', eventContext(info));
    trackAssistedApplicationEvent('rewarded_application_access_granted', {
      ...eventContext(info),
      access_expires_at: accessExpiresAt,
      access_ttl_hours: 12,
    });
  };

  // `completed` means Funding Choices closed the Offerwall and granted its
  // reward (entitlement cookie): grant the access like a GPT grant and go on
  // to the application at once. The rewarded choice inside Google's dialog
  // was the visitor's action; no further click is asked here.
  const handleOfferwallCompleted = (result: Extract<OfferwallReleaseResult, { outcome: 'completed' }>) => {
    if (grantedRef.current) return;
    grantedRef.current = true;
    const accessExpiresAt = grantRewardedApplicationAccess();
    setPhase('offerwall_done');
    trackAssistedApplicationEvent('rewarded_offerwall_completed', {
      ...offerwallContext(),
      shown_ms: result.shownMs,
      closed_ms: result.closedMs,
      completed_ms: result.completedMs,
      fc_root: result.root,
    });
    trackAssistedApplicationEvent('rewarded_application_access_granted', {
      ...offerwallContext(),
      access_expires_at: accessExpiresAt,
      access_ttl_hours: 12,
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
    void releaseHeldOfferwall({
      onShown: ({ shownMs, root }) => {
        if (!mountedRef.current) return;
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
      trackAssistedApplicationEvent('rewarded_offerwall_not_shown', {
        ...offerwallContext(),
        reason: result.reason,
      });
      if (result.reason === 'appear_timeout') {
        // Released but not rendered in time (Google's frequency, experiment
        // group, or access already granted). The release cannot be taken back,
        // so no GPT request may follow it: a late Offerwall would overlap a
        // second ad. Direct employer hand-off, which leaves this page.
        onUnavailable('offerwall_not_shown');
        return;
      }
      // Nothing was released for this click: the GPT request runs as before.
      setPhase('gpt');
    });
    // Runs once per offer; the context is read at release time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleVideoCompleted = () => {
    // Google documents rewardedSlotGranted as the authoritative web reward.
    // Video completion is optional telemetry and must never unlock the CTA.
  };

  const handleClosed = (grantedByEvent: boolean, info?: GptRewardedAdCallbackInfo) => {
    // `grantedByEvent` is true only when rewardedSlotGranted already fired for
    // this request; it just guards against the close being delivered first.
    if (grantedByEvent && !grantedRef.current) {
      handleGranted(info);
    }
    if (grantedByEvent || grantedRef.current) {
      return;
    }
    // No reward: the application stays locked. The visitor may choose to
    // watch again, but nothing retries on their behalf.
    setRetryRequired(true);
    trackAssistedApplicationEvent('rewarded_ad_unavailable', {
      ...eventContext(info),
      reason: 'video_closed_before_reward',
      handoff: 'none',
    });
  };

  const handleUnavailable = (reason = 'unavailable', info?: GptRewardedAdCallbackInfo) => {
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

  const retry = () => {
    grantedRef.current = false;
    setRewarded(false);
    setRetryRequired(false);
    setRetryToken((token) => token + 1);
  };

  const modal = (
    <div
      className="fixed inset-0 z-[1000] isolate flex min-h-[100dvh] items-end justify-center overflow-y-auto bg-black/55 px-3 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
      onClick={handleBackdropClick}
      data-testid="rewarded-application-offer"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewarded-application-offer-title"
        aria-describedby="rewarded-application-offer-description"
        className="relative my-auto max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-stripe border border-edge bg-surface p-4 shadow-stripe-lg sm:max-h-[min(90dvh,42rem)] sm:p-6"
      >
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-accent">{companyName}</p>
              <h2 id="rewarded-application-offer-title" className="mt-1 text-xl font-semibold font-display text-heading">
                Prepariamo la candidatura
              </h2>
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-subtle">{jobTitle}</p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              autoFocus
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-stripe text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              aria-label="Chiudi"
              data-testid="rewarded-application-offer-close"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <p id="rewarded-application-offer-description" className="text-sm leading-relaxed text-body">
            Per candidarti guardi un breve video pubblicitario Google: parte da solo appena è pronto. Al termine del video sblocchiamo il pulsante per aprire la candidatura sul sito dell’azienda.
          </p>

          <div className="rounded-stripe border border-info-border bg-info-subtle/60 p-3">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-body">
                Questo percorso è monetizzato solo da Google. Se in questo momento Google non ha un video da mostrare, ti portiamo subito al sito dell’azienda: nessun video sostitutivo e nessun secondo click.
              </p>
            </div>
          </div>

          <ol className="space-y-2.5 text-sm text-body" aria-label="Passaggi per continuare">
            <li className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span>Prepariamo il collegamento a {companyName}.</span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span>Il video Google parte da solo quando l’asta restituisce una creatività.</span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span>Al termine apriamo il sito dell’azienda.</span>
            </li>
          </ol>

          {rewarded && (
            <div className="space-y-3">
              <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-semibold text-success">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Pulsante candidatura sbloccato.
              </p>
              <button
                type="button"
                onClick={onContinue}
                className="inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-stripe bg-success-strong px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-success-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2"
              >
                Apri la candidatura sul sito dell’azienda
              </button>
            </div>
          )}

          {phase === 'offerwall' && (
            <p
              role="status"
              aria-live="polite"
              className="text-sm font-semibold text-body"
              data-testid="rewarded-application-offerwall-pending"
            >
              Stiamo preparando il video…
            </p>
          )}

          {phase === 'offerwall_verifying' && (
            <p
              role="status"
              aria-live="polite"
              className="text-sm font-semibold text-body"
              data-testid="rewarded-application-offerwall-verifying"
            >
              Verifichiamo lo sblocco con Google…
            </p>
          )}

          {phase === 'offerwall_done' && (
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-sm font-semibold text-success"
              data-testid="rewarded-application-offerwall-done"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Candidatura sbloccata: ti portiamo al sito dell’azienda…
            </p>
          )}

          {phase === 'gpt' && !retryRequired && !rewarded && (
            <GptRewardedAd
              label="Guarda il video e continua"
              loadingLabel="Stiamo preparando il video…"
              showingLabel="Video in riproduzione…"
              unavailableLabel="Il video non è disponibile in questo momento."
              showUnavailableMessage={false}
              autoStart
              retryToken={retryToken}
              onOptIn={(info) => trackAssistedApplicationEvent('rewarded_ad_opt_in', eventContext(info))}
              onGranted={handleGranted}
              onVideoCompleted={handleVideoCompleted}
              onClosed={handleClosed}
              onUnavailable={handleUnavailable}
            />
          )}

          {retryRequired && (
            <div className="space-y-3" role="alert">
              <p className="text-sm leading-relaxed text-body">
                Hai chiuso il video prima del reward. Per sbloccare il pulsante candidatura, puoi riprovare.
              </p>
              <button
                type="button"
                onClick={retry}
                className="inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Riprova con il video
              </button>
            </div>
          )}

          <p className="text-xs leading-relaxed text-muted">
            Il diritto di accesso al pulsante candidatura resta valido 12 ore su questo dispositivo.
          </p>
        </div>
      </div>
    </div>
  );

  // The Google Offerwall is its own full-page dialog: while it is on screen
  // this one must not sit on top of it or take its clicks.
  if (phase === 'offerwall_visible') return null;

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
