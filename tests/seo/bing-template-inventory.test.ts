import { describe, expect, it } from 'vitest';

import {
  buildTemplateInventory,
  classifyBingTemplate,
} from '../../scripts/seo/bing-template-inventory.mjs';

const BASE = 'https://frontaliereticino.ch';

describe('Bing title/meta template inventory', () => {
  it('maps the residual route families to their owning emitters', () => {
    expect(classifyBingTemplate(`${BASE}/articoli-frontaliere/guida/`).id).toBe('article-pages');
    expect(classifyBingTemplate(`${BASE}/en/gasoline-price-switzerland/stazioni-svizzere/`).id).toBe('fuel-station-index-pages');
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
});
