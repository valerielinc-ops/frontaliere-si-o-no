/**
 * SeoContentBlock — Keyword-rich introductory content for category landing pages
 *
 * Google indexes our statically-generated HTML. Adding rich, keyword-optimized
 * content to category landing pages helps us rank for long-tail queries like:
 *
 *   "calcolo stipendio netto frontaliere svizzera 2026"
 *   "confronto costo vita svizzera italia frontaliero"
 *   "guida completa frontaliere svizzera ticino"
 *
 * This component renders a collapsed-by-default banner that:
 * - Shows a one-line title with trust badges (minimal footprint)
 * - Expands on click to reveal feature cards and checklist
 * - Keeps full HTML in the DOM for crawlers (SEO value preserved)
 *
 * Each context targets different keyword clusters.
 * Content is in i18n so it works across all 4 locales.
 */

import React, { useState } from 'react';
import {
  Calculator, Scale, Landmark, BookOpen, Users, Target,
  ChevronDown, ChevronUp, Check, Star, Shield, Clock,
  ArrowRight, Info, CalendarDays, Quote,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useNavigationOptional } from '@/services/NavigationContext';
import type { ActiveTab } from '@/services/router';

// ─── Types ───────────────────────────────────────────────────────────────

export type SeoContext =
  | 'calculator'
  | 'confronti'
  | 'fisco'
  | 'guida'
  | 'vita'
  | 'stats';

interface SeoContentBlockProps {
  context: SeoContext;
}

// ─── Context Configuration ──────────────────────────────────────────────

const CONTEXT_CONFIG: Record<SeoContext, {
  Icon: typeof Calculator;
  gradient: string;
  collapsedBg: string;
  iconBg: string;
  iconText: string;
  features: number;
  checklist: number;
}> = {
  calculator: {
    Icon: Calculator,
    gradient: 'from-stripe-50 to-stripe-100 dark:from-stripe-950/30 dark:to-stripe-900/30',
    collapsedBg: 'bg-accent-subtle/60',
    iconBg: 'bg-accent-subtle',
    iconText: 'text-link',
    features: 4,
    checklist: 5,
  },
  confronti: {
    Icon: Scale,
    gradient: 'from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30',
    collapsedBg: 'bg-success-subtle/60',
    iconBg: 'bg-success-subtle',
    iconText: 'text-success',
    features: 4,
    checklist: 5,
  },
  fisco: {
    Icon: Landmark,
    gradient: 'from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30',
    collapsedBg: 'bg-success-subtle/60',
    iconBg: 'bg-success-subtle',
    iconText: 'text-success',
    features: 4,
    checklist: 5,
  },
  guida: {
    Icon: BookOpen,
    gradient: 'from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30',
    collapsedBg: 'bg-warning-subtle/60',
    iconBg: 'bg-warning-subtle',
    iconText: 'text-warning',
    features: 4,
    checklist: 5,
  },
  vita: {
    Icon: Users,
    gradient: 'from-amber-50 to-amber-50 dark:from-amber-950/30 dark:to-amber-950/30',
    collapsedBg: 'bg-warning-subtle/60',
    iconBg: 'bg-warning-subtle',
    iconText: 'text-warning',
    features: 4,
    checklist: 5,
  },
  stats: {
    Icon: Target,
    gradient: 'from-teal-50 to-stripe-50 dark:from-teal-950/30 dark:to-stripe-950/30',
    collapsedBg: 'bg-teal-50/60 dark:bg-teal-950/20',
    iconBg: 'bg-teal-100 dark:bg-teal-900/40',
    iconText: 'text-teal-600 dark:text-teal-400',
    features: 3,
    checklist: 4,
  },
};

// ─── Cross-Promo Feature Links ──────────────────────────────────────────
// Each context shows 4 feature cards from OTHER categories.
// This drives internal linking and user discovery.

interface FeatureLink {
  /** i18n key prefix — e.g. 'seoContent.confronti.feature1' */
  i18nKey: string;
  /** Navigation target tab */
  tab: ActiveTab;
  /** Optional sub-tab */
  subTab?: string;
}

