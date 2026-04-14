/**
 * FiscoLanding — Above-the-fold hero + tool grid for the /tasse-e-pensione landing page.
 *
 * Improves engagement on the tax_index template by showing:
 * 1. A hero section with value proposition and trust signals
 * 2. An 8-card grid of all fisco tools with descriptions
 * 3. Cross-section CTA buttons linking to calculator, guide, comparators
 *
 * Renders between SeoContentBlock and TaxReturnGuide when the user lands
 * on the fisco root URL without explicitly selecting a sub-tab.
 */

import React from 'react';
import {
  FileText, Banknote, Calendar, Heart, BarChart2,
  PiggyBank, TrendingUp, Receipt, ArrowRight,
  Landmark, Shield, Clock, Sparkles, Users,
  Calculator, BookOpen, Scale,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import type { FiscoSubTab, ActiveTab } from '@/services/router';

// ─── Tool Definitions ────────────────────────────────────────────────────

interface FiscoTool {
  key: FiscoSubTab;
  icon: typeof FileText;
  titleKey: string;
  descKey: string;
  badge?: 'popular' | 'new';
}

const FISCO_TOOLS: FiscoTool[] = [
  { key: 'tax-return',        icon: FileText,   titleKey: 'comparators.taxReturn',     descKey: 'fisco.landing.tool.taxReturn.desc',        badge: 'popular' },
  { key: 'withholding-rates', icon: Banknote,   titleKey: 'withholdingRates.navLabel',  descKey: 'fisco.landing.tool.withholdingRates.desc' },
  { key: 'calendar',          icon: Calendar,   titleKey: 'guide.tabs.calendar',        descKey: 'fisco.landing.tool.calendar.desc' },
  { key: 'ristorni',          icon: BarChart2,   titleKey: 'guide.tabs.ristorni',        descKey: 'fisco.landing.tool.ristorni.desc' },
  { key: 'pension',           icon: PiggyBank,  titleKey: 'nav.pension',                descKey: 'fisco.landing.tool.pension.desc',          badge: 'popular' },
  { key: 'pillar3',           icon: TrendingUp, titleKey: 'pension.pillar3',            descKey: 'fisco.landing.tool.pillar3.desc' },
  { key: 'tax-credit',        icon: Receipt,    titleKey: 'taxCredit.navLabel',         descKey: 'fisco.landing.tool.taxCredit.desc' },
  { key: 'new-frontier-tax-sim', icon: Users,  titleKey: 'newFrontierTaxSim.navLabel', descKey: 'fisco.landing.tool.newFrontierTaxSim.desc', badge: 'new' },
  { key: 'holidays',          icon: Heart,      titleKey: 'guide.tabs.holidays',        descKey: 'fisco.landing.tool.holidays.desc' },
];

interface CrossSectionCta {
  tab: ActiveTab;
  subTab?: string;
  icon: typeof Calculator;
  labelKey: string;
}

const CROSS_SECTION_CTAS: CrossSectionCta[] = [
  { tab: 'calculator', subTab: 'salary', icon: Calculator, labelKey: 'fisco.landing.cta.calculator' },
  { tab: 'guida',      subTab: 'permit-compare', icon: BookOpen,   labelKey: 'fisco.landing.cta.guide' },
  { tab: 'confronti',  subTab: 'cost-of-living', icon: Scale,      labelKey: 'fisco.landing.cta.comparators' },
];

// ─── Component ───────────────────────────────────────────────────────────

const FiscoLanding: React.FC = () => {
  const { t } = useTranslation();
  const nav = useNavigation();

  const handleToolClick = (subTab: FiscoSubTab) => {
    nav.navigateTo('fisco', subTab);
  };

  const handleCtaClick = (tab: ActiveTab, subTab?: string) => {
    nav.navigateTo(tab, subTab);
  };

  return (
    <div className="space-y-6 mb-8">
      {/* ─── Hero Section ──────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-warm-50 via-warm-100 to-warm-50 dark:from-warm-950/40 dark:via-warm-900/30 dark:to-warm-950/20 border border-warm-200/60 dark:border-warm-800/40">
        <div className="relative px-5 py-6 sm:px-8 sm:py-8">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-success-subtle flex items-center justify-center">
              <Landmark className="w-6 h-6 sm:w-7 sm:h-7 text-success" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl sm:text-2xl font-bold text-strong leading-tight">
                {t('fisco.landing.title')}
              </h1>
              <p className="mt-1.5 text-sm sm:text-base text-subtle leading-relaxed max-w-2xl">
                {t('fisco.landing.subtitle')}
              </p>
            </div>
          </div>

          {/* Trust signals */}
          <div className="flex flex-wrap items-center gap-3 mt-4 text-xs font-medium text-muted">
            <span className="inline-flex items-center gap-1 bg-surface/70 px-2.5 py-1 rounded-full">
              <Shield className="w-3.5 h-3.5 text-emerald-500" />
              {t('fisco.landing.trust.updated')}
            </span>
            <span className="inline-flex items-center gap-1 bg-surface/70 px-2.5 py-1 rounded-full">
              <Clock className="w-3.5 h-3.5 text-stripe-500" />
              {t('fisco.landing.trust.free')}
            </span>
            <span className="inline-flex items-center gap-1 bg-surface/70 px-2.5 py-1 rounded-full">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              {t('fisco.landing.trust.tools')}
            </span>
          </div>
        </div>
      </div>

      {/* ─── AI-Extractable Intro ────────────────────────────────────── */}
      <div className="max-w-2xl mx-auto text-center px-4 mt-3 mb-6">
        <p className="text-sm text-subtle leading-relaxed">
          {t('fisco.landing.intro.p1')}
        </p>
        <p className="text-sm text-subtle leading-relaxed mt-3">
          {t('fisco.landing.intro.p2')}
        </p>
      </div>

      {/* ─── Tool Grid ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {FISCO_TOOLS.map(({ key, icon: Icon, titleKey, descKey, badge }) => (
          <button
            key={key}
            onClick={() => handleToolClick(key)}
            className="group relative flex flex-col items-start gap-2 p-4 rounded-xl bg-surface border border-edge hover:border-emerald-300 dark:hover:border-emerald-700 hover:shadow-md transition-[color,background-color,border-color,box-shadow] text-left"
          >
            {badge && (
              <span className={`absolute top-2.5 right-2.5 text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                badge === 'popular'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-stripe-100 text-stripe-700 dark:bg-stripe-900/30 dark:text-stripe-400'
              }`}>
                {badge === 'popular' ? '⭐' : '🆕'}
              </span>
            )}
            <div className="w-9 h-9 rounded-lg bg-success-subtle flex items-center justify-center group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/50 transition-colors">
              <Icon className="w-4.5 h-4.5 text-success" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-strong group-hover:text-emerald-700 dark:group-hover:text-emerald-300 transition-colors">
                {t(titleKey)}
              </h3>
              <p className="mt-0.5 text-xs text-muted leading-relaxed line-clamp-2">
                {t(descKey)}
              </p>
            </div>
            <div className="mt-auto pt-1 flex items-center gap-1 text-xs font-medium text-success opacity-0 group-hover:opacity-100 transition-opacity">
              {t('fisco.landing.explore')}
              <ArrowRight className="w-3 h-3" />
            </div>
          </button>
        ))}
      </div>

      {/* ─── Cross-Section CTAs ────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
        <span className="text-xs font-medium text-muted uppercase tracking-wider shrink-0">
          {t('fisco.landing.alsoExplore')}
        </span>
        <div className="flex flex-wrap gap-2">
          {CROSS_SECTION_CTAS.map(({ tab, subTab, icon: Icon, labelKey }) => (
            <button
              key={tab}
              onClick={() => handleCtaClick(tab, subTab)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-subtle bg-surface-raised rounded-lg hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-400 transition-colors border border-transparent hover:border-emerald-200 dark:hover:border-emerald-800"
            >
              <Icon className="w-3.5 h-3.5" />
              {t(labelKey)}
              <ArrowRight className="w-3 h-3 opacity-60" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export { FISCO_TOOLS, CROSS_SECTION_CTAS };
export default FiscoLanding;
