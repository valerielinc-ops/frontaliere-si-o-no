import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import GptRewardedAd from '@/components/shared/GptRewardedAd';
import {
  grantRewardedApplicationAccess,
} from '@/services/rewardedApplicationAccess';
import {
  trackAssistedApplicationEvent,
} from '@/services/assistedApplicationExperiment';

const SURFACE = 'job_detail_rewarded_inline';

export interface RewardedApplicationOfferProps {
  jobId: string;
  companyId: string;
  companyName: string;
  jobTitle: string;
  onCompleted: () => void;
  onUnavailable: () => void;
  onDismiss?: () => void;
}

/**
 * Same-page rewarded application step.
 *
 * The job detail remains the canonical page. This dialog only appears after
 * an authenticated visitor asks to apply; it never owns a URL, SEO metadata,
 * JobPosting data, or a crawler-specific branch.
 */
export default function RewardedApplicationOffer({
  jobId,
  companyId,
  companyName,
  jobTitle,
  onCompleted,
  onUnavailable,
  onDismiss,
}: RewardedApplicationOfferProps) {
  const [rewarded, setRewarded] = useState(false);
  const [retryRequired, setRetryRequired] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const grantedRef = useRef(false);
  const videoCompletedRef = useRef(false);
  const completedRef = useRef(false);

  useEffect(() => {
    trackAssistedApplicationEvent('rewarded_application_offer_viewed', {
      variant: 'rewarded_ad',
      jobId,
      companyId,
      surface: SURFACE,
    });
  }, [companyId, jobId]);

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

  const completeIfReady = () => {
    // Google documents rewardedSlotGranted as the authoritative web reward
    // signal. A rewarded display can satisfy its view-time threshold without
    // emitting the optional video-completed event, so requiring both events
    // would strand a valid paid impression behind the modal.
    if (!grantedRef.current || completedRef.current) return;
    completedRef.current = true;
    onCompleted();
  };

  const handleGranted = () => {
    if (grantedRef.current) return;
    grantedRef.current = true;
    const accessExpiresAt = grantRewardedApplicationAccess();
    setRewarded(true);
    trackAssistedApplicationEvent('rewarded_ad_granted', {
      variant: 'rewarded_ad',
      jobId,
      companyId,
      surface: SURFACE,
    });
    trackAssistedApplicationEvent('rewarded_application_access_granted', {
      variant: 'rewarded_ad',
      jobId,
      companyId,
      surface: SURFACE,
      access_expires_at: accessExpiresAt,
      access_ttl_hours: 12,
    });
    completeIfReady();
  };

  const handleVideoCompleted = () => {
    videoCompletedRef.current = true;
    setRewarded(true);
    completeIfReady();
  };

  const handleClosed = (grantedByEvent: boolean) => {
    if (grantedByEvent && !grantedRef.current) {
      // Some GPT builds emit the granted bit on close without delivering the
      // separate rewardedSlotGranted event. Keep the entitlement and redirect
      // path deterministic in that case.
      handleGranted();
    }
    if (grantedByEvent || grantedRef.current) {
      // GPT's granted close event is emitted only after the rewarded
      // experience has satisfied its completion condition. Treat it as the
      // final lifecycle signal if a browser omits the separate video event.
      videoCompletedRef.current = true;
      completeIfReady();
      return;
    }
    setRetryRequired(true);
    trackAssistedApplicationEvent('rewarded_ad_unavailable', {
      variant: 'rewarded_ad',
      jobId,
      companyId,
      surface: SURFACE,
      reason: 'video_closed_before_reward',
    });
  };

  const handleUnavailable = (reason = 'unavailable') => {
    trackAssistedApplicationEvent('rewarded_ad_unavailable', {
      variant: 'rewarded_ad',
      jobId,
      companyId,
      surface: SURFACE,
      reason,
    });
    // The application path is monetized only by a delivered Google rewarded
    // ad. No-fill, consent, bot and unsupported-host failures all return to
    // the caller instead of showing a non-monetized substitute.
    onUnavailable();
  };

  const retry = () => {
    grantedRef.current = false;
    videoCompletedRef.current = false;
    completedRef.current = false;
    setRewarded(false);
    setRetryRequired(false);
    setRetryToken((token) => token + 1);
  };

  const modal = (
    <div
      className="fixed inset-0 z-[1000] isolate flex min-h-[100dvh] items-end justify-center overflow-y-auto bg-black/55 px-3 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
      onClick={(event) => { if (event.target === event.currentTarget) onDismiss?.(); }}
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
            Stiamo preparando il collegamento diretto al sito dell’azienda. Se c’è domanda Google, puoi scegliere di guardare la pubblicità; al termine apriamo la candidatura.
          </p>

          <div className="rounded-stripe border border-info-border bg-info-subtle/60 p-3">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-body">
                Questo percorso è monetizzato solo da Google. Il video parte esclusivamente dopo la tua scelta esplicita; se l’asta non restituisce una creatività, torniamo alla candidatura senza mostrare un sostituto non monetizzato.
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
              <span>Mostriamo un annuncio Google solo quando l’asta restituisce una creatività.</span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span>Al termine apriamo il sito dell’azienda.</span>
            </li>
          </ol>

          {rewarded && (
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-semibold text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Accesso sbloccato. Stiamo aprendo la candidatura…
            </p>
          )}

          {!retryRequired && !rewarded && (
            <GptRewardedAd
              label="Guarda il video e continua"
              loadingLabel="Stiamo preparando il video…"
              showingLabel="Video in riproduzione…"
              unavailableLabel="Il video non è disponibile in questo momento."
              showUnavailableMessage={false}
              retryToken={retryToken}
              onOptIn={() => trackAssistedApplicationEvent('rewarded_ad_opt_in', {
                variant: 'rewarded_ad',
                jobId,
                companyId,
                surface: SURFACE,
              })}
              onGranted={handleGranted}
              onVideoCompleted={handleVideoCompleted}
              onClosed={handleClosed}
              onUnavailable={handleUnavailable}
            />
          )}

          {retryRequired && (
            <div className="space-y-3" role="alert">
              <p className="text-sm leading-relaxed text-body">
                Il video non è stato completato. Per continuare verso il sito dell’azienda, riprova.
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
            Il diritto di accesso rewarded resta valido 12 ore su questo dispositivo.
          </p>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
