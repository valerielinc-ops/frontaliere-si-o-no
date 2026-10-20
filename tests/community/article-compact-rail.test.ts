import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const BLOG = read('components/community/BlogArticles.tsx');
const APP = read('App.tsx');
const RAIL_AD = read('components/shared/ArticleRailAd.tsx');
const RAIL_STACK = read('components/shared/ArticleRailAdStack.tsx');
const INDEX_CSS = read('index.css');
const INDEX_HTML = read('index.html');
const CRITICAL_CSS = read('build-plugins/shared/criticalCss.ts');

describe('article compact ad rail contract', () => {
  it('reserves a 160px rail tier from the content-driven 1200px breakpoint', () => {
    expect(INDEX_CSS).toMatch(/--breakpoint-xlc:\s*1200px/);
    expect(BLOG).toContain('xlc:grid-cols-[var(--ft-rail-w-c-l,160px)_minmax(0,1fr)_var(--ft-rail-w-c-r,160px)]');
    expect(BLOG).toContain('<div className="max-w-3xl xlc:max-w-none mx-auto">');
    expect(INDEX_HTML).toContain('.ft-blog-rail-grid-x { display: grid;');
    expect(INDEX_HTML).toContain('@media (min-width: 1200px) {\n        .xlc\\:max-w-none { max-width: none; }\n      }');
    expect(CRITICAL_CSS).toContain("'.ft-blog-rail-grid-x{display:grid;");
    expect(CRITICAL_CSS).toContain("'.xlc\\\\:max-w-none{max-width:none}' +");
  });

  it('never pins the article grid below its parent with an unlayered first-paint cap', () => {
    // The first-paint reserve is unlayered, so it outranks Tailwind's
    // `@layer utilities` forever: a 72rem cap there held the 3-column article
    // at 1152px on every desktop (centre column ~520px at 1540px).
    expect(CRITICAL_CSS).not.toContain("'.xlc\\\\:max-w-6xl");
    expect(INDEX_HTML).not.toContain('.xlc\\:max-w-6xl');
    expect(BLOG).not.toContain('xlc:max-w-6xl');
    expect(APP).toContain('<div className="max-xlw:max-w-7xl xlw:max-w-[1600px] mx-auto">');
  });

  it('keeps the article gutters at their reserved width when a rail does not fill', () => {
    // The gutters also hold the partner cards, TOC and resources: collapsing a
    // track to 0px pushed them under the article and reflowed the text.
    expect(BLOG).not.toContain('useRailGridCollapse()');
    expect(BLOG).not.toMatch(/ArticleRailAdStack side="(left|right)"[^>]*onEmptyResolved/);
    expect(BLOG).toContain('<div className={BLOG_ARTICLE_RAIL_GRID_CLASS_X}>');
  });

  it('pins the sticky ad cluster below the 81px sticky nav', () => {
    expect(RAIL_STACK).toContain('<div className="sticky top-24 flex flex-col gap-2">');
    expect(RAIL_STACK).not.toContain('sticky top-6');
  });

  it('mounts compact rails only on article surfaces and on both sides', () => {
    expect(BLOG.match(/<ArticleRailAdStack/g)).toHaveLength(2);
    expect(BLOG).toMatch(/ArticleRailAdStack side="left"[\s\S]*?compact/);
    expect(BLOG).toMatch(/ArticleRailAdStack side="right"[\s\S]*?compact/);
    expect(BLOG).toContain('const adEligibleRail = adEligible && (isDesktopXl || isCompactRail);');
    expect(BLOG).toContain("const isDesktopXl = useMediaQuery('(min-width: 1280px)') === true;");
    expect(BLOG).toContain("const isCompactRail = useMediaQuery('(min-width: 1200px) and (max-width: 1399.98px)') === true;");
    expect(BLOG).toContain('<ArticleRailAdStack side="left" enabled={adEligibleRail}');
    expect(BLOG).toContain('<ArticleRailAdStack side="right" enabled={adEligibleRail}');
    expect(BLOG).toContain("const BLOG_ARTICLE_RAIL_ASIDE_CLASS_X = 'ft-rail-aside-x ft-blog-rail-aside-x hidden xlc:flex");
  });

  it('restricts compact rail requests to creatives that fit the gutter', () => {
    expect(RAIL_AD).toContain('sizes={useNarrowSizes ? RAIL_SIZES_NARROW : RAIL_SIZES}');
    expect(RAIL_AD).toContain('hidden xlc:block xlw:hidden w-full text-center');
    expect(RAIL_STACK).toContain('compact?: boolean');
    expect(RAIL_STACK).toContain('hidden xlc:flex xlc:flex-col xlc:flex-1 xlc:min-h-0 xlw:hidden');
    expect(RAIL_STACK).toContain('narrow={narrow || compact}');
  });
});
