// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BORDER_MUNICIPALITY_HUB_PATH } from '../build-plugins/borderMunicipalityData';
import { routePreloadChunksFor } from '../build-plugins/staticPagePreloadMap';

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
    expect(STATIC_PLUGIN_SOURCE).toContain('routePreloadChunksFor(urlPath) ?? sectionChunks[firstSeg]');
  });

  it('maps the Vita subtab to the component that VitaTabContent actually renders', () => {
    expect(PREFETCH_SOURCE).toContain("() => import('@/components/tabs/VitaTabContent')");
    expect(PREFETCH_SOURCE).toContain("municipalities: [() => import('@/components/guide/FrontierGuide')]");
    expect(PREFETCH_SOURCE).not.toContain("components/comparators/CostOfLiving");
  });
});
