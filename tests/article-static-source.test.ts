import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  parseStaticArticleTranslationSource,
  parseStaticBlogBodySource,
} from '../packages/articles/engine/shared/articleStaticSource.mjs';
import {
  readArticleExcerpts,
  readArticleMetadata,
  readArticleSlugs,
} from '../packages/articles/engine/shared/articleReaders';

const BODY_PATH = 'packages/articles/content/blog-body/it/alpha.ts';

function moduleWith(properties: string, trailing = ''): string {
  return [
    'const translations: Record<string, string> = {',
    properties,
    '};',
    'export default translations;',
    trailing,
  ].join('\n');
}

describe('static article TypeScript source reader', () => {
  it('reads decoded literal values from the typed default-export record', () => {
    const faq = JSON.stringify(JSON.stringify([{ q: 'Question?', a: 'First\\nsecond' }]));
    const source = moduleWith([
      `  'blog.article.alpha.body1': 'L\\'Italia usa C:\\\\docs e \"virgolette\".',`,
      '  "blog.article.alpha.body2": `Escaped marker \\${literal} and a heading\\nnext line`,',
      `  'blog.article.alpha.faq': ${faq},`,
    ].join('\n'));

    const parsed = parseStaticBlogBodySource(source, BODY_PATH).alpha;
    expect(parsed.body1).toBe('L\'Italia usa C:\\docs e "virgolette".');
    expect(parsed.body2).toBe('Escaped marker ${literal} and a heading\nnext line');
    expect(JSON.parse(parsed.faq)).toEqual([{ q: 'Question?', a: 'First\\nsecond' }]);
  });

  it('parses metadata keys and keeps property order without re-decoding AST values', () => {
    const source = moduleWith([
      `  'blog.article.alpha.title': 'O\\'Brien',`,
      '  "blog.article.alpha.excerpt": "prima\\nseconda",',
      '  "blog.article.beta.imageAlt": `A \\${literal} image`,',
    ].join('\n'));

    const parsed = parseStaticArticleTranslationSource(source, 'blog-meta-it.ts');
    expect([...parsed.keys()]).toEqual(['alpha', 'beta']);
    expect([...parsed.get('alpha')!.entries()]).toEqual([
      ['title', "O'Brien"],
      ['excerpt', 'prima\nseconda'],
    ]);
    expect(parsed.get('beta')?.get('imageAlt')).toBe('A ${literal} image');
  });

  it('accepts a structurally valid empty metadata module but still rejects an empty body module', () => {
    const empty = moduleWith('');

    expect(parseStaticArticleTranslationSource(empty, 'blog-meta-empty.ts')).toEqual(new Map());
    expect(() => parseStaticBlogBodySource(empty, BODY_PATH)).toThrow(/no static body fields/u);
  });

  it('ignores strings/comments while rejecting real interpolation anywhere in the module', () => {
    const staticSource = [
      '// `comment ${notCode}`',
      '/* `comment ${notCode}` */',
      moduleWith([
        '  "note": "blog.article.fake.title: \'fake\'",',
        '  "escaped": `literal \\${notCode}`,',
        "  'blog.article.alpha.body1': 'real body',",
      ].join('\n')),
    ].join('\n');
    expect(parseStaticBlogBodySource(staticSource, BODY_PATH).alpha.body1).toBe('real body');

    const dynamicSource = [
      'const translations: Record<string, string> = {',
      "  'blog.article.alpha.body1': 'real body',",
      '  "unrelated": `prefix ${(() => ({ "blog.article.alpha.body4": "fake" }))()}`,',
      '};',
      'export default translations;',
    ].join('\n');
    expect(() => parseStaticBlogBodySource(dynamicSource, BODY_PATH))
      .toThrow(/Interpolated template literal is not supported/u);
  });

  it('rejects computed keys, duplicate keys, dynamic values, and malformed trailing source', () => {
    const invalidSources = [
      moduleWith([
        "  'blog.article.alpha.body1': 'valid',",
        "  [dynamicKey]: 'body',",
      ].join('\n')),
      moduleWith([
        "  'blog.article.alpha.body1': 'first',",
        "  'blog.article.alpha.body1': 'second',",
      ].join('\n')),
      moduleWith("  'blog.article.alpha.body1': makeBody(),"),
      moduleWith("  'blog.article.alpha.body1': 'valid',", 'const broken = ;'),
    ];

    for (const source of invalidSources) {
      expect(() => parseStaticBlogBodySource(source, BODY_PATH)).toThrow();
    }
  });

  it('requires the complete generated const Record module wrapper and binding', () => {
    const object = "{ 'blog.article.alpha.body1': 'valid' }";
    const invalidModules = [
      `const translations: Record<string, string> = ${object};`,
      `let translations: Record<string, string> = ${object}; export default translations;`,
      `const translations: Record<string, string> = ${object} as const; export default translations;`,
      `const translations: Record<string, string> = (${object} satisfies Record<string, string>); export default translations;`,
      `export default ${object};`,
      `const translations: Record<string, string> = ${object}; export default anotherRecord;`,
      `const translations: Record<string, string> = ${object}; translations['blog.article.alpha.body1'] = 'mutated'; export default translations;`,
      `const translations: Record<string, string> = ${object}; const unrelated = 'ignored'; export default translations;`,
    ];

    for (const source of invalidModules) {
      expect(() => parseStaticBlogBodySource(source, BODY_PATH)).toThrow();
    }
  });

  it('requires quoted literal keys and rejects duplicates outside the article namespace', () => {
    const invalidSources = [
      moduleWith("  'blog.article.alpha.body1': 'valid',\n  other: 'identifier key',"),
      moduleWith([
        "  'blog.article.alpha.body1': 'valid',",
        "  'unrelated': 'first',",
        '  "unrelated": "second",',
      ].join('\n')),
    ];

    for (const source of invalidSources) {
      expect(() => parseStaticBlogBodySource(source, BODY_PATH)).toThrow();
    }
  });

  it('requires the body filename to match the article key and a bodyN field to exist', () => {
    expect(() => parseStaticBlogBodySource(
      moduleWith("  'blog.article.other.body1': 'body',"),
      BODY_PATH,
    )).toThrow(/does not match file/u);
    expect(() => parseStaticBlogBodySource(
      moduleWith("  'blog.article.alpha.faq': '[]',"),
      BODY_PATH,
    )).toThrow(/no static body fields/u);
  });

  it('keeps missing metadata files empty but propagates parse errors from present files', () => {
    const absentFs = {
      existsSync: () => false,
      readFileSync: () => { throw new Error('unexpected read'); },
    } as unknown as typeof fs;
    expect(readArticleSlugs(absentFs, path, '/virtual', 'it', 'blog-meta', 'meta')).toEqual([]);
    expect(readArticleExcerpts(absentFs, path, '/virtual', 'it', 'blog-meta', 'meta').size).toBe(0);

    const invalidSource = [
      'const translations: Record<string, string> = {',
      "  'blog.article.alpha.title': 'Alpha',",
      '};',
      'const unrelated = `not static ${runtimeValue}`;',
      'export default translations;',
    ].join('\n');
    const presentFs = {
      existsSync: () => true,
      readFileSync: () => invalidSource,
    } as unknown as typeof fs;

    expect(() => readArticleSlugs(presentFs, path, '/virtual', 'it', 'blog-meta', 'meta'))
      .toThrow(/Interpolated template literal/u);
    expect(() => readArticleExcerpts(presentFs, path, '/virtual', 'it', 'blog-meta', 'meta'))
      .toThrow(/Interpolated template literal/u);
  });

  it('reads title and excerpt projections from one metadata source pass', () => {
    let reads = 0;
    const source = moduleWith([
      "  'blog.article.alpha.title': 'Alpha',",
      "  'blog.article.alpha.excerpt': 'A short summary.',",
    ].join('\n'));
    const sourceFs = {
      existsSync: () => true,
      readFileSync: () => {
        reads += 1;
        return source;
      },
    } as unknown as typeof fs;

    const metadata = readArticleMetadata(sourceFs, path, '/virtual', 'it', 'blog-meta', 'meta');

    expect(reads).toBe(1);
    expect(metadata.articles).toEqual([{ slug: 'alpha', title: 'Alpha' }]);
    expect([...metadata.excerpts]).toEqual([['alpha', 'A short summary.']]);
  });
});
