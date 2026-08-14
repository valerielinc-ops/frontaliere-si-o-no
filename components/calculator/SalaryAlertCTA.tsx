/**
 * SalaryAlertCTA — one-tap salary alert from the calculator results (issue #4469).
 *
 * Closes the calculator → job → email loop at the highest-intent moment: right
 * after a simulation, offer "avvisami quando escono offerte con netto ≥ CHF X".
 * The threshold is prefilled from the simulated monthly net (floored to a clean
 * CHF 100) and the alert is geo-scoped to Ticino — the criteria the visitor just
 * expressed by running the simulation.
 *
 * Auth handling mirrors SavedJobsAlertNudge (the established one-tap pattern):
 *   • known user (uid+email) → `subscribeSalaryAlert` in ONE tap;
 *   • anonymous → stash the full criteria via `savePendingJobAlert` and hand off
 *     to the always-mounted JobAlertForm on the job board (`requestJobAlertOpen`),
 *     which owns the auth/email capture + post-auth replay.
 *
 * Rendered unconditionally (no async flag gate) so it never shifts layout — zero
 * CLS, Auto Ads untouched (Non-Negotiable #7).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useAuth } from '@/services/authService';
import { useNavigationOptional } from '@/services/NavigationContext';
import { savePendingJobAlert } from '@/services/pendingJobAlert';
import { requestJobAlertOpen } from '@/services/jobAlertOpenSignal';
import {
  buildSalaryAlertConfig,
  subscribeSalaryAlert,
  upgradeBackfilledAlertConsent,
} from '@/services/jobAlertService';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { JOB_ALERT_SUBSCRIBED_KEY } from '@/services/jobAlertCtaState';

const VIEW_SESSION_KEY = 'salary_alert_cta_viewed';
const CTA_ID = 'calculator_salary_alert';
const ALERT_CANTON = 'TI';

interface Props {
  /** Simulated monthly net (CHF) that seeds the alert threshold. */
  netMonthlyCHF: number;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

/** Floor a net figure to a clean CHF 100 so the copy reads "≥ CHF 4 300". */
function floorToHundred(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 100) * 100;
}

export const SalaryAlertCTA: React.FC<Props> = ({ netMonthlyCHF }) => {
  const { t, locale } = useTranslation();
  const nav = useNavigationOptional();
  const { user } = useAuth();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');

  const threshold = floorToHundred(netMonthlyCHF);
  const alertLocale = (locale as 'it' | 'en' | 'de' | 'fr') || 'it';

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
    if (status === 'submitting') return;
    Analytics.trackCtaClick(CTA_ID, {
      component: 'SalaryAlertCTA',
      section: 'calculator_results',
      label: 'salary_alert_accept',
    });
    Analytics.trackFunnelStep('salary_alert_accept', {
      funnel: 'salary_alert',
      authed: Boolean(user?.uid),
    });

    const uid: string | undefined = user?.uid;
    const email: string | null | undefined = user?.email;

    // Anonymous: stash the full criteria and hand off to the job-board form,
    // which owns auth/email capture and replays the pending alert post-auth.
    if (!uid || !email) {
      savePendingJobAlert(
        buildSalaryAlertConfig({
          cantonCode: ALERT_CANTON,
          minNetMonthlyCHF: threshold,
          locale: alertLocale,
        }),
      );
      requestJobAlertOpen();
      if (nav) nav.navigateTo('job-board');
      else if (typeof window !== 'undefined') window.location.assign('/lavoro/');
      return;
    }

    setStatus('submitting');
    try {
      await subscribeSalaryAlert(uid, email, {
        cantonCode: ALERT_CANTON,
        minNetMonthlyCHF: threshold,
        locale: alertLocale,
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
      // #5876 — an explicit tap on "attiva alert" under the notice below. If
      // this person's alert came from the travaso, the act converts the deduced
      // consent into an explicit one. Never awaited into the catch: the
      // subscription succeeded whatever the proof write does.
      void upgradeBackfilledAlertConsent(email, alertLocale).catch(() => {});
    } catch {
      setStatus('error');
    }
  }, [status, user, threshold, alertLocale, nav]);

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
              <button
                type="button"
                onClick={handleAccept}
                disabled={status === 'submitting'}
                aria-busy={status === 'submitting'}
                className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl bg-success-strong text-on-accent font-bold text-sm shadow-sm hover:bg-success-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2 transition-[color,background-color,box-shadow] disabled:opacity-60"
              >
                {status === 'submitting' && (
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                )}
                {status === 'error'
                  ? t('results.salaryAlert.retry')
                  : t('results.salaryAlert.button')}
              </button>
              <ConsentNotice
                consentKey="communicationsOptIn"
                locale={alertLocale}
                className="mt-2 text-[11px] text-muted leading-relaxed block"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SalaryAlertCTA;
