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
import {
  useAuth,
  getAuthEmail,
  renderGoogleButtonWithReadiness,
  isLinkedInSignInAvailable,
  signInWithLinkedIn,
} from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';

export const PAYWALL_DISMISSED_KEY = 'frontaliere_paywall_dismissed';
export const SIM_COMPLETE_COUNTER_KEY = 'counter_sim_complete';
export const VISIT_COUNTER_KEY = 'visit_count';
export const JOB_EMAIL_KEY = 'ft_job_email';
export const NEWSLETTER_SUBSCRIBED_KEY = 'newsletter_subscribed';
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
  newsletterSubscribed: boolean;
  now?: number;
}

/**
 * Pure trigger-rule evaluator. Kept separate so it can be unit-tested without
 * mounting the component.
 *
 * Suppresses the paywall when the user has already given us their email via
 * any channel: job-board access (`ft_job_email`) or newsletter signup
 * (`newsletter_subscribed`, the canonical flag set by useNewsletterState +
 * JobBoard newsletter opt-in). Avoids re-asking the same email we already have.
 */
export function shouldShowPaywall(inputs: PaywallGateInputs): boolean {
  const { simCompleteCount, visitCount, dismissedAtRaw, jobEmail, newsletterSubscribed, now } = inputs;
  if (newsletterSubscribed) return false;
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
    const newsletterSubscribed = localStorage.getItem(NEWSLETTER_SUBSCRIBED_KEY) === 'true';
    return shouldShowPaywall({ simCompleteCount, visitCount, dismissedAtRaw, jobEmail, newsletterSubscribed });
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
  const { user } = useAuth();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [googleButtonReady, setGoogleButtonReady] = useState(false);
  const [linkedInAvailable, setLinkedInAvailable] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);

  // Fire paywall_shown exactly once on mount.
  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    Analytics.trackFunnelStep('paywall_shown', { funnel: 'newsletter_paywall' });
  }, []);

  // LinkedIn RC flag gate.
  useEffect(() => {
    isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
  }, []);

  // Pre-fill email from authenticated user (Google / LinkedIn / Facebook).
  useEffect(() => {
    const authEmail = getAuthEmail(user);
    if (authEmail && !email) setEmail(authEmail);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount the Google sign-in button once, only while not authenticated.
  useEffect(() => {
    let cancelled = false;
    const mountButton = async () => {
      if (user || !googleButtonRef.current) {
        if (googleButtonRef.current) googleButtonRef.current.innerHTML = '';
        setGoogleButtonReady(false);
        return;
      }
      try {
        const ready = await renderGoogleButtonWithReadiness(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          width: 320,
          locale,
        });
        if (!cancelled) setGoogleButtonReady(ready);
      } catch (error) {
        if (!cancelled) {
          setGoogleButtonReady(false);
          reportCaughtError(error, 'paywall.renderGoogleButton');
        }
      }
    };
    void mountButton();
    return () => { cancelled = true; };
  }, [user, locale]);

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
      // Mark as subscribed so the paywall (and other subscribe prompts) stop
      // re-asking the same email across the site.
      try { localStorage.setItem(NEWSLETTER_SUBSCRIBED_KEY, 'true'); } catch { /* ignore quota */ }
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
            <>
              {/* Social sign-in — same pattern as Newsletter / SubscriptionCTA / LeadMagnetCTA */}
              {!user && (
                <div className="space-y-2 mb-3">
                  <div ref={googleButtonRef} className="flex justify-center min-h-[40px]" aria-label="Google sign-in" />
                  {!googleButtonReady && (
                    <div className="h-10 flex items-center justify-center text-xs text-muted">
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                      <span>Loading…</span>
                    </div>
                  )}
                  {linkedInAvailable && (
                    <button
                      type="button"
                      onClick={() => signInWithLinkedIn()}
                      className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-brand-linkedin hover:bg-brand-linkedin-hover text-on-accent text-sm font-semibold transition-colors"
                      aria-label="Continue with LinkedIn"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM0 8h5v16H0V8zm7.5 0h4.78v2.2h.07c.67-1.26 2.3-2.58 4.73-2.58 5.06 0 6 3.33 6 7.66V24h-5v-7.1c0-1.7-.03-3.88-2.36-3.88-2.37 0-2.73 1.85-2.73 3.76V24h-5V8z"/>
                      </svg>
                      <span>
                        {locale === 'it' ? 'Continua con LinkedIn'
                          : locale === 'de' ? 'Mit LinkedIn fortfahren'
                          : locale === 'fr' ? 'Continuer avec LinkedIn'
                          : 'Continue with LinkedIn'}
                      </span>
                    </button>
                  )}
                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-edge" /></div>
                    <div className="relative flex justify-center"><span className="px-2 bg-surface text-xs text-muted uppercase tracking-wider">
                      {locale === 'it' ? 'oppure'
                        : locale === 'de' ? 'oder'
                        : locale === 'fr' ? 'ou'
                        : 'or'}
                    </span></div>
                  </div>
                </div>
              )}

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
            </>
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
