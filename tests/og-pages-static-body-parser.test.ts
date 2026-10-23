import { describe, expect, it } from 'vitest';

import { parseStaticBlogBodySource } from '../packages/articles/engine/ogPagesPlugin';
import {
  parseStaticArticleTranslationEntries,
  parseStaticArticleTranslationSource,
} from '../packages/articles/engine/shared/articleStaticSource.mjs';

const ARTICLE_ID = 'unicode-separator-article';
const SOURCE_PATH = `packages/articles/content/blog-body/fr/${ARTICLE_ID}.ts`;

function sourceWith(value: string): string {
  return [
    'const body: Record<string, string> = {',
    `  'blog.article.${ARTICLE_ID}.body1': '${value}',`,
    '};',
    'export default body;',
  ].join('\n');
}

describe('og article static body parser', () => {
  it('keeps Unicode line separators emitted by the corpus as literal content', () => {
    const body = `## En bref${String.fromCharCode(0x2028)}- point vérifié${String.fromCharCode(0x2029)}## Faits clés`;

    expect(parseStaticBlogBodySource(sourceWith(body), SOURCE_PATH)[ARTICLE_ID].body1).toBe(body);
  });

  it('still rejects a raw LF in an ordinary quoted literal', () => {
    expect(() => parseStaticBlogBodySource(sourceWith('line\nbroken'), SOURCE_PATH))
      .toThrow(/Unterminated string literal/);
  });

  it('fails the whole source when an unrelated template has interpolation', () => {
    const dynamicBefore = [
      'const unrelated = `ignored ${{ label: "runtime" }.label}`;',
      'const body: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.body1': 'rendered',`,
      '};',
      'export default body;',
    ].join('\n');
    const dynamicAfter = [
      'const body: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.body1': 'rendered',`,
      '};',
      'export default body;',
      'const unrelated = `ignored ${runtimeValue}`;',
    ].join('\n');

    for (const source of [dynamicBefore, dynamicAfter]) {
      expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
        .toThrow(/translation module must contain exactly a const record/u);
    }
  });

  it('ignores template markers in comments and ordinary quotes, and accepts escaped interpolation', () => {
    const source = [
      '// `comment ${notCode}`',
      '/* `comment ${notCode}` */',
      'const article: Record<string, string> = {',
      '  "single": \'${ordinaryText}\',',
      '  "double": "${ordinaryText}",',
      '  "escaped": `literal \\${notInterpolation}`,',
      `  'blog.article.${ARTICLE_ID}.body1': 'rendered',`,
      '};',
      'export default article;',
    ].join('\n');

    expect(parseStaticBlogBodySource(source, SOURCE_PATH)[ARTICLE_ID].body1).toBe('rendered');
  });

  it('fails closed instead of scanning regex braces inside an unrelated interpolation', () => {
    const source = [
      'const other = `x ${/\\${/ .test(value)} y`;',
      "const article = { 'blog.article.article-id.body1': 'body' };",
    ].join(' ');

    expect(() => parseStaticBlogBodySource(source, 'packages/articles/content/blog-body/fr/article-id.ts'))
        .toThrow(/translation record must have a Record<string, string> type/u);
  });

  it('fails before nested regex templates can expose fake article keys', () => {
    const source = [
      "const other = `prefix ${obj.return / /}/.test(`inner 'blog.article." + ARTICLE_ID + ".body1': 'wrong'`)} suffix`;",
      `const article = { 'blog.article.${ARTICLE_ID}.body1': 'body' };`,
    ].join(' ');

    expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
      .toThrow(/translation record must have a Record<string, string> type/u);
  });

  it('rejects a dynamic article key instead of extracting a partial body', () => {
    const source = [
      'const article = {',
      `  [\`blog.article.${ARTICLE_ID}.\${field}\`]: 'body',`,
      '};',
    ].join('\n');

    expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
      .toThrow(/translation module must contain exactly a const record/u);
  });

  it('still rejects an interpolated template used as article data', () => {
    const source = [
      'const body: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.body1': ` + '`runtime ${runtimeValue}`,',
      '};',
      'export default body;',
    ].join('\n');

    expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
      .toThrow(/must have a static string literal value/u);
  });
});

describe('article source entry projection', () => {
  it('exposes validated primitive offsets while preserving the existing Map result', () => {
    const source = [
      '// astral 🧭 prefix before source offsets',
      'const translations: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.title': 'Titolo',`,
      `  'blog.article.${ARTICLE_ID}.body1': 'Prima riga\\nseconda riga',`,
      '};',
      'export default translations;',
    ].join('\n');
    const entries = parseStaticArticleTranslationEntries(source, SOURCE_PATH);
    const map = parseStaticArticleTranslationSource(source, SOURCE_PATH);

    expect(entries).toEqual([
      {
        articleId: ARTICLE_ID,
        field: 'title',
        value: 'Titolo',
        index: source.indexOf(`'blog.article.${ARTICLE_ID}.title'`),
        valueStart: source.indexOf("'Titolo'") + 1,
        valueEnd: source.indexOf("'Titolo'") + 1 + 'Titolo'.length,
      },
      {
        articleId: ARTICLE_ID,
        field: 'body1',
        value: 'Prima riga\nseconda riga',
        index: source.indexOf(`'blog.article.${ARTICLE_ID}.body1'`),
        valueStart: source.indexOf("'Prima riga") + 1,
        valueEnd: source.indexOf("'Prima riga") + 1 + 'Prima riga\\nseconda riga'.length,
      },
    ]);
    expect([...map].map(([id, fields]) => [id, [...fields]])).toEqual([
      [ARTICLE_ID, [['title', 'Titolo'], ['body1', 'Prima riga\nseconda riga']]],
    ]);
  });

  it('does not return partial entries when a later translation value is dynamic', () => {
    const source = [
      'const translations: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.title': 'Titolo',`,
      "  'blog.article." + ARTICLE_ID + ".body1': `runtime ${value}`,",
      '};',
      'export default translations;',
    ].join('\n');

    expect(() => parseStaticArticleTranslationEntries(source, SOURCE_PATH))
      .toThrow(/must have a static string literal value/u);
  });
});
