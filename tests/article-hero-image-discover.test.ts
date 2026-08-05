import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Google Discover eligibility — the IMAGE half (issues #5005 / #5001).
 *
 * Discover's large-image card is opted into with `max-image-preview:large`,
 * which article pages have set for a long time. That directive raises the CAP
 * on preview size; it does not supply an image. Measured on four live article
 * pages with a Googlebot-smartphone UA before this landed:
 *
 *   <img       0 occurrences
 *   <picture>  0
 *   srcset     0
 *   <link rel="preload" as="image">   1   ← no consumer in the document
 *
 * The hero existed only in the React render, i.e. behind JS execution, so the
 * crawled markup offered nothing for the cap to apply to. The preload was a
 * high-priority fetch for an image the document never displayed.
 *
 * These assertions are source-level on purpose: rendering one article page
 * needs the full corpus plus a built `dist/` (spaBundleResolver throws
 * otherwise), and every other test that guards this emitter's shape
 * (article-pages-static-first-shape, offerwall-static-fc-snippet) reads the
 * source for the same reason.
 */
const SOURCE = readFileSync(
  resolve(__dirname, '..', 'packages/articles/engine/ogPagesPlugin.ts'),
  'utf-8',
);

describe('article pages emit a real hero image element (#5005)', () => {
  it('builds a hero <figure><img> with the intrinsic size reserved', () => {
    expect(SOURCE).toContain('const heroFigureHtml');
    // width/height are what reserve the box before the bytes land. Without
    // them the image is a layout shift, which Auto Ads inherits — and
    // Non-Negotiable #7 says CLS from ads is fixed by reserving space, never
    // by suppressing the ad.
    expect(SOURCE).toMatch(/heroFigureHtml\s*=\s*[\s\S]{0,400}?width="\$\{HERO_WIDTH\}"/);
    expect(SOURCE).toMatch(/heroFigureHtml\s*=\s*[\s\S]{0,400}?height="\$\{HERO_HEIGHT\}"/);
  });

  it('gives the hero an accessible name that is never empty', () => {
    // alt="" would be a decorative-image assertion — it would tell Discover
    // this image is not about the article, which is the opposite of the point.
    expect(SOURCE).toMatch(/heroFigureHtml\s*=\s*[\s\S]{0,400}?alt="\$\{esc\(heroAlt\)\}"/);
    expect(SOURCE).toContain('const heroAlt = localizedMeta?.imageAlt || localizedTitle');
  });

  it('renders the hero in BOTH emit branches, not just the rich one', () => {
    // The bundle-less fallback is currently unreachable (hasSpaBundle is typed
    // `true`), but its own header comment says it is kept in parity with the
    // rich branch precisely so a future resolver change cannot silently strip
    // what article pages carry. A hero in one branch only is that drift.
    const inserted = SOURCE.match(/\$\{heroFigureHtml\}/g) ?? [];
    expect(inserted).toHaveLength(2);
  });

  it('points the hero at the same URL as the preload, so the preload has a consumer', () => {
    // Two different URLs here would mean two requests and an unconsumed
    // high-priority preload — the state this replaced.
    expect(SOURCE).toMatch(/heroFigureHtml\s*=\s*[\s\S]{0,400}?<img src="\$\{en\.img\}"/);
    expect(SOURCE).toContain('<link rel="preload" as="image" href="${en.img}" fetchpriority="high">');
  });
});

describe('article NewsArticle JSON-LD carries image dimensions (#5001)', () => {
  it('builds `image` as an ImageObject, not a bare URL string', () => {
    // A bare string forces Google to fetch and measure the file before it can
    // decide large-card eligibility. The Event branch in this same file already
    // used the helper; the NewsArticle branch — every real article — did not.
    expect(SOURCE).not.toMatch(/^\s*image: imgU,\s*$/m);
    expect(SOURCE).toMatch(
      /'@type': 'NewsArticle',[\s\S]{0,900}?image: imageObjectLd\(\{[\s\S]{0,300}?url: imgU,/,
    );
  });

  it('declares a width at or above the Discover large-card floor', () => {
    expect(SOURCE).toMatch(/const HERO_WIDTH = (\d+);/);
    const width = Number(SOURCE.match(/const HERO_WIDTH = (\d+);/)![1]);
    expect(width).toBeGreaterThanOrEqual(1200);
  });
});

describe('the hero size lives in one constant', () => {
  it('og:image, the ImageObject and the <img> all read the same numbers', () => {
    // Four copies of `1200`/`675` across og tags, the Event ImageObject, the
    // NewsArticle ImageObject and the <img> attributes is a drift waiting to
    // happen — and here the drift is CLS, not cosmetics (AGENTS.md #6: a
    // literal duplicated in ≥2 places gets extracted, not copy-pasted).
    expect(SOURCE).toContain('<meta property="og:image:width" content="${HERO_WIDTH}">');
    expect(SOURCE).toContain('<meta property="og:image:height" content="${HERO_HEIGHT}">');
    expect(SOURCE).not.toContain('<meta property="og:image:width" content="1200">');
    expect(SOURCE).not.toContain('<meta property="og:image:height" content="675">');
    // No stray literal left in an ImageObject width/height either.
    expect(SOURCE).not.toMatch(/width: 1200,\s*\n\s*height: 675,/);
  });
});

/**
 * The hero's `class` attribute is only meaningful if Tailwind ever sees it.
 * `packages/articles/engine/**` was outside the content globs, so every
 * utility the article emitter writes survived on the accident of the same
 * class appearing in a scanned component.
 */
describe('Tailwind scans the source that emits article HTML', () => {
  it('includes packages/articles/engine in the content globs', () => {
    const config = readFileSync(resolve(__dirname, '..', 'tailwind.config.js'), 'utf-8');
    expect(config).toContain('./packages/articles/engine/**/*.{js,ts}');
  });

  it('every utility the engine emits is inside a scanned glob', () => {
    const config = readFileSync(resolve(__dirname, '..', 'tailwind.config.js'), 'utf-8');
    const globs = [...config.matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]);
    // The engine emits class="..." literals; whichever directory they live in
    // has to be covered, or the utilities are purged from the built CSS.
    expect(globs.some((g) => g.startsWith('packages/articles/engine/'))).toBe(true);
  });
});
