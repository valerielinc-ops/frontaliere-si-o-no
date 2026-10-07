import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderArticlePages } from '../build-plugins/ogPagesPlugin';
import { buildFlatBridgeFromSibling } from '../build-plugins/flatHtmlRedirectPlugin';

const rootDir = process.cwd();
const locales = ['it', 'en', 'de', 'fr'] as const;

describe('article corpus content revision stamp', () => {
  it('writes the same supplied revision to all four locale pages and their bridge', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-content-revision-'));
    const revision = '1760000000.abcdef123456';

    try {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'svizzera',
        onlyArticleId: 'costo-vita-svizzera-2026',
        contentRevision: revision,
      });

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      const stamp = `<meta name="ft:content-rev" content="${revision}">`;

      for (const locale of locales) {
        const html = fs.readFileSync(path.join(distDir, entry.paths[locale]), 'utf8');
        expect(html.match(/<meta name="ft:content-rev" content="([^"]+)">/)?.[1]).toBe(revision);

        const bridge = buildFlatBridgeFromSibling(html, entry.urls[locale]);
        expect(bridge).toContain(stamp);
      }
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('omits the stamp when the publisher does not provide a revision', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-no-content-revision-'));

    try {
      const result = await renderArticlePages({
        rootDir,
        distDir,
        section: 'svizzera',
        onlyArticleId: 'costo-vita-svizzera-2026',
      });

      expect(result.entries).toHaveLength(1);
      for (const locale of locales) {
        const html = fs.readFileSync(path.join(distDir, result.entries[0].paths[locale]), 'utf8');
        expect(html).not.toContain('name="ft:content-rev"');
      }
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 120_000);
});
