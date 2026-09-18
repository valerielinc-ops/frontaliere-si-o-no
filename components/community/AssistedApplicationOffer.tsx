import { useEffect } from 'react';
import { ArrowUpRight, Check, Loader2, Shield, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import {
  ASSISTED_APPLICATION_PRICE_EUR_CENTS,
  trackAssistedApplicationEvent,
  type AssistedApplicationVariant,
} from '@/services/assistedApplicationExperiment';

export interface AssistedApplicationOfferProps {
  jobId: string;
  companyId: string;
  companyName: string;
  jobTitle: string;
  variant: AssistedApplicationVariant;
  onChooseExternal: () => void;
  onChoosePaid: () => void | Promise<void>;
  onClose: () => void;
  paidLoading?: boolean;
  error?: string | null;
}

/** Transparent choice surface for the assisted-application treatment arm. */
export default function AssistedApplicationOffer({
  jobId,
  companyId,
  companyName,
  jobTitle,
  variant,
  onChooseExternal,
  onChoosePaid,
  onClose,
  paidLoading = false,
  error = null,
}: AssistedApplicationOfferProps) {
  const { t } = useTranslation();

  useEffect(() => {
    trackAssistedApplicationEvent('assisted_application_offer_viewed', {
      variant,
      jobId,
      companyId,
      price_eur_cents: ASSISTED_APPLICATION_PRICE_EUR_CENTS,
    });
  }, [companyId, jobId, variant]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/45 px-4 py-4 backdrop-blur-sm sm:items-center sm:py-6"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      data-testid="assisted-application-offer"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-application-offer-title"
        aria-describedby="assisted-application-offer-description"
        className="relative max-h-[min(90vh,42rem)] w-full max-w-md overflow-y-auto rounded-stripe border border-edge bg-surface p-5 shadow-stripe-lg sm:p-6"
      >
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-accent">{companyName}</p>
              <h2 id="assisted-application-offer-title" className="mt-1 text-xl font-semibold font-display text-heading">
                {t('jobBoard.assisted.title')}
              </h2>
              <p className="mt-2 text-sm text-subtle line-clamp-3">{jobTitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              autoFocus
              className="shrink-0 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-stripe text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              aria-label={t('common.close')}
              data-testid="assisted-application-offer-close"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <p id="assisted-application-offer-description" className="text-sm leading-relaxed text-body">
            {t('jobBoard.assisted.body')}
          </p>

          <ul className="space-y-2.5 text-sm text-body" aria-label={t('jobBoard.assisted.stepsLabel')}>
            {(['step1', 'step2', 'step3'] as const).map((step) => (
              <li key={step} className="flex items-start gap-2.5">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <span>{t(`jobBoard.assisted.${step}`)}</span>
              </li>
            ))}
          </ul>

          <div className="rounded-stripe border border-info-border bg-info-subtle/60 p-3">
            <div className="flex items-start gap-2.5">
              <Shield className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-body">{t('jobBoard.assisted.transparency')}</p>
            </div>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => { void onChoosePaid(); }}
              disabled={paidLoading}
              aria-busy={paidLoading}
              className="inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="assisted-application-offer-paid"
            >
              {paidLoading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {paidLoading ? t('jobBoard.assisted.paidLoading') : t('jobBoard.assisted.paidCta')}
            </button>
            <p className="text-center text-xs font-medium text-subtle">{t('jobBoard.assisted.priceNote')}</p>
            <button
              type="button"
              onClick={onChooseExternal}
              disabled={paidLoading}
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-stripe px-4 py-2 text-sm font-semibold text-link underline decoration-link/40 underline-offset-4 transition-colors hover:bg-surface-raised hover:decoration-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="assisted-application-offer-external"
            >
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              {t('jobBoard.assisted.externalCta')}
            </button>
          </div>

          <p className="text-xs leading-relaxed text-muted">{t('jobBoard.assisted.disclaimer')}</p>
          {error && <p role="alert" aria-live="assertive" className="text-sm leading-relaxed text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}
