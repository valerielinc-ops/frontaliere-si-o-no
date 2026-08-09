// @vitest-environment node
/**
 * `max-image-preview:large` on every indexable page (issue #5001).
 *
 * WHAT WAS WRONG, measured against the live site on 2026-08-05 by sampling one
 * URL from each of the 87 sitemaps in `sitemap.xml` with a Googlebot UA:
 *
 *   50 of the 83 families that answered 200 shipped WITHOUT
 *   `max-image-preview:large`.
 *
 * The directive is the gate Google applies before a page is eligible for a
 * large-image card in Discover and for image-rich SERP treatments; without it
 * the preview is capped at a thumbnail no matter how good the page's imagery
 * is. The families that had it were the ones whose plugin hand-rolled its own
 * `<head>` (articles, job detail, the static core pages). Every family that
 * went through the shared shell — comuni, salary, weather, fuel, health,
 * events, FAQ hub, search clusters, … — passed the plain `'index,follow'`
 * literal, because that is the only value the shell's own default and all 88
 * of its call sites ever used.
 *
 * The fix normalises at the single emission point rather than at the 88 call
 * sites, so a NEW page family that writes the obvious `robots: 'index,follow'`
 * is Discover-eligible without its author knowing this rule exists. These
 * tests pin both halves: the normaliser's contract, and the absence of
 * hand-rolled indexable directives that would bypass it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  ROBOTS_INDEX_ENHANCED,
  ROBOTS_INDEX_ENHANCED_CONTENT,
  normalizeRobotsDirective,
  replaceRobotsMeta,
  robotsMetaForContent,
  robotsMetaEnhancedForContent,
  MIN_INDEXABLE_WORDS,
} from '@/build-plugins/constants';
import { buildSimplePage } from '@/build-plugins/htmlTemplate';
import { ARTICLE_ROBOTS_INDEX_ENHANCED } from '@/packages/articles/engine/shared/robotsDirective';

const ROOT = path.resolve(__dirname, '..', '..');

describe('normalizeRobotsDirective', () => {
  it('upgrades the plain indexable literal every call site passes', () => {
    expect(normalizeRobotsDirective('index,follow')).toBe(ROBOTS_INDEX_ENHANCED_CONTENT);
    expect(normalizeRobotsDirective('index, follow')).toBe(ROBOTS_INDEX_ENHANCED_CONTENT);
    expect(normalizeRobotsDirective('index,follow')).toContain('max-image-preview:large');
  });

  it('never touches a directive that opts out of indexing', () => {
    // Rewriting these would turn a deliberate exclusion into an inclusion.
    for (const opt of ['noindex,follow', 'noindex, nofollow', 'NOINDEX,FOLLOW']) {
      expect(normalizeRobotsDirective(opt)).toBe(opt);
    }
  });

  it('leaves a directive that already tuned its own preview qualifiers alone', () => {
    const custom = 'index, follow, max-image-preview:standard';
    expect(normalizeRobotsDirective(custom)).toBe(custom);
    expect(normalizeRobotsDirective(ROBOTS_INDEX_ENHANCED_CONTENT)).toBe(ROBOTS_INDEX_ENHANCED_CONTENT);
  });
});

describe('the shared shell emits the enhanced directive by construction', () => {
  const page = (robots?: string) =>
    buildSimplePage({
      locale: 'it',
      title: 'T',
      description: 'D',
      canonicalUrl: 'https://frontaliereticino.ch/x/',
      bodyHtml: '<h1>T</h1>',
      ...(robots ? { robots } : {}),
    });

  it('defaults to Discover-eligible', () => {
    expect(page()).toContain('max-image-preview:large');
  });

  it('upgrades the literal that all 88 existing call sites pass', () => {
    expect(page('index,follow')).toContain('max-image-preview:large');
    expect(page('index,follow')).not.toContain('content="index,follow"');
  });

  it('still honours a caller that asks for noindex', () => {
    const html = page('noindex,follow');
    expect(html).toContain('content="noindex,follow"');
    expect(html).not.toContain('max-image-preview');
  });
});

describe('word-count-gated helpers agree', () => {
  const rich = `<p>${'parola '.repeat(MIN_INDEXABLE_WORDS).trim()}</p>`;
  const thin = '<p>due parole</p>';

  it('both indexable branches now carry the preview qualifiers', () => {
    expect(robotsMetaForContent(rich)).toBe(ROBOTS_INDEX_ENHANCED);
    expect(robotsMetaEnhancedForContent(rich)).toBe(ROBOTS_INDEX_ENHANCED);
    expect(robotsMetaForContent(rich)).toContain('max-image-preview:large');
  });

  it('the thin-content floor is untouched', () => {
    expect(robotsMetaForContent(thin)).toContain('noindex,follow');
    expect(robotsMetaEnhancedForContent(thin)).toContain('noindex,follow');
  });
});

describe('replaceRobotsMeta demotes by tag name, not by content value', () => {
  it('demotes whatever indexable directive the shell happens to emit', () => {
    // The regression this guards: exchangeRatePagesPlugin matched the literal
    // `content="index,follow"`, so the day the shell's directive changed its
    // thin-content demotion silently stopped firing (Non-Negotiable #4).
    const html = `<html><head><meta name="robots" content="${ROBOTS_INDEX_ENHANCED_CONTENT}"><title>x</title></head></html>`;
    const out = replaceRobotsMeta(html, 'noindex,follow');
    expect(out).toContain('content="noindex,follow"');
    expect(out).not.toContain('max-image-preview');
  });

  it('inserts the tag when the page has none', () => {
    const out = replaceRobotsMeta('<html><head><title>x</title></head></html>', 'noindex,follow');
    expect(out).toContain('<meta name="robots" content="noindex,follow">');
  });
});

describe('the confined articles package keeps its own copy in sync', () => {
  it('is BYTE-identical to the build-plugins value, ordering included', () => {
    // `packages/articles` may not import build-plugins (confinement test), so
    // the string exists twice on purpose.
    //
    // Byte equality, not set equality: `renderArticleHubPages` (this package)
    // and `emitSeoHubs` (build-plugins/seoHubsPlugin.ts) emit the SAME article
    // hub URLs by two paths, and tests/render-article-hub-pages-narrow-vs-full
    // asserts the two renders match byte for byte. A set-equality assertion
    // here passed while the two constants listed the same five qualifiers in a
    // different order — and that alone broke the hub byte-identity test.
    expect(ARTICLE_ROBOTS_INDEX_ENHANCED).toBe(ROBOTS_INDEX_ENHANCED_CONTENT);
    expect(ARTICLE_ROBOTS_INDEX_ENHANCED).toContain('max-image-preview:large');
  });
});

describe('the static index.html template keeps its own copy in sync', () => {
  it('is BYTE-identical to the build-plugins value, ordering included', () => {
    // `index.html` is Vite's raw HTML entry — it can't import the shared
    // constant, so the qualifier list is necessarily hand-typed a third
    // time. That copy had drifted to a different (still valid) ordering of
    // the same directives, which is invisible to crawlers but broke the
    // audit/build byte-identity comparison (#5494) that chases divergence
    // between the SSG build and the fast-publish path. Pinning it here means
    // the next hand-edit that reorders it fails a test instead of silently
    // reopening that chase.
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const match = html.match(/<meta\s+name="robots"\s+content="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(ROBOTS_INDEX_ENHANCED_CONTENT);
  });
});

/**
 * Fleet guard: no emitter may hand-roll an INDEXABLE robots meta tag that
 * skips the preview qualifiers. This is what turns the fix from "the 50
 * families measured today" into a property of the codebase — a new plugin that
 * copy-pastes a `<head>` block reintroduces the bug here, at review time,
 * instead of on the live site months later.
 */
describe('no hand-rolled indexable robots meta bypasses the normaliser', () => {
  const SCAN_DIRS = ['build-plugins', path.join('packages', 'articles', 'engine')];
  // Literal `<meta name="robots" content="...">` whose value starts with an
  // interpolation is fine — that is the shared constant being spliced in.
  const HARDCODED_INDEXABLE = /<meta\s+name="robots"\s+content="(?!\$\{)(?![^"]*noindex)[^"]*"/gi;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(p);
    }
    return out;
  }

  it('every hardcoded indexable directive carries max-image-preview:large', () => {
    const offenders: string[] = [];

    for (const rel of SCAN_DIRS) {
      const abs = path.join(ROOT, rel);
      for (const file of walk(abs)) {
        const src = readFileSync(file, 'utf8');
        HARDCODED_INDEXABLE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = HARDCODED_INDEXABLE.exec(src)) !== null) {
          if (m[0].includes('max-image-preview')) continue;
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(ROOT, file)}:${line} → ${m[0]}`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
