import { describe, expect, it } from 'vitest';

import { scanRedirectSource } from '../packages/articles/engine/shared/articleRouteOwnership.mjs';

describe('legacy article redirect source scanner', () => {
  it('ignores route-shaped text inside comments and string literals', () => {
    const source = [
      'const redirects = {',
      '  /* \'/fake-comment\': \'/fake-target\', */',
      '  \'/real-commented\': /* first */ /* second */ \'/real-target\',',
      'const note = "\'/fake-string\': \'/fake-target\'";',
      '};',
    ].join('\n');

    expect(scanRedirectSource(source)).toMatchObject({
      entries: {
        '/real-commented/': '/real-target/',
      },
      literalCount: 1,
      dynamicCount: 0,
      unsupported: [],
    });
  });

  it('skips template literals and keeps consecutive trailing comments out of the next entry', () => {
    const source = [
      'const redirects = {',
      '  \'/real-one\': \'/target-one/\' /* comment one */ /* comment two */,',
      '  \'/template\': `text with \'/fake-template\': \'/fake-target\'`,',
      '  \'/real-two\': \'/target-two/\'',
      '};',
    ].join('\n');

    const result = scanRedirectSource(source);
    expect(result.entries).toEqual({
      '/real-one/': '/target-one/',
      '/real-two/': '/target-two/',
    });
    expect(result.literalCount).toBe(2);
    expect(result.dynamicCount).toBe(1);
    expect(result.unsupported).toEqual([]);
  });

  it('fails closed on an unterminated block comment instead of returning a partial map', () => {
    expect(() => scanRedirectSource([
      'const redirects = {',
      '  \'/real\': \'/target/\',',
      '  /* missing terminator',
    ].join('\n'))).toThrow(/Unterminated block comment/u);
  });
});
