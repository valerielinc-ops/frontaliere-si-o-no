/**
 * WeeklyDigest — Weekly email digest preview + subscription CTA
 *
 * Shows a preview of what the weekly digest email looks like:
 * - Latest exchange rates
 * - Featured blog articles
 * - Tool of the week highlight
 * - Job market updates
 * Includes subscription CTA reusing Newsletter Firestore infrastructure.
 */

import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { unlockAchievement } from '@/services/gamificationService';
import {
 upsertNewsletterSubscriber,
 markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { useAuth, renderGoogleButtonWithReadiness, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';
import {
 Mail, Send, TrendingUp, BookOpen, Briefcase, Calendar,
 CheckCircle2, Loader2, ChevronDown, ChevronUp, Shield,
 ArrowRight, Newspaper, Star, Bell
} from 'lucide-react';

// ─── Lazy Firestore ─────────────────────────────────────────────────────

let _db: any = null;
let _dbInit = false;

const initDb = async () => {
 if (_dbInit) return _db;
 try {
 const { getFirestore } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 _db = getFirestore(app);
 _dbInit = true;
 return _db;
 } catch {
 return null;
 }
};

// ─── Tool rotation (deterministic per week) ─────────────────────────────

const FEATURED_TOOLS = [
 { id: 'calculator', icon: '🧮', key: 'calculator' },
 { id: 'exchange', icon: '💱', key: 'exchange' },
 { id: 'health', icon: '🏥', key: 'health' },
 { id: 'pension', icon: '🏦', key: 'pension' },
 { id: 'tax-return', icon: '📋', key: 'taxReturn' },
 { id: 'permit-quiz', icon: '❓', key: 'permitQuiz' },
 { id: 'tredicesima', icon: '🎁', key: 'tredicesima' },
 { id: 'cost-of-living', icon: '🏠', key: 'costOfLiving' },
];

function getWeekNumber(): number {
 const now = new Date();
 const start = new Date(now.getFullYear(), 0, 1);
 const diff = now.getTime() - start.getTime();
 return Math.ceil(diff / (7 * 24 * 60 * 60 * 1000));
}

function getToolOfWeek() {
 const week = getWeekNumber();
 return FEATURED_TOOLS[week % FEATURED_TOOLS.length];
}

// ─── Component ──────────────────────────────────────────────────────────

const WeeklyDigest: React.FC = () => {
 const { t, locale } = useTranslation();
 const { user, signIn: googleSignIn } = useAuth();
 const [email, setEmail] = useState('');
 const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
 const [showPreview, setShowPreview] = useState(false);
 const [alreadySubscribed] = useState(() =>
 localStorage.getItem('weekly_digest_subscribed') === 'true'
 );
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const googleButtonRef = useRef<HTMLDivElement>(null);

 const today = new Date();
 const dateStr = today.toLocaleDateString('it-CH', {
 day: 'numeric', month: 'long', year: 'numeric',
 });
 const weekNum = getWeekNumber();
 const featuredTool = getToolOfWeek();

 // ─── Subscribe handler ──────────────────────────────────────────────

 const handleSubscribe = useCallback(async () => {
 if (!validateEmailStrict(email) || status === 'loading') return;
 setStatus('loading');

 try {
 const db = await initDb();
 if (!db) {
 throw new Error('Firestore non disponibile');
 }
 await upsertNewsletterSubscriber(db, {
 email,
 source: 'weekly_digest',
 type: 'weekly_digest',
 isActive: true,
 });
 markNewsletterSubscribedLocally();
 localStorage.setItem('weekly_digest_subscribed', 'true');
 setStatus('success');
 unlockAchievement('email_results');
 Analytics.trackUIInteraction('weekly_digest', 'subscribe', 'success', email.split('@')[1]);
 } catch {
 setStatus('error');
 }
 }, [email, status]);

 useEffect(() => { isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {}); }, []);

 useEffect(() => {
 if (user || alreadySubscribed) {
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
 }, [user, alreadySubscribed, locale]);

 // ─── Render ─────────────────────────────────────────────────────────

 if (user) return null;
 if (alreadySubscribed || status === 'success') {
 return (
 <div className="bg-success-subtle border border-success-border rounded-2xl p-4 sm:p-6 text-center">
 <CheckCircle2 size={32} className="text-success mx-auto mb-3" />
 <h3 className="font-bold text-success">
 {t('weeklyDigest.subscribed')}
 </h3>
 <p className="text-sm text-success mt-1">
 {t('weeklyDigest.subscribedDesc')}
 </p>
 </div>
 );
 }

 return (
 <div className="max-w-2xl mx-auto">
 {/* Header */}
 <div className="text-center mb-6">
 <h2 className="text-2xl font-bold font-display text-strong flex items-center justify-center gap-3">
 <Newspaper size={24} className="text-accent" />
 {t('weeklyDigest.title')}
 </h2>
 <p className="text-subtle mt-2 text-sm max-w-md mx-auto">
 {t('weeklyDigest.subtitle')}
 </p>
 </div>

 {/* Digest Preview Toggle */}
 <button
 onClick={() => setShowPreview(!showPreview)}
 className="w-full flex items-center justify-between px-4 py-3 bg-accent-subtle border border-accent-border rounded-xl mb-4 text-sm transition-colors"
 aria-label={t('weeklyDigest.showPreview')}
 >
 <span className="flex items-center gap-2 font-medium text-accent">
 <Mail size={16} />
 {t('weeklyDigest.showPreview')}
 </span>
 {showPreview ? <ChevronUp size={16} className="text-accent" /> : <ChevronDown size={16} className="text-accent" />}
 </button>

 {/* Digest Preview */}
 {showPreview && (
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden mb-6">
 {/* Preview Header */}
 <div className="bg-info px-6 py-4">
 <div className="flex items-center gap-2 mb-1">
 <Bell size={16} className="text-on-accent/90" />
 <span className="text-on-accent/90 text-xs">{t('weeklyDigest.preview.header')}</span>
 </div>
 <h3 className="font-bold font-display text-on-accent text-lg">
 {t('weeklyDigest.preview.title', { week: String(weekNum) })}
 </h3>
 <p className="text-on-accent/70 text-sm">{dateStr}</p>
 </div>

 {/* 1. Exchange Rate */}
 <div className="px-6 py-4 border-b border-edge">
 <div className="flex items-center gap-2 mb-2">
 <TrendingUp size={16} className="text-accent" />
 <h4 className="font-semibold text-strong text-sm">
 {t('weeklyDigest.preview.exchangeTitle')}
 </h4>
 </div>
 <div className="bg-accent-subtle rounded-xl p-3">
 <div className="flex items-center justify-between">
 <span className="text-sm text-subtle">CHF/EUR</span>
 <span className="font-bold text-accent">0.9421</span>
 </div>
 <p className="text-sm text-muted mt-1">
 {t('weeklyDigest.preview.exchangeNote')}
 </p>
 </div>
 </div>

 {/* 2. Featured Articles */}
 <div className="px-6 py-4 border-b border-edge">
 <div className="flex items-center gap-2 mb-3">
 <BookOpen size={16} className="text-accent" />
 <h4 className="font-semibold text-strong text-sm">
 {t('weeklyDigest.preview.articlesTitle')}
 </h4>
 </div>
 <div className="space-y-2">
 <div className="flex items-start gap-3 bg-surface-alt rounded-xl p-3">
 <Star size={14} className="text-warning mt-0.5 shrink-0" />
 <div>
 <p className="text-sm font-medium text-body">
 {t('weeklyDigest.preview.article1')}
 </p>
 <p className="text-sm text-muted mt-0.5">5 min</p>
 </div>
 </div>
 <div className="flex items-start gap-3 bg-surface-alt rounded-xl p-3">
 <BookOpen size={14} className="text-accent mt-0.5 shrink-0" />
 <div>
 <p className="text-sm font-medium text-body">
 {t('weeklyDigest.preview.article2')}
 </p>
 <p className="text-sm text-muted mt-0.5">4 min</p>
 </div>
 </div>
 </div>
 </div>

 {/* 3. Tool of the Week */}
 <div className="px-6 py-4 border-b border-edge">
 <div className="flex items-center gap-2 mb-2">
 <span className="text-lg">{featuredTool.icon}</span>
 <h4 className="font-semibold text-strong text-sm">
 {t('weeklyDigest.preview.toolTitle')}
 </h4>
 </div>
 <div className="bg-accent-subtle rounded-xl p-3 flex items-center justify-between">
 <div>
 <p className="text-sm font-medium text-accent">
 {t(`weeklyDigest.tool.${featuredTool.key}`)}
 </p>
 <p className="text-xs text-accent mt-0.5">
 {t(`weeklyDigest.toolDesc.${featuredTool.key}`)}
 </p>
 </div>
 <ArrowRight size={16} className="text-accent shrink-0" />
 </div>
 </div>

 {/* 4. Job Market */}
 <div className="px-6 py-4">
 <div className="flex items-center gap-2 mb-2">
 <Briefcase size={16} className="text-success" />
 <h4 className="font-semibold text-strong text-sm">
 {t('weeklyDigest.preview.jobsTitle')}
 </h4>
 </div>
 <p className="text-sm text-subtle">
 {t('weeklyDigest.preview.jobsDesc', getCantonI18nParams())}
 </p>
 </div>
 </div>
 )}

 {/* Subscribe Form */}
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="font-bold text-strong mb-1 flex items-center gap-2">
 <Mail size={18} className="text-accent" />
 {t('weeklyDigest.subscribe')}
 </h3>
 <p className="text-sm text-subtle mb-4">
 {t('weeklyDigest.subscribeDesc')}
 </p>

 <div className="flex gap-2">
 <div className="flex-1">
 <EmailInput
 value={email}
 onChange={setEmail}
 placeholder={t('weeklyDigest.emailPlaceholder')}
 />
 </div>
 <button
 onClick={handleSubscribe}
 disabled={!validateEmailStrict(email) || status === 'loading'}
 className="px-5 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent font-semibold rounded-xl transition-colors flex items-center gap-2"
 aria-label={t('weeklyDigest.subscribeBtn')}
 >
 {status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
 </button>
 </div>

 {/* Social sign-in */}
 <div className="flex items-center gap-3 mt-3 mb-2">
 <div className="flex-1 h-px bg-surface-raised" />
 <span className="text-xs text-muted">{locale === 'it' ? 'oppure' : locale === 'de' ? 'oder' : locale === 'fr' ? 'ou' : 'or'}</span>
 <div className="flex-1 h-px bg-surface-raised" />
 </div>
 <div className="flex gap-2">
 <div className="flex-1 space-y-2">
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
 <button type="button" onClick={() => signInWithLinkedIn()} className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-brand-linkedin hover:bg-brand-linkedin-hover text-on-accent text-sm font-semibold transition-colors">
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 <span className="hidden sm:inline">{locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}</span>
 <span className="sm:hidden">LinkedIn</span>
 </button>
 )}
 </div>

 <div className="flex items-center gap-1 mt-3 text-xs text-muted">
 <Shield size={12} />
 <span>{t('weeklyDigest.privacy')}</span>
 </div>

 {/* Benefits */}
 <div className="grid grid-cols-2 gap-2 mt-4">
 {['rates', 'articles', 'tools', 'jobs'].map(benefit => (
 <div key={benefit} className="flex items-center gap-2 text-xs text-subtle">
 <CheckCircle2 size={12} className="text-success shrink-0" />
 <span>{t(`weeklyDigest.benefit.${benefit}`)}</span>
 </div>
 ))}
 </div>
 </div>
 </div>
 );
};

export default WeeklyDigest;
