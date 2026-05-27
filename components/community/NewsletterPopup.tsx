/**
 * NewsletterPopup — Modal with smart timing (20s on site + 30% scroll)
 * 
 * Shows a compact newsletter signup modal. Dismissed state is
 * remembered for 7 days. Does not show if already subscribed.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Bell, Send, CheckCircle2, Loader2, AlertCircle, LogIn, Shield, TrendingUp, FileText, Lightbulb, Users, Mail } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { unlockAchievement } from '@/services/gamificationService';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';
import { useAuth, promptOneTap, cancelOneTap, getAuthEmail, eagerAuth, renderGoogleButtonWithReadiness, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';
import { useNavigationOptional } from '@/services/NavigationContext';
import {
 upsertNewsletterSubscriber,
 markNewsletterSubscribedLocally,
 getNewsletterPendingEmail,
 getEmailProviderInfo,
 openEmailProvider,
 requestConfirmationEmail,
} from '@/services/newsletterSubscribers';

const POPUP_DISMISSED_KEY = 'newsletter_popup_dismissed';
const SUBSCRIBED_KEY = 'newsletter_subscribed';
const DISMISS_DAYS = 7;
const MIN_TIME_MS = 20_000; // 20 seconds minimum on site
const SCROLL_THRESHOLD = 0.3; // 30% scroll depth — long blog articles were firing the popup near the end at 0.5
const PAGE_VIEW_THRESHOLD = 3; // show after 3+ page views in session
const PAGE_VIEW_KEY = 'newsletter_pageviews';
const NEWSLETTER_ONETAP_KEY = 'onetap_prompted_newsletter_popup';

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
 } catch (e) {
 reportCaughtError(e, 'newsletterPopup.firestoreInit');
 return null;
 }
};

const NewsletterPopup: React.FC = () => {
 const { t, locale } = useTranslation();
 const nav = useNavigationOptional();
 const [visible, setVisible] = useState(false);
 const [queueActive, setQueueActive] = useState(false);
 const [email, setEmail] = useState('');
 const [consentChecked, setConsentChecked] = useState(false);
 const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'pending' | 'error' | 'exists'>('idle');
 const [errorMessage, setErrorMessage] = useState('');
 const [reminderMode, setReminderMode] = useState(false);
 const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'cooldown' | 'error'>('idle');
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const { user, signIn: googleSignIn, signInFacebook: facebookSignIn } = useAuth();
 const userRef = useRef(user);
 const googleButtonRef = useRef<HTMLDivElement>(null);
 useEffect(() => { userRef.current = user; }, [user]);
 useEffect(() => { isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {}); }, []);
 const timeReady = useRef(false);
 const scrollReady = useRef(false);
 const exitIntentFired = useRef(false);
 const [triggerSource, setTriggerSource] = useState<'smart' | 'exit_intent' | 'pageviews'>('smart');

 // Never show popup for crawlers / bots — they must see full page content
 const isCrawlerVisitor = useMemo(
 () =>
 /bot|crawler|spider|crawling|googlebot|bingbot|yandexbot|duckduckbot|baiduspider|semrushbot|ahrefsbot|applebot|slurp|facebookexternalhit|linkedinbot|twitterbot|whatsapp/i.test(
 navigator.userAgent || ''
 ),
 []
 );

 // Pre-fill email from auth account (checks providerData for Facebook users)
 useEffect(() => {
 const authEmail = getAuthEmail(user);
 if (authEmail && !email) {
 setEmail(authEmail);
 }
 }, [user]);

 // Try silent sign-in: check if Firebase already has a cached user session
 useEffect(() => {
 const trySilentAuth = async () => {
 try {
 const [{ getAuth }, { getApp }] = await Promise.all([
 import('firebase/auth'),
 import('@/services/firebase'),
 ]);
 const appInstance = await getApp();
 const auth = getAuth(appInstance);
 // onAuthStateChanged fires with cached user if session exists
 const unsub = auth.onAuthStateChanged((u) => {
 if (u?.email && !email) {
 setEmail(u.email);
 }
 unsub();
 });
 } catch {
 // Ad blocker or network issue — silent fail, user can still
 // enter email manually.
 }
 };
 trySilentAuth();
 }, []);

 useEffect(() => {
 // Don't show for crawlers / bots (they must see full page content)
 if (isCrawlerVisitor) return;

 // FRO-407: Don't show on profile page — popup z-index blocks Google One Tap login
 if (/^\/(profilo|profile|profil|en\/profile|de\/profil|fr\/profil)\/?$/.test(window.location.pathname)) return;

 // FRO-25: Check for pending confirmation (> 1 hour old)
 const pendingInfo = getNewsletterPendingEmail();
 const ONE_HOUR = 60 * 60 * 1000;
 if (pendingInfo && Date.now() - pendingInfo.since > ONE_HOUR) {
 // Check dismiss cooldown even for reminders
 const dismissed = localStorage.getItem(POPUP_DISMISSED_KEY);
 if (dismissed) {
 const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
 if (daysSince < 1) return; // 1-day cooldown for reminders (shorter than normal 7-day)
 }
 setEmail(pendingInfo.email);
 setReminderMode(true);
 setStatus('pending');
 setVisible(true);
 requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER);
 Analytics.trackUIInteraction('newsletter_popup', 'modal', 'show', 'pending_reminder');
 return;
 }

 // Don't show if already subscribed
 if (localStorage.getItem(SUBSCRIBED_KEY) === 'true') return;

 // Don't show if user is signed in (auto-subscribed on signup)
 if (user) return;

 // Don't show if dismissed recently
 const dismissed = localStorage.getItem(POPUP_DISMISSED_KEY);
 if (dismissed) {
 const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
 if (daysSince < DISMISS_DAYS) return;
 }

 const checkAndShow = () => {
 if (userRef.current) return;
 if (timeReady.current && scrollReady.current) {
 if (localStorage.getItem(SUBSCRIBED_KEY) !== 'true') {
 setVisible(true);
 requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER);
 Analytics.trackUIInteraction('newsletter_popup', 'modal', 'show', 'smart_trigger');
 }
 }
 };

 const timer = setTimeout(() => {
 timeReady.current = true;
 checkAndShow();
 }, MIN_TIME_MS);

 const onScroll = () => {
 if (scrollReady.current) return;
 const scrollPercent = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
 if (scrollPercent >= SCROLL_THRESHOLD) {
 scrollReady.current = true;
 checkAndShow();
 }
 };
 window.addEventListener('scroll', onScroll, { passive: true });

 // Exit-intent detection (desktop only): when mouse leaves viewport top
 const onMouseLeave = (e: MouseEvent) => {
 if (exitIntentFired.current) return;
 if (userRef.current) return;
 if (e.clientY <= 0 && timeReady.current) {
 exitIntentFired.current = true;
 if (localStorage.getItem(SUBSCRIBED_KEY) !== 'true') {
 setTriggerSource('exit_intent');
 setVisible(true);
 requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER);
 Analytics.trackUIInteraction('newsletter_popup', 'modal', 'show', 'exit_intent');
 }
 }
 };

 // Page-view counter: alternative trigger after 3+ pages visited
 const pageViews = parseInt(sessionStorage.getItem(PAGE_VIEW_KEY) || '0', 10) + 1;
 sessionStorage.setItem(PAGE_VIEW_KEY, String(pageViews));
 if (pageViews >= PAGE_VIEW_THRESHOLD && !scrollReady.current) {
 // After enough page exploration, trigger even without deep scroll
 const pageViewTimer = setTimeout(() => {
 if (localStorage.getItem(SUBSCRIBED_KEY) !== 'true' && !exitIntentFired.current && !userRef.current) {
 scrollReady.current = true;
 setTriggerSource('pageviews');
 checkAndShow();
 }
 }, MIN_TIME_MS);
 // Store for cleanup
 (window as any).__nlPageViewTimer = pageViewTimer;
 }

 const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
 if (!isMobile) {
 document.documentElement.addEventListener('mouseleave', onMouseLeave);
 }

 // Subscribe to popup queue
 const unsub = subscribe(() => setQueueActive(isActive('newsletter-popup')));

 return () => {
 clearTimeout(timer);
 window.removeEventListener('scroll', onScroll);
 if (!isMobile) {
 document.documentElement.removeEventListener('mouseleave', onMouseLeave);
 }
 if ((window as any).__nlPageViewTimer) {
 clearTimeout((window as any).__nlPageViewTimer);
 }
 unsub();
 };
 }, []);

 // Auto-dismiss if user signs in while popup is visible
 useEffect(() => {
 if (user && visible) {
 setVisible(false);
 releaseSlot('newsletter-popup');
 }
 }, [user, visible]);

 // Hide AdSense auto-ads while the popup is showing (they use z-index 2147483647).
 // CSS selectors in index.css handle most cases, but vignette/overlay ads inject
 // wrapper divs without predictable IDs — force-hide them via JS + MutationObserver.
 useEffect(() => {
 const isOpen = visible && queueActive;
 document.body.classList.toggle('modal-open', isOpen);
 if (!isOpen) return () => { document.body.classList.remove('modal-open'); };

 const hideGoogleOverlays = () => {
 // Vignette/overlay wrappers: fixed-positioned parents of aswift iframes
 document.querySelectorAll('iframe[id^="aswift_"]').forEach((iframe) => {
 let el = iframe.parentElement;
 while (el && el !== document.body) {
 const style = getComputedStyle(el);
 if (style.position === 'fixed' || style.position === 'absolute') {
 (el as HTMLElement).style.setProperty('display', 'none', 'important');
 break;
 }
 el = el.parentElement;
 }
 });
 // Google auto-placed containers
 document.querySelectorAll('.google-auto-placed').forEach((el) => {
 (el as HTMLElement).style.setProperty('display', 'none', 'important');
 });
 };

 hideGoogleOverlays();
 const observer = new MutationObserver(hideGoogleOverlays);
 observer.observe(document.body, { childList: true, subtree: true });

 return () => {
 observer.disconnect();
 document.body.classList.remove('modal-open');
 // Restore — AdSense will re-render on next page interaction
 document.querySelectorAll('.google-auto-placed').forEach((el) => {
 (el as HTMLElement).style.removeProperty('display');
 });
 };
 }, [visible, queueActive]);

 // Google One Tap: prompt when the popup is actually visible (slot active).
 useEffect(() => {
 if (!visible || !queueActive) return;
 if (user) return;
 if (localStorage.getItem(SUBSCRIBED_KEY) === 'true') return;
 if (sessionStorage.getItem(NEWSLETTER_ONETAP_KEY)) return;

 sessionStorage.setItem(NEWSLETTER_ONETAP_KEY, '1');
 eagerAuth();
 promptOneTap();

 return () => {
 cancelOneTap();
 };
 }, [visible, queueActive, user]);

 useEffect(() => {
 let cancelled = false;

 const mountButton = async () => {
 if (!visible || !queueActive || user) {
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
 reportCaughtError(error, 'newsletterPopup.renderGoogleButton');
 }
 }
 };

 void mountButton();
 return () => {
 cancelled = true;
 };
 }, [visible, queueActive, user, locale]);

 const handleDismiss = () => {
 localStorage.setItem(POPUP_DISMISSED_KEY, String(Date.now()));
 setVisible(false);
 releaseSlot('newsletter-popup');
 cancelOneTap();
 Analytics.trackUIInteraction('newsletter_popup', 'modal', 'dismiss', 'closed');
 };

 const validateEmail = (emailStr: string) => validateEmailStrict(emailStr).valid;

 const CONSENT_TEXT = 'Accetto di ricevere la newsletter settimanale con aggiornamenti su cambio CHF/EUR, traffico di frontiera e novità fiscali per frontalieri. Posso disiscrivermi in qualsiasi momento.';

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!validateEmail(email)) {
 setErrorMessage(t('newsletter.invalidEmail'));
 setStatus('error');
 return;
 }
 if (!consentChecked) {
 setErrorMessage(t('newsletter.consentRequired'));
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
 source: 'popup',
 sourceChannel: 'popup',
 sourcePage: window.location.pathname,
 sourceCta: 'newsletter_popup_submit',
 sourceComponent: 'NewsletterPopup',
 sourceRouteFamily: nav?.activeTab || 'web_app',
 locale: navigator.language || 'it-IT',
 isActive: false,
 status: 'pending',
 consentGiven: true,
 consentText: CONSENT_TEXT,
 consentMethod: 'email_checkbox',
 consentUserAgent: navigator.userAgent,
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
 Analytics.trackUIInteraction('newsletter_popup', 'form', 'subscribe', 'success');
 } catch (error: any) {
 reportCaughtError(error, 'newsletterPopup.subscribe');
 setErrorMessage(error.message || t('newsletter.subscribeError'));
 setStatus('error');
 }
 };

 if (!visible || !queueActive) return null;

 // Render via portal to escape React root's stacking context.
 // AdSense auto-ads are injected outside #root with z-index: 2147483647,
 // so the popup must also be outside #root to compete in the same context.
 const portalTarget = document.getElementById('modal-root') || document.body;

 return createPortal(
 <div className="fixed inset-0 z-[2147483647] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in">
 <div className="relative w-full max-w-md max-h-[90dvh] flex flex-col bg-surface rounded-2xl shadow-2xl border border-edge overflow-hidden">
 {/* Header gradient */}
 <div className="bg-gradient-to-r from-info-strong to-success-strong p-4 sm:p-6 text-on-accent shrink-0">
 <button
 onClick={handleDismiss}
 className="absolute top-3 right-3 p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-on-accent/70 hover:text-on-accent hover:bg-on-accent/20 rounded-lg transition-colors"
 aria-label={t('newsletter.popup.close')}
 >
 <X className="w-5 h-5" />
 </button>
 <div className="flex items-center gap-3 mb-2">
 <div className="p-2 bg-on-accent/20 rounded-xl">
 <Bell className="w-6 h-6" />
 </div>
 <h2 className="text-xl font-bold font-display">
 {triggerSource === 'exit_intent' ? t('newsletter.exitIntent.title') : t('newsletter.popup.title')}
 </h2>
 </div>
 <p className="text-on-accent/80 text-sm">
 {triggerSource === 'exit_intent' ? t('newsletter.exitIntent.subtitle') : t('newsletter.popup.subtitle')}
 </p>
 </div>

 {/* Body */}
 <div className="p-6 overflow-y-auto overscroll-contain">
 {(status === 'success' || status === 'pending') ? (
 <div className="text-center py-4">
 {status === 'pending' ? (
 <>
 <Mail className="w-12 h-12 text-warning mx-auto mb-3" />
 <p className="font-bold text-strong mb-1">
 {reminderMode ? t('newsletter.pendingReminder.title') : t('newsletter.doubleOptIn.title')}
 </p>
 <p className="text-sm text-subtle">
 {reminderMode ? t('newsletter.pendingReminder.description') : t('newsletter.doubleOptIn.description')}
 </p>
 <p className="text-xs text-muted mt-2">{t('newsletter.doubleOptIn.spamHint')}</p>

 {/* FRO-23: Email provider button */}
 {email && (() => {
 const provider = getEmailProviderInfo(email);
 if (!provider) return null;
 return (
 <button
 onClick={() => openEmailProvider(email)}
 className="mt-3 inline-flex items-center gap-2 px-5 py-2.5 bg-info-strong hover:bg-info-strong-hover text-on-accent text-sm font-semibold rounded-xl transition-colors"
 >
 <Mail className="w-4 h-4" />
 {t('newsletter.openEmailProvider', { provider: provider.name })}
 </button>
 );
 })()}

 {/* FRO-26: Resend confirmation button */}
 {email && (
 <div className="mt-3">
 <p className="text-sm text-muted mb-1">{t('newsletter.pendingReminder.resend')}</p>
 <button
 disabled={resendStatus === 'sending' || resendStatus === 'sent'}
 onClick={async () => {
 setResendStatus('sending');
 try {
 const result = await requestConfirmationEmail(email);
 if (result.success) {
 setResendStatus('sent');
 } else if (result.error === 'cooldown_active') {
 setResendStatus('cooldown');
 } else {
 setResendStatus('error');
 }
 } catch {
 setResendStatus('error');
 }
 }}
 className="text-xs font-medium text-info hover:text-info underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
 <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-3" />
 <p className="font-bold text-strong mb-1">{t('newsletter.subscriptionConfirmed')}</p>
 <p className="text-sm text-subtle">{t('newsletter.subscriptionConfirmedDesc')}</p>
 </>
 )}
 <button
 onClick={() => {
 setVisible(false);
 releaseSlot('newsletter-popup');
 cancelOneTap();
 }}
 className="mt-4 px-6 py-2 text-sm font-medium text-info hover:bg-info-subtle rounded-xl transition-colors"
 >
 {t('newsletter.popup.close')}
 </button>
 </div>
 ) : (
 <form onSubmit={handleSubmit} className="space-y-4">
 {/* Social proof */}
 <div className="flex items-center gap-2 text-xs text-subtle bg-surface-alt px-3 py-2 rounded-xl">
 <Users className="w-4 h-4 text-info shrink-0" />
 <span className="font-medium">{t('newsletter.socialProof')}</span>
 </div>

 {/* Value propositions */}
 <div className="space-y-1.5">
 <div className="flex items-center gap-2 text-xs text-body">
 <TrendingUp className="w-3.5 h-3.5 text-accent shrink-0" />
 <span>{t('newsletter.valueProp.1')}</span>
 </div>
 <div className="flex items-center gap-2 text-xs text-body">
 <FileText className="w-3.5 h-3.5 text-warning shrink-0" />
 <span>{t('newsletter.valueProp.2')}</span>
 </div>
 <div className="flex items-center gap-2 text-xs text-body">
 <Lightbulb className="w-3.5 h-3.5 text-success shrink-0" />
 <span>{t('newsletter.valueProp.3')}</span>
 </div>
 </div>

 {/* Benefits */}
 <div className="flex gap-2 text-xs text-subtle">
 <span className="px-2 py-1 bg-info-subtle rounded-lg">💱 {t('newsletter.exchangeRate')}</span>
 <span className="px-2 py-1 bg-success-subtle rounded-lg">🚦 {t('newsletter.borderTraffic')}</span>
 <span className="px-2 py-1 bg-danger-subtle rounded-lg">📋 {t('newsletter.taxNews')}</span>
 </div>

 <div className="space-y-2">
 <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-xl" />
 {!googleButtonReady && (
 <button
 type="button"
 onClick={async () => {
 try {
 const u = await googleSignIn();
 if (u?.email) {
 setEmail(u.email);
 Analytics.trackUIInteraction('newsletter_popup', 'button', 'google_signin', 'click');
 }
 } catch { /* user closed */ }
 }}
 className="w-full grid grid-cols-[20px_1fr_20px] items-center py-2.5 px-4 border border-edge rounded-xl text-sm font-semibold text-strong bg-surface hover:bg-surface-raised transition-colors shadow-sm"
 >
 <svg className="w-4 h-4" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
 <span className="text-center">{t('newsletter.popup.googleSignIn')}</span>
 <span aria-hidden="true" />
 </button>
 )}
 </div>

 {/* LinkedIn Sign-In Button (conditional on Remote Config) */}
 {linkedInAvailable && (
 <button
 type="button"
 onClick={() => signInWithLinkedIn()}
 className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-brand-linkedin hover:bg-brand-linkedin-hover text-on-accent text-sm font-semibold transition-colors"
 >
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
 </button>
 )}

 {/* Facebook Sign-In button hidden — Facebook app not yet approved */}
 {/* TODO: Re-enable once Facebook app review is complete */}

 <div className="relative">
 <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-edge" /></div>
 <div className="relative flex justify-center text-xs"><span className="bg-surface px-2 text-muted">{t('newsletter.popup.orEmail')}</span></div>
 </div>

 <div>
 <label htmlFor="popup-email" className="sr-only">{t('newsletter.emailLabel')}</label>
 <EmailInput
 id="popup-email"
 value={email}
 onChange={(val) => { setEmail(val); setStatus('idle'); }}
 placeholder={t('newsletter.emailPlaceholder')}
 className="w-full px-4 py-3 bg-surface-alt border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-info text-strong"
 />
 </div>

 <label className="flex items-start gap-2 cursor-pointer">
 <input
 type="checkbox"
 checked={consentChecked}
 onChange={(e) => { setConsentChecked(e.target.checked); setStatus('idle'); }}
 className="mt-0.5 w-4 h-4 rounded text-info focus-visible:ring-info shrink-0"
 />
 <span className="text-xs text-muted leading-relaxed">
 {t('newsletter.consentLabel')}
 </span>
 </label>

 {status === 'error' && (
 <div className="flex items-center gap-2 p-2 bg-danger-subtle rounded-lg text-danger text-xs">
 <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {errorMessage}
 </div>
 )}
 {status === 'exists' && (
 <div className="flex items-center gap-2 p-2 bg-warning-subtle rounded-lg text-warning text-xs">
 <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {t('newsletter.alreadySubscribed')}
 </div>
 )}

 <button
 type="submit"
 disabled={status === 'loading'}
 className="w-full py-3 bg-gradient-to-r from-info-strong to-success-strong text-on-accent font-bold rounded-xl hover:from-info-strong-hover hover:to-success-strong-hover transition-[color,background-color,border-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg"
 >
 {status === 'loading' ? (
 <><Loader2 className="w-4 h-4 animate-spin" /> {t('newsletter.subscribing')}</>
 ) : (
 <><Send className="w-4 h-4" /> {t('newsletter.subscribeFree')}</>
 )}
 </button>

 <p className="text-xs text-center text-muted">
 {t('newsletter.unsubscribeNotice')}
 {' '}
 <button
 type="button"
 onClick={() => {
 handleDismiss();
 nav?.navigateTo('privacy');
 }}
 className="underline hover:text-info transition-colors"
 >
 {t('newsletter.popup.privacyLink')}
 </button>
 </p>
 <div className="flex items-center justify-center gap-1.5 text-sm text-success">
 <Shield className="w-3 h-3" />
 <span>{t('newsletter.dataPrivacy')}</span>
 </div>
 </form>
 )}
 </div>
 </div>
 </div>,
 portalTarget,
 );
};

export default NewsletterPopup;
