import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLUG_TABLES } from '../services/routeSlugs.data';
import { buildFaqHubPath } from '../data/faq-hub/routes';
import {
  ANNUAL_REPORT_SLUG,
  MARKET_REPORT_SLUG,
  REPORT_SITEMAP_LINKS,
} from '../build-plugins/shared/reportRoutes';

const root = path.resolve(__dirname, '..');
const sitemap = fs.readFileSync(path.join(root, 'public/sitemap-pages.xml'), 'utf8');
const redirects = fs.readFileSync(path.join(root, 'build-plugins/legacyRedirectsPlugin.ts'), 'utf8');
const staticPagesSource = fs.readFileSync(path.join(root, 'build-plugins/staticPagesPlugin.ts'), 'utf8');
const annualReportSource = fs.readFileSync(path.join(root, 'build-plugins/annualReportPlugin.ts'), 'utf8');
const marketReportSource = fs.readFileSync(path.join(root, 'build-plugins/marketReportPlugin.ts'), 'utf8');

describe('canonical utility route families', () => {
  it('keeps complete FAQ hub HTML under its dedicated plugin ownership', () => {
    const source = fs.readFileSync(path.join(root, 'build-plugins/staticPagesPlugin.ts'), 'utf8');
    expect(source).toContain('if (FAQ_HUB_ROUTES.includes(`${normalizedPath}/`)) continue;');
    expect(source).toContain('if (ogPagesPaths.has(locNormalized)) {');
    expect(source).toContain('if (FAQ_HUB_ROUTES.includes(`${locNormalized}/`)) continue;');
  });
  it.each([
    ['/about/', '/en/about-us/'],
    ['/contact/', '/en/contact-us/'],
    ['/privacy-policy/', '/en/privacy/'],
    ['/en/cross-border-faq/', '/en/frequently-asked-questions/'],
    ['/de/grenzgaenger-faq/', '/de/haeufige-fragen/'],
    ['/fr/faq-frontaliers/', '/fr/questions-frequentes/'],
  ])('retires %s from sitemap and keeps its bridge to %s', (from, to) => {
    expect(sitemap).not.toContain(`https://frontaliereticino.ch${from}`);
    expect(redirects).toContain(`'${from}': '${to}'`);
    expect(sitemap).toContain(`https://frontaliereticino.ch${to}`);
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('uses the existing FAQ hub for the %s route and sitemap', (locale) => {
    const route = `${locale === 'it' ? '' : `/${locale}`}/${SLUG_TABLES[locale].faq}/`;
    expect(route).toBe(buildFaqHubPath(locale));
    const faqGroup = sitemap.match(/<url>\s*<loc>https:\/\/frontaliereticino\.ch\/domande-frequenti-frontalieri\/<\/loc>[\s\S]*?<\/url>/)?.[0];
    expect(faqGroup).toContain(`hreflang="${locale}" href="https://frontaliereticino.ch${route}"`);
  });

  it('keeps every report site-map href aligned with both report emitters', () => {
    const locales = ['it', 'en', 'de', 'fr'] as const;
    const expected = [
      ...locales.map((locale) => `/${ANNUAL_REPORT_SLUG[locale]}/`),
      ...locales.map((locale) => `/${MARKET_REPORT_SLUG[locale]}/`),
    ];

    expect(REPORT_SITEMAP_LINKS.map(({ href }) => href)).toEqual(expected);
    expect(annualReportSource).toContain('export const REPORT_SLUG = ANNUAL_REPORT_SLUG;');
    expect(marketReportSource).toContain('export const REPORT_SLUG = MARKET_REPORT_SLUG;');
    expect(staticPagesSource).toContain("import { REPORT_SITEMAP_LINKS } from './shared/reportRoutes';");
    expect(staticPagesSource).toContain("renderHubLinks('Report annuali', REPORT_SITEMAP_LINKS)");
    expect(staticPagesSource).not.toContain('/report/frontaliere-ticino-2026/');
    expect(staticPagesSource).not.toContain('/en/reports/cross-border-job-market-ticino-2026/');
  });
});
