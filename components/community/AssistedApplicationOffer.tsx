import { useEffect } from 'react';
import { ArrowUpRight, Loader2, Shield, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import {
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
    });
  }, [companyId, jobId, variant]);

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 backdrop-blur-sm px-4"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      data-testid="assisted-application-offer"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-application-offer-title"
        className="relative w-full max-w-lg rounded-2xl border border-edge bg-surface p-5 sm:p-6 shadow-xl space-y-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">{companyName}</p>
            <h2 id="assisted-application-offer-title" className="mt-1 text-xl font-bold font-display text-heading">
              {t('jobBoard.assisted.title')}
            </h2>
            <p className="mt-1 text-sm text-subtle line-clamp-2">{jobTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg text-muted hover:text-heading hover:bg-surface-raised"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.body')}</p>

        <div className="rounded-xl border border-info-border bg-info-subtle/60 p-3 text-xs leading-relaxed text-body">
          <div className="flex items-start gap-2">
            <Shield className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
            <p>{t('jobBoard.assisted.transparency')}</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={onChooseExternal}
            disabled={paidLoading}
            className="min-h-[48px] inline-flex items-center justify-center gap-2 rounded-lg border border-edge bg-surface px-4 py-3 text-sm font-semibold text-body hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            {t('jobBoard.assisted.externalCta')}
          </button>
          <button
            type="button"
            onClick={() => { void onChoosePaid(); }}
            disabled={paidLoading}
            className="min-h-[48px] inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {paidLoading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t('jobBoard.assisted.paidCta')}
          </button>
        </div>

        <p className="text-[11px] leading-relaxed text-muted">{t('jobBoard.assisted.disclaimer')}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}
