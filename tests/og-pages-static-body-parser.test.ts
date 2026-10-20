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

  it('skips an interpolated template that is outside article data', () => {
    const source = [
      'const unrelated = `ignored ${{ label: "runtime" }.label}`;',
      'const body: Record<string, string> = {',
      `  'blog.article.${ARTICLE_ID}.body1': 'rendered',`,
      '};',
    ].join('\n');

    expect(parseStaticBlogBodySource(source, SOURCE_PATH)[ARTICLE_ID].body1).toBe('rendered');
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
