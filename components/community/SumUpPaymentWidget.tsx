import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CreditCard, Loader2, ShieldCheck, X } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { ASSISTED_APPLICATION_PRICE_EUR_CENTS } from '@/services/assistedApplicationExperiment';

const SUMUP_SDK_SRC = 'https://gateway.sumup.com/gateway/ecom/card/v2/sdk.js';
const SUMUP_LOCALE: Record<Locale, string> = {
  it: 'it-CH',
  en: 'en-GB',
  de: 'de-CH',
  fr: 'fr-CH',
};

interface SumUpMountOptions {
  id: string;
  checkoutId: string;
  amount: string;
  currency: 'EUR';
  locale: string;
  country: 'CH';
  showFooter: boolean;
  onResponse: (type: string, body: unknown) => void;
  onLoad?: () => void;
}

interface SumUpCardInstance {
  unmount?: () => void;
}

interface SumUpCardApi {
  mount: (options: SumUpMountOptions) => SumUpCardInstance;
}

declare global {
  interface Window {
    SumUpCard?: SumUpCardApi;
  }
}

let sdkPromise: Promise<void> | null = null;

function loadSumUpSdk(): Promise<void> {
  if (typeof window !== 'undefined' && window.SumUpCard) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SUMUP_SDK_SRC}"]`);
    if (existing) {
      if (window.SumUpCard) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('sumup_sdk_load_failed')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = SUMUP_SDK_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('sumup_sdk_load_failed'));
    document.head.appendChild(script);
  }).catch((error) => {
    sdkPromise = null;
    throw error;
  });

  return sdkPromise;
}

export interface SumUpPaymentWidgetProps {
  checkoutId: string;
  locale: Locale;
  onResponse: (type: string, body: unknown) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
  error?: string | null;
  busy?: boolean;
}

/**
 * Embedded SumUp payment form for the assisted-application flow.
 *
 * The checkout status is still confirmed by the SumUp webhook on the server;
 * the widget callback only controls the client's return to the order page.
 */
export default function SumUpPaymentWidget({
  checkoutId,
  locale,
  onResponse,
  onError,
  onClose,
  error = null,
  busy = false,
}: SumUpPaymentWidgetProps) {
  const { t } = useTranslation();
  const generatedId = useId();
  const containerId = `sumup-card-${generatedId.replace(/:/g, '')}`;
  const titleId = `${containerId}-title`;
  const descriptionId = `${containerId}-description`;
  const responseRef = useRef(onResponse);
  const errorRef = useRef(onError);
  const [sdkLoading, setSdkLoading] = useState(true);
  const formattedAmount = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(ASSISTED_APPLICATION_PRICE_EUR_CENTS / 100);

  useEffect(() => {
    responseRef.current = onResponse;
  }, [onResponse]);

  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    let card: SumUpCardInstance | null = null;
    setSdkLoading(true);

    void loadSumUpSdk()
      .then(() => {
        if (cancelled) return;
        const sumUpCard = window.SumUpCard;
        if (!sumUpCard) throw new Error('sumup_sdk_unavailable');
        card = sumUpCard.mount({
          id: containerId,
          checkoutId,
          amount: (ASSISTED_APPLICATION_PRICE_EUR_CENTS / 100).toFixed(2),
          currency: 'EUR',
          locale: SUMUP_LOCALE[locale],
          country: 'CH',
          showFooter: true,
          onResponse: (type, body) => responseRef.current(type, body),
          onLoad: () => {
            if (!cancelled) setSdkLoading(false);
          },
        });
        if (!cancelled) setSdkLoading(false);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSdkLoading(false);
          errorRef.current(error);
        }
      });

    return () => {
      cancelled = true;
      card?.unmount?.();
    };
  }, [checkoutId, containerId, locale]);

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!busy && event.target === event.currentTarget) onClose();
  };

  const modal = (
    <div
      className="fixed inset-0 z-[1000] flex min-h-[100dvh] items-end justify-center overflow-y-auto bg-black/55 px-0 py-0 backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
      onMouseDown={handleBackdropMouseDown}
      data-testid="sumup-payment-widget"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={sdkLoading || busy}
        className="relative flex max-h-[min(760px,calc(100dvh-1rem))] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-edge bg-surface shadow-stripe-lg sm:max-h-[calc(100dvh-3rem)] sm:rounded-stripe"
      >
        <header className="shrink-0 border-b border-edge bg-surface px-4 pb-4 pt-4 sm:px-6 sm:pb-5 sm:pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-stripe bg-accent-subtle text-accent">
                <CreditCard className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 id={titleId} className="font-display text-lg font-semibold text-heading sm:text-xl">
                  {t('jobBoard.assisted.title')}
                </h2>
                <p className="mt-1 text-sm text-subtle">SumUp</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-stripe text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t('common.close')}
              data-testid="sumup-payment-widget-close"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <div
            id={descriptionId}
            className="mt-4 flex items-center justify-between gap-4 rounded-stripe border border-accent/20 bg-accent-subtle/50 px-3 py-3"
          >
            <span className="text-sm font-medium text-subtle">{t('jobBoard.assisted.priceNote')}</span>
            <span className="shrink-0 text-lg font-semibold tabular-nums text-heading">{formattedAmount}</span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4 sm:px-6 sm:pb-6">
          <div className="rounded-stripe border border-edge bg-surface-alt p-3 sm:p-4">
            <div className="relative min-h-[240px]" aria-busy={sdkLoading}>
              {sdkLoading && (
                <div
                  className="absolute inset-0 space-y-3 rounded-stripe bg-surface-alt p-3"
                  aria-hidden="true"
                >
                  <div className="h-4 w-32 animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
                  <div className="h-11 w-full animate-pulse rounded-stripe bg-surface-raised motion-reduce:animate-none" />
                  <div className="h-11 w-full animate-pulse rounded-stripe bg-surface-raised motion-reduce:animate-none" />
                  <div className="ml-auto h-11 w-28 animate-pulse rounded-stripe bg-surface-raised motion-reduce:animate-none" />
                </div>
              )}
              <div
                id={containerId}
                className={sdkLoading ? 'min-h-[240px] opacity-0' : 'min-h-[240px] opacity-100 transition-opacity duration-200'}
              />
            </div>
          </div>

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="mt-4 flex items-start gap-3 rounded-stripe border border-danger/20 bg-danger-subtle px-3 py-3 text-sm leading-relaxed text-danger"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          {(sdkLoading || busy) && (
            <p role="status" aria-live="polite" className="mt-4 flex items-center justify-center gap-2 rounded-stripe bg-accent-subtle/40 px-3 py-2.5 text-sm text-subtle">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {t('jobBoard.assisted.paidLoading')}
            </p>
          )}

          <div className="mt-4 flex items-start gap-2 border-t border-edge pt-4 text-xs leading-relaxed text-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <p>
              <span className="font-semibold text-subtle">SumUp</span>
              {' · '}
              {t('jobBoard.assisted.priceNote')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
