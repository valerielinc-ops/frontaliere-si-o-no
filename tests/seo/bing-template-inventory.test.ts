import { describe, expect, it } from 'vitest';

import {
  buildTemplateInventory,
  classifyBingTemplate,
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
    expect(classifyBingTemplate(`${BASE}/prezzi-diesel/oggi/`).id).toBe('fuel-daily-pages');
    expect(classifyBingTemplate(`${BASE}/de/gesundheitseinrichtungen/hug/`).id).toBe('health-facility-pages');
    expect(classifyBingTemplate(`${BASE}/fr/encheres-plaques-suisses/geneve-ge/`).id).toBe('plate-auction-pages');
    expect(classifyBingTemplate(`${BASE}/en/find-jobs-geneva/lugano/`).id).toBe('job-board-pages');
  });

  it('preserves unknown paths instead of assigning a guessed first match', () => {
    const result = classifyBingTemplate(`${BASE}/new-seo-family/example/`);
    expect(result.id).toBe('unknown');
    expect(result.reason).toBe('no-route-family');
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
