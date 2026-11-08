import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadArticleRouteRedirects,
  resolveArticleRouteHref,
  scanRedirectSource,
} from '../packages/articles/engine/shared/articleRouteOwnership.mjs';

const ROOT = resolve(__dirname, '..');
const ARTICLE_REDIRECTS = resolve(ROOT, 'data/article-redirects.json');
const LEGACY_REDIRECTS = resolve(ROOT, 'build-plugins/legacyRedirectsPlugin.ts');
const EVENT_ALIAS_CASES = [
  [
    '/eventi/ticino/altri-eventi/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
    '/eventi/grigioni/altri-eventi/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
  ],
  [
    '/en/events/ticino/other-events/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
    '/en/events/graubunden/other-events/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
  ],
  [
    '/de/veranstaltungen/tessin/weitere-veranstaltungen/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
    '/de/veranstaltungen/graubunden/weitere-veranstaltungen/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
  ],
  [
    '/fr/evenements/tessin/autres-evenements/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
    '/fr/evenements/grisons/autres-evenements/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/',
  ],
] as const;

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

  it('shares exact edge-owned event aliases with article link resolution', () => {
    const redirects = loadArticleRouteRedirects(
      { readFileSync },
      ARTICLE_REDIRECTS,
      LEGACY_REDIRECTS,
    );

    for (const [legacy, canonical] of EVENT_ALIAS_CASES) {
      expect(redirects[legacy], legacy).toBe(canonical);
      expect(resolveArticleRouteHref(legacy, { redirects }), legacy).toBe(canonical);
      expect(resolveArticleRouteHref(`${legacy}?utm_source=bing#event`, { redirects }))
        .toBe(`${canonical}?utm_source=bing#event`);
    }
  });

  it('does not reinterpret nearby event routes or non-site links', () => {
    const redirects = loadArticleRouteRedirects(
      { readFileSync },
      ARTICLE_REDIRECTS,
      LEGACY_REDIRECTS,
    );
    const nearby = '/eventi/ticino/altri-eventi/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-15/';

    expect(resolveArticleRouteHref(nearby, { redirects })).toBe(nearby);
    expect(resolveArticleRouteHref('https://example.com/eventi/ticino/', { redirects }))
      .toBe('https://example.com/eventi/ticino/');
    expect(resolveArticleRouteHref('mailto:editor', { redirects }))
      .toBe('mailto:editor');
  });

  it('fails closed on an unterminated block comment instead of returning a partial map', () => {
    expect(() => scanRedirectSource([
      'const redirects = {',
      '  \'/real\': \'/target/\',',
      '  /* missing terminator',
    ].join('\n'))).toThrow(/Unterminated block comment/u);
  });
});
