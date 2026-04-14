/**
 * RelatedTools — Contextual internal cross-linking between pages
 *
 * THIS IS A CRITICAL SEO COMPONENT. Internal links help Google:
 * 1. Discover and crawl all pages (crawl budget efficiency)
 * 2. Understand page relationships (topic clustering)
 * 3. Distribute PageRank (link equity flow)
 * 4. Determine content relevance and authority
 *
 * Each page should link to 3-4 related pages via this component.
 * Links use actual <a href> tags (not React state navigation) so
 * crawlers can follow them without executing JavaScript.
 *
 * Usage:
 * <RelatedTools context="salary" onNavigate={(tab, sub) => {...}} />
 *
 * The `context` prop determines which related tools are shown.
 */

import React from 'react';
import { ArrowRight, Calculator, FileText, Scale, Heart, Briefcase, TrendingUp, Shield, Globe, Landmark, Gift } from 'lucide-react';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

// ─── Types ───────────────────────────────────────────────────────────────

export type RelatedContext =
 | 'salary' // Main salary calculator
 | 'payslip' // Payslip simulator
 | 'tax' // Tax/fiscal pages
 | 'insurance' // Health insurance
 | 'pension' // Pension planner
 | 'exchange' // Currency exchange
 | 'comparison' // Cost of living comparisons
 | 'permits' // Permit compare
 | 'guide' // Guides landing
 | 'blog'; // Blog articles

interface RelatedTool {
 titleKey: string;
 descKey: string;
 Icon: typeof Calculator;
 href: string; // Italian URL for SEO crawling
 tab: string;
 subTab?: string;
}

interface RelatedToolsProps {
 context: RelatedContext;
 onNavigate?: (tab: string, subTab?: string) => void;
}

// ─── Related tools map ──────────────────────────────────────────────────

const TOOL_DEFINITIONS: Record<string, RelatedTool> = {
 salary: {
 titleKey: 'relatedTools.salary.title',
 descKey: 'relatedTools.salary.desc',
 Icon: Calculator,
 href: '/calcola-stipendio',
 tab: 'calculator',
 },
 payslip: {
 titleKey: 'relatedTools.payslip.title',
 descKey: 'relatedTools.payslip.desc',
 Icon: FileText,
 href: '/calcola-stipendio/simula-busta-paga',
 tab: 'calculator',
 subTab: 'payslip',
 },
 taxReturn: {
 titleKey: 'relatedTools.taxReturn.title',
 descKey: 'relatedTools.taxReturn.desc',
 Icon: FileText,
 href: '/tasse-e-pensione/dichiarazione-redditi',
 tab: 'fisco',
 subTab: 'tax-return',
 },
 insurance: {
 titleKey: 'relatedTools.insurance.title',
 descKey: 'relatedTools.insurance.desc',
 Icon: Heart,
 href: '/compara-servizi/confronta-casse-malati',
 tab: 'confronti',
 subTab: 'health',
 },
 pension: {
 titleKey: 'relatedTools.pension.title',
 descKey: 'relatedTools.pension.desc',
 Icon: Landmark,
 href: '/tasse-e-pensione/calcola-previdenza',
 tab: 'fisco',
 subTab: 'pension',
 },
 exchange: {
 titleKey: 'relatedTools.exchange.title',
 descKey: 'relatedTools.exchange.desc',
 Icon: TrendingUp,
 href: '/compara-servizi/cambio-franco-euro',
 tab: 'confronti',
 subTab: 'exchange',
 },
 costOfLiving: {
 titleKey: 'relatedTools.costOfLiving.title',
 descKey: 'relatedTools.costOfLiving.desc',
 Icon: Scale,
 href: '/compara-servizi/costo-della-vita',
 tab: 'confronti',
 subTab: 'cost-of-living',
 },
 permits: {
 titleKey: 'relatedTools.permits.title',
 descKey: 'relatedTools.permits.desc',
 Icon: Shield,
 href: '/guida-frontaliere/permessi-di-lavoro',
 tab: 'guida',
 subTab: 'permits',
 },
 firstDay: {
 titleKey: 'relatedTools.firstDay.title',
 descKey: 'relatedTools.firstDay.desc',
 Icon: Briefcase,
 href: '/guida-frontaliere/primo-giorno-lavoro',
 tab: 'guida',
 subTab: 'first-day',
 },
 pillar3: {
 titleKey: 'relatedTools.pillar3.title',
 descKey: 'relatedTools.pillar3.desc',
 Icon: Landmark,
 href: '/tasse-e-pensione/simula-terzo-pilastro',
 tab: 'fisco',
 subTab: 'pillar3',
 },
 mortgage: {
 titleKey: 'relatedTools.mortgage.title',
 descKey: 'relatedTools.mortgage.desc',
 Icon: Globe,
 href: '/statistiche/confronto-mutui',
 tab: 'stats',
 subTab: 'mortgage',
 },
 glossary: {
 titleKey: 'relatedTools.glossary.title',
 descKey: 'relatedTools.glossary.desc',
 Icon: FileText,
 href: '/glossario-frontaliere',
 tab: 'glossario',
 },
 tredicesima: {
 titleKey: 'relatedTools.tredicesima.title',
 descKey: 'relatedTools.tredicesima.desc',
 Icon: Gift,
 href: '/calcolo-tredicesima-frontaliere',
 tab: 'tredicesima',
 },
 jobs: {
 titleKey: 'relatedTools.jobs.title',
 descKey: 'relatedTools.jobs.desc',
 Icon: Briefcase,
 href: '/cerca-lavoro-ticino',
 tab: 'job-board',
 },
};

