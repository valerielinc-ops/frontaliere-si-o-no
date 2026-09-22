import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import GptRewardedAd from '@/components/shared/GptRewardedAd';
import RewardedHouseVideo from '@/components/shared/RewardedHouseVideo';
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
}: RewardedApplicationOfferProps) {
  const [rewarded, setRewarded] = useState(false);
  const [retryRequired, setRetryRequired] = useState(false);
  const [houseFallback, setHouseFallback] = useState(false);
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

  const completeIfReady = () => {
    if (!grantedRef.current || !videoCompletedRef.current || completedRef.current) return;
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

  const handleUnavailable = () => {
    trackAssistedApplicationEvent('rewarded_ad_unavailable', {
      variant: 'rewarded_ad',
      jobId,
      companyId,
      surface: SURFACE,
      reason: 'no_fill_or_gpt_unavailable',
    });
    setHouseFallback(true);
  };

  const handleHouseCompleted = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    const accessExpiresAt = grantRewardedApplicationAccess();
    setRewarded(true);
    trackAssistedApplicationEvent('rewarded_house_video_completed', {
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
      provider: 'house_video',
      access_expires_at: accessExpiresAt,
      access_ttl_hours: 12,
    });
    onCompleted();
  };

  const handleHouseStarted = () => {
    trackAssistedApplicationEvent('rewarded_house_video_started', {
      variant: 'rewarded_ad',
      jobId,
      companyId,
      surface: SURFACE,
    });
  };

  const retry = () => {
    grantedRef.current = false;
    videoCompletedRef.current = false;
    completedRef.current = false;
    setRewarded(false);
    setRetryRequired(false);
    setHouseFallback(false);
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/45 px-4 py-4 backdrop-blur-sm sm:items-center sm:py-6"
      data-testid="rewarded-application-offer"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewarded-application-offer-title"
        aria-describedby="rewarded-application-offer-description"
        className="relative max-h-[min(90vh,42rem)] w-full max-w-md overflow-y-auto rounded-stripe border border-edge bg-surface p-5 shadow-stripe-lg sm:p-6"
      >
        <div className="space-y-5">
          <div className="min-w-0">
            <h2 id="rewarded-application-offer-title" className="text-xl font-semibold font-display text-heading">
              Prepariamo la candidatura
            </h2>
            <p className="mt-2 text-sm font-semibold text-accent">{companyName}</p>
            <p className="mt-1 text-sm leading-relaxed text-subtle">{jobTitle}</p>
          </div>

          <p id="rewarded-application-offer-description" className="text-sm leading-relaxed text-body">
            Stiamo preparando il collegamento diretto al sito dell’azienda. Attendi qualche secondo mentre verifichiamo la disponibilità del video breve.
          </p>

          <div className="rounded-stripe border border-info-border bg-info-subtle/60 p-3">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-body">
                Il video sostiene il servizio. Quando sarà terminato, apriremo direttamente la candidatura senza modificare questa pagina.
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
              <span>Mostriamo un breve video per sostenere il servizio.</span>
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

          {!retryRequired && !rewarded && houseFallback && (
            <RewardedHouseVideo
              onStarted={handleHouseStarted}
              onCompleted={handleHouseCompleted}
              onUnavailable={onUnavailable}
            />
          )}

          {!retryRequired && !rewarded && !houseFallback && (
            <GptRewardedAd
              label="Guarda il video e continua"
              loadingLabel="Stiamo preparando il video…"
              showingLabel="Video in riproduzione…"
              unavailableLabel="Il video non è disponibile in questo momento."
              showUnavailableMessage={false}
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
}
