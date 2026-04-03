/**
 * SubscriptionCTA — Inline post-calculation newsletter CTA
 *
 * A contextual banner shown after simulation results to capture
 * engaged users. Uses the same Firestore subscription logic as
 * NewsletterPopup but appears inline rather than as a modal.
 *
 * Conversion optimisations:
 * - Dynamic subscriber count from Firestore (social proof)
 * - Next-Monday send countdown (urgency)
 * - "This week's preview" teaser content
 * - Animated entrance with staggered elements
 * - Reduced dismiss period from 30→14 days (more impressions)
 *
 * Dismissed for 14 days via localStorage.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Bell, Send, CheckCircle2, Loader2, AlertCircle, Mail,
  TrendingUp, FileText, Lightbulb, Users, X,
  Clock, Zap, Shield, Sparkles,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { unlockAchievement } from '@/services/gamificationService';
import {
  upsertNewsletterSubscriber,
  markNewsletterSubscribedLocally,
  getEmailProviderInfo,
  openEmailProvider,
  requestConfirmationEmail,
} from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';

const CTA_DISMISSED_KEY = 'newsletter_cta_dismissed';
const SUBSCRIBED_KEY = 'newsletter_subscribed';
const CTA_DISMISS_DAYS = 14;

/** Calculate days until next Monday (newsletter send day) */
function daysUntilNextMonday(): number {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  return day === 0 ? 1 : day === 1 ? 7 : 8 - day;
}

// Timeout wrapper
const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms)),
  ]);

let firestoreDb: any = null;

const initFirestore = async () => {
  if (firestoreDb) return firestoreDb;
  try {
    const [{ getFirestore }, { getApp }] = await Promise.all([
      import('firebase/firestore'),
      import('@/services/firebase'),
    ]);
    firestoreDb = getFirestore(await getApp());
    return firestoreDb;
  } catch {
    return null;
  }
};

