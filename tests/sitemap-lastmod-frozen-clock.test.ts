import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverSitemapFiles } from '../build-plugins/sitemapAliasPlugin';

/**
 * Sul banco con clock congelato il `lastmod` di sitemap.xml non deve dipendere
 * dall'orologio reale del filesystem (mtime): due gambe costruite a cavallo
 * della mezzanotte UTC producevano un sitemap.xml diverso per il solo fuso
 * del run. Senza BENCH_FROZEN_CLOCK_MS vale sempre la data di modifica.
 */
let dir: string | null = null;
afterEach(() => {
  delete process.env.BENCH_FROZEN_CLOCK_MS;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function seed(mtime: Date): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-frozen-'));
  const file = path.join(dir, 'sitemap-pages.xml');
  fs.writeFileSync(file, '<urlset/>');
  fs.utimesSync(file, mtime, mtime);
  return dir;
}

describe('discoverSitemapFiles lastmod', () => {
  it('uses the file mtime when no frozen clock is configured', async () => {
    const d = seed(new Date('2026-04-15T10:00:00Z'));
    expect((await discoverSitemapFiles(d))[0].lastmod).toBe('2026-04-15');
  });

  it('uses the frozen bench clock instead of the real mtime', async () => {
    const d = seed(new Date('2026-04-15T10:00:00Z'));
    process.env.BENCH_FROZEN_CLOCK_MS = String(Date.parse('2026-10-24T22:00:00Z'));
    expect((await discoverSitemapFiles(d))[0].lastmod).toBe('2026-10-24');
  });

  it('ignores a malformed frozen clock value', async () => {
    const d = seed(new Date('2026-04-15T10:00:00Z'));
    process.env.BENCH_FROZEN_CLOCK_MS = 'not-a-number';
    expect((await discoverSitemapFiles(d))[0].lastmod).toBe('2026-04-15');
  });
});
