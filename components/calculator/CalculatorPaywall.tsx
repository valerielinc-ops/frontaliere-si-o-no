/**
 * CalculatorPaywall.tsx — Soft paywall modal (E2)
 *
 * Shown after 3+ simulation completions OR 2+ visits, unless the user has:
 *  - already dismissed the paywall within the last 30 days
 *  - already converted via the job-board (ft_job_email present)
 *
 * Captures an email in exchange for a PDF report of the simulation.
 * The PDF is generated client-side (jsPDF) and delivered to the user's inbox
 * via the `sendCalculatorReport` Cloud Function.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Mail, ShieldCheck, CheckCircle2, AlertCircle, Download, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import type { SimulationResult, SimulationInputs } from '../../types';
import { generateCalculatorPdfReport } from '@/services/pdfReport';

export const PAYWALL_DISMISSED_KEY = 'frontaliere_paywall_dismissed';
export const SIM_COMPLETE_COUNTER_KEY = 'counter_sim_complete';
export const VISIT_COUNTER_KEY = 'visit_count';
export const JOB_EMAIL_KEY = 'ft_job_email';
export const PAYWALL_DISMISS_DAYS = 30;

const FUNCTIONS_BASE = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net';
const SEND_CALCULATOR_REPORT_URL = `${FUNCTIONS_BASE}/sendCalculatorReport`;

/**
 * Returns true when the paywall dismissal is still active (ISO timestamp <30 days old).
 * Accepts legacy numeric timestamps too (older builds used Date.now()).
 */
function isDismissalActive(raw: string | null, now = Date.now()): boolean {
  if (!raw) return false;
  // Try ISO string first, fall back to numeric.
  let ts = Date.parse(raw);
  if (Number.isNaN(ts)) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return false;
    ts = n;
  }
  const diffDays = (now - ts) / (1000 * 60 * 60 * 24);
  return diffDays < PAYWALL_DISMISS_DAYS;
}

export interface PaywallGateInputs {
  simCompleteCount: number;
  visitCount: number;
  dismissedAtRaw: string | null;
  jobEmail: string | null;
  now?: number;
}

/**
 * Pure trigger-rule evaluator. Kept separate so it can be unit-tested without
 * mounting the component.
 */
export function shouldShowPaywall(inputs: PaywallGateInputs): boolean {
  const { simCompleteCount, visitCount, dismissedAtRaw, jobEmail, now } = inputs;
  if (jobEmail && jobEmail.length > 0) return false;
  if (isDismissalActive(dismissedAtRaw, now)) return false;
  return simCompleteCount >= 3 || visitCount >= 2;
}

/**
 * LocalStorage-backed version of the trigger rule. Safe to call in SSR/test
 * environments (returns false if `window` is undefined).
 */
export function shouldShowPaywallFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const simCompleteCount = parseInt(localStorage.getItem(SIM_COMPLETE_COUNTER_KEY) || '0', 10) || 0;
    const visitCount = parseInt(localStorage.getItem(VISIT_COUNTER_KEY) || '0', 10) || 0;
    const dismissedAtRaw = localStorage.getItem(PAYWALL_DISMISSED_KEY);
    const jobEmail = localStorage.getItem(JOB_EMAIL_KEY);
    return shouldShowPaywall({ simCompleteCount, visitCount, dismissedAtRaw, jobEmail });
  } catch {
    return false;
  }
}

interface CalculatorPaywallProps {
  result: SimulationResult;
  inputs: SimulationInputs;
  /** Called when the modal is closed (dismiss, Esc, success). */
  onClose: () => void;
  /** Optional test hook — override the fetch() used to POST to the Cloud Function. */
  fetchImpl?: typeof fetch;
}

