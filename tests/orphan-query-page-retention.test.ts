// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_LANDINGS, orphanQueryLandingPlugin } from '../build-plugins/orphanQueryLandingPlugin';

afterEach(() => vi.unstubAllEnvs());

async function renderClusters(count: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-retention-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/gsc-orphan-queries-clusters.json'), JSON.stringify({
    clusters: Array.from({ length: count }, (_, i) => ({
      clusterId: `it-ricerca-${i}`, locale: 'it', canonicalQuery: `ricerca qualificata ${i}`,
      canonicalSlug: `ricerca-${i}`, roleTokens: ['qualificata'], regionTokens: [],
      totalImpressions: 10, totalClicks: 0, queries: [{ query: `posti qualificati ${i}`, clicks: 0, impressions: 10 }],
    })),
  }));
  try {
    const plugin = orphanQueryLandingPlugin(root);
    await (plugin.closeBundle as () => Promise<void>)();
    return {
      first: fs.readFileSync(path.join(root, 'dist/ricerca/ricerca-0/index.html'), 'utf8'),
      lastExists: fs.existsSync(path.join(root, `dist/ricerca/ricerca-${count - 1}/index.html`)),
      sitemapExists: fs.existsSync(path.join(root, 'dist/sitemap-orphan-landings.xml')),
      aliases: JSON.parse(fs.readFileSync(path.join(root, 'dist/orphan-query-aliases.json'), 'utf8')),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('known orphan-query URLs survive ranking changes', () => {
  it('publishes row 1001 while zero-match pages remain noindex and absent from the sitemap', async () => {
    vi.stubEnv('MAX_ORPHAN_LANDINGS', '0');
    vi.stubEnv('SKIP_ORPHAN_LANDINGS', '0');
    const result = await renderClusters(1001);
    expect(result.lastExists).toBe(true);
    expect(result.first).toMatch(/noindex/);
    expect(result.sitemapExists).toBe(false);
    expect(result.aliases.aliases['/ricerca/posti-qualificati-1000/']).toBe('/ricerca/ricerca-1000/');
  });

  it('still permits an explicit preview limit', async () => {
    vi.stubEnv('MAX_ORPHAN_LANDINGS', '1');
    vi.stubEnv('SKIP_ORPHAN_LANDINGS', '0');
    const result = await renderClusters(2);
    expect(result.lastExists).toBe(false);
    expect(result.aliases.aliases['/ricerca/posti-qualificati-1/']).toBeUndefined();
  });

  it.each(['0', '-1', '1.9', 'invalid'])('rejects oversized input with a default or invalid override (%s)', async (raw) => {
    vi.stubEnv('MAX_ORPHAN_LANDINGS', raw);
    vi.stubEnv('SKIP_ORPHAN_LANDINGS', '0');
    await expect(renderClusters(DEFAULT_MAX_LANDINGS + 1)).rejects.toThrow('refusing to silently drop published pages');
  });
});