/** For each SeoContext, 5 features from other categories (we show 4, excluding current sub-tab if applicable) */
const CROSS_PROMO: Record<SeoContext, FeatureLink[]> = {
  calculator: [
    { i18nKey: 'seoContent.confronti.feature1', tab: 'confronti', subTab: 'health' },     // LAMal
    { i18nKey: 'seoContent.confronti.feature2', tab: 'confronti', subTab: 'exchange' },    // Cambio CHF-EUR
    { i18nKey: 'seoContent.fisco.feature1', tab: 'fisco', subTab: 'tax-return' },           // Dichiarazione redditi
    { i18nKey: 'seoContent.guida.feature1', tab: 'guida', subTab: 'permit-compare' },       // Confronto permessi
    { i18nKey: 'seoContent.vita.feature1', tab: 'confronti', subTab: 'cost-of-living' },    // Costo vita
  ],
  confronti: [
    { i18nKey: 'seoContent.calculator.feature1', tab: 'calculator', subTab: 'salary' },     // Stipendio netto
    { i18nKey: 'seoContent.fisco.feature3', tab: 'fisco', subTab: 'tax-credit' },            // Credito d'imposta
    { i18nKey: 'seoContent.fisco.feature1', tab: 'fisco', subTab: 'tax-return' },            // Dichiarazione redditi
    { i18nKey: 'seoContent.guida.feature2', tab: 'guida', subTab: 'first-day' },             // Primo giorno
    { i18nKey: 'seoContent.stats.feature1', tab: 'stats', subTab: 'traffic' },               // Traffico valichi
  ],
  fisco: [
    { i18nKey: 'seoContent.calculator.feature1', tab: 'calculator', subTab: 'salary' },     // Stipendio netto
    { i18nKey: 'seoContent.confronti.feature1', tab: 'confronti', subTab: 'health' },       // LAMal
    { i18nKey: 'seoContent.confronti.feature2', tab: 'confronti', subTab: 'exchange' },     // Cambio CHF-EUR
    { i18nKey: 'seoContent.guida.feature1', tab: 'guida', subTab: 'permit-compare' },       // Confronto permessi
    { i18nKey: 'seoContent.vita.feature1', tab: 'confronti', subTab: 'cost-of-living' },    // Costo vita
  ],
  guida: [
    { i18nKey: 'seoContent.calculator.feature1', tab: 'calculator', subTab: 'salary' },     // Stipendio netto
    { i18nKey: 'seoContent.calculator.feature3', tab: 'fisco', subTab: 'pension' },          // Pianificatore pensione
    { i18nKey: 'seoContent.confronti.feature1', tab: 'confronti', subTab: 'health' },       // LAMal
    { i18nKey: 'seoContent.fisco.feature2', tab: 'fisco', subTab: 'calendar' },              // Calendario fiscale
    { i18nKey: 'seoContent.vita.feature4', tab: 'vita', subTab: 'companies' },               // Comunità frontaliera
  ],
  vita: [
    { i18nKey: 'seoContent.calculator.feature1', tab: 'calculator', subTab: 'salary' },     // Stipendio netto
    { i18nKey: 'seoContent.confronti.feature2', tab: 'confronti', subTab: 'exchange' },     // Cambio CHF-EUR
    { i18nKey: 'seoContent.fisco.feature1', tab: 'fisco', subTab: 'tax-return' },            // Dichiarazione redditi
    { i18nKey: 'seoContent.guida.feature2', tab: 'guida', subTab: 'first-day' },             // Primo giorno
    { i18nKey: 'seoContent.stats.feature2', tab: 'stats', subTab: 'overview' },              // Stipendi medi
  ],
  stats: [
    { i18nKey: 'seoContent.calculator.feature1', tab: 'calculator', subTab: 'salary' },     // Stipendio netto
    { i18nKey: 'seoContent.confronti.feature1', tab: 'confronti', subTab: 'health' },       // LAMal
    { i18nKey: 'seoContent.confronti.feature2', tab: 'confronti', subTab: 'exchange' },     // Cambio CHF-EUR
    { i18nKey: 'seoContent.fisco.feature1', tab: 'fisco', subTab: 'tax-return' },            // Dichiarazione redditi
    { i18nKey: 'seoContent.guida.feature1', tab: 'guida', subTab: 'permit-compare' },       // Confronto permessi
  ],
};

// ─── Component ───────────────────────────────────────────────────────────

