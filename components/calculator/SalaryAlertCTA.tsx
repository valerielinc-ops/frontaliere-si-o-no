/**
 * SalaryAlertCTA — one-tap salary alert from the calculator results (issue #4469).
 *
 * Closes the calculator → job → email loop at the highest-intent moment: right
 * after a simulation, offer "avvisami quando escono offerte con netto ≥ CHF X".
 * The threshold is prefilled from the simulated monthly net (floored to a clean
 * CHF 100) and the alert is geo-scoped to Ticino — the criteria the visitor just
 * expressed by running the simulation.
 *
 * Auth handling keeps the visitor in the calculator:
 *   • known user (uid+email) → `subscribeSalaryAlert` in ONE tap;
 *   • anonymous → stash the full criteria, reveal email/social access inline,
 *     then replay the request as soon as authentication completes.
 *
 * Rendered unconditionally (no async flag gate) so it never shifts layout — zero
 * CLS, Auto Ads untouched (Non-Negotiable #7).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, Check, Loader2, Mail, Shield } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useAuth } from '@/services/authService';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { upsertNewsletterSubscriber, requestConfirmationEmail } from '@/services/newsletterSubscribers';
import { consentProof } from '@/services/consentTexts';
import { getFirestore } from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { reportCaughtError } from '@/services/errorReporter';
import {
  buildSalaryAlertConfig,
  subscribeSalaryAlert,
  upgradeBackfilledAlertConsent,
} from '@/services/jobAlertService';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { JOB_ALERT_SUBSCRIBED_KEY } from '@/services/jobAlertCtaState';
import { consumePendingSalaryAlert, savePendingSalaryAlert } from '@/services/pendingSalaryAlert';

const VIEW_SESSION_KEY = 'salary_alert_cta_viewed';
const CTA_ID = 'calculator_salary_alert';
const ALERT_CANTON = 'TI';

interface Props {
  /** Simulated monthly net (CHF) that seeds the alert threshold. */
  netMonthlyCHF: number;
}

type Status = 'idle' | 'capture' | 'submitting' | 'success' | 'error';
type CaptureStatus = 'idle' | 'submitting' | 'sent' | 'error';

/** Floor a net figure to a clean CHF 100 so the copy reads "≥ CHF 4 300". */
function floorToHundred(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 100) * 100;
}

