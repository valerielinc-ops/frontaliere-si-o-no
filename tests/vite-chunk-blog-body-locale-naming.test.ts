import { describe, it, expect } from 'vitest';
import { matchBlogBodyChunkLocale, buildBlogBodyChunkFileName } from '../build-plugins/shared/blogBodyChunkNaming';

/**
 * Pins vite.config.ts's blog-body chunk locale keying for BOTH module-id
 * shapes Rollup can hand back — the legacy `services/locales/...` path and
 * the real, symlink-resolved `packages/articles/content/...` path (issue
 * #4881 Fase 6 review fix).
 *
 * Regression this guards: `services/locales/blog-body{,-ch}` are now OS
 * symlinks into `packages/articles/content/blog-body{,-ch}`. Vite's default
 * `resolve.preserveSymlinks: false` means Rollup's `facadeModuleId` is the
 * REAL path, not the symlink path — a matcher that only recognizes the
 * legacy shape silently stops keying chunks by locale (build still
 * succeeds; names just collide by iteration order instead). No build is
 * required to catch that: the matching/naming logic is a pure function
 * fed synthetic facadeModuleId strings here.
 */
describe('blog-body chunk locale naming (issue #4881 Fase 6 review fix)', () => {
  it('matches the legacy services/locales path shape (frontaliere)', () => {
    const match = matchBlogBodyChunkLocale('/repo/services/locales/blog-body/it/some-slug.ts');
    expect(match).toEqual({ isCh: false, locale: 'it' });
  });

  it('matches the legacy services/locales path shape (svizzera, -ch)', () => {
    const match = matchBlogBodyChunkLocale('/repo/services/locales/blog-body-ch/de/some-slug.ts');
    expect(match).toEqual({ isCh: true, locale: 'de' });
  });

  it('matches the real, symlink-resolved packages/articles/content path (frontaliere)', () => {
    const match = matchBlogBodyChunkLocale('/repo/packages/articles/content/blog-body/en/some-slug.ts');
    expect(match).toEqual({ isCh: false, locale: 'en' });
  });

  it('matches the real, symlink-resolved packages/articles/content path (svizzera, -ch)', () => {
    const match = matchBlogBodyChunkLocale('/repo/packages/articles/content/blog-body-ch/fr/some-slug.ts');
    expect(match).toEqual({ isCh: true, locale: 'fr' });
  });

  it('matches on Windows-style backslash separators, both shapes', () => {
    expect(matchBlogBodyChunkLocale('C:\\repo\\services\\locales\\blog-body\\it\\some-slug.ts')).toEqual({
      isCh: false,
      locale: 'it',
    });
    expect(matchBlogBodyChunkLocale('C:\\repo\\packages\\articles\\content\\blog-body-ch\\de\\some-slug.ts')).toEqual({
      isCh: true,
      locale: 'de',
    });
  });

  it('returns null for a non-blog-body module id', () => {
    expect(matchBlogBodyChunkLocale('/repo/packages/articles/engine/ogPagesPlugin.ts')).toBeNull();
  });

  it('returns null for undefined/null facadeModuleId', () => {
    expect(matchBlogBodyChunkLocale(undefined)).toBeNull();
    expect(matchBlogBodyChunkLocale(null)).toBeNull();
  });

  it('emitted chunk filename carries the locale key for both path shapes', () => {
    const legacy = matchBlogBodyChunkLocale('/repo/services/locales/blog-body/en/eventi-weekend-ticino.ts');
    const relocated = matchBlogBodyChunkLocale(
      '/repo/packages/articles/content/blog-body/en/eventi-weekend-ticino.ts',
    );
    expect(buildBlogBodyChunkFileName('eventi-weekend-ticino', legacy)).toBe('assets/eventi-weekend-ticino.en.js');
    expect(buildBlogBodyChunkFileName('eventi-weekend-ticino', relocated)).toBe('assets/eventi-weekend-ticino.en.js');
    // Both shapes MUST agree — same slug, same locale, same emitted name,
    // regardless of which path Rollup happened to hand back.
    expect(buildBlogBodyChunkFileName('eventi-weekend-ticino', legacy)).toBe(
      buildBlogBodyChunkFileName('eventi-weekend-ticino', relocated),
    );
  });

  it('emitted chunk filename carries the ch. infix for the svizzera section, both shapes', () => {
    const legacy = matchBlogBodyChunkLocale('/repo/services/locales/blog-body-ch/fr/some-slug.ts');
    const relocated = matchBlogBodyChunkLocale('/repo/packages/articles/content/blog-body-ch/fr/some-slug.ts');
    expect(buildBlogBodyChunkFileName('some-slug', legacy)).toBe('assets/some-slug.ch.fr.js');
    expect(buildBlogBodyChunkFileName('some-slug', relocated)).toBe('assets/some-slug.ch.fr.js');
  });

  it('falls back to a plain stable name when there is no match', () => {
    expect(buildBlogBodyChunkFileName('vendor-react', null)).toBe('assets/vendor-react.js');
  });
});
