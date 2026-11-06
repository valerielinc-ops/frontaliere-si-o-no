/**
 * Shared internal linking module
 * 
 * Used by both BlogArticles and AiChatbot for consistent navigation.
 * Centralises NavAction types, route mapping, multilingual keyword matching,
 * and chatbot knowledge-base generation from i18n keys.
 */

import { buildPath } from '@/services/router';
import { buildFuelTodayPath } from '../build-plugins/fuelDailyData';
import type { Locale } from './i18n';

// ─── NavAction type ──────────────────────────────────────────

export type NavAction = 'calculator' | 'exchange' | 'health' | 'cost-of-living' | 'pension' | 'pillar3' |
 'payslip' | 'tax-return' | 'residency' | 'ristorni' | 'unemployment' | 'jobs' | 'companies' | 'banks' |
 'first-day' | 'permits' | 'border' | 'calendar' | 'whatif' | 'shopping' | 'transport' | 'salary-compare' | 'traffic-history' |
 'border-map' | 'municipalities' | 'car-transfer' | 'car-cost' | 'permit-compare' | 'renovation' |
 'mobile' | 'ral' | 'parental-leave' | 'nursery' | 'living-ch' | 'living-it' | 'livability' | 'job-board' | 'jobs-observatory' |
 'search-jobs';

/**
 * Named NavAction constants.
 * Use these instead of string literals so renames surface as type errors.
 * Consumers (e.g. AiChatbot searchJobs tool) reference `NAV_ACTION.SEARCH_JOBS`
 * to emit deep-links to the JobBoard results view.
 */
export const NAV_ACTION = {
 SEARCH_JOBS: 'search-jobs',
 JOB_BOARD: 'job-board',
 JOBS: 'jobs',
} as const satisfies Record<string, NavAction>;

export type NavigatorMap = Partial<Record<NavAction, () => void>>;

// ─── NavAction → AppRoute ────────────────────────────────────

/** NavAction → AppRoute for buildPath() so <a> links get real href for SEO crawlers */
export const NAV_ACTION_ROUTES: Record<NavAction, Parameters<typeof buildPath>[0]> = {
 calculator: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' },
 exchange: { activeTab: 'confronti', confrontiSubTab: 'exchange' },
 health: { activeTab: 'confronti', confrontiSubTab: 'health' },
 'cost-of-living':{ activeTab: 'confronti', confrontiSubTab: 'cost-of-living' },
 pension: { activeTab: 'fisco', fiscoSubTab: 'pension' },
 pillar3: { activeTab: 'fisco', fiscoSubTab: 'pillar3' },
 payslip: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' },
 'tax-return': { activeTab: 'fisco', fiscoSubTab: 'tax-return' },
 residency: { activeTab: 'calculator', calcolatoreSubTab: 'residency' },
 ristorni: { activeTab: 'fisco', fiscoSubTab: 'ristorni' },
 unemployment: { activeTab: 'guida', guidaSubTab: 'unemployment' },
 jobs: { activeTab: 'confronti', confrontiSubTab: 'jobs' },
 companies: { activeTab: 'vita', vitaSubTab: 'companies' },
 banks: { activeTab: 'confronti', confrontiSubTab: 'banks' },
 'first-day': { activeTab: 'guida', guidaSubTab: 'first-day' },
 permits: { activeTab: 'guida', guidaSubTab: 'permits' },
 border: { activeTab: 'guida', guidaSubTab: 'border' },
 calendar: { activeTab: 'fisco', fiscoSubTab: 'calendar' },
 whatif: { activeTab: 'calculator', calcolatoreSubTab: 'whatif' },
 shopping: { activeTab: 'confronti', confrontiSubTab: 'shopping' },
 transport: { activeTab: 'vita', vitaSubTab: 'transport' },
 'salary-compare':{ activeTab: 'stats', statsSubTab: 'salary-compare' },
 'jobs-observatory':{ activeTab: 'stats', statsSubTab: 'jobs-observatory' },
 'traffic-history':{ activeTab: 'stats', statsSubTab: 'traffic-history' },
 'border-map': { activeTab: 'guida', guidaSubTab: 'border-map' },
 municipalities: { activeTab: 'vita', vitaSubTab: 'municipalities' },
 'car-transfer': { activeTab: 'guida', guidaSubTab: 'car-transfer' },
 'car-cost': { activeTab: 'guida', guidaSubTab: 'car-cost' },
 'permit-compare':{ activeTab: 'guida', guidaSubTab: 'permit-compare' },
 renovation: { activeTab: 'confronti', confrontiSubTab: 'renovation' },
 mobile: { activeTab: 'confronti', confrontiSubTab: 'mobile' },
 ral: { activeTab: 'calculator', calcolatoreSubTab: 'ral' },
 'parental-leave':{ activeTab: 'calculator', calcolatoreSubTab: 'parental-leave' },
 nursery: { activeTab: 'vita', vitaSubTab: 'nursery' },
 'living-ch': { activeTab: 'vita', vitaSubTab: 'living-ch' },
 'living-it': { activeTab: 'vita', vitaSubTab: 'living-it' },
 livability: { activeTab: 'stats', statsSubTab: 'livability' },
 'job-board': { activeTab: 'job-board' },
 'search-jobs': { activeTab: 'job-board' },
};

