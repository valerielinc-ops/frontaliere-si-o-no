import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decideCorpusOverlayMode,
  prepareCorpusContentOverlay,
  validateCorpusContentShape,
} from '../scripts/lib/article-corpus-overlay.mjs';
import { filterEntriesByImagePostcondition } from '../scripts/lib/article-image-postcondition.mjs';

describe('article corpus overlay mode', () => {
  it('usa il corpus main in CI', () => {
    expect(decideCorpusOverlayMode({ isCi: true, dryRun: false, explicit: false })).toEqual({
      mode: 'overlay',
      reason: 'GitHub Actions',
    });
  });

  it('in dry-run locale lascia la copia locale e non scrive il tree', () => {
    expect(decideCorpusOverlayMode({ isCi: false, dryRun: true, explicit: false })).toEqual({
      mode: 'local',
      reason: 'dry-run locale: si usa la copia locale senza modificare il tree',
    });
  });

  it('fuori da CI rifiuta il render reale senza flag esplicito', () => {
    const verdict = decideCorpusOverlayMode({ isCi: false, dryRun: false, explicit: false });
    expect(verdict.mode).toBe('refuse');
    expect(verdict.reason).toMatch(/--allow-content-overlay/);
  });

  it('il flag esplicito abilita il clone anche fuori da CI', () => {
    expect(decideCorpusOverlayMode({ isCi: false, dryRun: false, explicit: true }).mode).toBe('overlay');
  });

  it('la forma minima del corpus richiede entrambe le registries, meta e un body per locale', () => {
    expect(validateCorpusContentShape('/definitely/missing/corpus/content').ok).toBe(false);
    expect(validateCorpusContentShape('/definitely/missing/corpus/content').missing).toContain('blog-body/it/*.ts');
  });

  it('accetta una forma minima completa del corpus', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-shape-'));
    try {
      for (const file of [
        'blog-articles-data.ts',
        'swiss-articles-data.ts',
        'blog-meta-it.ts',
        'blog-meta-en.ts',
        'blog-meta-de.ts',
        'blog-meta-fr.ts',
        'blog-meta-ch-it.ts',
        'blog-meta-ch-en.ts',
        'blog-meta-ch-de.ts',
        'blog-meta-ch-fr.ts',
      ]) fs.writeFileSync(path.join(root, file), '');
      for (const dir of [
        'blog-body/it',
        'blog-body/en',
        'blog-body/de',
        'blog-body/fr',
        'blog-body-ch/it',
        'blog-body-ch/en',
        'blog-body-ch/de',
        'blog-body-ch/fr',
      ]) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
        fs.writeFileSync(path.join(root, dir, 'article.ts'), '');
      }
      expect(validateCorpusContentShape(root)).toEqual({ ok: true, missing: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('riporta il fallimento del clone invece di procedere con una copia locale', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-clone-failure-'));
    try {
      expect(() => prepareCorpusContentOverlay({
        rootDir: root,
        remote: path.join(root, 'missing-remote.git'),
      })).toThrow(/clone corpus fallito/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('toglie indice e bridge quando il registro dichiara un’immagine ma l’HTML usa il fallback generico', () => {
    const result = filterEntriesByImagePostcondition({
      entries: [
        { articleId: 'degraded', paths: { it: 'degraded/index.html' }, flatPaths: { it: 'degraded.html' } },
        { articleId: 'healthy', paths: { it: 'healthy/index.html' }, flatPaths: { it: 'healthy.html' } },
        { articleId: 'resolved', paths: { it: 'resolved/index.html' }, flatPaths: { it: 'resolved.html' } },
      ],
      declaredImages: {
        degraded: '/images/blog/degraded.webp',
        healthy: '/og-image.png',
        resolved: '/images/blog/resolved.webp',
      },
      htmlByPath: {
        'degraded/index.html': '<meta property="og:image" content="/og-image.png">',
        'degraded.html': '<meta property="og:image" content="/og-image.png">',
        'healthy/index.html': '<meta property="og:image" content="/og-image.png">',
        'healthy.html': '<meta property="og:image" content="/og-image.png">',
        'resolved/index.html': '<meta property="og:image" content="/images/blog/resolved.webp">',
        'resolved.html': '<meta property="og:image" content="/images/blog/resolved.webp">',
      },
    });
    expect(result.entries.map((entry) => entry.articleId)).toEqual(['healthy', 'resolved']);
    expect(result.excludedPages).toBe(result.excludedArticles[0].paths.length);
  });
});
