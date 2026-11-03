import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, FileText, Loader2, Shield, X } from 'lucide-react';
import { useLocale, useTranslation } from '@/services/i18n';
import { getApplicationConciergePath } from '@/services/router';
import { AssistedApplicationLegalLinks } from '@/components/community/AssistedApplicationLegalLinks';
import { useApplicationOfferAdClearance } from '@/components/community/useApplicationOfferAdClearance';
import { useApplicationOfferBackdropDismiss } from '@/components/community/useApplicationOfferBackdropDismiss';
import {
  ASSISTED_APPLICATION_PRICE_EUR_CENTS,
  trackAssistedApplicationEvent,
  type AssistedApplicationJobDetails,
  type AssistedApplicationCopyVariant,
  type AssistedApplicationLayoutVariant,
  type AssistedApplicationVariant,
} from '@/services/assistedApplicationExperiment';

export interface AssistedApplicationOfferProps {
  jobId: string;
  companyId: string;
  companyName: string;
  jobTitle: string;
  /** `rewarded_ad` when the offer is the fallback of an Offerwall that could not load. */
  variant: AssistedApplicationVariant;
  /** Fixed-copy attribution kept on the order while only the layout varies. */
  copyVariant?: AssistedApplicationCopyVariant;
  /** Layout arm; safe default preserves the current offer structure. */
  layoutVariant?: AssistedApplicationLayoutVariant;
  /** False until the public Remote Config allowlist assigns the layout test. */
  layoutExperimentActive?: boolean;
  /** Real, localized job facts from the selected listing. */
  jobDetails?: AssistedApplicationJobDetails;
  onChooseExternal: () => void;
  onChoosePaid: () => void | Promise<void>;
  onClose: () => void;
  paidLoading?: boolean;
  error?: string | null;
  /**
   * Shown by a host overlay (RewardedApplicationOffer's paid choice) that
   * already locks the body scroll and handles Escape: two locks would
   * restore each other's saved value out of order.
   */
  embedded?: boolean;
  /** `trigger` of `assisted_application_offer_viewed` (who opened the offer). */
  trigger?: string;
  /** Label of the free button, when the free path is not a direct hand-off. */
  externalLabel?: string;
}

