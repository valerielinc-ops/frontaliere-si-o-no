import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCanonicalBridgePage, buildFlatRedirect } from '@/build-plugins/constants';

describe('SEO builder noindex guards', () => {
  it('flat alias pages use a canonical bridge without JS redirect or meta refresh', () => {
    const html = buildFlatRedirect('https://frontaliereticino.ch/articoli-frontaliere/test/', '/articoli-frontaliere/test/');
    expect(html).not.toContain('location.replace(');
    expect(html).toContain('rel="canonical"');
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain('Versione canonica disponibile');
  });

  describe('buildCanonicalBridgePage noindex parameter', () => {
    it('defaults to index,follow when noindex is not set', () => {
      const html = buildCanonicalBridgePage({
        canonicalUrl: 'https://frontaliereticino.ch/test/',
        pathLabel: '/test/',
      });
      expect(html).toContain('content="index,follow"');
      expect(html).not.toContain('noindex');
    });

    it('outputs noindex,follow when noindex is true', () => {
      const html = buildCanonicalBridgePage({
        canonicalUrl: 'https://frontaliereticino.ch/test/',
        pathLabel: '/test/',
        noindex: true,
      });
      expect(html).toContain('content="noindex,follow"');
      expect(html).not.toContain('content="index,follow"');
    });

    it('outputs index,follow when noindex is explicitly false', () => {
      const html = buildCanonicalBridgePage({
        canonicalUrl: 'https://frontaliereticino.ch/test/',
        pathLabel: '/test/',
        noindex: false,
      });
      expect(html).toContain('content="index,follow"');
    });
  });

  describe('bridge page call sites pass noindex: true', () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', 'build-plugins', 'jobsSeoPagesPlugin.ts'),
      'utf-8',
    );

    it('expired job soft-landing pages use self-canonical and conditional noindex for thin content', () => {
      const start = source.indexOf('// 3. Generate soft-landing pages for expired slugs');
      const end = source.indexOf('if (expiredCount > 0)', start);
      const block = source.slice(start, end);
      // Soft-landing pages use self-referencing canonical
      expect(block).toContain('rel="canonical"');
      expect(block).not.toContain('http-equiv="refresh"');
      // Robots directive is conditional on content quality via robotsMetaForContent()
      // Pages with >= MIN_INDEXABLE_WORDS get index,follow; below threshold get noindex,follow
      expect(block).toContain('robotsMetaForContent');
      expect(block).toContain('expiredRobotsTag');
    });

    it('legacy slug bridge pages serve full locale-canonical HTML (indexable, BRIDGE_TARGET_SLUG injected)', () => {
      // Phase 4 (2026-04-30): replaces the previous thin
      // buildCanonicalBridgePage redirect — those were noindex,follow with
      // a `location.replace` placeholder UI. The new bridge reuses the
      // full locale-canonical `html` (same pattern as the previousSlugs
      // bridge at jobsSeoPagesPlugin:7264-7271): `<link rel="canonical">`
      // inside `html` already points at the locale-canonical URL, so
      // Google folds equity. Robots stays at the canonical's default
      // (index,follow) — the previous noindex was a workaround for
      // title-uniqueness duplication that the canonical signal already
      // handles. The page is now SPA-hydratable (bundle inside `html`),
      // monetised (ADSENSE_SNIPPET inherited), and auth-gated for real
      // users while bypassing for crawlers via `isCrawlerVisitor`.
      // Anchor on the `if` statement, not the comment, so the comment block
      // (which legitimately mentions `buildCanonicalBridgePage` to explain
      // what was replaced) doesn't leak into the assertion text.
      const ifLine = "if (locale !== 'it' && perLocaleSlug[locale] !== job.slug) {";
      const start = source.indexOf(ifLine, source.indexOf('// Legacy bridge'));
      const end = source.indexOf("recordEmit('active-job-legacy-bridge'", start);
      const block = source.slice(start, end);
      // Reuses the locale-canonical html, NOT the thin redirect builder.
      expect(block).not.toContain('buildCanonicalBridgePage');
      expect(block).not.toContain('noindex: true');
      // Hooks: __BRIDGE_TARGET_SLUG__ for the SPA's lookup, plus the
      // canonical html as the source.
      expect(block).toContain('__BRIDGE_TARGET_SLUG__');
      expect(block).toContain('perLocaleSlug[locale]');
      expect(block).toContain('html.replace(\'</head>\'');
      // Cross-job collision guard: don't clobber another job's canonical.
      expect(block).toContain('activeJobDirs.has');
    });

    it('company slug alias pages serve full canonical content (no thin stub, no noindex)', () => {
      const start = source.indexOf('// Redirect pages for raw slugs that differ from canonical');
      const end = source.indexOf('const rawFlat', start);
      const block = source.slice(start, end);
      // Mirrors the previousSlugs bridge pattern: alias URLs (e.g.
      // /azienda-lidl-svizzera/ vs canonical /azienda-lidl/) serve the SAME
      // rich companyHtml so Google sees substantive content instead of a thin
      // ~200-byte "go to canonical" stub. The embedded `<link rel="canonical">`
      // already points to the canonical hub URL — that single signal
      // consolidates authority on the canonical without de-indexing the alias.
      // No `buildCanonicalBridgePage`, no `noindex` here by design.
      expect(block).not.toContain('buildCanonicalBridgePage');
      expect(block).not.toContain('noindex: true');
      expect(block).toContain('companyHtml');
    });

    it('legacy redirect pages use noindex,follow (archived, not canonical)', () => {
      const legacySource = readFileSync(
        path.resolve(__dirname, '..', 'build-plugins', 'legacyRedirectsPlugin.ts'),
        'utf-8',
      );
      const start = legacySource.indexOf('buildCompatHtml');
      const end = legacySource.indexOf('for (const [fromRaw', start);
      const block = legacySource.slice(start, end);
      expect(block).toContain('buildCanonicalBridgePage');
      expect(block).toContain('noindex: true');
    });
  });
});
