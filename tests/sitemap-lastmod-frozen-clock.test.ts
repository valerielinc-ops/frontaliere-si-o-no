import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverSitemapFiles } from '../build-plugins/sitemapAliasPlugin';

/**
 * Il `lastmod` di sitemap.xml viene dal contenuto del figlio, non dall'orologio:
 * ne' il filesystem (mtime) ne' il clock congelato del banco devono cambiarlo.
 * Con il `mtime` due gambe costruite a cavallo della mezzanotte UTC producevano
 * un sitemap.xml diverso per il solo fuso del run.
 */
let dir: string | null = null;
afterEach(() => {
  delete process.env.BENCH_FROZEN_CLOCK_MS;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function seed(mtime: Date, xml: string): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-frozen-'));
  const file = path.join(dir, 'sitemap-pages.xml');
  fs.writeFileSync(file, xml);
  fs.utimesSync(file, mtime, mtime);
  return dir;
}

describe('discoverSitemapFiles lastmod', () => {
  it('ignores the file mtime', async () => {
    const d = seed(new Date('2026-04-15T10:00:00Z'), '<urlset><lastmod>2026-02-17</lastmod></urlset>');
    expect((await discoverSitemapFiles(d))[0].lastmod).toBe('2026-02-17');
  });

  it('ignores the frozen bench clock', async () => {
    const d = seed(new Date('2026-04-15T10:00:00Z'), '<urlset><lastmod>2026-02-17</lastmod></urlset>');
    process.env.BENCH_FROZEN_CLOCK_MS = String(Date.parse('2026-10-24T22:00:00Z'));
    expect((await discoverSitemapFiles(d))[0].lastmod).toBe('2026-02-17');
  });

  it('claims no date for a sitemap without dates', async () => {
    const d = seed(new Date('2026-04-15T10:00:00Z'), '<urlset/>');
    expect((await discoverSitemapFiles(d))[0].lastmod).toBeUndefined();
  });
});
