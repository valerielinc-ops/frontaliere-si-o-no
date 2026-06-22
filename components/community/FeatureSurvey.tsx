/**
 * FeatureSurvey — "Which feature would you like next?" micro-survey.
 *
 * A compact, dismissible bottom-corner card (NOT a full-screen modal) so it
 * never blocks page content or fights AdSense Auto Ads vignettes for z-index.
 * Single-select feature chips + an optional free-text "other" field. Responses
 * are captured to PostHog (`feature_survey_response`) and mirrored to GA4 via
 * Analytics, reusing the analytics pipeline already wired in the app — no extra
 * SDK, no PostHog dashboard config, no consent banner (PostHog runs under
 * legitimate interest, see services/posthog.ts).
 *
 * Fully localised (IT/EN/DE/FR) through the existing i18n core chunk.
 *
 * Timing: shows after real engagement (≥2 page views + 25s on site), respects
 * the shared popup queue so it never overlaps the newsletter popup, and is
 * remembered for 90 days once dismissed or answered.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Lightbulb, Send, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { captureEvent } from '@/services/posthog';
import { isLikelyBot } from '@/services/botPatterns';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';

const SLOT_ID = 'feature-survey';
const DISMISSED_KEY = 'feature_survey_dismissed'; // timestamp once dismissed/answered
const PAGE_VIEW_KEY = 'feature_survey_pageviews';
const DISMISS_DAYS = 90; // long cooldown — survey, not a recurring nag
const MIN_TIME_MS = 25_000; // 25s on site before it may appear
const PAGE_VIEW_THRESHOLD = 2; // only engaged visitors

// Stable option ids (locale-independent) so PostHog aggregates across languages.
const OPTIONS = [
  { id: 'salary_tools', icon: '💰' },
  { id: 'traffic_alerts', icon: '🚦' },
  { id: 'job_match', icon: '💼' },
  { id: 'tax_guide', icon: '📋' },
  { id: 'insurance', icon: '🏥' },
  { id: 'mobile_app', icon: '📱' },
  { id: 'other', icon: '✏️' },
] as const;

type OptionId = (typeof OPTIONS)[number]['id'];

const FeatureSurvey: React.FC = () => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [queueActive, setQueueActive] = useState(false);
  const [selected, setSelected] = useState<OptionId | null>(null);
  const [otherText, setOtherText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const timeReady = useRef(false);
  const requested = useRef(false);

  // Never show for bots/crawlers — they must see full page content, and we don't
  // want survey events polluting analytics. Mirrors the PostHog bot gate.
  const isBot = useMemo(() => isLikelyBot(), []);

  useEffect(() => {
    if (isBot) return;

    // Respect the 90-day cooldown after a dismiss or an answer.
    const dismissed = localStorage.getItem(DISMISSED_KEY);
    if (dismissed) {
      const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
      if (daysSince < DISMISS_DAYS) return;
    }

    // Engagement gate: count page views this session.
    const pageViews = parseInt(sessionStorage.getItem(PAGE_VIEW_KEY) || '0', 10) + 1;
    sessionStorage.setItem(PAGE_VIEW_KEY, String(pageViews));

    const tryRequest = () => {
      if (requested.current) return;
      if (!timeReady.current) return;
      if (pageViews < PAGE_VIEW_THRESHOLD) return;
      requested.current = true;
      requestSlot(SLOT_ID, POPUP_PRIORITY.NEWSLETTER); // same low urgency as newsletter
      setVisible(true);
    };

    const timer = setTimeout(() => {
      timeReady.current = true;
      tryRequest();
    }, MIN_TIME_MS);

    const unsub = subscribe(() => setQueueActive(isActive(SLOT_ID)));

    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [isBot]);

  const persistCooldown = () => {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  };

  const handleDismiss = () => {
    persistCooldown();
    setVisible(false);
    releaseSlot(SLOT_ID);
    Analytics.trackUIInteraction('feature_survey', 'card', 'survey', 'dismiss');
  };

  const handleSubmit = () => {
    if (!selected) return;
    const trimmed = otherText.trim().slice(0, 280);
    const payload: Record<string, string> = {
      feature: selected,
      page: window.location.pathname,
    };
    if (selected === 'other' && trimmed) payload.detail = trimmed;

    captureEvent('feature_survey_response', payload);
    Analytics.trackEvent('feature_survey_response', payload);

    persistCooldown();
    setSubmitted(true);
    // Auto-close shortly after the thank-you state.
    setTimeout(() => {
      setVisible(false);
      releaseSlot(SLOT_ID);
    }, 2200);
  };

  if (isBot || !visible || !queueActive) return null;

  const portalTarget = document.getElementById('modal-root') || document.body;

  return createPortal(
    <div
      role="dialog"
      aria-label={t('survey.feature.aria')}
      className="fixed z-[60] bottom-3 right-3 left-3 sm:left-auto sm:bottom-5 sm:right-5 w-auto sm:w-[22rem] max-w-[calc(100vw-1.5rem)] bg-surface rounded-2xl shadow-2xl border border-edge overflow-hidden animate-fade-in"
    >
      <div className="bg-gradient-to-r from-info-strong to-success-strong p-3 sm:p-4 text-on-accent">
        <button
          onClick={handleDismiss}
          className="absolute top-2 right-2 p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-on-accent/70 hover:text-on-accent hover:bg-on-accent/20 rounded-lg transition-colors"
          aria-label={t('survey.feature.close')}
        >
          <X className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 pr-10">
          <div className="p-1.5 bg-on-accent/20 rounded-lg shrink-0">
            <Lightbulb className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold font-display leading-tight">{t('survey.feature.title')}</h2>
            <p className="text-on-accent/80 text-xs mt-0.5">{t('survey.feature.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="p-3 sm:p-4">
        {submitted ? (
          <div className="text-center py-4">
            <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-2" />
            <p className="font-bold text-strong mb-0.5">{t('survey.feature.thanks.title')}</p>
            <p className="text-sm text-subtle">{t('survey.feature.thanks.body')}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {OPTIONS.map((opt) => {
                const isSel = selected === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSelected(opt.id)}
                    aria-pressed={isSel}
                    className={
                      'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition-colors min-h-[44px] ' +
                      (isSel
                        ? 'bg-info-subtle border-info text-strong'
                        : 'bg-surface-alt border-edge text-body hover:bg-surface-raised')
                    }
                  >
                    <span aria-hidden="true">{opt.icon}</span>
                    {t(`survey.feature.option.${opt.id}`)}
                  </button>
                );
              })}
            </div>

            {selected === 'other' && (
              <textarea
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                maxLength={280}
                rows={2}
                placeholder={t('survey.feature.otherPlaceholder')}
                className="mt-3 w-full px-3 py-2 bg-surface-alt border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-info text-strong text-sm resize-none"
              />
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleDismiss}
                className="px-3 py-2 text-sm font-medium text-muted hover:text-body transition-colors"
              >
                {t('survey.feature.dismiss')}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!selected}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-info-strong to-success-strong text-on-accent text-sm font-bold rounded-xl hover:from-info-strong-hover hover:to-success-strong-hover transition-[color,background-color,border-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
              >
                <Send className="w-4 h-4" />
                {t('survey.feature.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    portalTarget,
  );
};

export default FeatureSurvey;