/** Transparent choice surface for the assisted-application treatment arm. */
export default function AssistedApplicationOffer({
  jobId,
  companyId,
  companyName,
  jobTitle,
  variant,
  copyVariant = 'handled_for_you',
  layoutVariant = 'control',
  layoutExperimentActive = false,
  jobDetails,
  onChooseExternal,
  onChoosePaid,
  onClose,
  paidLoading = false,
  error = null,
  embedded = false,
  trigger,
  externalLabel,
}: AssistedApplicationOfferProps) {
  const { t } = useTranslation();
  const [locale] = useLocale();
  const handleBackdropClick = useApplicationOfferBackdropDismiss(onClose);
  const copyKey = (part: 'title' | 'body') => `jobBoard.assisted.copy.handled_for_you.${part}`;
  const hiringText = t('jobBoard.assisted.benefit.hiringText');
  const zeroSpamText = t('jobBoard.assisted.benefit.zeroSpam');
  const jobPanelClass = layoutVariant === 'proposal_b'
    ? 'border border-accent/20 bg-accent-subtle/70'
    : layoutVariant === 'proposal_5'
      ? 'border border-edge bg-surface-raised'
      : layoutVariant === 'variant_7'
        ? 'border border-edge bg-surface'
        : 'border border-edge bg-surface-raised';
  const isProposalB = layoutVariant === 'proposal_b';
  // The free and paid buttons sit at the card's bottom, where Google's anchor
  // ad lands: the card stays above it.
  const adClearance = useApplicationOfferAdClearance();
  // The canonical landing is a public page; authentication is only needed
  // when the visitor starts checkout or opens a paid service.
  const conciergeHref = getApplicationConciergePath(locale);

  useEffect(() => {
    trackAssistedApplicationEvent('assisted_application_offer_viewed', {
      variant,
      copy_variant: copyVariant,
      ...(layoutExperimentActive ? { layout_variant: layoutVariant } : {}),
      jobId,
      companyId,
      price_eur_cents: ASSISTED_APPLICATION_PRICE_EUR_CENTS,
      ...(trigger ? { trigger } : {}),
    });
    // Viewed once per job; the trigger is the one it opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, copyVariant, jobId, layoutExperimentActive, layoutVariant, variant]);

  useEffect(() => {
    if (embedded) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [embedded, onClose]);

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      autoFocus
      className="absolute right-0 top-[-0.375rem] inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-stripe text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      aria-label={t('common.close')}
      data-testid="assisted-application-offer-close"
    >
      <X className="h-5 w-5" aria-hidden="true" />
    </button>
  );

  const modal = (
    <div
      className="fixed inset-0 z-[1000] isolate flex min-h-[100dvh] items-end justify-center overflow-y-auto bg-black/55 px-3 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] backdrop-blur-sm sm:items-center sm:px-4 sm:py-3 lg:px-8"
      onClick={handleBackdropClick}
      style={adClearance.overlayStyle}
      data-testid="assisted-application-offer"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-application-offer-title"
        aria-describedby="assisted-application-offer-description"
        className="relative my-auto max-h-[calc(100dvh_-_1.5rem_-_var(--offer-ad-inset,0px))] w-full max-w-md overflow-y-auto overscroll-contain rounded-stripe border border-edge bg-surface px-4 pt-4 shadow-stripe-lg sm:max-h-[min(90dvh,40rem,calc(100dvh_-_1.5rem_-_var(--offer-ad-inset,0px)))] sm:max-w-2xl sm:px-5 sm:pt-5 md:max-w-5xl md:px-6 md:pt-4 lg:max-h-[min(90dvh,42rem,calc(100dvh_-_1.5rem_-_var(--offer-ad-inset,0px)))] lg:max-w-6xl"
        style={adClearance.cardStyle}
        data-layout-variant={layoutVariant}
      >
        <div className="grid gap-3 pb-2 sm:pb-3 md:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)] md:items-stretch md:gap-3 lg:gap-6">
          {jobDetails && (
            <section
              className={'order-3 min-w-0 rounded-stripe p-3 sm:p-4 md:order-2 md:col-start-1 md:row-start-2 ' + jobPanelClass}
              aria-label={t('jobBoard.assisted.jobDetails')}
              data-testid="assisted-application-job-details"
              data-job-panel-style={isProposalB ? 'proposal_c' : layoutVariant}
            >
              <h3 className="font-display text-base font-semibold leading-tight text-heading sm:text-lg">{jobTitle}</h3>
              <p className="mt-1 text-xs font-medium text-subtle sm:text-sm">{companyName}</p>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                {([
                  ['jobBoard.assisted.jobLocation', jobDetails.location],
                  ['jobBoard.assisted.jobSalary', jobDetails.salary],
                  ['jobBoard.assisted.jobContract', jobDetails.contract],
                ] as const).map(([labelKey, value]) => (
                  <div key={labelKey} className="min-w-0">
                    <dt className="text-xs font-medium text-subtle">{t(labelKey)}</dt>
                    <dd className="mt-0.5 break-words text-xs font-semibold leading-snug text-body">{value || t('jobBoard.assisted.jobNotListed')}</dd>
                  </div>
                ))}
              </dl>
              {jobDetails.description && (
                <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-body">{jobDetails.description}</p>
              )}
            </section>
          )}

          <section
            className={'order-1 min-w-0 space-y-2.5 md:col-start-2 md:row-start-1 md:flex md:flex-col md:space-y-0 md:gap-y-2.5 '
              + (jobDetails ? 'md:row-span-2' : 'md:col-span-1')}
          >
            <header className="relative min-w-0 pr-11">
              <h2 id="assisted-application-offer-title" className="font-display text-xl font-semibold leading-tight text-heading sm:text-2xl">
                {t(copyKey('title'))}
              </h2>
              {closeButton}
            </header>

            {isProposalB && (
              <section className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2 rounded-xl border border-accent/15 bg-accent-subtle/60 p-2">
                <div
                  className="relative mx-auto h-12 w-10"
                  role="img"
                  aria-label={t('jobBoard.assisted.benefit.tailoredCv')}
                >
                  <div className="absolute inset-1 rotate-6 rounded-lg border border-accent/15 bg-surface" aria-hidden="true" />
                  <div className="absolute inset-1 rounded-lg border border-edge bg-surface p-2 shadow-stripe-sm">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-subtle text-accent">
                      <FileText className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <p className="mt-1.5 text-xs font-bold text-heading">CV</p>
                    <div className="mt-1.5 space-y-1" aria-hidden="true">
                      <span className="block h-1 w-full rounded-full bg-surface-raised" />
                      <span className="block h-1 w-4/5 rounded-full bg-surface-raised" />
                      <span className="block h-1 w-3/5 rounded-full bg-surface-raised" />
                    </div>
                    <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-edge bg-surface text-success shadow-stripe-sm">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </span>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-accent">{t('jobBoard.assisted.dossierTitle')}</p>
                  <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-body">
                    <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                    {t('jobBoard.assisted.dossierReady')}
                  </p>
                </div>
              </section>
            )}

            <p id="assisted-application-offer-description" className="border-t border-edge pt-3 text-sm leading-relaxed text-body">
              {t(copyKey('body'))}
            </p>

            <div
              className="sticky bottom-0 z-10 -mx-4 space-y-1.5 border-t border-edge bg-surface px-4 pb-1.5 pt-1.5 sm:-mx-5 sm:px-5 md:-mx-6 md:px-6"
              data-testid="assisted-application-offer-actions"
            >
              {error && <p role="alert" aria-live="assertive" className="text-sm leading-relaxed text-danger">{error}</p>}
              <button
                type="button"
                onClick={() => { void onChoosePaid(); }}
                disabled={paidLoading}
                aria-busy={paidLoading}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-2 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="assisted-application-offer-paid"
              >
                {paidLoading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {paidLoading ? t('jobBoard.assisted.paidLoading') : t('jobBoard.assisted.paidCta')}
              </button>
              <p className="text-center text-xs font-medium leading-tight text-subtle">{t('jobBoard.assisted.priceNote')}</p>
              <a
                href={conciergeHref}
                className="flex min-h-[44px] items-center justify-center gap-2 rounded-stripe border border-accent/20 bg-accent-subtle/35 px-3 py-1.5 text-center text-xs font-semibold leading-snug text-accent transition-colors hover:bg-accent-subtle/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                {t('jobBoard.concierge.offerLink')}
                <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
              </a>
              <button
                type="button"
                onClick={onChooseExternal}
                disabled={paidLoading}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-stripe px-3 py-1.5 text-sm font-semibold text-link underline decoration-link/40 underline-offset-4 transition-colors hover:bg-surface-raised hover:decoration-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="assisted-application-offer-external"
              >
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                {externalLabel ?? t('jobBoard.assisted.externalCta')}
              </button>
            </div>
          </section>

          <div
            className="order-2 min-w-0 space-y-2.5 md:col-start-1 md:row-start-1"
            data-testid="assisted-application-supporting-benefits"
          >
            {layoutVariant === 'proposal_5' ? (
              <div className="grid grid-cols-2 divide-x divide-edge rounded-xl border border-edge bg-surface-raised py-2.5" data-testid="assisted-application-benefits">
                <div className="flex min-w-0 items-center gap-2 px-2.5 sm:px-3">
                  <span className="font-display text-2xl font-semibold leading-none tracking-tight text-accent">3×</span>
                  <p className="text-xs font-semibold leading-snug text-body">{hiringText}</p>
                </div>
                <div className="flex min-w-0 items-center gap-2 px-2.5 sm:px-3">
                  <Shield className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  <p className="text-xs font-semibold leading-snug text-body">{zeroSpamText}</p>
                </div>
              </div>
            ) : layoutVariant === 'variant_7' ? (
              <div className="flex items-center gap-3 rounded-stripe border border-edge bg-surface-raised px-3 py-3" data-testid="assisted-application-benefits">
                <span className="font-display text-3xl font-semibold leading-none tracking-tight text-accent">3×</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold leading-snug text-heading">{hiringText}</p>
                  <p className="mt-1.5 border-t border-edge pt-1.5 text-xs leading-snug text-subtle">{zeroSpamText}</p>
                </div>
              </div>
            ) : isProposalB ? (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="assisted-application-benefits">
                <p className="flex items-baseline gap-2">
                  <span className="font-display text-3xl font-semibold leading-none tracking-tight text-accent">3×</span>
                  <span className="text-xs font-semibold leading-snug text-body">{hiringText}</span>
                </p>
                <p className="flex items-center gap-1.5 text-xs font-semibold text-body">
                  <Shield className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  {zeroSpamText}
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold text-body" data-testid="assisted-application-benefits">
                <p className="inline-flex items-center gap-1.5">
                  <span className="font-display text-2xl font-bold leading-none text-accent">3×</span>
                  <span>{hiringText}</span>
                </p>
                <p className="inline-flex items-center gap-1.5">
                  <Shield className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  <span>{zeroSpamText}</span>
                </p>
              </div>
            )}
          </div>

          <details className="order-4 border-t border-edge pt-2 text-xs leading-snug text-muted md:col-span-2">
            <summary className="cursor-pointer font-medium">{t('common.disclaimer')}</summary>
            <p className="mt-1">
              {t('jobBoard.assisted.disclaimer')} <AssistedApplicationLegalLinks />
            </p>
          </details>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
