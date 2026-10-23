import { describe, expect, it } from 'vitest';
import { evaluateBfsGate } from '../scripts/audit-bfs-depth.mjs';

describe('BFS gate empty-tier contract (#13465 FU-006)', () => {
  it('warns about a malformed zero-denominator tier without hard-failing it', () => {
    const result = evaluateBfsGate({
      perSitemap: {
        'sitemap-empty.xml': { total: 0, atDepthGtMax: 1, deepest: 7 },
      },
      baseline: { version: 2, mode: 'rate', perSitemap: {} },
    });

    expect(result.unbaselined).toEqual([
      { name: 'sitemap-empty.xml', atDepthGtMax: 1, ratePct: 0 },
    ]);
    expect(result.buriedNewShards).toEqual([]);
    expect(result.regressions).toEqual([]);
  });

  it('does not emit a warning for a new tier with no buried URLs', () => {
    const result = evaluateBfsGate({
      perSitemap: {
        'sitemap-clean.xml': { total: 0, atDepthGtMax: 0, deepest: 0 },
      },
      baseline: { version: 2, mode: 'rate', perSitemap: {} },
    });

    expect(result.unbaselined).toEqual([]);
    expect(result.buriedNewShards).toEqual([]);
  });
});
