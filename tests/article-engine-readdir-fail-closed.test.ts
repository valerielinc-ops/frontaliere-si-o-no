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
  enumerateRenderableSectionArticleIds,
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

  it('keeps body-only chunks out of the renderable audit population', () => {
    const rootDir = temporaryRoot('article-section-renderable-');
    const section = {
      ...ARTICLE_SECTION_DESCRIPTORS[0],
      seoFiles: ['seo-source.ts'],
      bodyDir: 'test-body',
    };
    const seoFile = path.join(rootDir, section.seoFiles[0]);
    const bodyDir = path.join(rootDir, 'services', 'locales', section.bodyDir, 'it');

    fs.mkdirSync(path.dirname(seoFile), { recursive: true });
    fs.writeFileSync(seoFile, "export const pages = {\n  'blog-live-article': {\n    title: 'Live',\n  },\n};\n");
    fs.mkdirSync(bodyDir, { recursive: true });
    fs.writeFileSync(path.join(bodyDir, 'live-article.ts'), 'export {};\n');
    fs.writeFileSync(path.join(bodyDir, 'body-only-article.ts'), 'export {};\n');

    expect(enumerateRenderableSectionArticleIds(section, rootDir)).toEqual(['live-article']);
    expect(enumerateSectionArticleIds(section, rootDir)).toEqual(['live-article', 'body-only-article']);
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

describe('static article body source literals', () => {
  const guideHeadings = [
    {
      id: 'frontaliere-educatore-ticino-stipendio-requisiti',
      headings: {
        it: '## Lavorare come educatore in Ticino: stipendio LIS 2026 e requisiti',
        en: '## Working as an educator in Ticino: LIS 2026 pay and requirements',
        de: '## Als Erzieher im Tessin arbeiten: LIS-Lohn 2026 und Voraussetzungen',
        fr: '## Travailler comme éducateur au Tessin : salaire LIS 2026 et exigences',
      },
    },
    {
      id: 'educatore-infanzia-ticino-stipendio-requisiti',
      headings: {
        it: '## Educatore dell’infanzia in Ticino: stipendio e requisiti',
        en: '## Early-childhood educator in Ticino: pay and requirements',
        de: '## Erzieher im Tessin: Lohn und Voraussetzungen',
        fr: '## Éducateur de la petite enfance au Tessin : salaire et exigences',
      },
    },
    {
      id: 'educatore-infanzia-ticino-stipendi-2026',
      headings: {
        it: '## Educatore dell’infanzia in Ticino: stipendi LIS 2026',
        en: '## Early-childhood educator pay in Ticino: LIS 2026 scale',
        de: '## Erzieher im Tessin: LIS-Lohnklassen 2026',
        fr: '## Éducateur au Tessin : salaires du LIS en 2026',
      },
    },
    {
      id: 'educatore-infanzia-ticino-stipendi',
      headings: {
        it: '## Stipendio educatore dell’infanzia in Ticino: come leggerlo',
        en: '## Educator salary in Ticino: how to read the figures',
        de: '## Lohn für Erzieher im Tessin: Zahlen richtig einordnen',
        fr: '## Salaire d’éducateur au Tessin : comprendre les chiffres',
      },
    },
    {
      id: 'educatore-infanzia-ticino-stipendi-requisiti',
      headings: {
        it: '## Educatore dell’infanzia in Ticino: titoli e requisiti',
        en: '## Early-childhood educator in Ticino: qualifications and requirements',
        de: '## Erzieher im Tessin: Ausbildung und Voraussetzungen',
        fr: '## Éducateur au Tessin : diplômes et exigences',
      },
    },
    {
      id: 'educatore-infanzia-ticino-stipendio',
      headings: {
        it: '## Stipendio e candidatura per educatori dell’infanzia in Ticino',
        en: '## Educator pay and applications in Ticino',
        de: '## Lohn und Bewerbung für Erzieher im Tessin',
        fr: '## Salaire et candidature d’éducateur au Tessin',
      },
    },
  ] as const;

  const locales = ['it', 'en', 'de', 'fr'] as const;

  function quoteStaticTsString(value: string, quote: "'" | '"' | '`'): string {
    let escaped = value.replace(/\\/g, '\\\\');
    if (quote !== '`') escaped = escaped.replace(/\r\n|[\r\n]/g, '\\n');
    if (quote === "'") escaped = escaped.replace(/'/g, "\\'");
    if (quote === '"') escaped = escaped.replace(/"/g, '\\"');
    if (quote === '`') {
      escaped = escaped.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    }
    return `${quote}${escaped}${quote}`;
  }

  function writeArticleSeoFixture(rootDir: string, ids: readonly string[]): void {
    const seoFile = path.join(rootDir, 'services', 'seo', 'seo-blog-ch.ts');
    fs.mkdirSync(path.dirname(seoFile), { recursive: true });
    const entries = ids.map((id) => `
      'blog-${id}': {
        title: 'Static literal fixture ${id}',
        description: 'Static article body source regression fixture for ${id}.',
        ogTitle: 'Static literal fixture ${id}',
        ogDescription: 'Static article body source regression fixture for ${id}.',
        canonicalPath: '/articoli-svizzera/${id}/',
      },`).join('\n');
    fs.writeFileSync(seoFile, `export const pages = {${entries}\n};\n`);

    const slugFile = path.join(rootDir, 'services', 'routerSwissData.ts');
    const slugEntries = ids.map((id) => `
      '${id}': { it: '${id}-it', en: '${id}-en', de: '${id}-de', fr: '${id}-fr' },`).join('\n');
    fs.writeFileSync(slugFile, `export const SWISS_SLUGS = {${slugEntries}\n};\n`);
  }

  it('renders the 24 extracted locale headings and static body, template, and FAQ literals', async () => {
    const rootDir = temporaryRoot('article-body-quoted-source-');
    const distDir = temporaryRoot('article-body-quoted-dist-');
    const fixtureId = 'static-literal-forms';
    const ids = [...guideHeadings.map(({ id }) => id), fixtureId];
    writeArticleSeoFixture(rootDir, ids);

    for (const { id, headings } of guideHeadings) {
      for (const locale of locales) {
        const localeDir = path.join(rootDir, 'services', 'locales', 'blog-body-ch', locale);
        fs.mkdirSync(localeDir, { recursive: true });
        const key = `blog.article.${id}.body1`;
        const body = `${headings[locale]}\n\nA static, localized body paragraph from the extracted source fixture.`;
        // The current publisher emits these exact double-quoted key/value
        // literals. These 24 headings were extracted from the corresponding
        // six article records in all four locales; the complete bodies remain
        // in the corpus repository and are not imported by this site test.
        fs.writeFileSync(path.join(localeDir, `${id}.ts`), `export default ${JSON.stringify({ [key]: body })};\n`);
      }
    }

    const fixtureDir = path.join(rootDir, 'services', 'locales', 'blog-body-ch', 'it');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const faq = JSON.stringify([
      { q: 'What does the static FAQ parser preserve?', a: 'It preserves escaped quotes, JSON structure, and enough answer text for the rendered schema.' },
      { q: 'Can a static FAQ be written with a different source delimiter?', a: 'Yes, the parser reads static single, double, and template literals without evaluating code.' },
    ]);
    const literalBodySource = [
      'export default {',
      `  ${quoteStaticTsString(`blog.article.${fixtureId}.body1`, "'")}: ${quoteStaticTsString('## Body one: double quoted value\n\nA line with "escaped quotes" and café.', '"')},`,
      `  ${quoteStaticTsString(`blog.article.${fixtureId}.body2`, '"')}: ${quoteStaticTsString("## Body two: single quoted value\n\nAn apostrophe: it's preserved, with a path \\\\server and a [source link](https://example.test/source).", "'")},`,
      `  ${quoteStaticTsString(`blog.article.${fixtureId}.body3`, '`')}: ${quoteStaticTsString('## Body three: template value\n\nInline `code` and literal ${articleId} remain text.\n\nA slash before two source newlines: \\\n\nThis paragraph must stay separate.', '`')},`,
      `  ${quoteStaticTsString(`blog.article.${fixtureId}.faq`, '`')}: ${quoteStaticTsString(faq, '"')},`,
      '};',
    ].join('\n');
    fs.writeFileSync(path.join(fixtureDir, `${fixtureId}.ts`), literalBodySource);

    const rendered = await renderArticlePages({
      rootDir,
      distDir,
      section: 'svizzera',
      onlyArticleIds: ids,
    });

    for (const { id, headings } of guideHeadings) {
      const entry = rendered.entries.find((candidate) => candidate.articleId === id);
      expect(entry, `expected static page for ${id}`).toBeDefined();
      for (const locale of locales) {
        const html = fs.readFileSync(path.join(distDir, entry!.paths[locale]), 'utf8');
        expect(html, `${id}/${locale} should contain its extracted body heading`).toContain(headings[locale].slice(3, 32));
      }
    }

    const literalEntry = rendered.entries.find((candidate) => candidate.articleId === fixtureId);
    expect(literalEntry).toBeDefined();
    const literalHtml = fs.readFileSync(path.join(distDir, literalEntry!.paths.it), 'utf8');
    expect(literalHtml).toContain('Body one: double quoted value');
    expect(literalHtml).toContain('Body two: single quoted value');
    expect(literalHtml).toContain('Body three: template value');
    expect(literalHtml).toContain('literal ${articleId} remain text');
    expect(literalHtml).toMatch(/A slash before two source newlines:[\s\S]*<\/p>\s*<p>This paragraph must stay separate\./);
    expect(literalHtml).toContain('What does the static FAQ parser preserve?');
    expect(literalHtml).toContain('href="https://example.test/source"');
    expect(literalHtml).toMatch(/"@type"\s*:\s*"FAQPage"/);
  });

  it('fails the render when an existing body property is dynamic instead of silently using fallback prose', async () => {
    const rootDir = temporaryRoot('article-body-dynamic-source-');
    const distDir = temporaryRoot('article-body-dynamic-dist-');
    const articleId = 'dynamic-body-fixture';
    writeArticleSeoFixture(rootDir, [articleId]);
    const localeDir = path.join(rootDir, 'services', 'locales', 'blog-body-ch', 'it');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(
      path.join(localeDir, `${articleId}.ts`),
      `export default { "blog.article.${articleId}.body1": getArticleBody() };\n`,
    );

    await expect(renderArticlePages({
      rootDir,
      distDir,
      section: 'svizzera',
      onlyArticleId: articleId,
    })).rejects.toThrow(/not a static string/);
  });

  it.each([
    ['concatenation', '"intro" + getTail()'],
    ['postfix call', '"intro".replace("intro", "rewritten")'],
  ] as const)('rejects a body literal followed by %s instead of truncating it', async (_kind, valueExpression) => {
    const rootDir = temporaryRoot('article-body-expression-source-');
    const distDir = temporaryRoot('article-body-expression-dist-');
    const articleId = 'expression-body-fixture';
    writeArticleSeoFixture(rootDir, [articleId]);
    const localeDir = path.join(rootDir, 'services', 'locales', 'blog-body-ch', 'it');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(
      path.join(localeDir, `${articleId}.ts`),
      `export default { "blog.article.${articleId}.body1": ${valueExpression} };\n`,
    );

    await expect(renderArticlePages({
      rootDir,
      distDir,
      section: 'svizzera',
      onlyArticleId: articleId,
    })).rejects.toThrow(/must have a static string literal value/);
  });
});
