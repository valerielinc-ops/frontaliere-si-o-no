import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Check, Shield } from 'lucide-react';
import GptRewardedAd from '@/components/shared/GptRewardedAd';
import { useKillSwitches } from '@/hooks/useKillSwitches';
import { trackAssistedApplicationEvent } from '@/services/assistedApplicationExperiment';
import { grantRewardedApplicationAccess } from '@/services/rewardedApplicationAccess';
import {
  clearRewardedApplicationHandoff,
  readRewardedApplicationHandoff,
  type RewardedApplicationHandoff,
} from '@/services/rewardedApplicationHandoff';

function readHandoffToken(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('handoff');
}

export default function RewardedApplicationPage() {
  const killSwitches = useKillSwitches();
  const handoff = useMemo<RewardedApplicationHandoff | null>(
    () => readRewardedApplicationHandoff(readHandoffToken()),
    [],
  );
  const [granted, setGranted] = useState(false);
  const [fallbackVisible, setFallbackVisible] = useState(false);
  const [closedWithoutReward, setClosedWithoutReward] = useState(false);
  const [adAttempt, setAdAttempt] = useState(0);

  useEffect(() => {
    document.title = handoff?.companyName
      ? `Candidatura — ${handoff.companyName} | Frontaliere Ticino`
      : 'Candidatura — Frontaliere Ticino';
    const robots = document.querySelector('meta[name="robots"]') || document.createElement('meta');
    robots.setAttribute('name', 'robots');
    robots.setAttribute('content', 'noindex,nofollow');
    if (!robots.parentElement) document.head.appendChild(robots);
  }, [handoff]);

  const handleGranted = () => {
    if (!handoff || granted) return;
    const expiresAt = grantRewardedApplicationAccess();
    setGranted(true);
    setClosedWithoutReward(false);
    trackAssistedApplicationEvent('rewarded_application_access_granted', {
      variant: 'rewarded_ad',
      jobId: handoff.jobId,
      companyId: handoff.companyId,
      access_expires_at: expiresAt,
      access_ttl_hours: 12,
      surface: 'rewarded_application_external_page',
    });
  };

  const handleClosed = (rewarded: boolean) => {
    if (!handoff) return;
    if (!rewarded) {
      // Closing the ad is not a dismiss path: the user must retry the video.
      // A direct link is exposed only when GPT reports that no ad is available.
      setClosedWithoutReward(true);
      return;
    }
    clearRewardedApplicationHandoff(handoff.token);
    trackAssistedApplicationEvent('external_apply_redirected', {
      variant: 'rewarded_ad',
      jobId: handoff.jobId,
      companyId: handoff.companyId,
      surface: 'rewarded_application_external_page',
    });
    window.location.assign(handoff.destination);
  };

  if (!handoff) {
    return (
      <main className="min-h-screen bg-surface-alt px-4 py-12 text-body">
        <section className="mx-auto max-w-md rounded-stripe border border-edge bg-surface p-6 shadow-stripe-lg">
          <h1 className="text-xl font-semibold font-display text-heading">Sessione scaduta</h1>
          <p className="mt-3 text-sm leading-relaxed text-subtle">Non troviamo più questa candidatura. Torna agli annunci e riprova.</p>
          <a href="/cerca-lavoro-ticino/" className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-stripe bg-accent px-4 py-2 text-sm font-semibold text-on-accent">
            Torna agli annunci <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </section>
      </main>
    );
  }

  const directHref = handoff.destination;

  return (
    <main className="min-h-screen bg-surface-alt px-4 py-8 text-body sm:py-12">
      <section className="mx-auto max-w-md rounded-stripe border border-edge bg-surface p-6 shadow-stripe-lg sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Candidatura</p>
        <h1 className="mt-2 text-2xl font-semibold font-display text-heading">Guarda un breve video per continuare</h1>
        <p className="mt-3 text-sm leading-relaxed text-subtle">
          {handoff.companyName || 'Offerta di lavoro'}{handoff.jobTitle ? ` · ${handoff.jobTitle}` : ''}
        </p>

        <div className="mt-6 rounded-stripe border border-info-border bg-info-subtle/60 p-3">
          <div className="flex items-start gap-2.5">
            <Shield className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-body">Guarda il video per sbloccare il redirect diretto al sito dell’azienda.</p>
          </div>
        </div>

        <div className="mt-5">
          <Fragment key={adAttempt}>
            <GptRewardedAd
              enabled={!killSwitches.rewardedApplicationAd}
              label="Guarda il video e continua"
              loadingLabel="Preparo il video…"
              unavailableLabel="Il video non è disponibile in questo momento."
              onReady={() => {
                setFallbackVisible(false);
                setClosedWithoutReward(false);
              }}
              onOptIn={() => trackAssistedApplicationEvent('rewarded_ad_opt_in', {
                variant: 'rewarded_ad', jobId: handoff.jobId, companyId: handoff.companyId, surface: 'rewarded_application_external_page',
              })}
              onGranted={handleGranted}
              onClosed={(rewarded) => {
                handleClosed(rewarded);
              }}
              onUnavailable={() => {
                setFallbackVisible(true);
                setClosedWithoutReward(false);
                trackAssistedApplicationEvent('rewarded_ad_unavailable', {
                  variant: 'rewarded_ad', jobId: handoff.jobId, companyId: handoff.companyId, surface: 'rewarded_application_external_page',
                });
              }}
            />
          </Fragment>
        </div>

        {granted && (
          <p role="status" className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-success">
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Ricompensa ricevuta. Attendo la chiusura del video per aprire l’offerta…
          </p>
        )}

        {closedWithoutReward && (
          <div className="mt-3 space-y-3" role="status">
            <p className="text-xs leading-relaxed text-muted">Il video è stato chiuso prima del completamento. Guarda il video per continuare.</p>
            <button
              type="button"
              onClick={() => {
                setClosedWithoutReward(false);
                setAdAttempt((attempt) => attempt + 1);
              }}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-stripe border border-edge px-4 py-2 text-sm font-semibold text-link hover:bg-surface-raised"
            >
              Riprova il video
            </button>
          </div>
        )}

        {fallbackVisible && !closedWithoutReward && (
          <a
            href={directHref}
            onClick={() => clearRewardedApplicationHandoff(handoff.token)}
            className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-stripe px-4 py-2 text-sm font-semibold text-link underline decoration-link/40 underline-offset-4 hover:bg-surface-raised"
          >
            Candidati direttamente, gratis <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
        <p className="mt-4 text-xs leading-relaxed text-muted">Il diritto di accesso Rewarded resta valido 12 ore su questo dispositivo.</p>
      </section>
    </main>
  );
}
