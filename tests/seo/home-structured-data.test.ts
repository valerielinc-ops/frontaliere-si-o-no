/**
 * What the four homepages declare in JSON-LD (audit GEO 2026-10-31).
 *
 * index.html is the template of `/` and, through `renderLocaleRootShell`, of
 * `/en/`, `/de/` and `/fr/`. A block written there reaches all four, so it must
 * either describe what those pages show or be scoped to the Italian root.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { renderLocaleRootShell } from '../../build-plugins/staticPagesPlugin';
import { ORGANIZATION_LD, ORGANIZATION_SAME_AS } from '../../services/seo/organizationLd';
import { EXCHANGE_RATE_DATE } from '../../services/seo/exchangeRateMeta';
import { jsToJson } from '../../build-plugins/shared/jsToJson';
import SEO_PAGES_METADATA from '../../services/seo/seo-pages';

const ROOT = resolve(__dirname, '../..');
const INDEX_HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf-8');
const ROBOTS = readFileSync(resolve(ROOT, 'public/robots.txt'), 'utf-8');

type Node = Record<string, unknown>;

function jsonLd(html: string): Node[] {
  const { document } = new JSDOM(html).window;
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((script) => JSON.parse(script.textContent || '{}') as Node);
}

const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, '');
const byType = (nodes: Node[], type: string) => nodes.filter((node) => node['@type'] === type);

describe('the Italian home template', () => {
  const nodes = jsonLd(INDEX_HTML);

  it('declares no FAQPage or HowTo the page does not show', () => {
    expect(byType(nodes, 'FAQPage')).toEqual([]);
    expect(byType(nodes, 'HowTo')).toEqual([]);
    const calculator = JSON.stringify(SEO_PAGES_METADATA.calculator.structuredData);
    expect(calculator).not.toContain('FAQPage');
    expect(calculator).not.toContain('HowTo');
  });

  it('offers no SearchAction, because ?q= is disallowed and only the job board reads it', () => {
    expect(JSON.stringify(nodes)).not.toContain('SearchAction');
    expect(JSON.stringify(SEO_PAGES_METADATA.calculator.structuredData)).not.toContain('SearchAction');
    expect(ROBOTS).toContain('Disallow: /*?q=*');
    expect(ROBOTS).not.toMatch(/noindex meta runtime/);
  });

  it('keeps every JSON-LD opening tag out of comments, where a regex reader would take it for real', () => {
    for (const comment of INDEX_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      expect(comment[0]).not.toContain('application/ld+json');
    }
  });

  it('states the licence of the /statistiche/ dataset, not a privacy policy', () => {
    const [dataset] = byType(nodes, 'Dataset');
    expect(dataset.license).toBe('https://creativecommons.org/licenses/by-nc/4.0/');
    const pagesSource = readFileSync(resolve(ROOT, 'services/seo/seo-pages.ts'), 'utf-8');
    const statistics = pagesSource.slice(pagesSource.indexOf('Statistiche frontalieri e osservatorio offerte lavoro Ticino 2026'));
    expect(statistics).toContain(`"license": "${dataset.license}"`);
  });

  it('describes one publisher: logo object, no second profile per network', () => {
    const organization = byType(nodes, 'Organization')[0];
    expect(organization.logo).toEqual(JSON.parse(JSON.stringify(ORGANIZATION_LD.logo)));
    expect(organization.sameAs).toEqual([...ORGANIZATION_SAME_AS]);
    const hosts = ORGANIZATION_SAME_AS.map(hostOf);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});

describe.each(['en', 'de', 'fr'] as const)('the %s home shell', (locale) => {
  const nodes = jsonLd(renderLocaleRootShell(INDEX_HTML, locale));

  it('has its own WebPage', () => {
    const webPages = byType(nodes, 'WebPage');
    expect(webPages).toHaveLength(1);
    expect(webPages[0].url).toBe(`https://frontaliereticino.ch/${locale}/`);
    expect(webPages[0].inLanguage).toBe(locale);
    expect(webPages[0].name).not.toBe('Simulazione Tasse Nuovi Frontalieri 2026');
  });

  it('carries no Italian-only block', () => {
    expect(byType(nodes, 'DefinedTermSet')).toEqual([]);
    expect(byType(nodes, 'Dataset')).toEqual([]);
  });

  it('is stable when the shell is rendered twice', () => {
    const once = renderLocaleRootShell(INDEX_HTML, locale);
    expect(jsonLd(renderLocaleRootShell(once, locale))).toEqual(jsonLd(once));
  });
});

describe('the exchange-rate specification', () => {
  const node = (SEO_PAGES_METADATA.exchange.structuredData as Node[])
    .find((item) => item['@type'] === 'ExchangeRateSpecification') as Node;

  it('dates the rate and gives the spread as numbers', () => {
    expect((node.currentExchangeRate as Node).validFrom).toBe(EXCHANGE_RATE_DATE);
    expect(EXCHANGE_RATE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(node.exchangeRateSpread).toMatchObject({ '@type': 'MonetaryAmount', currency: 'CHF', minValue: 0.3, maxValue: 3 });
  });

  it('survives the build-time parse of seo-pages.ts', () => {
    expect(jsToJson('"validFrom": EXCHANGE_RATE_DATE', { baseUrl: 'https://x', buildDateIso: '2026-01-01T00:00:00.000Z' }))
      .toBe(`"validFrom": "${EXCHANGE_RATE_DATE}"`);
  });
});
