import { describe, expect, it } from 'vitest';
import { readStaticObjectEntries } from '../packages/articles/engine/shared/ts-literals.mjs';

describe('shared static literal reader compatibility', () => {
  it('exposes the complete key/value source span without changing enumerable entries', () => {
    const source = "const META = {\n  'blog.article.demo.title': 'L\\'incontro',\n};\n";
    const entry = readStaticObjectEntries(source, 'blog-meta.ts')[0];

    expect(entry.start).toBe(source.indexOf("'blog.article.demo.title'"));
    expect(entry.end).toBe(source.indexOf("'L\\'incontro'") + "'L\\'incontro'".length);
    expect(source.slice(entry.start, entry.end)).toBe("'blog.article.demo.title': 'L\\'incontro'");
    expect(Object.getOwnPropertyDescriptor(entry, 'end')?.enumerable).toBe(false);
    expect(Object.keys(entry)).toEqual(['key', 'value', 'keyQuote', 'valueQuote']);
  });

  it('allows an emitter fragment to end with its final comma only when explicitly requested', () => {
    const fragment = "'blog.article.demo.imageAlt': 'Alt italiano',";

    expect(() => readStaticObjectEntries(fragment, 'emitted-fragment.ts'))
      .toThrow(/dangling comma/u);
    expect(readStaticObjectEntries(fragment, 'emitted-fragment.ts', { allowTerminalFragment: true }))
      .toMatchObject([{ key: 'blog.article.demo.imageAlt', value: 'Alt italiano' }]);
  });

  it('keeps decoded newlines by default and applies literal newlineAs only on request', () => {
    const source = "const META = { 'blog.article.demo.title': 'prima\\nseconda' };";
    const raw = readStaticObjectEntries(source, 'blog-meta.ts')[0];
    const flattened = readStaticObjectEntries(source, 'blog-meta.ts', { newlineAs: ' ' })[0];
    const escapedCarriageReturn = readStaticObjectEntries(
      "const META = { 'blog.article.demo.title': 'prima\\rseconda' };",
      'blog-meta.ts',
      { newlineAs: ' ' },
    )[0];
    const escapedCarriageReturnLineFeed = readStaticObjectEntries(
      "const META = { 'blog.article.demo.title': 'prima\\r\\nseconda' };",
      'blog-meta.ts',
      { newlineAs: ' ' },
    )[0];
    const rawCarriageReturn = readStaticObjectEntries(
      "const META = { 'blog.article.demo.title': `prima\r\nseconda` };",
      'blog-meta.ts',
      { newlineAs: ' ' },
    )[0];
    const replacementTokens = readStaticObjectEntries(source, 'blog-meta.ts', { newlineAs: '$&$$' })[0];

    expect(raw.value).toBe('prima\nseconda');
    expect(flattened.value).toBe('prima seconda');
    expect(flattened.rawValue).toBe('prima\\nseconda');
    expect(escapedCarriageReturn.value).toBe('prima seconda');
    expect(escapedCarriageReturnLineFeed.value).toBe('prima seconda');
    expect(rawCarriageReturn.value).toBe('prima seconda');
    expect(replacementTokens.value).toBe('prima$&$$seconda');
  });
});
