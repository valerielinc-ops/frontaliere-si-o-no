// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BORDER_MUNICIPALITY_HUB_PATH } from '../build-plugins/borderMunicipalityData';
import {
  routeAwarePreloadChunksFor,
  routePreloadChunksFor,
} from '../build-plugins/staticPagePreloadMap';

const PREFETCH_SOURCE = readFileSync(resolve(__dirname, '../services/prefetch.ts'), 'utf8');
const STATIC_PLUGIN_SOURCE = readFileSync(resolve(__dirname, '../build-plugins/staticPagesPlugin.ts'), 'utf8');

describe('FrontierGuide route preload (#8904)', () => {
  it('preloads FrontierGuide for every locale municipality hub', () => {
    for (const hubPath of Object.values(BORDER_MUNICIPALITY_HUB_PATH)) {
      expect(routePreloadChunksFor(hubPath)).toEqual(['FrontierGuide']);
      expect(routePreloadChunksFor(hubPath.slice(0, -1))).toEqual(['FrontierGuide']);
      expect(routePreloadChunksFor(`${hubPath}?source=test#hub`)).toEqual(['FrontierGuide']);
    }
  });

  it('does not broaden the exact route override to the generic Vita hub', () => {
    expect(routePreloadChunksFor('/vivere-in-ticino/')).toBeUndefined();
    expect(STATIC_PLUGIN_SOURCE).toContain(
      'routeAwarePreloadChunksFor(urlPath, sectionChunks[firstSeg])',
    );
  });

  it('keeps CostOfLiving on its route-specific landing before the Vita fallback', () => {
    const costOfLivingPath = '/vivere-in-ticino/costo-della-vita/';

    const vitaFallback = ['FrontierGuide'];

    expect(routeAwarePreloadChunksFor(costOfLivingPath, vitaFallback)).toEqual(['CostOfLiving']);
    expect(routeAwarePreloadChunksFor(costOfLivingPath.slice(0, -1), vitaFallback)).toEqual(['CostOfLiving']);
    expect(routeAwarePreloadChunksFor(`${costOfLivingPath}?source=test#costs`, vitaFallback)).toEqual(['CostOfLiving']);
    expect(routeAwarePreloadChunksFor('/vivere-in-ticino/', vitaFallback)).toEqual(['FrontierGuide']);
  });

  it('maps the Vita subtab to the component that VitaTabContent actually renders', () => {
    expect(PREFETCH_SOURCE).toMatch(
      /vita:\s*\[\s*\(\) => import\('@\/components\/tabs\/VitaTabContent'\),\s*\(\) => import\('@\/components\/guide\/FrontierGuide'\),?\s*\]/,
    );
    expect(PREFETCH_SOURCE).toContain("municipalities: [() => import('@/components/guide/FrontierGuide')]");
    expect(PREFETCH_SOURCE).not.toContain("components/comparators/CostOfLiving");
  });

  it('maps every localized Vita section to FrontierGuide instead of CostOfLiving', () => {
    for (const section of ['vivere-in-ticino', 'living-in-ticino', 'leben-im-tessin', 'vivre-au-tessin']) {
      expect(STATIC_PLUGIN_SOURCE).toContain(`'${section}': ['FrontierGuide']`);
      expect(STATIC_PLUGIN_SOURCE).not.toContain(`'${section}': ['CostOfLiving']`);
    }
  });
});
