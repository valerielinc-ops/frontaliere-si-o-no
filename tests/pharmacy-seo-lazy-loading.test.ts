import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const seoService = readFileSync(resolve(ROOT, 'services/seoService.ts'), 'utf8');
const router = readFileSync(resolve(ROOT, 'services/router.ts'), 'utf8');
const runtimeSeo = readFileSync(resolve(ROOT, 'services/pharmacies/runtimeSeo.ts'), 'utf8');
const routePaths = readFileSync(resolve(ROOT, 'services/pharmacies/routePaths.ts'), 'utf8');

describe('pharmacy SEO lazy chunk wiring', () => {
  it('keeps pharmacy snapshots and resolver out of generic SEO/router imports', () => {
    expect(seoService).not.toContain('pharmacy-duties-ticino.json');
    expect(seoService).not.toContain('pharmacies-ticino-complete.json');
    expect(seoService).not.toContain("from './pharmacies/data'");
    expect(seoService).not.toContain("from './pharmacies/paths'");
    expect(seoService).not.toContain("from './pharmacies/dutyWeek'");
    expect(seoService).toContain("import('./pharmacies/runtimeSeo')");
    expect(seoService).toMatch(/route\.pharmacyPath[\s\S]*loadPharmacyRuntimeSeo\(\)/);

    expect(router).toContain("from './pharmacies/routePaths'");
    expect(router).not.toContain("from './pharmacies/paths'");
    expect(routePaths).not.toContain("from './data'");
    expect(routePaths).not.toContain('pharmacies-ticino');
    expect(runtimeSeo).toContain("import dutiesJson from '../../data/pharmacy-duties-ticino.json'");
    expect(runtimeSeo).toContain("import completeTicinoJson from '../../data/pharmacies-ticino-complete.json'");
  });
});