const CalculatorPaywall: React.FC<CalculatorPaywallProps> = ({ result, inputs, onClose, fetchImpl }) => {
  const { t, locale } = useTranslation();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const shownRef = useRef(false);

  // Fire paywall_shown exactly once on mount.
  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    Analytics.trackFunnelStep('paywall_shown', { funnel: 'newsletter_paywall' });
  }, []);

  // Focus trap + Esc-to-close.
  useEffect(() => {
    const previousActive = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    closeBtnRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleDismiss();
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      try { previousActive?.focus?.(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDismiss = useCallback(() => {
    try {
      localStorage.setItem(PAYWALL_DISMISSED_KEY, new Date().toISOString());
    } catch { /* quota exceeded — ignore */ }
    Analytics.trackUIInteraction('calculator', 'paywall', 'paywall_dismiss', 'click');
    onClose();
  }, [onClose]);

  const blobToBase64 = useCallback((blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('invalid_reader_result'));
          return;
        }
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('file_reader_error'));
      reader.readAsDataURL(blob);
    });
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'loading') return;
    const trimmed = email.trim();
    if (!validateEmailStrict(trimmed).valid) {
      setErrorMessage(t('calculator.paywall.errorToast'));
      setStatus('error');
      return;
    }
    setStatus('loading');
    setErrorMessage('');
    try {
      const pdfBlob = await generateCalculatorPdfReport({ result, inputs, locale }, trimmed);
      const pdfBase64 = await blobToBase64(pdfBlob);
      const resultSummary = {
        netCH_CHF: Math.round(result.chResident.netIncomeAnnual),
        netIT_CHF: Math.round(result.itResident.netIncomeAnnual),
        savingsCHF: Math.round(result.savingsCHF),
        exchangeRate: result.exchangeRate,
      };
      const fetcher = fetchImpl ?? fetch;
      const resp = await fetcher(SEND_CALCULATOR_REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, pdfBase64, resultSummary, locale }),
      });
      if (!resp.ok) {
        Analytics.trackError(`sendCalculatorReport failed: ${resp.status}`);
        log('paywall_error', { status: resp.status });
        throw new Error(`http_${resp.status}`);
      }
      Analytics.trackFunnelStep('paywall_email_submitted', { funnel: 'newsletter_paywall' });
      setStatus('success');
      // Auto-close after short delay so the user sees the confirmation.
      setTimeout(() => onClose(), 1800);
    } catch (err: any) {
      setErrorMessage(t('calculator.paywall.errorToast'));
      setStatus('error');
    }
  }, [email, result, inputs, locale, onClose, status, t, blobToBase64, fetchImpl]);

  const titleId = useMemo(() => `calc-paywall-title-${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-[color:rgba(15,23,42,0.65)] backdrop-blur-sm px-4"
      aria-hidden={false}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md bg-surface rounded-2xl shadow-2xl border border-edge overflow-hidden animate-fade-in-up"
      >
        <button
          ref={closeBtnRef}
          type="button"
          onClick={handleDismiss}
          aria-label={t('calculator.paywall.dismissLabel')}
          className="absolute top-2 right-2 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-muted hover:text-body rounded-lg transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="p-6 sm:p-7">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-accent-subtle rounded-xl">
              <Download className="w-5 h-5 text-accent" />
            </div>
            <h2 id={titleId} className="text-lg sm:text-xl font-bold font-display text-strong leading-tight">
              {t('calculator.paywall.title')}
            </h2>
          </div>

          <p className="text-sm text-subtle leading-relaxed mb-4">
            {t('calculator.paywall.body')}
          </p>

          <ul className="space-y-2 mb-5">
            <li className="flex items-start gap-2 text-sm text-body">
              <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
              <span>{t('calculator.paywall.bullet1')}</span>
            </li>
            <li className="flex items-start gap-2 text-sm text-body">
              <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
              <span>{t('calculator.paywall.bullet2')}</span>
            </li>
          </ul>

          {status === 'success' ? (
            <div className="flex items-start gap-2 p-3 bg-success-subtle border border-success-border rounded-xl text-success text-sm">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{t('calculator.paywall.successToast')}</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <label htmlFor="calc-paywall-email" className="sr-only">
                {t('calculator.paywall.emailPlaceholder')}
              </label>
              <EmailInput
                id="calc-paywall-email"
                value={email}
                onChange={(val) => { setEmail(val); if (status === 'error') setStatus('idle'); }}
                placeholder={t('calculator.paywall.emailPlaceholder')}
                className="w-full px-4 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm"
              />

              {status === 'error' && errorMessage && (
                <div className="flex items-start gap-2 p-2 bg-danger-subtle rounded-lg text-danger text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={status === 'loading'}
                className="w-full flex items-center justify-center gap-2 px-5 py-2.5 bg-accent-strong text-on-accent font-bold rounded-xl hover:bg-accent-strong-hover transition-[color,background-color,opacity] disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {status === 'loading' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> {t('calculator.paywall.submitting')}</>
                ) : (
                  <><Mail className="w-4 h-4" /> {t('calculator.paywall.submit')}</>
                )}
              </button>

              <p className="text-xs text-muted flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-success shrink-0" />
                <span>{t('calculator.paywall.privacyNote')}</span>
              </p>

              <button
                type="button"
                onClick={handleDismiss}
                className="w-full text-center text-xs text-muted hover:text-body underline underline-offset-2 py-1 transition-colors"
              >
                {t('calculator.paywall.dismissLabel')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

// local helper so we can still forward paywall_error without requiring it be an Analytics method
function log(event: string, details: Record<string, string | number | boolean>) {
  try {
    Analytics.trackUIInteraction('calculator', 'paywall', event, 'error', JSON.stringify(details));
  } catch { /* noop */ }
}

export default CalculatorPaywall;
