import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('sitemap-emit consistency — every sitemap URL has a dist file', () => {
  it('canton sitemap URLs all resolve to a dist HTML file', () => {
    if (!fs.existsSync(DIST)) return; // skip in offline test runs
    const sitemapDir = DIST;
    const cantonShards = fs.readdirSync(sitemapDir)
      .filter((f) => f.startsWith('sitemap-jobs-') && f.endsWith('.xml'));
    const missing: string[] = [];
    for (const shard of cantonShards) {
      const xml = fs.readFileSync(path.join(sitemapDir, shard), 'utf-8');
      const locs = [...xml.matchAll(/<loc>https:\/\/frontaliereticino\.ch(\/[^<]+)<\/loc>/g)].map((m) => m[1]);
      for (const loc of locs) {
        const trimmed = loc.replace(/\/$/, '').replace(/^\//, '');
        const filePath = path.join(DIST, trimmed, 'index.html');
        const flatPath = path.join(DIST, trimmed + '.html');
        if (!fs.existsSync(filePath) && !fs.existsSync(flatPath)) {
          missing.push(`${shard}: ${loc}`);
        }
      }
    }
    expect(missing, `Missing HTML for sitemap URLs (sample): ${missing.slice(0, 5).join(', ')}`).toEqual([]);
  });
});
