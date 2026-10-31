import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverSitemapFiles } from '../build-plugins/sitemapAliasPlugin';

/**
 * Il `lastmod` dell'indice viene dal contenuto del file, non dall'orologio: la
 * mtime di ogni sotto-sitemap e' la data di build, quindi tutte le 159 voci
 * dell'indice dicevano lo stesso giorno. Effetto collaterale voluto: due gambe
 * del banco a cavallo della mezzanotte UTC danno lo stesso sitemap.xml senza
 * bisogno di un orologio congelato.
 */
let dir: string | null = null;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function seed(xml: string): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-content-'));
  fs.writeFileSync(path.join(dir, 'sitemap-pages.xml'), xml);
  return dir;
}

describe('discoverSitemapFiles lastmod', () => {
  it('takes the newest entry of the file, ignoring the build mtime', async () => {
    const d = seed('<urlset><url><lastmod>2026-04-15</lastmod></url><url><lastmod>2026-05-02T10:00:00Z</lastmod></url><url><lastmod>2026-01-01</lastmod></url></urlset>');
    fs.utimesSync(path.join(d, 'sitemap-pages.xml'), new Date('2026-10-30T00:00:00Z'), new Date('2026-10-30T00:00:00Z'));
    expect((await discoverSitemapFiles(d))[0].lastmod).toBe('2026-05-02');
  });

  it('leaves a file that dates nothing undated instead of using the build day', async () => {
    const d = seed('<urlset><url><loc>https://example.test/</loc></url></urlset>');
    expect((await discoverSitemapFiles(d))[0].lastmod).toBeUndefined();
  });
});
