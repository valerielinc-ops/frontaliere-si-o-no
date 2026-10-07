import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  corpusArticleChangeTimestamp,
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

  it('legge dal clone il commit che ha introdotto o ritirato un id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-id-history-'));
    const runGit = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    const registryPath = path.join(root, 'content/routerBlogData.ts');
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      runGit('init', '--initial-branch=main');
      runGit('config', 'user.email', 'fixture@example.invalid');
      runGit('config', 'user.name', 'fixture');
      fs.writeFileSync(registryPath, "export const BLOG_SLUGS = { 'stable-article': { it: 'stable-article' } };\n");
      runGit('add', 'content/routerBlogData.ts');
      runGit('commit', '-m', 'fixture stable');
      fs.writeFileSync(
        registryPath,
        "export const BLOG_SLUGS = { 'stable-article': { it: 'stable-article' }, 'new-article': { it: 'new-article' } };\n",
      );
      runGit('add', 'content/routerBlogData.ts');
      runGit('commit', '-m', 'fixture introduce');
      const introducedAt = corpusArticleChangeTimestamp(root, 'frontaliere', 'new-article');
      expect(introducedAt).toEqual(expect.any(Number));
      fs.writeFileSync(registryPath, "export const BLOG_SLUGS = { 'stable-article': { it: 'stable-article' } };\n");
      runGit('add', 'content/routerBlogData.ts');
      runGit('commit', '-m', 'fixture retire');
      const retiredAt = corpusArticleChangeTimestamp(root, 'frontaliere', 'new-article');
      expect(retiredAt).toEqual(expect.any(Number));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('la ricerca si ferma al cambio più recente e non guarda prima della finestra', () => {
    // Nel clone di CI, senza blob, ogni commit visitato dal pickaxe è uno
    // scaricamento: la storia intera del registro vale migliaia di richieste.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-id-window-'));
    const registryPath = path.join(root, 'content/routerBlogData.ts');
    const commitAt = (epoch: number, message: string, content: string) => {
      fs.writeFileSync(registryPath, content);
      const env = { ...process.env, GIT_AUTHOR_DATE: `@${epoch} +0000`, GIT_COMMITTER_DATE: `@${epoch} +0000` };
      execFileSync('git', ['-C', root, 'add', 'content/routerBlogData.ts'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-m', message], { stdio: 'ignore', env });
    };
    const now = 1_791_400_000;
    const day = 24 * 60 * 60;
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '--initial-branch=main'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'config', 'user.name', 'fixture'], { stdio: 'ignore' });
      commitAt(now - 10 * day, 'old', "export const BLOG_SLUGS = { 'old-article': { it: 'old-article' } };\n");
      commitAt(
        now - 3600,
        'recent',
        "export const BLOG_SLUGS = { 'old-article': { it: 'old-article' }, 'recent-article': { it: 'recent-article' } };\n",
      );
      const since = now - 2 * day;
      expect(corpusArticleChangeTimestamp(root, 'frontaliere', 'recent-article', { sinceEpochSeconds: since })).toBe(now - 3600);
      // Fuori dalla finestra: più vecchio di tutto ciò che il chiamante tollera.
      expect(corpusArticleChangeTimestamp(root, 'frontaliere', 'old-article', { sinceEpochSeconds: since })).toBe(since - 1);
      // Senza finestra la ricerca resta completa.
      expect(corpusArticleChangeTimestamp(root, 'frontaliere', 'old-article')).toBe(now - 10 * day);
      expect(corpusArticleChangeTimestamp(root, 'frontaliere', 'never-seen')).toBeNull();
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