// Keyword intent is shared with the publisher in the confined articles engine.
export { matchContentLinks } from '../packages/articles/engine/shared/contentLinkVocabulary.mjs';

/** One locale-aware destination catalogue for prose links and CTA cards. */
export function contentLinkDestinations(locale: Locale): Record<string, string> {
 return {
  ...Object.fromEntries(Object.entries(NAV_ACTION_ROUTES).map(([id, route]) => [id, buildPath(route, locale)])),
  'fuel-petrol': buildFuelTodayPath(locale, 'benzina'),
  'fuel-diesel': buildFuelTodayPath(locale, 'diesel'),
 };
}

// ─── Chatbot Knowledge Base ──────────────────────────────────

/** Maps NavAction → i18n key prefix for blog.cta.{key}.title/desc */
const TOOL_I18N_MAP: Array<{ action: NavAction; ctaKey: string }> = [
 { action: 'calculator', ctaKey: 'calculator' },
 { action: 'exchange', ctaKey: 'exchange' },
 { action: 'health', ctaKey: 'health' },
 { action: 'cost-of-living', ctaKey: 'costOfLiving' },
 { action: 'pension', ctaKey: 'pension' },
 { action: 'pillar3', ctaKey: 'pillar3' },
 { action: 'payslip', ctaKey: 'payslip' },
 { action: 'tax-return', ctaKey: 'taxReturn' },
 { action: 'residency', ctaKey: 'residency' },
 { action: 'ristorni', ctaKey: 'ristorni' },
 { action: 'unemployment', ctaKey: 'unemployment' },
 { action: 'jobs', ctaKey: 'jobs' },
 { action: 'companies', ctaKey: 'companies' },
 { action: 'banks', ctaKey: 'banks' },
 { action: 'first-day', ctaKey: 'firstDay' },
 { action: 'permits', ctaKey: 'permits' },
 { action: 'border', ctaKey: 'border' },
 { action: 'calendar', ctaKey: 'calendar' },
 { action: 'whatif', ctaKey: 'whatif' },
 { action: 'shopping', ctaKey: 'shopping' },
 { action: 'transport', ctaKey: 'transport' },
 { action: 'salary-compare', ctaKey: 'salaryCompare' },
 { action: 'traffic-history', ctaKey: 'trafficHistory' },
 { action: 'parental-leave', ctaKey: 'parentalLeave' },
 { action: 'job-board', ctaKey: 'jobBoard' },
];

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Builds a locale-aware tool catalogue for the chatbot system prompt.
 * Each entry: "- [title](nav:action): description"
 */
export function buildToolCatalogue(t: TranslateFn): string {
 return TOOL_I18N_MAP.map(({ action, ctaKey }) => {
 const title = t(`blog.cta.${ctaKey}.title`);
 const desc = t(`blog.cta.${ctaKey}.desc`);
 return `- [${title}](nav:${action}): ${desc}`;
 }).join('\n');
}

/**
 * Builds a locale-aware system prompt for the Gemini chatbot.
 * Includes the tool catalogue and instructions to use [text](nav:action) links.
 */
export function buildSystemPrompt(t: TranslateFn, locale: string): string {
 const catalogue = buildToolCatalogue(t);
 return t('chatbot.systemPrompt', { tools: catalogue, locale });
}