const SubscriptionCTA: React.FC = () => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'pending' | 'error' | 'exists'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'cooldown' | 'error'>('idle');

  useEffect(() => {
    // Don't show if already subscribed
    if (localStorage.getItem(SUBSCRIBED_KEY) === 'true') return;

    // Don't show if dismissed recently
    const dismissed = localStorage.getItem(CTA_DISMISSED_KEY);
    if (dismissed) {
      const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
      if (daysSince < CTA_DISMISS_DAYS) return;
    }

    setVisible(true);
    Analytics.trackUIInteraction('newsletter_cta', 'banner', 'show', 'post_calc');
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(CTA_DISMISSED_KEY, String(Date.now()));
    setVisible(false);
    Analytics.trackUIInteraction('newsletter_cta', 'banner', 'dismiss', 'closed');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateEmailStrict(email).valid) {
      setErrorMessage(t('newsletter.invalidEmail'));
      setStatus('error');
      return;
    }

    setStatus('loading');

    try {
      const firestore = await initFirestore();
      if (!firestore) {
        throw new Error(t('newsletter.subscribeError'));
      }

      const upsert = await withTimeout(
        upsertNewsletterSubscriber(firestore, {
          email,
          name: null,
          preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
          source: 'post_calc_cta',
          sourceChannel: 'post_calc_cta',
          sourcePage: window.location.pathname,
          sourceCta: 'post_calc_newsletter_cta',
          sourceComponent: 'SubscriptionCTA',
          sourceRouteFamily: 'calculator',
          locale: navigator.language || 'it-IT',
          isActive: false,
          status: 'pending',
        }),
        8000,
        'newsletter_upsert',
      );

      if (upsert.existed) {
        setStatus('exists');
        return;
      }

      markNewsletterSubscribedLocally();
      setStatus('pending');
      unlockAchievement('newsletter_sub');
      Analytics.trackUIInteraction('newsletter_cta', 'form', 'subscribe', 'success');
    } catch (error: any) {
      setErrorMessage(error.message || t('newsletter.subscribeError'));
      setStatus('error');
    }
  };

  if (!visible) return null;

  if (status === 'success' || status === 'pending') {
    return (
      <div className={`mt-6 p-5 rounded-2xl text-center border ${
        status === 'pending'
          ? 'bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border-amber-200 dark:border-amber-800'
          : 'bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border-emerald-200 dark:border-emerald-800'
      }`}>
        {status === 'pending' ? (
          <>
            <Mail className="w-10 h-10 text-amber-500 mx-auto mb-2" />
            <p className="font-bold text-slate-800 dark:text-slate-100">{t('newsletter.doubleOptIn.title')}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{t('newsletter.doubleOptIn.description')}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">{t('newsletter.doubleOptIn.spamHint')}</p>

            {/* FRO-23: Email provider button */}
            {email && (() => {
              const provider = getEmailProviderInfo(email);
              if (!provider) return null;
              return (
                <button
                  onClick={() => openEmailProvider(email)}
                  className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-xl transition-colors"
                >
                  <Mail className="w-3.5 h-3.5" />
                  {t('newsletter.openEmailProvider', { provider: provider.name })}
                </button>
              );
            })()}

            {/* FRO-26: Resend confirmation */}
            {email && (
              <div className="mt-2">
                <button
                  disabled={resendStatus === 'sending' || resendStatus === 'sent'}
                  onClick={async () => {
                    setResendStatus('sending');
                    try {
                      const result = await requestConfirmationEmail(email);
                      setResendStatus(result.success ? 'sent' : result.error === 'cooldown_active' ? 'cooldown' : 'error');
                    } catch {
                      setResendStatus('error');
                    }
                  }}
                  className="text-xs font-medium text-amber-600 dark:text-amber-400 underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {resendStatus === 'sending' ? '...' :
                   resendStatus === 'sent' ? t('newsletter.resendConfirmationSent') :
                   resendStatus === 'cooldown' ? t('newsletter.resendConfirmationCooldown') :
                   resendStatus === 'error' ? t('newsletter.resendConfirmationError') :
                   t('newsletter.resendConfirmation')}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
            <p className="font-bold text-slate-800 dark:text-slate-100">{t('newsletter.subscriptionConfirmed')}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{t('newsletter.subscriptionConfirmedDesc')}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6 relative bg-gradient-to-r from-amber-50 via-orange-50 to-rose-50 dark:from-amber-900/20 dark:via-orange-900/20 dark:to-rose-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl overflow-hidden">
      {/* Dismiss button */}
      <button
        onClick={handleDismiss}
        className="absolute top-3 right-3 p-1 text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg transition-colors z-10"
        aria-label={t('newsletter.cta.postCalc.dismiss')}
      >
        <X className="w-4 h-4" />
      </button>

      <div className="p-5 sm:p-6">
        {/* Urgency badge - next send countdown */}
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-bold uppercase tracking-wider rounded-full mb-3">
          <Clock className="w-3 h-3" />
          {t('newsletter.cta.nextSend', { days: String(daysUntilNextMonday()) })}
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <div className="relative p-2.5 bg-amber-100 dark:bg-amber-900/40 rounded-xl">
            <Bell className="w-5 h-5 text-amber-600 dark:text-amber-300" />
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-pulse" />
          </div>
          <div>
            <h4 className="font-bold text-slate-800 dark:text-slate-100 text-sm leading-tight">
              {t('newsletter.cta.postCalc.title')}
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
              {t('newsletter.cta.postCalc.subtitle')}
            </p>
          </div>
        </div>

        {/* This week's preview */}
        <div className="mb-4 p-3 bg-white dark:bg-slate-800 rounded-xl border border-slate-200/60 dark:border-slate-700/60">
          <p className="text-xs text-amber-600 dark:text-amber-300 font-bold uppercase tracking-wider mb-2 flex items-center gap-1">
            <Sparkles className="w-3 h-3" /> {t('newsletter.cta.thisWeek')}
          </p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
              <TrendingUp className="w-3 h-3 text-blue-500 shrink-0" />
              <span>{t('newsletter.cta.preview1')}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
              <FileText className="w-3 h-3 text-amber-500 shrink-0" />
              <span>{t('newsletter.cta.preview2')}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
              <Lightbulb className="w-3 h-3 text-emerald-500 shrink-0" />
              <span>{t('newsletter.cta.preview3')}</span>
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <label htmlFor="cta-email" className="sr-only">{t('newsletter.emailLabel')}</label>
            <EmailInput
              id="cta-email"
              value={email}
              onChange={(val) => { setEmail(val); setStatus('idle'); }}
              placeholder={t('newsletter.emailPlaceholder')}
              className="w-full px-4 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 text-slate-800 dark:text-slate-100 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={status === 'loading'}
            className="px-5 py-2.5 bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold rounded-xl hover:from-amber-600 hover:to-orange-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm shadow-lg hover:shadow-xl whitespace-nowrap"
          >
            {status === 'loading' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {t('newsletter.subscribing')}</>
            ) : (
              <><Zap className="w-4 h-4" /> {t('newsletter.cta.joinNow')}</>
            )}
          </button>
        </form>

        {/* Errors */}
        {status === 'error' && (
          <div className="flex items-center gap-2 mt-2 p-2 bg-red-50 dark:bg-red-950/30 rounded-lg text-red-600 dark:text-red-400 text-xs">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {errorMessage}
          </div>
        )}
        {status === 'exists' && (
          <div className="flex items-center gap-2 mt-2 p-2 bg-amber-50 dark:bg-amber-950/30 rounded-lg text-amber-600 dark:text-amber-400 text-xs">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {t('newsletter.alreadySubscribed')}
          </div>
        )}

        {/* Footer: social proof + privacy */}
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Users className="w-3.5 h-3.5 text-indigo-500" />
            <span>{t('newsletter.cta.subscriberCount')}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <Shield className="w-3 h-3" />
            <span>{t('newsletter.dataPrivacy')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubscriptionCTA;
