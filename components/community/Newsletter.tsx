import React, { useState, useEffect, useRef } from 'react';
import { Mail, Send, CheckCircle2, AlertCircle, Loader2, Bell, Shield, LogIn } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { useTranslation } from '@/services/i18n';
import { unlockAchievement } from '@/services/gamificationService';
import EmailInput, { validateEmailStrict, checkMxRecord } from '@/components/shared/EmailInput';
import { useAuth, getAuthEmail, eagerAuth, promptOneTap, cancelOneTap, renderGoogleButtonWithReadiness, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';
import {
 upsertNewsletterSubscriber,
 markNewsletterSubscribedLocally,
 getEmailProviderInfo,
 openEmailProvider,
 requestConfirmationEmail,
} from '@/services/newsletterSubscribers';

// Firebase Firestore will be lazily imported
let firestoreInitialized = false;
let db: any = null;

// Timeout wrapper for Firestore operations that may hang indefinitely
const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
 Promise.race([
 promise,
 new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms)),
 ]);

const initFirestore = async () => {
 if (firestoreInitialized) return db;
 try {
 console.log('[Newsletter] Initializing Firestore...');
 const { getFirestore } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 console.log('[Newsletter] Firebase app loaded:', app.name, '| Options:', JSON.stringify({ projectId: app.options.projectId, appId: app.options.appId?.slice(0, 10) + '...' }));
 db = getFirestore(app);
 firestoreInitialized = true;
 console.log('[Newsletter] Firestore initialized successfully');
 return db;
 } catch (error) {
 reportCaughtError(error, 'newsletter.firestoreInit');
 return null;
 }
};

interface NewsletterProps {
 compact?: boolean;
}

const SUBSCRIBED_KEY = 'newsletter_subscribed';
const NEWSLETTER_ONETAP_FOOTER_KEY = 'onetap_prompted_newsletter_footer';

