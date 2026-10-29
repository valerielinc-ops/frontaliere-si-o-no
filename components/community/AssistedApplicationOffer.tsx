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
  const steps = [
    t('jobBoard.assisted.step1'),
    t('jobBoard.assisted.step2'),
    t('jobBoard.assisted.step3'),
  ];
  const jobPanelClass = layoutVariant === 'proposal_b'
    ? 'border border-accent/20 bg-accent-subtle/70'
    : layoutVariant === 'proposal_5'
      ? 'border border-edge bg-surface-raised'
      : layoutVariant === 'variant_7'
        ? 'border border-edge bg-surface'
        : 'border border-edge bg-surface-raised';
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

  const modal = (
    <div
      className="fixed inset-0 z-[1000] isolate flex min-h-[100dvh] items-end justify-center overflow-y-auto bg-black/55 px-3 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
      onClick={handleBackdropClick}
      style={adClearance.overlayStyle}
      data-testid="assisted-application-offer"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-application-offer-title"
        aria-describedby="assisted-application-offer-description"
        className={'relative my-auto max-h-[calc(100dvh_-_2rem_-_var(--offer-ad-inset,0px))] w-full '
          + (layoutVariant === 'proposal_b' ? 'max-w-lg' : 'max-w-md')
          + ' overflow-y-auto overscroll-contain rounded-stripe border border-edge bg-surface px-4 pt-4 shadow-stripe-lg sm:max-h-[min(90dvh,42rem,calc(100dvh_-_2rem_-_var(--offer-ad-inset,0px)))] sm:px-6 sm:pt-6'}
        style={adClearance.cardStyle}
        data-layout-variant={layoutVariant}
      >
        {/* The bottom padding sits here, not on the scrolling card: the pinned
            actions block then reaches the card's bottom edge, and no scrolled
            text shows in a strip under it (live 2026-10-07: 16-24 px). */}
        <div className={'space-y-4 pb-4 sm:pb-6 ' + (layoutVariant === 'proposal_b' ? 'sm:space-y-5' : '')}>
          <div className="flex items-start justify-between gap-4">
            {layoutVariant !== 'proposal_b' && (
              <div className="min-w-0">
                <p className="text-sm font-semibold text-accent">{companyName}</p>
                <h2 id="assisted-application-offer-title" className="mt-1 text-xl font-semibold font-display text-heading">
                  {t(copyKey('title'))}
                </h2>
                <p className="mt-2 text-sm text-subtle line-clamp-3">{jobTitle}</p>
              </div>
            )}
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

          {layoutVariant === 'proposal_b' && (
            <section className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 rounded-xl border border-accent/15 bg-accent-subtle/65 p-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-5 sm:p-5">
              <div
                className="relative mx-auto h-[6.75rem] w-[5rem] sm:h-32 sm:w-24"
                role="img"
                aria-label={t('jobBoard.assisted.benefit.tailoredCv')}
              >
                <div className="absolute inset-1 rotate-6 rounded-xl border border-accent/15 bg-surface" aria-hidden="true" />
                <div className="absolute inset-1 rounded-xl border border-edge bg-surface p-2.5 shadow-stripe-sm sm:p-3">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-subtle text-accent">
                    <FileText className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <p className="mt-2 text-xs font-bold text-heading">CV</p>
                  <p className="mt-0.5 text-xs font-semibold leading-tight text-accent">{t('jobBoard.assisted.benefit.tailoredCv')}</p>
                  <div className="mt-2 space-y-1.5" aria-hidden="true">
                    <span className="block h-1 w-full rounded-full bg-surface-raised" />
                    <span className="block h-1 w-4/5 rounded-full bg-surface-raised" />
                    <span className="block h-1 w-3/5 rounded-full bg-surface-raised" />
                  </div>
                  <span className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-edge bg-surface text-success shadow-stripe-sm">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </div>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-accent">{t('jobBoard.assisted.dossierTitle')}</p>
                <h2 id="assisted-application-offer-title" className="mt-1 text-lg font-semibold font-display leading-tight text-heading sm:text-xl">
                  {t(copyKey('title'))}
                </h2>
                <p id="assisted-application-offer-description" className="mt-2 text-xs leading-relaxed text-body sm:text-sm">
                  {t(copyKey('body'))}
                </p>
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-accent/15 bg-surface/80 px-2.5 py-1 text-xs font-semibold text-body">
                  <Check className="h-3 w-3 shrink-0 text-success" aria-hidden="true" />
                  {t('jobBoard.assisted.dossierReady')}
                </p>
              </div>
            </section>
          )}

          {layoutVariant === 'proposal_5' ? (
            <div className="grid gap-3 sm:grid-cols-[1.2fr_0.8fr] sm:items-stretch" data-testid="assisted-application-benefits">
              <p id="assisted-application-offer-description" className="text-sm leading-relaxed text-body">
                {t(copyKey('body'))}
              </p>
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-edge bg-surface-raised p-3 sm:grid-cols-1">
                <div className="flex items-center gap-2">
                  <span className="font-display text-2xl font-semibold leading-none tracking-tight text-accent">3×</span>
                  <p className="text-xs font-semibold leading-snug text-body">{hiringText}</p>
                </div>
                <div className="flex items-center gap-2 sm:border-t sm:border-edge sm:pt-2">
                  <Shield className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  <p className="text-xs font-semibold leading-snug text-body">{zeroSpamText}</p>
                </div>
              </div>
            </div>
          ) : layoutVariant === 'proposal_b' ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="assisted-application-benefits">
              <div className="flex items-baseline gap-2">
                <span className="font-display text-3xl font-semibold leading-none tracking-tight text-accent">3×</span>
                <p className="text-xs font-semibold text-body">{hiringText}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Shield className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <p className="text-xs font-semibold text-body">{zeroSpamText}</p>
              </div>
            </div>
          ) : layoutVariant === 'variant_7' ? (
            <div className="flex items-center gap-3 rounded-stripe border border-edge bg-surface-raised px-3.5 py-3" data-testid="assisted-application-benefits">
              <span className="font-display text-3xl font-semibold leading-none tracking-tight text-accent">3×</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold leading-snug text-heading">{hiringText}</p>
                <p className="mt-1 text-xs leading-snug text-subtle">{zeroSpamText}</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold text-body" data-testid="assisted-application-benefits">
              <p className="inline-flex items-center gap-1.5">
                <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <span>3× {hiringText}</span>
              </p>
              <p className="inline-flex items-center gap-1.5">
                <Shield className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <span>{zeroSpamText}</span>
              </p>
            </div>
          )}

          {layoutVariant !== 'proposal_b' && layoutVariant !== 'proposal_5' && (
            <p id="assisted-application-offer-description" className="text-sm leading-relaxed text-body">
              {t(copyKey('body'))}
            </p>
          )}

          {jobDetails && (
            <section
              className={'p-3 ' + (layoutVariant === 'proposal_b' ? 'rounded-xl sm:rounded-2xl sm:p-4 ' : 'rounded-stripe ')
                + jobPanelClass}
              aria-label={t('jobBoard.assisted.jobDetails')}
              data-testid="assisted-application-job-details"
              data-job-panel-style={layoutVariant === 'proposal_b' ? 'proposal_c' : layoutVariant}
            >
              <h3 className={layoutVariant === 'proposal_b'
                ? 'font-display text-base font-semibold leading-tight text-heading'
                : 'text-xs font-semibold text-heading'}
              >
                {layoutVariant === 'proposal_b' ? jobTitle : t('jobBoard.assisted.jobDetails')}
              </h3>
              {layoutVariant === 'proposal_b' && (
                <p className="mt-1 text-xs font-medium text-subtle">{companyName}</p>
              )}
              <dl className={layoutVariant === 'proposal_b'
                ? 'mt-2 flex flex-wrap gap-2'
                : 'mt-2 grid grid-cols-2 gap-x-3 gap-y-2'}
              >
                {([
                  ['jobBoard.assisted.jobLocation', jobDetails.location],
                  ['jobBoard.assisted.jobSalary', jobDetails.salary],
                  ['jobBoard.assisted.jobContract', jobDetails.contract],
                ] as const).map(([labelKey, value]) => (
                  <div
                    key={labelKey}
                    className={layoutVariant === 'proposal_b' ? 'min-w-0 rounded-full bg-surface/80 px-3 py-1.5' : 'min-w-0'}
                  >
                    <dt className={layoutVariant === 'proposal_b' ? 'inline text-xs font-medium text-subtle' : 'text-xs font-medium text-subtle'}>
                      {t(labelKey)}{layoutVariant === 'proposal_b' ? ': ' : ''}
                    </dt>
                    <dd className={layoutVariant === 'proposal_b'
                      ? 'inline break-words text-xs font-semibold text-body'
                      : 'mt-0.5 break-words text-xs font-semibold text-body'}
                    >
                      {value || t('jobBoard.assisted.jobNotListed')}
                    </dd>
                  </div>
                ))}
              </dl>
              {jobDetails.description && (
                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-body">{jobDetails.description}</p>
              )}
            </section>
          )}

          {layoutVariant === 'variant_7' ? (
            <ol className="space-y-0.5 text-sm text-body" aria-label={t('jobBoard.assisted.stepsLabel')} data-testid="assisted-application-steps-timeline">
              {steps.map((step, index) => (
                <li key={step} className="relative flex gap-3 pb-3 last:pb-0">
                  {index < steps.length - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px bg-edge" aria-hidden="true" />}
                  <span className="z-[1] flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent/20 bg-accent-subtle text-xs font-bold tabular-nums text-accent">{index + 1}</span>
                  <span className="pt-1.5 leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <ul className="space-y-2 text-sm text-body" aria-label={t('jobBoard.assisted.stepsLabel')}>
              {steps.map((step) => (
                <li key={step} className="flex items-start gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  <span>{step}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-stripe border border-info-border bg-info-subtle/60 p-3">
            <div className="flex items-start gap-2.5">
              <Shield className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-body">{t('jobBoard.assisted.transparency')}</p>
            </div>
          </div>

          {/* Pinned to the card's bottom while the card scrolls: with the room
              Google's anchor ad leaves (adClearance) the card can be shorter
              than its content, and the free path was below the fold (live
              2026-10-07, 717 px viewport: card 550 px, content 724 px). */}
          <div
            className="sticky bottom-0 z-10 -mx-4 space-y-3 border-t border-edge bg-surface px-4 pb-2 pt-3 sm:-mx-6 sm:px-6"
            data-testid="assisted-application-offer-actions"
          >
            {error && <p role="alert" aria-live="assertive" className="text-sm leading-relaxed text-danger">{error}</p>}
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
            <div className="rounded-stripe border border-accent/30 bg-accent-subtle/40 p-3">
              <a
                href={conciergeHref}
                className="block text-sm font-semibold text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
              >
                {t('jobBoard.concierge.offerLink')}
              </a>
              <p className="mt-1 text-xs leading-relaxed text-subtle">{t('jobBoard.concierge.offerLinkHint')}</p>
            </div>
            <button
              type="button"
              onClick={onChooseExternal}
              disabled={paidLoading}
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-stripe px-4 py-2 text-sm font-semibold text-link underline decoration-link/40 underline-offset-4 transition-colors hover:bg-surface-raised hover:decoration-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="assisted-application-offer-external"
            >
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              {externalLabel ?? t('jobBoard.assisted.externalCta')}
            </button>
          </div>

          <p className="text-xs leading-relaxed text-muted">
            {t('jobBoard.assisted.disclaimer')} <AssistedApplicationLegalLinks />
          </p>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
