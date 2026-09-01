import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.readdirSync.mockImplementation(actual.readdirSync);
  return {
    ...actual,
    default: { ...actual.default, readdirSync: fsMock.readdirSync },
    readdirSync: fsMock.readdirSync,
  };
});

import fs from 'node:fs';
import {
  ARTICLE_SECTION_DESCRIPTORS,
  enumerateSectionArticleIds,
} from '../build-plugins/shared/articleSectionDescriptors';
import {
  listBlogArticleHtmlFiles,
} from '../build-plugins/blogContextualLinksPlugin';
import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const temporaryRoots: string[] = [];
const realReaddirSync = vi.importActual<typeof import('node:fs')>('node:fs')
  .then((actual) => actual.readdirSync);

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected readdir failure`), { code });
}

function temporaryRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(dir);
  return dir;
}

beforeEach(async () => {
  const readdirSync = await realReaddirSync;
  fsMock.readdirSync.mockReset();
  fsMock.readdirSync.mockImplementation(readdirSync);
});

afterEach(() => {
  for (const dir of temporaryRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('article engine directory reads fail closed', () => {
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

    const readdirSync = await realReaddirSync;
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

  it('keeps contextual-link enumeration nominal and tolerates an ENOENT race', async () => {
    const distDir = temporaryRoot('article-contextual-readdir-');
    const slugs = { it: 'blog', en: 'blog', de: 'blog', fr: 'blog' };
    const itRoot = path.join(distDir, 'blog');
    const enRoot = path.join(distDir, 'en', 'blog');
    fs.mkdirSync(path.join(itRoot, 'nominal-article'), { recursive: true });
    fs.writeFileSync(path.join(itRoot, 'nominal-article', 'index.html'), '<main>ok</main>');
    fs.mkdirSync(enRoot, { recursive: true });

    const readdirSync = await realReaddirSync;
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

  it('propagates EIO from the body-directory read used by the article renderer', async () => {
    const rootDir = temporaryRoot('article-render-source-');
    const distDir = temporaryRoot('article-render-readdir-error-');
    const seoFile = path.join(rootDir, 'services', 'seo', 'seo-blog-ch.ts');
    fs.mkdirSync(path.dirname(seoFile), { recursive: true });
    fs.writeFileSync(seoFile, `
      export const pages = {
        'blog-injected-readdir': {
          title: 'Injected readdir observer',
          description: 'Observer fixture',
          ogTitle: 'Injected readdir observer',
          ogDescription: 'Observer fixture',
          canonicalPath: '/articoli-svizzera/injected-readdir/',
        },
      };
    `);
    const bodyDir = path.join(rootDir, 'services', 'locales', 'blog-body-ch', 'it');
    const readdirSync = await realReaddirSync;
    fsMock.readdirSync.mockImplementation((dir, options) => {
      if (String(dir) === bodyDir) throw filesystemError('EIO');
      return readdirSync(dir, options as never) as never;
    });

    await expect(renderArticlePages({ rootDir, distDir, section: 'svizzera' }))
      .rejects.toThrow('EIO');
  });
});
