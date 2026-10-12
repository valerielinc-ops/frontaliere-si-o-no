import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
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
  const responseRef = useRef(onResponse);
  const errorRef = useRef(onError);
  const [sdkLoading, setSdkLoading] = useState(true);

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

  const modal = (
    <div
      className="fixed inset-0 z-[1000] flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-black/55 px-3 py-4 backdrop-blur-sm sm:px-4 sm:py-6"
      data-testid="sumup-payment-widget"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sumup-payment-widget-title"
        className="relative my-auto w-full max-w-md rounded-stripe border border-edge bg-surface p-4 shadow-stripe-lg sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="sumup-payment-widget-title" className="text-xl font-semibold font-display text-heading">
            {t('jobBoard.assisted.title')}
          </h2>
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

        <div className="mt-5 min-h-[180px]" id={containerId} />
        {error && <p role="alert" aria-live="assertive" className="mt-3 text-sm leading-relaxed text-danger">{error}</p>}
        {(sdkLoading || busy) && (
          <p role="status" aria-live="polite" className="mt-3 flex items-center justify-center gap-2 text-sm text-subtle">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t('jobBoard.assisted.paidLoading')}
          </p>
        )}
      </div>
    </div>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
