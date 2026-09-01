import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const actualDefault = (actual as unknown as { default?: typeof actual }).default ?? actual;
  fsMock.readdirSync.mockImplementation(actual.readdirSync);
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  fsMock.statSync.mockImplementation(actual.statSync);
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync);
  return {
    ...actual,
    default: {
      ...actualDefault,
      readdirSync: fsMock.readdirSync,
      readFileSync: fsMock.readFileSync,
      statSync: fsMock.statSync,
      writeFileSync: fsMock.writeFileSync,
    },
    readdirSync: fsMock.readdirSync,
    readFileSync: fsMock.readFileSync,
    statSync: fsMock.statSync,
    writeFileSync: fsMock.writeFileSync,
  };
});

import fs from 'node:fs';
import {
  ARTICLE_SECTION_DESCRIPTORS,
  enumerateSectionArticleIds,
} from '../build-plugins/shared/articleSectionDescriptors';
import {
  blogContextualLinksPlugin,
  listBlogArticleHtmlFiles,
  readBlogIndexSlugs,
} from '../build-plugins/blogContextualLinksPlugin';
import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const temporaryRoots: string[] = [];
const realFs = vi.importActual<typeof import('node:fs')>('node:fs');

function filesystemError(code: string, operation = 'filesystem'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected ${operation} failure`), { code });
}

function temporaryRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(dir);
  return dir;
}

function writeRendererSeoFixture(rootDir: string, articleId = 'injected-read'): void {
  const seoFile = path.join(rootDir, 'services', 'seo', 'seo-blog-ch.ts');
  fs.mkdirSync(path.dirname(seoFile), { recursive: true });
  fs.writeFileSync(seoFile, `
    export const pages = {
      'blog-${articleId}': {
        title: 'Injected filesystem observer',
        description: 'Observer fixture',
        ogTitle: 'Injected filesystem observer',
        ogDescription: 'Observer fixture',
        canonicalPath: '/articoli-svizzera/${articleId}/',
      },
    };
  `);
}

async function runContextualLinksPlugin(rootDir: string): Promise<void> {
  const hook = blogContextualLinksPlugin(rootDir).closeBundle;
  if (typeof hook === 'function') {
    await hook.call({} as never);
    return;
  }
  await hook?.handler.call({} as never);
}

beforeEach(async () => {
  const actual = await realFs;
  for (const [mock, implementation] of [
    [fsMock.readdirSync, actual.readdirSync],
    [fsMock.readFileSync, actual.readFileSync],
    [fsMock.statSync, actual.statSync],
    [fsMock.writeFileSync, actual.writeFileSync],
  ] as const) {
    mock.mockReset();
    mock.mockImplementation(implementation);
  }
});

afterEach(() => {
  for (const dir of temporaryRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('article engine filesystem operations fail closed', () => {
  it('enumerates nominal files and treats ENOENT as an absent locale directory', async () => {
    const rootDir = temporaryRoot('article-section-readdir-');
    const section = {
      ...ARTICLE_SECTION_DESCRIPTORS[0],
      seoFiles: [],
      bodyDir: 'test-body',
    };
    const itDir = path.join(rootDir, 'services', 'locales', section.bodyDir, 'it');
    fs.mkdirSync(itDir, { recursive: true });
    fs.writeFileSync(path.join(itDir, 'nominal-article.ts'), 'export {};\n');

    const { readdirSync } = await realFs;
    fsMock.readdirSync.mockImplementation((dir, options) => {
      if (String(dir).endsWith(path.join(section.bodyDir, 'en'))) {
        throw filesystemError('ENOENT');
      }
      return readdirSync(dir, options as never) as never;
    });

    expect(enumerateSectionArticleIds(section, rootDir)).toEqual(['nominal-article']);
  });

  it.each(['EACCES', 'EIO', 'EMFILE'])('propagates %s from article-id enumeration', (code) => {
    const rootDir = temporaryRoot('article-section-readdir-error-');
    const section = {
      ...ARTICLE_SECTION_DESCRIPTORS[0],
      seoFiles: [],
      bodyDir: 'test-body',
    };
    fsMock.readdirSync.mockImplementation(() => { throw filesystemError(code); });

    expect(() => enumerateSectionArticleIds(section, rootDir)).toThrow(code);
  });

  it.each(['EACCES', 'EIO'])('propagates %s while reading an article-id SEO source', async (code) => {
    const rootDir = temporaryRoot('article-section-seo-read-error-');
    const seoFile = path.join(rootDir, 'seo-source.ts');
    const section = {
      ...ARTICLE_SECTION_DESCRIPTORS[0],
      seoFiles: ['seo-source.ts'],
      bodyDir: 'test-body',
    };
    const { readFileSync } = await realFs;
    fsMock.readFileSync.mockImplementation((file, options) => {
      if (String(file) === seoFile) throw filesystemError(code, 'read');
      return readFileSync(file, options as never) as never;
    });

    expect(() => enumerateSectionArticleIds(section, rootDir)).toThrow(code);
  });

  it('keeps contextual-link enumeration nominal and tolerates an ENOENT race', async () => {
    const distDir = temporaryRoot('article-contextual-readdir-');
    const slugs = { it: 'blog', en: 'blog', de: 'blog', fr: 'blog' };
    const itRoot = path.join(distDir, 'blog');
    const enRoot = path.join(distDir, 'en', 'blog');
    fs.mkdirSync(path.join(itRoot, 'nominal-article'), { recursive: true });
    fs.writeFileSync(path.join(itRoot, 'nominal-article', 'index.html'), '<main>ok</main>');
    fs.mkdirSync(enRoot, { recursive: true });

    const { readdirSync } = await realFs;
    fsMock.readdirSync.mockImplementation((dir, options) => {
      if (String(dir) === enRoot) throw filesystemError('ENOENT');
      return readdirSync(dir, options as never) as never;
    });

    expect(listBlogArticleHtmlFiles(distDir, slugs)).toContainEqual({
      locale: 'it',
      absPath: path.join(itRoot, 'nominal-article', 'index.html'),
      articleSlug: 'nominal-article',
    });
  });

  it.each(['EACCES', 'EIO'])('propagates %s while enumerating contextual-link HTML', (code) => {
    const distDir = temporaryRoot('article-contextual-readdir-error-');
    const slugs = { it: 'blog', en: 'blog', de: 'blog', fr: 'blog' };
    fs.mkdirSync(path.join(distDir, 'blog'), { recursive: true });
    fsMock.readdirSync.mockImplementation(() => { throw filesystemError(code); });

    expect(() => listBlogArticleHtmlFiles(distDir, slugs)).toThrow(code);
  });

  it('propagates EIO while reading a contextual-link HTML candidate', async () => {
    const rootDir = temporaryRoot('article-contextual-read-error-');
    const distDir = path.join(rootDir, 'dist');
    const indexHtml = path.join(distDir, readBlogIndexSlugs(rootDir).it, 'read-error', 'index.html');
    fs.mkdirSync(path.dirname(indexHtml), { recursive: true });
    fs.writeFileSync(indexHtml, '<main>candidate</main>');

    const { readFileSync } = await realFs;
    fsMock.readFileSync.mockImplementation((file, options) => {
      if (String(file) === indexHtml) throw filesystemError('EIO', 'read');
      return readFileSync(file, options as never) as never;
    });

    await expect(runContextualLinksPlugin(rootDir)).rejects.toThrow('EIO');
  });

  it('propagates EACCES instead of publishing a partially rewritten contextual-link set', async () => {
    const rootDir = temporaryRoot('article-contextual-write-error-');
    const distDir = path.join(rootDir, 'dist');
    const indexHtml = path.join(distDir, readBlogIndexSlugs(rootDir).it, 'write-error', 'index.html');
    fs.mkdirSync(path.dirname(indexHtml), { recursive: true });
    fs.writeFileSync(indexHtml, `<article><p>${'filler '.repeat(550)}</p><p>I prezzi del diesel sono aumentati.</p></article>`);

    const { writeFileSync } = await realFs;
    fsMock.writeFileSync.mockImplementation((file, data, options) => {
      if (String(file) === indexHtml) throw filesystemError('EACCES', 'write');
      return writeFileSync(file, data, options as never);
    });

    await expect(runContextualLinksPlugin(rootDir)).rejects.toThrow('EACCES');
  });

  it('propagates EIO from the body-directory read used by the article renderer', async () => {
    const rootDir = temporaryRoot('article-render-source-');
    const distDir = temporaryRoot('article-render-readdir-error-');
    writeRendererSeoFixture(rootDir, 'injected-readdir');
    const bodyDir = path.join(rootDir, 'services', 'locales', 'blog-body-ch', 'it');
    const { readdirSync } = await realFs;
    fsMock.readdirSync.mockImplementation((dir, options) => {
      if (String(dir) === bodyDir) throw filesystemError('EIO');
      return readdirSync(dir, options as never) as never;
    });

    await expect(renderArticlePages({ rootDir, distDir, section: 'svizzera' }))
      .rejects.toThrow('EIO');
  });

  it.each([
    ['EACCES', 'services/locales/blog-meta-ch-en.ts'],
    ['EIO', 'services/locales/blog-body-ch/it/injected-read.ts'],
  ])('propagates %s while reading renderer input %s', async (code, relativeTarget) => {
    const rootDir = temporaryRoot('article-render-read-error-');
    const distDir = temporaryRoot('article-render-read-dist-');
    writeRendererSeoFixture(rootDir);
    const bodyFile = path.join(rootDir, 'services', 'locales', 'blog-body-ch', 'it', 'injected-read.ts');
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    fs.writeFileSync(bodyFile, "export default {'blog.article.injected-read.body1': 'fixture'};\n");
    const target = path.join(rootDir, relativeTarget);

    const { readFileSync } = await realFs;
    fsMock.readFileSync.mockImplementation((file, options) => {
      if (String(file) === target) throw filesystemError(code, 'read');
      return readFileSync(file, options as never) as never;
    });

    await expect(renderArticlePages({ rootDir, distDir, section: 'svizzera' }))
      .rejects.toThrow(code);
  });

  it('propagates EACCES from the single-article stat fast path', async () => {
    const rootDir = temporaryRoot('article-render-stat-error-');
    const distDir = temporaryRoot('article-render-stat-dist-');
    writeRendererSeoFixture(rootDir);
    const target = path.join(rootDir, 'services', 'locales', 'blog-body-ch', 'it', 'injected-read.ts');

    const { statSync } = await realFs;
    fsMock.statSync.mockImplementation((file, options) => {
      if (String(file) === target) throw filesystemError('EACCES', 'stat');
      return statSync(file, options as never) as never;
    });

    await expect(renderArticlePages({
      rootDir,
      distDir,
      section: 'svizzera',
      onlyArticleId: 'injected-read',
    })).rejects.toThrow('EACCES');
  });
});
