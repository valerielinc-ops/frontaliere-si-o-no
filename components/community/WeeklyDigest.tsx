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

import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { unlockAchievement } from '@/services/gamificationService';
import {
  upsertNewsletterSubscriber,
  markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
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
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [showPreview, setShowPreview] = useState(false);
  const [alreadySubscribed] = useState(() =>
    localStorage.getItem('weekly_digest_subscribed') === 'true'
  );

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

  // ─── Render ─────────────────────────────────────────────────────────

  if (alreadySubscribed || status === 'success') {
    return (
      <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-2xl p-4 sm:p-6 text-center">
        <CheckCircle2 size={32} className="text-emerald-600 mx-auto mb-3" />
        <h3 className="font-bold text-emerald-800 dark:text-emerald-200">
          {t('weeklyDigest.subscribed')}
        </h3>
        <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">
          {t('weeklyDigest.subscribedDesc')}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center justify-center gap-3">
          <Newspaper size={24} className="text-indigo-500" />
          {t('weeklyDigest.title')}
        </h2>
        <p className="text-subtle mt-2 text-sm max-w-md mx-auto">
          {t('weeklyDigest.subtitle')}
        </p>
      </div>

      {/* Digest Preview Toggle */}
      <button
        onClick={() => setShowPreview(!showPreview)}
        className="w-full flex items-center justify-between px-4 py-3 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl mb-4 text-sm transition-colors"
        aria-label={t('weeklyDigest.showPreview')}
      >
        <span className="flex items-center gap-2 font-medium text-indigo-700 dark:text-indigo-300">
          <Mail size={16} />
          {t('weeklyDigest.showPreview')}
        </span>
        {showPreview ? <ChevronUp size={16} className="text-indigo-500" /> : <ChevronDown size={16} className="text-indigo-500" />}
      </button>

      {/* Digest Preview */}
      {showPreview && (
        <div className="bg-surface rounded-2xl border border-edge overflow-hidden mb-6">
          {/* Preview Header */}
          <div className="bg-teal-600 dark:bg-teal-700 px-6 py-4">
            <div className="flex items-center gap-2 mb-1">
              <Bell size={16} className="text-white/90" />
              <span className="text-white/90 text-xs">{t('weeklyDigest.preview.header')}</span>
            </div>
            <h3 className="font-bold text-white text-lg">
              {t('weeklyDigest.preview.title', { week: String(weekNum) })}
            </h3>
            <p className="text-white/70 text-sm">{dateStr}</p>
          </div>

          {/* 1. Exchange Rate */}
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={16} className="text-blue-600" />
              <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
                {t('weeklyDigest.preview.exchangeTitle')}
              </h4>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-subtle">CHF/EUR</span>
                <span className="font-bold text-blue-700 dark:text-blue-300">0.9421</span>
              </div>
              <p className="text-sm text-muted mt-1">
                {t('weeklyDigest.preview.exchangeNote')}
              </p>
            </div>
          </div>

          {/* 2. Featured Articles */}
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-2 mb-3">
              <BookOpen size={16} className="text-violet-600" />
              <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
                {t('weeklyDigest.preview.articlesTitle')}
              </h4>
            </div>
            <div className="space-y-2">
              <div className="flex items-start gap-3 bg-slate-50 dark:bg-slate-700/50 rounded-xl p-3">
                <Star size={14} className="text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {t('weeklyDigest.preview.article1')}
                  </p>
                  <p className="text-sm text-muted mt-0.5">5 min</p>
                </div>
              </div>
              <div className="flex items-start gap-3 bg-slate-50 dark:bg-slate-700/50 rounded-xl p-3">
                <BookOpen size={14} className="text-indigo-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {t('weeklyDigest.preview.article2')}
                  </p>
                  <p className="text-sm text-muted mt-0.5">4 min</p>
                </div>
              </div>
            </div>
          </div>

          {/* 3. Tool of the Week */}
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">{featuredTool.icon}</span>
              <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
                {t('weeklyDigest.preview.toolTitle')}
              </h4>
            </div>
            <div className="bg-violet-50 dark:bg-violet-900/20 rounded-xl p-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-violet-700 dark:text-violet-300">
                  {t(`weeklyDigest.tool.${featuredTool.key}`)}
                </p>
                <p className="text-xs text-violet-600 dark:text-violet-400 mt-0.5">
                  {t(`weeklyDigest.toolDesc.${featuredTool.key}`)}
                </p>
              </div>
              <ArrowRight size={16} className="text-violet-500 shrink-0" />
            </div>
          </div>

          {/* 4. Job Market */}
          <div className="px-6 py-4">
            <div className="flex items-center gap-2 mb-2">
              <Briefcase size={16} className="text-emerald-600" />
              <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
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
        <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1 flex items-center gap-2">
          <Mail size={18} className="text-indigo-500" />
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
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors flex items-center gap-2"
            aria-label={t('weeklyDigest.subscribeBtn')}
          >
            {status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>

        <div className="flex items-center gap-1 mt-3 text-xs text-muted">
          <Shield size={12} />
          <span>{t('weeklyDigest.privacy')}</span>
        </div>

        {/* Benefits */}
        <div className="grid grid-cols-2 gap-2 mt-4">
          {['rates', 'articles', 'tools', 'jobs'].map(benefit => (
            <div key={benefit} className="flex items-center gap-2 text-xs text-subtle">
              <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
              <span>{t(`weeklyDigest.benefit.${benefit}`)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WeeklyDigest;
