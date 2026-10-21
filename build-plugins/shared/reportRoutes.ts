/**
 * Canonical report routes shared by the report emitters and the site-map rail.
 *
 * Keeping the route tables here makes a report rename update every consumer at
 * once. Values intentionally omit the leading/trailing slash; `reportHref`
 * supplies the canonical trailing slash at the boundary.
 */

export type ReportLocale = 'it' | 'en' | 'de' | 'fr';

export const REPORT_LOCALES: readonly ReportLocale[] = ['it', 'en', 'de', 'fr'];

export const ANNUAL_REPORT_SLUG: Record<ReportLocale, string> = {
  it: 'report/frontalieri-2026',
  en: 'en/report/cross-border-workers-2026',
  de: 'de/report/grenzgaenger-2026',
  fr: 'fr/report/frontaliers-2026',
};

export const MARKET_REPORT_SLUG: Record<ReportLocale, string> = {
  it: 'reports/mercato-lavoro-frontalieri-ticino-2026',
  en: 'en/reports/ticino-cross-border-job-market-2026',
  de: 'de/reports/tessiner-grenzgaenger-arbeitsmarkt-2026',
  fr: 'fr/reports/marche-emploi-frontaliers-tessin-2026',
};

export function reportHref(slug: string): string {
  return `/${slug}/`;
}

export const REPORT_SITEMAP_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: reportHref(ANNUAL_REPORT_SLUG.it), label: 'Annual Report 2026 (italiano)' },
  { href: reportHref(ANNUAL_REPORT_SLUG.en), label: 'Annual Report 2026 (English)' },
  { href: reportHref(ANNUAL_REPORT_SLUG.de), label: 'Annual Report 2026 (Deutsch)' },
  { href: reportHref(ANNUAL_REPORT_SLUG.fr), label: 'Annual Report 2026 (Français)' },
  { href: reportHref(MARKET_REPORT_SLUG.it), label: 'Market Report 2026 (italiano)' },
  { href: reportHref(MARKET_REPORT_SLUG.en), label: 'Market Report 2026 (English)' },
  { href: reportHref(MARKET_REPORT_SLUG.de), label: 'Market Report 2026 (Deutsch)' },
  { href: reportHref(MARKET_REPORT_SLUG.fr), label: 'Market Report 2026 (Français)' },
];
