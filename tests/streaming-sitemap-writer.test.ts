import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStreamingSitemapWriter } from '../scripts/lib/streaming-sitemap-writer.mjs';

describe('streaming sitemap writer', () => {
  it('rolls over at the URL cap and keeps each file independently valid', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-sitemap-writer-'));
    try {
      const writer = createStreamingSitemapWriter({
        distDir: dist,
        filePrefix: 'sitemap-jobs-expired',
        cap: 2,
        chunkEntries: 1,
        header: '<urlset>\n',
      });
      for (let index = 0; index < 5; index += 1) {
        writer.push(`<url><loc>${index}</loc></url>`);
      }

      expect(writer.finish()).toEqual({
        files: [
          'sitemap-jobs-expired-001.xml',
          'sitemap-jobs-expired-002.xml',
          'sitemap-jobs-expired-003.xml',
        ],
        entries: 5,
      });
      expect(writer.finish()).toEqual({
        files: [
          'sitemap-jobs-expired-001.xml',
          'sitemap-jobs-expired-002.xml',
          'sitemap-jobs-expired-003.xml',
        ],
        entries: 5,
      });

      const files = fs.readdirSync(dist).sort();
      expect(files).toEqual([
        'sitemap-jobs-expired-001.xml',
        'sitemap-jobs-expired-002.xml',
        'sitemap-jobs-expired-003.xml',
      ]);
      for (const file of files) {
        const xml = fs.readFileSync(path.join(dist, file), 'utf8');
        expect(xml.startsWith('<urlset>\n')).toBe(true);
        expect(xml.endsWith('</urlset>\n')).toBe(true);
        expect((xml.match(/<url>/g) ?? []).length).toBeLessThanOrEqual(2);
      }
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});
