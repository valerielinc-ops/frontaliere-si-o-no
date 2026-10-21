import { describe, expect, it } from 'vitest';

import { parseStaticBlogBodySource } from '../packages/articles/engine/ogPagesPlugin';

const ARTICLE_ID = 'unicode-separator-article';
const SOURCE_PATH = `packages/articles/content/blog-body/fr/${ARTICLE_ID}.ts`;

function sourceWith(value: string): string {
  return [
    'const body: Record<string, string> = {',
    `  'blog.article.${ARTICLE_ID}.body1': '${value}',`,
    '};',
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
    ].join('\n');
    const dynamicAfter = [
      'const body: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.body1': 'rendered',`,
      '};',
      'const unrelated = `ignored ${runtimeValue}`;',
    ].join('\n');

    for (const source of [dynamicBefore, dynamicAfter]) {
      expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
        .toThrow(/Interpolated template literal is not static article data/);
    }
  });

  it('ignores template markers in comments and ordinary quotes, and accepts escaped interpolation', () => {
    const source = [
      '// `comment ${notCode}`',
      '/* `comment ${notCode}` */',
      'const single = \'${ordinaryText}\';',
      'const double = "${ordinaryText}";',
      'const escaped = `literal \\${notInterpolation}`;',
      `const article = { 'blog.article.${ARTICLE_ID}.body1': 'rendered' };`,
    ].join('\n');

    expect(parseStaticBlogBodySource(source, SOURCE_PATH)[ARTICLE_ID].body1).toBe('rendered');
  });

  it('fails closed instead of scanning regex braces inside an unrelated interpolation', () => {
    const source = [
      'const other = `x ${/\\${/ .test(value)} y`;',
      "const article = { 'blog.article.article-id.body1': 'body' };",
    ].join(' ');

    expect(() => parseStaticBlogBodySource(source, 'packages/articles/content/blog-body/fr/article-id.ts'))
      .toThrow(/Interpolated template literal is not static article data/);
  });

  it('fails before nested regex templates can expose fake article keys', () => {
    const source = [
      "const other = `prefix ${obj.return / /}/.test(`inner 'blog.article." + ARTICLE_ID + ".body1': 'wrong'`)} suffix`;",
      `const article = { 'blog.article.${ARTICLE_ID}.body1': 'body' };`,
    ].join(' ');

    expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
      .toThrow(/Interpolated template literal is not static article data/);
  });

  it('rejects a dynamic article key instead of extracting a partial body', () => {
    const source = [
      'const article = {',
      `  [\`blog.article.${ARTICLE_ID}.\${field}\`]: 'body',`,
      '};',
    ].join('\n');

    expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
      .toThrow(/Interpolated template literal is not static article data/);
  });

  it('still rejects an interpolated template used as article data', () => {
    const source = [
      'const body: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.body1': ` + '`runtime ${runtimeValue}`,',
      '};',
    ].join('\n');

    expect(() => parseStaticBlogBodySource(source, SOURCE_PATH))
      .toThrow(/Interpolated template literal is not static article data/);
  });
});
