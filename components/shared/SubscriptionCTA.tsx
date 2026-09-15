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
 * -"This week's preview" teaser content
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
} from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import EmailConsentCheckbox from '@/components/shared/EmailConsentCheckbox';
import { useAuth } from '@/services/authService';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';

import { NEWSLETTER_CTA_DISMISSED_KEY as CTA_DISMISSED_KEY, isNewsletterCtaEligible } from '@/services/newsletterCtaState';

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
 const { t, locale } = useTranslation();
 const { user } = useAuth();
 // CLS fix (#3529): compute visibility SYNCHRONOUSLY (localStorage) so the
 // banner is part of the component's first commit instead of mounting one
 // effect-tick later (null → ~700px growth mid-flow counted as layout shift).
 // Shared eligibility logic lives in services/newsletterCtaState.ts.
 const [visible, setVisible] = useState(isNewsletterCtaEligible);
 const [email, setEmail] = useState('');
 const [status, setStatus] = useState<'idle' | 'loading' | 'pending' | 'success' | 'error' | 'exists'>('idle');
 const [errorMessage, setErrorMessage] = useState('');

 useEffect(() => {
 if (visible) {
 Analytics.trackUIInteraction('newsletter_cta', 'banner', 'show', 'post_calc');
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps -- fire the "show" event once per mount only
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
 registrationMethod: 'email',
 }),
 8000,
 'newsletter_upsert',
 );

 const needsConfirmation = upsert.status === 'pending' && !upsert.hadConfirmationProof;
 if (upsert.existed && !needsConfirmation) {
 setStatus('exists');
 return;
 }

 if (needsConfirmation) {
 setStatus('pending');
 Analytics.trackUIInteraction('newsletter_cta', 'form', 'subscribe', 'confirmation_pending');
 return;
 }

 markNewsletterSubscribedLocally();
 setStatus('success');
 unlockAchievement('newsletter_sub');
 Analytics.trackUIInteraction('newsletter_cta', 'form', 'subscribe', 'success');
 } catch (error: any) {
 setErrorMessage(error.message || t('newsletter.subscribeError'));
 setStatus('error');
 }
 };

 if (!visible || user) return null;

 if (status === 'pending') {
 return (
 <div className="mt-6 p-5 rounded-2xl text-center border bg-info-subtle border-info-border" role="status" aria-live="polite">
 <Mail className="w-10 h-10 text-info mx-auto mb-2" />
 <p className="font-bold text-strong">{t('newsletter.doubleOptIn.title')}</p>
 <p className="text-sm text-subtle mt-1">{t('newsletter.doubleOptIn.description')}</p>
 <p className="text-xs text-muted mt-2">{t('newsletter.doubleOptIn.spamHint')}</p>
 </div>
 );
 }

 if (status === 'success') {
 return (
 <div className="mt-6 p-5 rounded-2xl text-center border bg-gradient-to-r from-success-subtle to-info-subtle border-success-border">
 <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-2" />
 <p className="font-bold text-strong">{t('newsletter.subscriptionConfirmed')}</p>
 <p className="text-sm text-subtle mt-1">{t('newsletter.subscriptionConfirmedDesc')}</p>
 </div>
 );
 }

 return (
 <div className="mt-6 relative bg-gradient-to-r from-warning-subtle via-warning-subtle to-danger-subtle border border-warning-border rounded-2xl overflow-hidden">
 {/* Dismiss button */}
 <button
 onClick={handleDismiss}
 className="absolute top-1 right-1 p-3 min-w-[44px] min-h-[44px] flex items-center justify-center text-muted hover:text-body rounded-lg transition-colors z-10"
 aria-label={t('newsletter.cta.postCalc.dismiss')}
 >
 <X className="w-4 h-4" />
 </button>

 <div className="p-5 sm:p-6">
 {/* Urgency badge - next send countdown */}
 <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-warning-subtle text-warning text-xs font-bold uppercase tracking-wider rounded-full mb-3">
 <Clock className="w-3 h-3" />
 {t('newsletter.cta.nextSend', { days: String(daysUntilNextMonday()) })}
 </div>

 {/* Header */}
 <div className="flex items-center gap-3 mb-3">
 <div className="relative p-2.5 bg-warning-subtle rounded-xl">
 <Bell className="w-5 h-5 text-warning" />
 <span className="absolute -top-1 -right-1 w-3 h-3 bg-danger-strong rounded-full" />
 </div>
 <div>
 <h4 className="font-bold text-strong text-sm leading-tight">
 {t('newsletter.cta.postCalc.title')}
 </h4>
 <p className="text-sm text-subtle mt-0.5">
 {t('newsletter.cta.postCalc.subtitle')}
 </p>
 </div>
 </div>

 {/* This week's preview */}
 <div className="mb-4 p-3 bg-surface rounded-xl border border-edge/60">
 <p className="text-xs text-warning font-bold uppercase tracking-wider mb-2 flex items-center gap-1">
 <Sparkles className="w-3 h-3" /> {t('newsletter.cta.thisWeek')}
 </p>
 <div className="space-y-1.5">
 <div className="flex items-center gap-2 text-xs text-body">
 <TrendingUp className="w-3 h-3 text-accent shrink-0" />
 <span>{t('newsletter.cta.preview1')}</span>
 </div>
 <div className="flex items-center gap-2 text-xs text-body">
 <FileText className="w-3 h-3 text-warning shrink-0" />
 <span>{t('newsletter.cta.preview2')}</span>
 </div>
 <div className="flex items-center gap-2 text-xs text-body">
 <Lightbulb className="w-3 h-3 text-success shrink-0" />
 <span>{t('newsletter.cta.preview3')}</span>
 </div>
 </div>
 </div>

 {/* Form */}
 <form onSubmit={handleSubmit} className="flex flex-col gap-2">
 <div className="flex flex-col sm:flex-row gap-2">
 <div className="flex-1">
 <label htmlFor="cta-email" className="sr-only">{t('newsletter.emailLabel')}</label>
 <EmailInput
 id="cta-email"
 value={email}
 onChange={(val) => { setEmail(val); setStatus('idle'); }}
 placeholder={t('newsletter.emailPlaceholder')}
 className="w-full px-4 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-info text-strong text-sm"
 />
 </div>
 <button
 type="submit"
 disabled={status === 'loading'}
 className="px-5 py-2.5 bg-gradient-to-r from-warning-strong to-warning-strong text-on-accent font-bold rounded-xl hover:from-warning-strong hover:to-warning-strong-hover transition-[color,background-color,border-color,box-shadow,opacity] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm shadow-lg hover:shadow-xl whitespace-nowrap"
 >
 {status === 'loading' ? (
 <><Loader2 className="w-4 h-4 animate-spin" /> {t('newsletter.subscribing')}</>
 ) : (
 <><Zap className="w-4 h-4" /> {t('newsletter.cta.joinNow')}</>
 )}
 </button>
 </div>
 <EmailConsentCheckbox
   id="subscription-cta-consent"
   consentKey="communicationsOptIn"
   locale={locale}
   className="flex items-start gap-2"
 />
 </form>

 {/* Errors */}
 {status === 'error' && (
 <div className="flex items-center gap-2 mt-2 p-2 bg-danger-subtle rounded-lg text-danger text-xs">
 <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {errorMessage}
 </div>
 )}
 {status === 'exists' && (
 <div className="flex items-center gap-2 mt-2 p-2 bg-warning-subtle rounded-lg text-warning text-xs">
 <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {t('newsletter.alreadySubscribed')}
 </div>
 )}

 {/* Social sign-in */}
 <div className="flex items-center gap-3 mt-3 mb-2">
 <div className="flex-1 h-px bg-surface-raised" />
 <span className="text-xs text-muted">{locale === 'it' ? 'oppure' : locale === 'de' ? 'oder' : locale === 'fr' ? 'ou' : 'or'}</span>
 <div className="flex-1 h-px bg-surface-raised" />
 </div>
 <SocialSignInButtons
 locale={locale}
 layout="grid"
 googleWidth={280}
 googleFallbackVariant="sm"
 linkedInResponsiveLabel
 errorContext="subscriptionCta"
 />


 {/* Footer: social proof + privacy */}
 <div className="flex items-center justify-between mt-3">
 <div className="flex items-center gap-1.5 text-xs text-muted">
 <Users className="w-3.5 h-3.5 text-accent" />
 <span>{t('newsletter.cta.subscriberCount')}</span>
 </div>
 <div className="flex items-center gap-1.5 text-sm text-success">
 <Shield className="w-3 h-3" />
 <span>{t('newsletter.dataPrivacy')}</span>
 </div>
 </div>
 </div>
 </div>
 );
};

export default SubscriptionCTA;