// Which tools to show for each context — carefully curated for topical relevance
const CONTEXT_MAP: Record<RelatedContext, string[]> = {
 salary: ['payslip', 'taxReturn', 'pension', 'jobs'],
 payslip: ['salary', 'taxReturn', 'tredicesima', 'jobs'],
 tax: ['salary', 'payslip', 'pension', 'glossary'],
 insurance: ['salary', 'costOfLiving', 'permits', 'pension'],
 pension: ['pillar3', 'salary', 'insurance', 'taxReturn'],
 exchange: ['salary', 'costOfLiving', 'mortgage', 'insurance'],
 comparison: ['exchange', 'costOfLiving', 'insurance', 'salary'],
 permits: ['firstDay', 'insurance', 'salary', 'jobs'],
 guide: ['salary', 'insurance', 'permits', 'jobs'],
 blog: ['salary', 'insurance', 'exchange', 'jobs'],
};

// ─── Component ───────────────────────────────────────────────────────────

const RelatedTools: React.FC<RelatedToolsProps> = ({ context, onNavigate }) => {
 const { t } = useTranslation();
 const toolKeys = CONTEXT_MAP[context] || CONTEXT_MAP.salary;
 // Programmatic self-exclusion: never show a link to the page the user is already on
 const tools = toolKeys
 .filter(key => key !== context)
 .map(key => TOOL_DEFINITIONS[key])
 .filter(Boolean);

 const handleClick = (e: React.MouseEvent, tool: RelatedTool) => {
 e.preventDefault();
 Analytics.trackUIInteraction('related_tools', 'link', 'click', `${context}_to_${tool.tab}_${tool.subTab || ''}`);
 if (onNavigate) {
 onNavigate(tool.tab, tool.subTab);
 } else {
 // Dispatch navigate-tab event — App.tsx listens for this and updates state + URL
 window.dispatchEvent(new CustomEvent('navigate-tab', {
 detail: { tab: tool.tab, subTab: tool.subTab },
 }));
 }
 };

 return (
 <section className="mt-8 mb-4" aria-label={t('relatedTools.heading')}>
 <h3 className="text-sm font-bold text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
 <ArrowRight className="w-4 h-4" />
 {t('relatedTools.heading')}
 </h3>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {tools.map((tool) => (
 <a
 key={tool.href}
 href={tool.href}
 onClick={(e) => handleClick(e, tool)}
 className="group flex items-center gap-3 p-3 bg-surface border border-edge rounded-xl hover:border-stripe-300 dark:hover:border-stripe-600 hover:shadow-md transition-[color,background-color,border-color,box-shadow]"
 >
 <div className="p-2 bg-accent-subtle rounded-lg shrink-0 group-hover:bg-stripe-100 dark:group-hover:bg-stripe-900/50 transition-colors">
 <tool.Icon className="w-4 h-4 text-accent" />
 </div>
 <div className="min-w-0 flex-1">
 <p className="text-sm font-semibold text-strong group-hover:text-stripe-700 dark:group-hover:text-stripe-300 transition-colors">
 {t(tool.titleKey, getCantonI18nParams())}
 </p>
 <p className="text-sm text-muted mt-0.5 line-clamp-2">
 {t(tool.descKey, getCantonI18nParams())}
 </p>
 </div>
 <ArrowRight className="w-4 h-4 text-edge group-hover:text-stripe-500 dark:group-hover:text-stripe-400 shrink-0 group-hover:translate-x-0.5 transition-[color,background-color,border-color,transform]" />
 </a>
 ))}
 </div>
 </section>
 );
};

export default RelatedTools;
export { CONTEXT_MAP, TOOL_DEFINITIONS };
