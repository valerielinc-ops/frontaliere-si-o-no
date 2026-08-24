/**
 * PreferredSourceCTA — "Aggiungi Frontaliere Ticino alle tue fonti preferite"
 *
 * Fase 4 della issue 5004 (Google Preferred Sources per AI Overviews / AI Mode):
 * l'eleggibilita' tecnica non basta, perche' Preferred Sources e' una scelta
 * che l'UTENTE fa dal proprio account Google. Il deep link sotto apre esattamente
 * quel pannello con il nostro dominio precompilato, quindi la selezione costa un
 * click invece di una ricerca dentro le impostazioni.
 *
 * Superfici di montaggio (tutte e tre nella stessa PR della checklist Fase 1):
 *   - footer del sito           → App.tsx, variant="inline"
 *   - fine di ogni articolo     → components/community/BlogArticles.tsx, variant="card"
 *   - newsletter (HTML email)   → services/newsletter-template.mjs (non React)
 *
 * Analytics: click → Analytics.trackCtaClick(<ctaId per placement>, {...}), la
 * convenzione osservata su ogni CTA custom del sito (vedi ConsultingCTA). Il
 * listener globale di services/analytics.ts emetterebbe comunque un `cta_click`
 * di fallback, ma senza gli utm_* e senza distinguere le due superfici.
 */

import React from 'react';
import { Sparkles, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

/**
 * Deep link al pannello "Fonti preferite" di Google, con il dominio canonico
 * (senza `www`, come da AGENTS.md → Architecture) passato in `q`.
 * Non e' un path del sito: nessun trailing slash da forzare qui.
 */
export const PREFERRED_SOURCE_URL =
  'https://www.google.com/preferences/source?q=frontaliereticino.ch';

/** 'inline' = riga compatta da footer; 'card' = card da fine-articolo. */
export type PreferredSourceVariant = 'inline' | 'card';

interface PreferredSourceCTAProps {
  variant?: PreferredSourceVariant;
}

const CTA_ID: Record<PreferredSourceVariant, string> = {
  inline: 'footer_preferred_source_cta',
  card: 'article_preferred_source_cta',
};

const SECTION: Record<PreferredSourceVariant, string> = {
  inline: 'site_footer',
  card: 'article_end',
};

const UTM_SOURCE: Record<PreferredSourceVariant, string> = {
  inline: 'site_footer',
  card: 'article_end',
};

const PreferredSourceCTA: React.FC<PreferredSourceCTAProps> = ({ variant = 'inline' }) => {
  const { t } = useTranslation();

  const buttonLabel = t('preferredSource.button');

  const handleClick = () => {
    Analytics.trackCtaClick(CTA_ID[variant], {
      targetUrl: PREFERRED_SOURCE_URL,
      component: 'PreferredSourceCTA',
      section: SECTION[variant],
      label: buttonLabel,
      utm_source: UTM_SOURCE[variant],
      utm_medium: 'inline_cta',
      utm_campaign: 'preferred_sources',
    });
  };

  if (variant === 'card') {
    return (
      <div
        data-testid="preferred-source-cta-card"
        className="mt-8 rounded-2xl border border-accent-border bg-accent-subtle/60 p-5 sm:p-6"
      >
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-11 h-11 rounded-xl bg-accent-subtle flex items-center justify-center text-accent">
            <Sparkles size={22} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base sm:text-lg font-bold font-display text-strong mb-1">
              {t('preferredSource.title')}
            </p>
            <p className="text-sm text-subtle leading-relaxed mb-4">
              {t('preferredSource.body')}
            </p>
            <a
              href={PREFERRED_SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleClick}
              aria-label={buttonLabel}
              className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-accent-strong text-on-accent font-bold text-sm shadow-sm hover:bg-accent-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-[color,background-color,box-shadow] no-underline"
            >
              {buttonLabel}
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="preferred-source-cta-inline"
      className="flex items-center gap-3 p-3 bg-accent-subtle/50 rounded-xl border border-accent-border"
    >
      <Sparkles className="w-5 h-5 text-accent flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-body">{t('preferredSource.body')}</p>
      </div>
      <a
        href={PREFERRED_SOURCE_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
        aria-label={buttonLabel}
        className="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-link bg-accent-subtle hover:bg-accent-subtle rounded-lg transition-colors border border-accent-border no-underline"
      >
        <ExternalLink className="w-3 h-3" aria-hidden="true" />
        {buttonLabel}
      </a>
    </div>
  );
};

export default PreferredSourceCTA;