const Newsletter: React.FC<NewsletterProps> = ({ compact = false }) => {
 const { t, locale } = useTranslation();
 const { user, signIn: googleSignIn, signInFacebook: facebookSignIn } = useAuth();
 const [email, setEmail] = useState('');
 const [name, setName] = useState('');
 const [alreadySubscribed] = useState(() => localStorage.getItem(SUBSCRIBED_KEY) === 'true');
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const googleButtonRef = useRef<HTMLDivElement>(null);

 useEffect(() => { isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {}); }, []);

 // Pre-fill email from auth account (checks providerData for Facebook users)
 useEffect(() => {
 const authEmail = getAuthEmail(user);
 if (authEmail && !email) {
 setEmail(authEmail);
 }
 }, [user]);
 const [preferences, setPreferences] = useState({
 exchangeRate: true,
 traffic: true,
 taxUpdates: true,
 tips: false,
 });
 const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'pending' | 'error' | 'exists'>('idle');
 const [errorMessage, setErrorMessage] = useState('');
 const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'cooldown' | 'error'>('idle');

 useEffect(() => {
 if (!compact || user) return;
 if (sessionStorage.getItem(NEWSLETTER_ONETAP_FOOTER_KEY)) return;
 sessionStorage.setItem(NEWSLETTER_ONETAP_FOOTER_KEY, '1');
 eagerAuth();
 promptOneTap();
 return () => cancelOneTap();
 }, [compact, user]);

 useEffect(() => {
 let cancelled = false;

 const mountButton = async () => {
 if (!compact || user) {
 if (googleButtonRef.current) googleButtonRef.current.innerHTML = '';
 setGoogleButtonReady(false);
 return;
 }

 try {
 const ready = await renderGoogleButtonWithReadiness(googleButtonRef.current, {
 theme: 'outline',
 size: 'large',
 text: 'continue_with',
 width: 280,
 locale,
 });
 if (!cancelled) setGoogleButtonReady(ready);
 } catch (error) {
 if (!cancelled) {
 setGoogleButtonReady(false);
 reportCaughtError(error, 'newsletter.renderGoogleButton');
 }
 }
 };

 void mountButton();
 return () => {
 cancelled = true;
 };
 }, [compact, user, locale]);

 const validateEmail = (emailStr: string) => validateEmailStrict(emailStr).valid;

 const handleSubscribe = async (e: React.FormEvent) => {
 e.preventDefault();

 const validation = validateEmailStrict(email);
 if (!validation.valid) {
 setErrorMessage(t(validation.reason === 'gibberish' ? 'newsletter.gibberishEmail' : 'newsletter.invalidEmail'));
 setStatus('error');
 return;
 }

 setStatus('loading');
 Analytics.trackNewsletter('subscribe', email.split('@')[1]);
 console.log('[Newsletter] Subscribe attempt:', { email: email.replace(/(.{2}).*(@.*)/, '$1***$2'), name: name || '(none)', preferences });

 // MX record check (async, fail-open)
 const domain = email.split('@')[1];
 const hasMx = await checkMxRecord(domain);
 if (!hasMx) {
 setErrorMessage(t('newsletter.mxCheckFailed'));
 setStatus('error');
 Analytics.trackNewsletter('error', 'no_mx_record');
 return;
 }

 try {
 const firestore = await initFirestore();
 if (!firestore) {
 throw new Error(t('newsletter.subscribeError'));
 }

 const upsert = await withTimeout(
 upsertNewsletterSubscriber(firestore, {
 email,
 name: name.trim() || null,
 preferences,
 source: 'web_app',
 sourceChannel: 'newsletter_page',
 sourcePage: window.location.pathname,
 sourceCta: compact ? 'newsletter_footer_compact' : 'newsletter_page_submit',
 sourceComponent: compact ? 'NewsletterCompact' : 'Newsletter',
 sourceRouteFamily: compact ? 'footer' : 'newsletter',
 locale: navigator.language || 'it-IT',
 isActive: false, // pending until double opt-in confirmed
 status: 'pending',
 }),
 8000,
 'newsletter_upsert',
 );
 if (upsert.existed) {
 console.log('[Newsletter] Email already subscribed');
 setStatus('exists');
 Analytics.trackNewsletter('error', email.split('@')[1]);
 return;
 }

 markNewsletterSubscribedLocally();
 setStatus('pending');
 setEmail('');
 setName('');
 unlockAchievement('newsletter_sub');
 console.log('[Newsletter] ✅ Subscription saved as pending (double opt-in)');
 Analytics.trackNewsletter('subscribe', email.split('@')[1]);
 } catch (error: any) {
 reportCaughtError(error, 'newsletter.subscribe');
 setErrorMessage(error.message || t('newsletter.subscribeError'));
 setStatus('error');
 Analytics.trackNewsletter('error', error.message);
 }
 };

 // Don't show if already subscribed or if user is signed in (auto-subscribed on signup)
 if (user) return null;
 if (alreadySubscribed && status === 'idle') return null;

 if (compact) {
 return (
 <div className="bg-gradient-to-r from-teal-600 to-emerald-700 rounded-2xl p-4 sm:p-6 text-white">
 <div className="flex items-center gap-3 mb-3">
 <Bell size={20} />
 <h3 className="font-bold text-lg">{t('newsletter.title')}</h3>
 </div>
 <p className="text-emerald-100 text-sm mb-4">
 {t('newsletter.compactDescription')}
 </p>

 {(status === 'success' || status === 'pending') ? (
 <div className={`flex items-center gap-2 ${status === 'pending' ? 'text-amber-200' : 'text-emerald-200'}`}>
 {status === 'pending' ? <Mail size={18} /> : <CheckCircle2 size={18} />}
 {status === 'pending' ? t('newsletter.doubleOptIn.checkInbox') : t('newsletter.subscriptionConfirmedShort')}
 </div>
 ) : (
 <div className="space-y-3">
 <form onSubmit={handleSubscribe} className="flex gap-2">
 <div className="flex-grow">
 <EmailInput
 value={email}
 onChange={(val) => { setEmail(val); setStatus('idle'); }}
 placeholder={t('newsletter.emailPlaceholder')}
 className="w-full px-4 py-2.5 bg-white/15 border border-white/25 rounded-xl text-white placeholder-white/50 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
 darkVariant
 />
 </div>
 <button type="submit" disabled={status === 'loading'}
 className="px-5 py-2.5 bg-surface text-info font-bold text-sm rounded-xl hover:bg-teal-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
 aria-label={t('newsletter.subscribeFree')}
 >
 {status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
 </button>
 </form>
 {!user && (
 <div className="flex flex-col gap-2">
 <div className="space-y-2">
 <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-xl" />
 {!googleButtonReady && (
 <button
 onClick={async () => {
 Analytics.trackNewsletter('view_form', 'google');
 await googleSignIn();
 }}
 className="w-full min-h-[44px] grid grid-cols-[20px_1fr_20px] items-center px-4 py-2 bg-white/10 border border-white/20 rounded-xl text-white/90 text-xs font-semibold hover:bg-white/20 transition-colors"
 >
 <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
 <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
 <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
 <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
 <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
 </svg>
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
 className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#0A66C2] hover:bg-[#004182] text-white text-sm font-semibold transition-colors"
 >
 <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
 </button>
 )}
 {/* Facebook button hidden — Facebook app not yet approved */}
 {/* TODO: Re-enable once Facebook app review is complete */}
 </div>
 )}
 </div>
 )}
 {status === 'error' && <p className="text-red-200 text-xs mt-2">{errorMessage}</p>}
 {status === 'exists' && <p className="text-amber-200 text-xs mt-2">{t('newsletter.alreadySubscribed')}</p>}
 </div>
 );
 }

 return (
 <div className="space-y-6 animate-fade-in">
 <div className="bg-gradient-to-br from-teal-600 via-emerald-600 to-green-700 rounded-3xl p-5 sm:p-8 text-white shadow-2xl">
 <div className="flex items-center gap-4 mb-4">
 <div className="p-3 bg-white/20 rounded-2xl">
 <Mail size={32} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-extrabold">{t('newsletter.weeklyTitle')}</h1>
 <p className="text-emerald-100 mt-1">{t('newsletter.weeklySubtitle')}</p>
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
 <div className="bg-white/20 rounded-xl p-3 text-center">
 <div className="text-2xl mb-1">💱</div>
 <div className="text-sm font-bold">{t('newsletter.exchangeRate')}</div>
 <div className="text-xs text-white/70">{t('newsletter.weeklyRate')}</div>
 </div>
 <div className="bg-white/20 rounded-xl p-3 text-center">
 <div className="text-2xl mb-1">🚦</div>
 <div className="text-sm font-bold">{t('newsletter.borderTraffic')}</div>
 <div className="text-xs text-white/70">{t('newsletter.timesAndTips')}</div>
 </div>
 <div className="bg-white/20 rounded-xl p-3 text-center">
 <div className="text-2xl mb-1">📋</div>
 <div className="text-sm font-bold">{t('newsletter.taxNews')}</div>
 <div className="text-xs text-white/70">{t('newsletter.deadlinesAndChanges')}</div>
 </div>
 </div>
 </div>

 {(status === 'success' || status === 'pending') ? (
 <div className="bg-warning-subtle rounded-2xl border border-warning-border p-5 sm:p-8 text-center">
 <Mail size={48} className="text-amber-500 mx-auto mb-4" />
 <h3 className="text-xl font-bold text-strong mb-2">{t('newsletter.doubleOptIn.title')}</h3>
 <p className="text-subtle mb-3">
 {t('newsletter.doubleOptIn.description')}
 </p>
 <p className="text-sm text-muted mb-4">
 {t('newsletter.doubleOptIn.spamHint')}
 </p>

 {/* FRO-23: Email provider button */}
 {email && (() => {
 const provider = getEmailProviderInfo(email);
 if (!provider) return null;
 return (
 <button
 onClick={() => openEmailProvider(email)}
 className="inline-flex items-center gap-2 px-5 py-2.5 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-xl transition-colors"
 >
 <Mail size={16} />
 {t('newsletter.openEmailProvider', { provider: provider.name })}
 </button>
 );
 })()}

 {/* FRO-26: Resend confirmation */}
 {email && (
 <div className="mt-4">
 <p className="text-sm text-muted mb-1">{t('newsletter.pendingReminder.resend')}</p>
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
 className="text-xs font-medium text-info hover:text-teal-700 underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
 >
 {resendStatus === 'sending' ? '...' :
 resendStatus === 'sent' ? t('newsletter.resendConfirmationSent') :
 resendStatus === 'cooldown' ? t('newsletter.resendConfirmationCooldown') :
 resendStatus === 'error' ? t('newsletter.resendConfirmationError') :
 t('newsletter.resendConfirmation')}
 </button>
 </div>
 )}
 </div>
 ) : (
 <form onSubmit={handleSubscribe} className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm space-y-5">
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
 <div>
 <label htmlFor="newsletter-email" className="text-xs font-bold text-muted uppercase mb-1 block">{t('newsletter.emailLabel')}</label>
 <EmailInput
 id="newsletter-email"
 value={email}
 onChange={(val) => { setEmail(val); setStatus('idle'); }}
 placeholder="mario.rossi@gmail.com"
 className="w-full px-4 py-3 bg-surface-alt border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
 />
 </div>
 <div>
 <label htmlFor="newsletter-name" className="text-xs font-bold text-muted uppercase mb-1 block">{t('newsletter.nameLabel')}</label>
 <input type="text" value={name}
 id="newsletter-name"
 onChange={(e) => setName(e.target.value)}
 placeholder="Mario"
 autoComplete="given-name"
 name="name"
 className="w-full px-4 py-3 bg-surface-alt border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-info" />
 </div>
 </div>

 {/* Preferences */}
 <div>
 <label className="text-xs font-bold text-muted uppercase mb-3 block">{t('newsletter.interestsLabel')}</label>
 <div className="grid grid-cols-2 gap-3">
 {[
 { key: 'exchangeRate', label: `💱 ${t('newsletter.exchangeRate')}`, desc: t('newsletter.exchangeRateDesc') },
 { key: 'traffic', label: `🚦 ${t('newsletter.borderTraffic')}`, desc: t('newsletter.borderTrafficDesc') },
 { key: 'taxUpdates', label: `📋 ${t('newsletter.taxNews')}`, desc: t('newsletter.taxNewsDesc') },
 { key: 'tips', label: `💡 ${t('newsletter.tips')}`, desc: t('newsletter.tipsDesc') },
 ].map(pref => (
 <label key={pref.key}
 className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-colors border ${
 preferences[pref.key as keyof typeof preferences]
 ? 'border-info-border bg-info-subtle'
 : 'border-edge hover:border-slate-300'
 }`}
 >
 <input type="checkbox"
 checked={preferences[pref.key as keyof typeof preferences]}
 onChange={(e) => setPreferences(prev => ({ ...prev, [pref.key]: e.target.checked }))}
 className="mt-1 w-4 h-4 rounded text-teal-600 focus-visible:ring-info"
 aria-label={pref.label} />
 <div>
 <div className="font-bold text-sm text-strong">{pref.label}</div>
 <div className="text-sm text-muted">{pref.desc}</div>
 </div>
 </label>
 ))}
 </div>
 </div>

 {status === 'error' && (
 <div className="flex items-center gap-2 p-3 bg-danger-subtle rounded-xl text-red-600 text-sm">
 <AlertCircle size={16} /> {errorMessage}
 </div>
 )}
 {status === 'exists' && (
 <div className="flex items-center gap-2 p-3 bg-warning-subtle rounded-xl text-amber-600 text-sm">
 <AlertCircle size={16} /> {t('newsletter.alreadySubscribedFull')}
 </div>
 )}

 <div className="flex items-center justify-between">
 <div className="flex items-center gap-2 text-xs text-muted">
 <Shield size={14} />
 {t('newsletter.protectedBy')}
 </div>
 <button type="submit" disabled={status === 'loading'}
 className="px-8 py-3 bg-gradient-to-r from-teal-600 to-emerald-700 text-white font-bold rounded-xl hover:from-teal-700 hover:to-emerald-800 transition-[color,background-color,border-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg"
 >
 {status === 'loading' ? (
 <>
 <Loader2 size={18} className="animate-spin" />
 {t('newsletter.subscribing')}
 </>
 ) : (
 <>
 <Send size={18} />
 {t('newsletter.subscribeFree')}
 </>
 )}
 </button>
 </div>

 <p className="text-sm text-muted text-center">
 {t('newsletter.unsubscribeNotice')}
 </p>
 </form>
 )}
 </div>
 );
};

export default Newsletter;
