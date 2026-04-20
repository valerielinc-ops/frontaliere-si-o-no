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

import React, { useState, useEffect, useMemo, useRef } from 'react';
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
import { useAuth, renderGoogleButtonWithReadiness, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';

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
 const { t, locale } = useTranslation();
 const { user, signIn: googleSignIn } = useAuth();
 const [visible, setVisible] = useState(false);
 const [email, setEmail] = useState('');
 const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'pending' | 'error' | 'exists'>('idle');
 const [errorMessage, setErrorMessage] = useState('');
 const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'cooldown' | 'error'>('idle');
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const googleButtonRef = useRef<HTMLDivElement>(null);

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

 useEffect(() => { isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {}); }, []);

 useEffect(() => {
 if (!visible || user) {
 if (googleButtonRef.current) googleButtonRef.current.innerHTML = '';
 setGoogleButtonReady(false);
 return;
 }
 let cancelled = false;
 const mount = async () => {
 if (!googleButtonRef.current || cancelled) return;
 try {
 const ready = await renderGoogleButtonWithReadiness(googleButtonRef.current, {
 theme: 'outline', size: 'large', text: 'continue_with', width: 280, locale,
 });
 if (!cancelled) setGoogleButtonReady(ready);
 } catch {
 if (!cancelled) setGoogleButtonReady(false);
 }
 };
 void mount();
 return () => { cancelled = true; };
 }, [visible, user, locale]);

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

 if (!visible || user) return null;

 if (status === 'success' || status === 'pending') {
 return (
 <div className={`mt-6 p-5 rounded-2xl text-center border ${
 status === 'pending'
 ? 'bg-gradient-to-r from-warning-subtle to-warning-subtle border-warning-border'
 : 'bg-gradient-to-r from-success-subtle to-info-subtle border-success-border'
 }`}>
 {status === 'pending' ? (
 <>
 <Mail className="w-10 h-10 text-warning mx-auto mb-2" />
 <p className="font-bold text-strong">{t('newsletter.doubleOptIn.title')}</p>
 <p className="text-xs text-subtle mt-1">{t('newsletter.doubleOptIn.description')}</p>
 <p className="text-xs text-muted mt-2">{t('newsletter.doubleOptIn.spamHint')}</p>

 {/* FRO-23: Email provider button */}
 {email && (() => {
 const provider = getEmailProviderInfo(email);
 if (!provider) return null;
 return (
 <button
 onClick={() => openEmailProvider(email)}
 className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-warning-strong hover:bg-warning-strong-hover text-on-accent text-xs font-semibold rounded-xl transition-colors"
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
 className="text-xs font-medium text-warning underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
 <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-2" />
 <p className="font-bold text-strong">{t('newsletter.subscriptionConfirmed')}</p>
 <p className="text-sm text-subtle mt-1">{t('newsletter.subscriptionConfirmedDesc')}</p>
 </>
 )}
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
 <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
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
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
 <div className="space-y-2">
 <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-xl" />
 {!googleButtonReady && (
 <button type="button" onClick={() => googleSignIn()} className="w-full min-h-[40px] grid grid-cols-[20px_1fr_20px] items-center px-4 py-2 bg-surface border border-edge rounded-xl text-body text-xs font-semibold hover:bg-surface-raised transition-colors">
 <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
 <span className="text-center">{t('newsletter.popup.googleSignIn')}</span>
 <span aria-hidden="true" />
 </button>
 )}
 </div>
 {linkedInAvailable && (
 <button type="button" onClick={() => signInWithLinkedIn()} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-brand-linkedin hover:bg-brand-linkedin-hover text-on-accent text-sm font-semibold transition-colors">
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 <span className="hidden sm:inline">{locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}</span>
 <span className="sm:hidden">LinkedIn</span>
 </button>
 )}
 </div>

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
