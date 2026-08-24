import React from 'react';
import { Send } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { TELEGRAM_CHANNEL_URL, isTelegramChannelConfigured } from '@/services/telegramChannel';

/**
 * Telegram broadcast-channel CTA, shared by every surface that offers the
 * channel as a second subscription option next to email.
 *
 * WHY a component and not copy-pasted JSX: the gating condition is the load
 * bearing part. `isTelegramChannelConfigured()` is what keeps the site from
 * ever rendering a dead `t.me` link when `VITE_TELEGRAM_CHANNEL_URL` is unset,
 * and a gate re-typed at each call site is a gate that eventually gets typed
 * wrong. Every consumer gets the identical fail-safe by construction, and a
 * single test (tests/telegram-channel-cta.test.tsx) covers all of them.
 *
 * Renders NOTHING (null) when the channel is not configured — callers can drop
 * it straight into a layout without adding their own conditional.
 *
 * The two tones exist because the newsletter surfaces are not one background:
 * `surface` is the light card used on the full newsletter page and popup,
 * `on-accent` sits on the blue/green gradient of the compact newsletter block,
 * where semantic `text-on-accent` tokens are the only ones that keep contrast.
 * Both stay inside the project's semantic color tokens — no inline hex, no
 * `dark:` variants (see AGENTS.md → Accessibility And UX).
 */

export interface TelegramChannelCtaProps {
  /** Visual tone; pick the one matching the surrounding background. */
  tone?: 'surface' | 'on-accent';
  /** Extra classes for spacing at the call site (never colors). */
  className?: string;
}

const TelegramChannelCta: React.FC<TelegramChannelCtaProps> = ({ tone = 'surface', className = '' }) => {
  const { t } = useTranslation();

  // Fail-safe gate: no configured channel → no link at all.
  if (!isTelegramChannelConfigured()) return null;

  const onAccent = tone === 'on-accent';

  const wrapper = onAccent
    ? 'flex items-center gap-3 rounded-xl border border-on-accent/25 bg-on-accent/15 p-3 no-underline hover:bg-on-accent/25 transition-colors'
    : 'flex items-center gap-3 rounded-2xl border border-accent-border bg-accent-subtle p-4 no-underline hover:border-accent transition-colors';

  const iconWrap = onAccent ? 'p-2 bg-on-accent/20 rounded-lg shrink-0' : 'p-2 bg-accent-subtle rounded-xl shrink-0';
  const iconColor = onAccent ? 'w-5 h-5 text-on-accent' : 'w-5 h-5 text-accent';
  const titleColor = onAccent ? 'text-sm font-bold text-on-accent' : 'text-sm font-bold text-link';
  const descColor = onAccent ? 'text-xs text-on-accent/80' : 'text-xs text-subtle';

  return (
    <a
      href={TELEGRAM_CHANNEL_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`${wrapper} ${className}`.trim()}
    >
      <div className={iconWrap}>
        <Send className={iconColor} aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className={titleColor}>{t('newsletter.telegram.title')}</p>
        <p className={descColor}>{t('newsletter.telegram.desc')}</p>
      </div>
    </a>
  );
};

export default TelegramChannelCta;
