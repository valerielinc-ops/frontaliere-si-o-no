import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { PREFERRED_SOURCE_URL } from '@/components/shared/PreferredSourceCTA';
import { POPUP_PRIORITY } from '@/services/popupQueue';

const DISMISS_KEY = 'preferredSourcePopup:dismissedUntil';
const ACCEPTED_KEY = 'preferredSourcePopup:accepted';
const SEEN_KEY = 'preferredSourcePopup:seen';
const DISMISS_DAYS = 7;
const SHOW_DELAY_MS = 1200;
const TITLE_ID = 'preferred-source-popup-title';

export interface PreferredSourcePopupProps {
  /** Article id used to attribute the popup impression and click. */
  articleId: string;
}

function isSuppressed(): boolean {
  try {
    if (localStorage.getItem(ACCEPTED_KEY) === 'true') return true;
    const dismissedUntil = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (dismissedUntil > Date.now()) return true;
    return sessionStorage.getItem(SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export default function PreferredSourcePopup({ articleId }: PreferredSourcePopupProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isSuppressed()) return undefined;
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [articleId]);

  const handleDismiss = useCallback(() => {
    try {
      localStorage.setItem(
        DISMISS_KEY,
        String(Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000),
      );
    } catch { /* storage unavailable — the prompt still closes for this view */ }
    Analytics.trackEvent('preferred_source_popup_dismissed', { article_id: articleId });
    setVisible(false);
  }, [articleId]);

  const handleAccept = useCallback(() => {
    try {
      localStorage.setItem(ACCEPTED_KEY, 'true');
    } catch { /* storage unavailable — the prompt still closes for this view */ }
    Analytics.trackCtaClick('article_preferred_source_popup_cta', {
      targetUrl: PREFERRED_SOURCE_URL,
      component: 'PreferredSourcePopup',
      section: 'article_popup',
      label: t('preferredSource.popupAccept'),
      utm_source: 'article_popup',
      utm_medium: 'popup',
      utm_campaign: 'preferred_sources',
      utm_content: articleId,
    });
    setVisible(false);
  }, [articleId, t]);

  const handleShown = useCallback(() => {
    try {
      sessionStorage.setItem(SEEN_KEY, 'true');
    } catch { /* storage unavailable — the prompt still works for this view */ }
    Analytics.trackEvent('preferred_source_popup_shown', { article_id: articleId });
  }, [articleId]);

  if (!visible) return null;

  return (
    <BottomPromptShell
      slotId="preferred-source-popup"
      priority={POPUP_PRIORITY.PREFERRED_SOURCE}
      ariaLabelledBy={TITLE_ID}
      onEscape={handleDismiss}
      onShown={handleShown}
    >
      <div className="p-3.5 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-strong text-on-accent shadow-sm">
            <Sparkles className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <h3 id={TITLE_ID} className="text-sm font-bold text-heading">
              {t('preferredSource.popupTitle')}
            </h3>
            <p className="mt-0.5 text-xs text-subtle">
              {t('preferredSource.popupBody')}
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleDismiss}
                className="inline-flex items-center px-3 py-1.5 min-h-[44px] text-xs font-semibold text-muted hover:text-strong transition-colors"
              >
                {t('preferredSource.popupDismiss')}
              </button>
              <a
                href={PREFERRED_SOURCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleAccept}
                className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors no-underline"
              >
                {t('preferredSource.popupAccept')}
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </BottomPromptShell>
  );
}
