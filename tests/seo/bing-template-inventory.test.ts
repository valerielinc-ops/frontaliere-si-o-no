import { describe, expect, it } from 'vitest';

import {
  BING_TEMPLATE_TABLE,
  buildTemplateInventory,
  classifyBingTemplate,
  templateIndexFor,
} from '../../scripts/seo/bing-template-inventory.mjs';
import {
  aggregateCrawlReports,
  buildIssueBody,
} from '../../scripts/seo/bing-site-explorer-report.mjs';

const BASE = 'https://frontaliereticino.ch';

describe('Bing title/meta template inventory', () => {
  it('maps the residual route families to their owning emitters', () => {
    expect(classifyBingTemplate(`${BASE}/articoli-frontaliere/guida/`).id).toBe('article-pages');
    expect(classifyBingTemplate(`${BASE}/en/gasoline-price-switzerland/swiss-stations/`).id).toBe('fuel-station-index-pages');
    expect(classifyBingTemplate(`${BASE}/prezzi-diesel/oggi/`).id).toBe('fuel-daily-route-family');
    expect(classifyBingTemplate(`${BASE}/de/gesundheitseinrichtungen/hug/`).id).toBe('health-facility-pages');
    expect(classifyBingTemplate(`${BASE}/fr/encheres-plaques-suisses/geneve-ge/`).id).toBe('plate-auction-route-family');
    expect(classifyBingTemplate(`${BASE}/en/find-jobs-geneva/lugano/`).id).toBe('job-board-pages');
  });

  it('maps event, pharmacy and legacy calculator routes without swallowing nearby paths', () => {
    const positiveCases = [
      [`${BASE}/eventi/`, 'event-pages'],
      [`${BASE}/en/events/aargau/lugano/event-slug/`, 'event-pages'],
      [`${BASE}/de/veranstaltungen/zurich/archiv/page-2/`, 'event-pages'],
      [`${BASE}/fr/evenements/vaud/ce-week-end/`, 'event-pages'],
      [`${BASE}/farmacie/italia/como/como/farmacia-esempio/`, 'pharmacy-pages'],
      [`${BASE}/en/on-duty-pharmacies/week/2026-10-19/`, 'pharmacy-pages'],
      [`${BASE}/de/apotheken/ticino/lugano/notdienst/`, 'pharmacy-pages'],
      [`${BASE}/fr/pharmacies-de-garde/`, 'pharmacy-pages'],
      [`${BASE}/en/calcola-stipendio/?reddito=65000&tipo=OLD`, 'calculator-legacy-alias-pages'],
      [`${BASE}/de/calcola-stipendio/`, 'calculator-legacy-alias-pages'],
      [`${BASE}/fr/calcola-stipendio/`, 'calculator-legacy-alias-pages'],
    ] as const;

    for (const [url, family] of positiveCases) {
      expect(classifyBingTemplate(url).id, url).toBe(family);
    }

    const nearbyNonTargets = [
      `${BASE}/blog/events/a/`,
      `${BASE}/eventi-notizie/`,
      `${BASE}/en/farmacie/`,
      `${BASE}/pharmacies-old/example/`,
      `${BASE}/en/calcola-stipendio/details/`,
      `${BASE}/calcola-stipendio/`,
    ];
    for (const url of nearbyNonTargets) {
      expect(classifyBingTemplate(url).id, url).toBe('unknown');
    }
  });

  it('records the concrete emitters for the newly classified families', () => {
    expect(BING_TEMPLATE_TABLE.find((family) => family.id === 'event-pages')?.sourcePaths)
      .toEqual(expect.arrayContaining(['build-plugins/eventsSeoPagesPlugin.ts']));
    expect(BING_TEMPLATE_TABLE.find((family) => family.id === 'pharmacy-pages')?.sourcePaths)
      .toEqual(expect.arrayContaining([
        'build-plugins/pharmacyDirectoryPagesPlugin.ts',
        'build-plugins/pharmacyHubPlugin.ts',
      ]));
    expect(BING_TEMPLATE_TABLE.find((family) => family.id === 'calculator-legacy-alias-pages')?.sourcePaths)
      .toEqual(expect.arrayContaining(['build-plugins/calculatorLegacyAliasPlugin.ts']));
  });

  it('preserves unknown paths instead of assigning a guessed first match', () => {
    const result = classifyBingTemplate(`${BASE}/new-seo-family/example/`);
    expect(result.id).toBe('unknown');
    expect(result.reason).toBe('no-route-family');
  });

  it('exposes a stable compact template table for referrer attribution', () => {
    const index = templateIndexFor(`${BASE}/en/find-jobs-geneva/example/`);
    expect(BING_TEMPLATE_TABLE[index]).toMatchObject({ id: 'job-board-pages' });
    expect(BING_TEMPLATE_TABLE[index].sourcePaths).toContain('build-plugins/jobsSeoPagesPlugin.ts');
    expect(templateIndexFor(`${BASE}/not-yet-classified/`)).not.toBe(index);
  });

  it('groups only the two residual metadata findings and keeps bounded samples', () => {
    const inventory = buildTemplateInventory([
      { code: 'title-too-long', url: `${BASE}/articoli-frontaliere/a/` },
      { code: 'meta-description-too-short', url: `${BASE}/articoli-frontaliere/b/` },
      { code: 'meta-description-too-short', url: `${BASE}/strutture-sanitarie/hug/` },
      { code: 'meta-description-too-short', url: `${BASE}/not-yet-classified/` },
      { code: 'canonical-drift', url: `${BASE}/articoli-frontaliere/ignored/` },
    ], { sampleLimit: 1 });

    expect(inventory.findingCount).toBe(4);
    expect(inventory.classifiedFindings).toBe(3);
    expect(inventory.unclassifiedFindings).toBe(1);
    expect(inventory.families.map((family) => family.id)).toEqual([
      'article-pages',
      'health-facility-pages',
      'unknown',
    ]);
    expect(inventory.families[0].codeCounts).toEqual({
      'title-too-long': 1,
      'meta-description-too-short': 1,
    });
    expect(inventory.families[0].samples['meta-description-too-short']).toHaveLength(1);
    expect(inventory.families.find((family) => family.id === 'unknown')?.reasons).toEqual(['no-route-family']);
  });

  it('publishes the inventory in the full-tree summary and issue body', () => {
    const findings = [
      { code: 'title-too-long', url: `${BASE}/articoli-frontaliere/a/`, root: '/articoli-frontaliere/', status: 200 },
      { code: 'meta-description-too-short', url: `${BASE}/strutture-sanitarie/hug/`, root: '/strutture-sanitarie/', status: 200 },
    ];
    const summary = aggregateCrawlReports([{
      partition: 0,
      partitions: 1,
      manifestCount: findings.length,
      partitionTotal: findings.length,
      checkedCount: findings.length,
      baseUrl: BASE,
      codeCounts: { 'title-too-long': 1, 'meta-description-too-short': 1 },
      statusCounts: { 200: findings.length },
      folderStats: {
        '/articoli-frontaliere/': { checked: 1, statuses: { 200: 1 }, findings: { 'title-too-long': 1 } },
        '/strutture-sanitarie/': { checked: 1, statuses: { 200: 1 }, findings: { 'meta-description-too-short': 1 } },
      },
      findings,
      discoveredOutOfSitemap: [],
    }], { baseUrl: BASE, manifestCount: findings.length, sitemapCount: 1, urls: findings.map((item) => item.url) });

    expect(summary.templateInventory.findingCount).toBe(2);
    expect(summary.templateInventory.families.map((family) => family.id)).toEqual([
      'article-pages',
      'health-facility-pages',
    ]);
    expect(buildIssueBody(summary)).toContain('### Inventario template per title/meta');
    expect(buildIssueBody(summary)).toContain('build-plugins/healthFacilitiesPlugin.ts');
  });
});