const SeoContentBlock: React.FC<SeoContentBlockProps> = ({ context }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const config = CONTEXT_CONFIG[context];
  const nav = useNavigationOptional();

  // Reset expanded state when the section context changes (e.g. navigating
  // from fisco to guida). Without this, React reuses the component instance
  // and the card stays open on the new page.
  React.useEffect(() => { setExpanded(false); }, [context]);

  // Cross-promo: show features from OTHER categories, excluding current sub-tab
  const crossPromoFeatures = CROSS_PROMO[context].filter(f => {
    // Never link to the tab+subTab the user is currently on
    if (!nav) return true;
    if (f.tab === nav.activeTab) {
      // If the feature targets the same tab, exclude it (user is already there)
      return false;
    }
    return true;
  }).slice(0, 4);

  return (
    <section
      className={`mb-4 rounded-xl border border-edge overflow-hidden transition-colors ${
        expanded
          ? `bg-gradient-to-br ${config.gradient}`
          : config.collapsedBg
      }`}
      aria-label={t(`seoContent.${context}.title`)}
    >
      {/* Collapsed: minimal one-line header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left group"
        aria-expanded={expanded}
      >
        <config.Icon className={`w-4 h-4 ${config.iconText} shrink-0`} aria-hidden="true" />
        <h2 className="text-sm font-semibold text-body flex-1 line-clamp-2">
          {t(`seoContent.${context}.title`)}
        </h2>
        <div className="hidden sm:flex items-center gap-2 mr-2">
          <span className="flex items-center gap-1 text-xs text-muted">
            <Star className="w-3 h-3 text-amber-500" aria-hidden="true" />
            2026
          </span>
          <span className="flex items-center gap-1 text-xs text-muted">
            <Shield className="w-3 h-3 text-emerald-500" aria-hidden="true" />
            {t('seoContent.trust.free')}
          </span>
        </div>
        <Info className="w-3.5 h-3.5 text-muted shrink-0 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors" aria-hidden="true" />
        {expanded
          ? <ChevronUp className="w-4 h-4 text-muted shrink-0" aria-hidden="true" />
          : <ChevronDown className="w-4 h-4 text-muted shrink-0" aria-hidden="true" />
        }
      </button>

      {/* Expanded: full SEO content */}
      {expanded && (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5 animate-in fade-in duration-200">
          {/* Subtitle */}
          <p className="text-sm text-subtle mb-3">
            {t(`seoContent.${context}.subtitle`)}
          </p>

          {/* Expert quote — authority signal for AI citation (+30% visibility) */}
          {t(`seoContent.${context}.expertQuote`) !== `seoContent.${context}.expertQuote` && (
            <blockquote className="border-l-3 border-accent-border pl-3 mb-3 py-1.5" data-speakable="true">
              <p className="text-sm italic text-subtle">
                <Quote className="inline w-3.5 h-3.5 mr-1 text-accent -mt-0.5" aria-hidden="true" />
                {t(`seoContent.${context}.expertQuote`)}
              </p>
              <cite className="text-xs text-muted not-italic font-medium">
                — {t(`seoContent.${context}.expertName`)}
              </cite>
            </blockquote>
          )}

          {/* Trust signals */}
          <div className="flex flex-wrap gap-3 mb-3">
            <div className="flex items-center gap-1.5 text-xs text-subtle">
              <Star className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
              <span>{t('seoContent.trust.accuracy')}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-subtle">
              <Clock className="w-3.5 h-3.5 text-stripe-500" aria-hidden="true" />
              <span>{t('seoContent.trust.updated')}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-subtle">
              <Shield className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
              <span>{t('seoContent.trust.free')}</span>
            </div>
          </div>

          {/* Feature cards — cross-promo links to other sections */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            {crossPromoFeatures.map((feature, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setExpanded(false);
                  nav?.navigateTo(feature.tab, feature.subTab);
                }}
                className="flex items-center gap-2 p-2.5 bg-surface/70 rounded-lg text-left hover:bg-surface hover:shadow-sm transition-[color,background-color,border-color,box-shadow] cursor-pointer group/card"
              >
                <ArrowRight className={`w-3.5 h-3.5 shrink-0 ${config.iconText} group-hover/card:translate-x-0.5 transition-transform`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-body group-hover/card:text-stripe-600 dark:group-hover/card:text-stripe-400 transition-colors">
                    {t(`${feature.i18nKey}.title`)}
                  </p>
                  <p className="text-sm text-muted mt-0.5 line-clamp-1">
                    {t(`${feature.i18nKey}.desc`)}
                  </p>
                </div>
              </button>
            ))}
          </div>

          {/* Checklist */}
          <div className="space-y-1">
            {Array.from({ length: config.checklist }, (_, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-body">
                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
                <span>{t(`seoContent.${context}.check${i + 1}`)}</span>
              </div>
            ))}
          </div>

          {/* Data updated label */}
          <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-edge/50">
            <CalendarDays className="w-3.5 h-3.5 text-muted shrink-0" aria-hidden="true" />
            <span className="text-sm text-muted">
              {t('seoContent.dataUpdated')}
            </span>
          </div>
        </div>
      )}
    </section>
  );
};

export default SeoContentBlock;