export const SalaryAlertCTA: React.FC<Props> = ({ netMonthlyCHF }) => {
  const { t, locale } = useTranslation();
  const { user } = useAuth();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const completingPendingRef = useRef(false);
  const [status, setStatus] = useState<Status>('idle');
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('idle');
  const [captureEmail, setCaptureEmail] = useState('');
  const [captureError, setCaptureError] = useState('');

  const threshold = floorToHundred(netMonthlyCHF);
  const alertLocale = (locale as 'it' | 'en' | 'de' | 'fr') || 'it';

  const persistCreatedAlert = useCallback(async (uid: string, email: string, config: ReturnType<typeof buildSalaryAlertConfig>) => {
    await subscribeSalaryAlert(uid, email, {
      profession: config.keywords[0] || null,
      cantonCode: config.cantonFilter?.[0] || null,
      minNetMonthlyCHF: config.minNetMonthlyCHF,
      locale: config.locale,
    });
    Analytics.trackJobAlertCreated({
      location: ALERT_CANTON,
      frequency: 'weekly',
      surface: 'calculator_results',
    });
    try {
      localStorage.setItem(JOB_ALERT_SUBSCRIBED_KEY, 'true');
    } catch {
      /* storage unavailable */
    }
    setStatus('success');
    // #5876 — the explicit alert action is the only place that upgrades a
    // backfilled proof. Never turn a successful alert into an error if the
    // ancillary audit write is unavailable.
    void upgradeBackfilledAlertConsent(email, alertLocale).catch(() => {});
  }, [alertLocale]);

  // Social sign-in and the email magic-link flow both update the global user.
  // Replay the exact criteria once, and put it back if the Firestore write
  // fails so the visitor can retry without rebuilding the simulation.
  useEffect(() => {
    if (!user?.uid || !user.email || completingPendingRef.current) return;
    const pending = consumePendingSalaryAlert();
    if (!pending) return;
    completingPendingRef.current = true;
    setStatus('submitting');
    void persistCreatedAlert(user.uid, user.email, pending)
      .catch((error) => {
        savePendingSalaryAlert(pending);
        reportCaughtError(error, 'salaryAlert.pendingReplay');
        setStatus('error');
      })
      .finally(() => {
        completingPendingRef.current = false;
      });
  }, [persistCreatedAlert, user]);

  // Fire the funnel view event once per session when the card is seen.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let alreadyViewed = false;
    try {
      alreadyViewed = sessionStorage.getItem(VIEW_SESSION_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
    if (alreadyViewed) return;

    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || fired) continue;
          fired = true;
          Analytics.trackFunnelStep('salary_alert_view', { funnel: 'salary_alert' });
          try {
            sessionStorage.setItem(VIEW_SESSION_KEY, '1');
          } catch {
            /* storage unavailable */
          }
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleAccept = useCallback(async () => {
    if (status === 'submitting' || status === 'success') return;
    Analytics.trackCtaClick(CTA_ID, {
      component: 'SalaryAlertCTA',
      section: 'calculator_results',
      label: 'salary_alert_accept',
    });
    Analytics.trackDecisionMomentNextAction('calculator', 'salary_alert');
    Analytics.trackFunnelStep('salary_alert_accept', {
      funnel: 'salary_alert',
      authed: Boolean(user?.uid),
    });

    const uid: string | undefined = user?.uid;
    const email: string | null | undefined = user?.email;

    const config = buildSalaryAlertConfig({
      cantonCode: ALERT_CANTON,
      minNetMonthlyCHF: threshold,
      locale: alertLocale,
    });

    // Anonymous: keep the visitor at the result and make the next action
    // explicit. The alert is written only after authentication completes.
    if (!uid || !email) {
      savePendingSalaryAlert(config);
      setCaptureStatus('idle');
      setCaptureError('');
      setStatus('capture');
      Analytics.trackFunnelStep('salary_alert_capture_view', {
        funnel: 'salary_alert',
        capture_surface: 'calculator_results',
      });
      return;
    }

    setStatus('submitting');
    try {
      await persistCreatedAlert(uid, email, config);
    } catch {
      setStatus('error');
    }
  }, [alertLocale, persistCreatedAlert, status, threshold, user]);

  const handleCaptureSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (captureStatus === 'submitting') return;
    const trimmed = captureEmail.trim().toLowerCase();
    if (!validateEmailStrict(trimmed).valid) {
      setCaptureError(t('newsletter.invalidEmail'));
      setCaptureStatus('error');
      return;
    }
    setCaptureStatus('submitting');
    setCaptureError('');
    try {
      const firestore = getFirestore(await getApp());
      const upsert = await upsertNewsletterSubscriber(firestore, {
        email: trimmed,
        preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
        source: 'calculator_salary_alert_email',
        sourcePage: typeof window !== 'undefined' ? window.location.pathname : '',
        sourceCta: CTA_ID,
        sourceComponent: 'SalaryAlertCTA',
        sourceRouteFamily: 'calculator',
        locale: typeof navigator !== 'undefined' ? navigator.language || 'it-IT' : 'it-IT',
        reconsent: true,
        ...consentProof('communicationsOptIn', 'email_submit', alertLocale),
      });
      // The upsert's confirmation request is the newsletter DOI (or the
      // re-consent DOI); it is not the authentication contract the parked
      // calculator intent needs. Request a separate passwordless access link
      // for every capture result, including a brand-new pending address, so
      // the alert can replay as soon as the visitor proves possession of the
      // email. The two messages have different purposes and the server keeps
      // the login link outside the DOI attempt cap.
      await requestConfirmationEmail(trimmed, 'login');
      Analytics.trackFunnelStep('salary_alert_email_sent', {
        funnel: 'salary_alert',
        capture_surface: 'calculator_results',
        existing_address: upsert.existed,
      });
      setCaptureEmail(trimmed);
      setCaptureStatus('sent');
    } catch (error) {
      reportCaughtError(error, 'salaryAlert.captureEmail');
      setCaptureError(t('newsletter.subscribeError'));
      setCaptureStatus('error');
    }
  }, [alertLocale, captureEmail, captureStatus, t]);

  // Below the CHF 100 floor there is no meaningful threshold to advertise.
  if (threshold <= 0) return null;

  const thresholdLabel = `CHF ${threshold.toLocaleString('it-CH')}`;

  return (
    <div
      ref={rootRef}
      data-testid="salary-alert-cta"
      className="mb-6 rounded-2xl border border-success-border bg-gradient-to-br from-success-subtle via-surface to-info-subtle p-5 sm:p-6 shadow-sm"
    >
      <div className="flex items-start gap-4">
        <div className="shrink-0 w-11 h-11 rounded-xl bg-success-subtle flex items-center justify-center text-success">
          {status === 'success' ? (
            <Check size={22} aria-hidden="true" />
          ) : (
            <BellRing size={22} aria-hidden="true" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {status === 'success' ? (
            <>
              <p className="text-base sm:text-lg font-bold font-display text-strong mb-1">
                {t('results.salaryAlert.successTitle')}
              </p>
              <p className="text-sm text-subtle leading-relaxed">
                {t('results.salaryAlert.successBody', { amount: thresholdLabel })}
              </p>
            </>
          ) : (
            <>
              <p className="text-base sm:text-lg font-bold font-display text-strong mb-1">
                {t('results.salaryAlert.headline', { amount: thresholdLabel })}
              </p>
              <p className="text-sm text-subtle leading-relaxed mb-4">
                {t('results.salaryAlert.body')}
              </p>
              {status === 'error' && (
                <p className="text-sm text-danger mb-3" role="alert">
                  {t('results.salaryAlert.error')}
                </p>
              )}
              {status === 'capture' ? (
                <div className="mt-4 space-y-3" data-testid="salary-alert-capture">
                  {captureStatus === 'sent' ? (
                    <div className="rounded-xl border border-success-border bg-success-subtle px-3 py-3 text-sm text-success" role="status">
                      <p className="font-semibold flex items-center gap-2">
                        <Mail size={16} aria-hidden="true" />
                        {t('results.salaryAlert.capture.checkEmailTitle')}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed">{t('results.salaryAlert.capture.checkEmailBody')}</p>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-xl border border-edge bg-surface/80 px-3 py-3">
                        <p className="text-sm font-semibold text-strong">{t('results.salaryAlert.capture.title')}</p>
                        <p className="mt-1 text-xs text-subtle leading-relaxed">{t('results.salaryAlert.capture.body')}</p>
                      </div>
                      <SocialSignInButtons
                        locale={alertLocale}
                        layout="grid"
                        googleWidth={360}
                        errorContext="salaryAlertCapture"
                        onAuthIntent={() => Analytics.trackFunnelStep('salary_alert_auth_start', { funnel: 'salary_alert', capture_surface: 'calculator_results' })}
                      />
                      <div className="flex items-center gap-3" aria-hidden="true">
                        <div className="flex-1 h-px bg-edge" />
                        <span className="text-[11px] uppercase tracking-wider text-muted">{t('results.salaryAlert.capture.or')}</span>
                        <div className="flex-1 h-px bg-edge" />
                      </div>
                      <form onSubmit={handleCaptureSubmit} className="space-y-2">
                        <label htmlFor="salary-alert-email" className="sr-only">{t('results.salaryAlert.capture.emailLabel')}</label>
                        <EmailInput
                          id="salary-alert-email"
                          value={captureEmail}
                          onChange={(value) => {
                            setCaptureEmail(value);
                            if (captureStatus === 'error') setCaptureStatus('idle');
                          }}
                          placeholder={t('newsletter.emailPlaceholder')}
                          className="w-full px-4 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm"
                        />
                        {captureStatus === 'error' && captureError && (
                          <p className="text-xs text-danger" role="alert">{captureError}</p>
                        )}
                        <button
                          type="submit"
                          disabled={captureStatus === 'submitting'}
                          aria-busy={captureStatus === 'submitting'}
                          className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-accent text-on-accent px-4 py-2.5 text-sm font-semibold hover:bg-accent-hover disabled:opacity-60"
                        >
                          {captureStatus === 'submitting' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}
                          {t('results.salaryAlert.capture.emailCta')}
                        </button>
                      </form>
                    </>
                  )}
                  <p className="flex items-start gap-1.5 text-xs text-muted leading-relaxed">
                    <Shield size={13} className="text-success shrink-0 mt-0.5" aria-hidden="true" />
                    <ConsentNotice consentKey="communicationsOptIn" locale={alertLocale} className="text-[10px] text-muted leading-snug block" />
                  </p>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleAccept}
                    disabled={status === 'submitting'}
                    aria-busy={status === 'submitting'}
                    className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl bg-success-strong text-on-accent font-bold text-sm shadow-sm hover:bg-success-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2 transition-[color,background-color,box-shadow] disabled:opacity-60"
                  >
                    {status === 'submitting' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    {status === 'error' ? t('results.salaryAlert.retry') : t('results.salaryAlert.button')}
                  </button>
                  <ConsentNotice
                    consentKey="communicationsOptIn"
                    locale={alertLocale}
                    className="mt-2 text-[11px] text-muted leading-relaxed block"
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SalaryAlertCTA;
