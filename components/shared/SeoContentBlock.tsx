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
    gradient: 'from-blue-50 to-blue-100 dark:from-blue-950/30 dark:to-blue-900/30',
    collapsedBg: 'bg-blue-50/60 dark:bg-blue-950/20',
    iconBg: 'bg-blue-100 dark:bg-blue-900/40',
    iconText: 'text-blue-600 dark:text-blue-400',
    features: 4,
    checklist: 5,
  },
  confronti: {
    Icon: Scale,
    gradient: 'from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/30',
    collapsedBg: 'bg-violet-50/60 dark:bg-violet-950/20',
    iconBg: 'bg-violet-100 dark:bg-violet-900/40',
    iconText: 'text-violet-600 dark:text-violet-400',
    features: 4,
    checklist: 5,
  },
  fisco: {
    Icon: Landmark,
    gradient: 'from-emerald-50 to-blue-50 dark:from-emerald-950/30 dark:to-blue-950/30',
    collapsedBg: 'bg-emerald-50/60 dark:bg-emerald-950/20',
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/40',
    iconText: 'text-emerald-600 dark:text-emerald-400',
    features: 4,
    checklist: 5,
  },
  guida: {
    Icon: BookOpen,
    gradient: 'from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30',
    collapsedBg: 'bg-amber-50/60 dark:bg-amber-950/20',
    iconBg: 'bg-amber-100 dark:bg-amber-900/40',
    iconText: 'text-amber-600 dark:text-amber-400',
    features: 4,
    checklist: 5,
  },
  vita: {
    Icon: Users,
    gradient: 'from-pink-50 to-rose-50 dark:from-pink-950/30 dark:to-rose-950/30',
    collapsedBg: 'bg-pink-50/60 dark:bg-pink-950/20',
    iconBg: 'bg-pink-100 dark:bg-pink-900/40',
    iconText: 'text-pink-600 dark:text-pink-400',
    features: 4,
    checklist: 5,
  },
  stats: {
    Icon: Target,
    gradient: 'from-blue-50 to-sky-50 dark:from-blue-950/30 dark:to-sky-950/30',
    collapsedBg: 'bg-blue-50/60 dark:bg-blue-950/20',
    iconBg: 'bg-blue-100 dark:bg-blue-900/40',
    iconText: 'text-blue-600 dark:text-blue-400',
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
      className={`mb-4 rounded-xl border border-slate-200/60 dark:border-slate-700/60 overflow-hidden transition-colors ${
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
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex-1 line-clamp-2">
          {t(`seoContent.${context}.title`)}
        </h2>
        <div className="hidden sm:flex items-center gap-2 mr-2">
          <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            <Star className="w-3 h-3 text-amber-500" aria-hidden="true" />
            2026
          </span>
          <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            <Shield className="w-3 h-3 text-emerald-500" aria-hidden="true" />
            {t('seoContent.trust.free')}
          </span>
        </div>
        <Info className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors" aria-hidden="true" />
        {expanded
          ? <ChevronUp className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" aria-hidden="true" />
          : <ChevronDown className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" aria-hidden="true" />
        }
      </button>

      {/* Expanded: full SEO content */}
      {expanded && (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5 animate-in fade-in duration-200">
          {/* Subtitle */}
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
            {t(`seoContent.${context}.subtitle`)}
          </p>

          {/* Expert quote — authority signal for AI citation (+30% visibility) */}
          {t(`seoContent.${context}.expertQuote`) !== `seoContent.${context}.expertQuote` && (
            <blockquote className="border-l-3 border-blue-400 dark:border-blue-500 pl-3 mb-3 py-1.5" data-speakable="true">
              <p className="text-sm italic text-slate-600 dark:text-slate-400">
                <Quote className="inline w-3.5 h-3.5 mr-1 text-blue-400 dark:text-blue-500 -mt-0.5" aria-hidden="true" />
                {t(`seoContent.${context}.expertQuote`)}
              </p>
              <cite className="text-xs text-slate-500 dark:text-slate-400 not-italic font-medium">
                — {t(`seoContent.${context}.expertName`)}
              </cite>
            </blockquote>
          )}

          {/* Trust signals */}
          <div className="flex flex-wrap gap-3 mb-3">
            <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
              <Star className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
              <span>{t('seoContent.trust.accuracy')}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
              <Clock className="w-3.5 h-3.5 text-blue-500" aria-hidden="true" />
              <span>{t('seoContent.trust.updated')}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
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
                className="flex items-center gap-2 p-2.5 bg-white/70 dark:bg-slate-800/50 rounded-lg text-left hover:bg-white dark:hover:bg-slate-800 hover:shadow-sm transition-[color,background-color,border-color,box-shadow] cursor-pointer group/card"
              >
                <ArrowRight className={`w-3.5 h-3.5 shrink-0 ${config.iconText} group-hover/card:translate-x-0.5 transition-transform`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 group-hover/card:text-blue-600 dark:group-hover/card:text-blue-400 transition-colors">
                    {t(`${feature.i18nKey}.title`)}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">
                    {t(`${feature.i18nKey}.desc`)}
                  </p>
                </div>
              </button>
            ))}
          </div>

          {/* Checklist */}
          <div className="space-y-1">
            {Array.from({ length: config.checklist }, (_, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
                <span>{t(`seoContent.${context}.check${i + 1}`)}</span>
              </div>
            ))}
          </div>

          {/* Data updated label */}
          <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-slate-200/50 dark:border-slate-700/50">
            <CalendarDays className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" aria-hidden="true" />
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t('seoContent.dataUpdated')}
            </span>
          </div>
        </div>
      )}
    </section>
  );
};

export default SeoContentBlock;
