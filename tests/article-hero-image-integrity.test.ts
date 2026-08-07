// Google Discover eligibility, the part that a source-grep cannot see (#5001).
//
// tests/article-hero-image-discover.test.ts already pins the SHAPE of the hero
// markup by reading the emitter's source. Shape was never the thing that broke.
// What broke was the two VALUES the shape carries, and both only exist after
// the renderer has touched the filesystem:
//
//   1. `src` pointed at the SITE ROOT. `resolveImagePath('/images/blog/x.webp')`
//      fell through to `norm(blogImageById[id] || '')`, which is `'/'`, and
//      `'/'` passed the existence check because `path.join(distDir, '')` is
//      distDir — a directory that always exists. The page then shipped
//      `<img src="/">` + `og:image=<BASE_URL>/` + a JSON-LD ImageObject naming
//      the same URL. All three serve text/html. A page with no valid <img> is
//      not Discover-eligible, and nothing failed the build.
//      Measured live on 2026-08-07: 92 article pages, all HTTP 200.
//
//   2. The declared size was a CONSTANT (1200x675) while the files are not.
//      Measured over the corpus: the width is 1200 essentially everywhere but
//      the height runs 179..2469, so several hundred pages declared a height
//      their own file contradicts — a false statement to crawlers and, because
//      width/height is what reserves the box, CLS that Auto Ads inherits
//      (Non-Negotiable #7 — reserve space, never suppress the ad).
//
// So these are RENDER tests, not source tests: they run the real
// `renderArticlePages` into a temp distDir whose image files this test creates
// itself, at sizes it chose, and then assert what came out. The svizzera
// section is used for the same reason
// tests/render-article-pages-single-vs-full.test.ts uses it — same code path,
// ~640 articles instead of ~3100.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { renderArticlePages } from '../build-plugins/ogPagesPlugin';
import { readImageIntrinsicSize } from '../packages/articles/engine/shared/imageIntrinsicSize';

const rootDir = process.cwd();

/** Deliberately NOT 1200x675 — the whole point is to catch a hardcoded pair. */
const FIXTURE_WIDTH = 1200;
const FIXTURE_HEIGHT = 901;

/** A real, parseable PNG of exactly w x h. Header is what the emitter reads. */
function pngBytes(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((w + 1) * h); // filter byte + row, all zero
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Every `/images/...` path the svizzera SEO source names. Enumerated with a
 * plain sweep, not by re-implementing the resolver: this only decides WHERE to
 * drop fixture files, never what the emitter is expected to do with them.
 */
function heroCandidatePaths(): string[] {
  const src = fs.readFileSync(path.join(rootDir, 'services/seo/seo-blog-ch.ts'), 'utf-8');
  return [...new Set(src.match(/\/images\/[^'"`\s,}]+/g) ?? [])];
}

function writeFixture(distDir: string, rel: string, buf: Buffer): void {
  const abs = path.join(distDir, rel.replace(/^\/+/, ''));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

type Emitted = { rel: string; html: string };

function readEmitted(distDir: string, entries: { paths: Record<string, string> }[]): Emitted[] {
  const out: Emitted[] = [];
  for (const e of entries) {
    for (const rel of Object.values(e.paths)) {
      const abs = path.join(distDir, rel);
      if (fs.existsSync(abs)) out.push({ rel, html: fs.readFileSync(abs, 'utf-8') });
    }
  }
  return out;
}

const HERO_IMG_RX = /<img\b[^>]*class="w-full h-auto rounded-lg"[^>]*>/;
const ATTR_RX = /([a-zA-Z0-9:_-]+)="([^"]*)"/g;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RX)) out[m[1].toLowerCase()] = m[2];
  return out;
}

function metaContent(html: string, property: string): string | undefined {
  const m = html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`));
  return m?.[1];
}

/** Every `image` object reachable in the page's JSON-LD documents. */
function jsonLdImages(html: string): { url?: string; width?: number; height?: number }[] {
  const found: { url?: string; width?: number; height?: number }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const img = obj.image;
    if (img && typeof img === 'object' && !Array.isArray(img)) {
      const i = img as Record<string, unknown>;
      if (i['@type'] === 'ImageObject') {
        found.push({
          url: typeof i.contentUrl === 'string' ? i.contentUrl : (typeof i.url === 'string' ? i.url : undefined),
          width: typeof i.width === 'number' ? i.width : undefined,
          height: typeof i.height === 'number' ? i.height : undefined,
        });
      }
    }
    Object.values(obj).forEach(walk);
  };
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(m[1])); } catch { /* not this page's problem */ }
  }
  return found;
}

/** Strip the origin so a CDN URL and a site-relative path compare equal. */
function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '') || '/';
}

describe('article hero <img> always points at a real image file (#5001)', () => {
  it('never emits a src that resolves to the site root', async () => {
    // distDir deliberately holds ONLY the last-resort default. Every article's
    // own hero is absent, which is exactly the state that produced `src="/"`
    // on 92 live pages — and is also the state every scratch render is in
    // (see the "Known gap" header in scripts/publish-article-fast.mjs).
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-missing-'));
    try {
      writeFixture(distDir, '/og-image.png', pngBytes(1200, 630));

      const { entries } = await renderArticlePages({ rootDir, distDir, section: 'svizzera' });
      expect(entries.length).toBeGreaterThan(0);

      const pages = readEmitted(distDir, entries);
      expect(pages.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const { rel, html } of pages) {
        const tag = html.match(HERO_IMG_RX)?.[0];
        if (!tag) { offenders.push(`${rel}: no hero <img> at all`); continue; }
        const src = attrs(tag).src ?? '';
        // The bug's exact signature: a src that is the site root. It is not an
        // image — the origin answers it with the HTML document.
        if (src === '' || src === '/' || /^https?:\/\/[^/]+\/?$/.test(src)) {
          offenders.push(`${rel}: hero src is the site root (${JSON.stringify(src)})`);
          continue;
        }
        // Stronger than "not the root": whatever it names must be a FILE that
        // this render could see, and that file must parse as an image.
        const abs = path.join(distDir, pathOf(src).replace(/^\/+/, ''));
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          offenders.push(`${rel}: hero src ${src} is not a file in dist`);
          continue;
        }
        if (!readImageIntrinsicSize(abs)) offenders.push(`${rel}: hero src ${src} is not a parseable image`);
      }

      expect(offenders.slice(0, 10).join('\n'), `${offenders.length}/${pages.length} pages`).toBe('');
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 300_000);

  it('keeps og:image and the JSON-LD ImageObject on that same file', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-agree-'));
    try {
      writeFixture(distDir, '/og-image.png', pngBytes(1200, 630));
      for (const rel of heroCandidatePaths()) writeFixture(distDir, rel, pngBytes(FIXTURE_WIDTH, FIXTURE_HEIGHT));

      const { entries } = await renderArticlePages({ rootDir, distDir, section: 'svizzera' });
      const pages = readEmitted(distDir, entries);
      expect(pages.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const { rel, html } of pages) {
        const tag = html.match(HERO_IMG_RX)?.[0];
        if (!tag) { offenders.push(`${rel}: no hero <img>`); continue; }
        const src = pathOf(attrs(tag).src ?? '');
        const og = metaContent(html, 'og:image');
        if (!og) { offenders.push(`${rel}: no og:image`); continue; }
        if (pathOf(og) !== src) offenders.push(`${rel}: og:image ${pathOf(og)} != <img> ${src}`);
        for (const ld of jsonLdImages(html)) {
          if (ld.url && pathOf(ld.url) !== src) offenders.push(`${rel}: JSON-LD image ${pathOf(ld.url)} != <img> ${src}`);
        }
      }

      expect(offenders.slice(0, 10).join('\n'), `${offenders.length}/${pages.length} pages`).toBe('');
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('declared hero dimensions equal the file (#5001)', () => {
  it('reads width/height from the bytes, not from a constant', async () => {
    // Fixtures are 1200x901. A renderer that measures reports 901; one that
    // carries a hardcoded pair reports whatever that pair says.
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-dims-'));
    try {
      writeFixture(distDir, '/og-image.png', pngBytes(1200, 630));
      for (const rel of heroCandidatePaths()) writeFixture(distDir, rel, pngBytes(FIXTURE_WIDTH, FIXTURE_HEIGHT));

      const { entries } = await renderArticlePages({ rootDir, distDir, section: 'svizzera' });
      const pages = readEmitted(distDir, entries);
      expect(pages.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const { rel, html } of pages) {
        const tag = html.match(HERO_IMG_RX)?.[0];
        if (!tag) { offenders.push(`${rel}: no hero <img>`); continue; }
        const a = attrs(tag);
        const src = pathOf(a.src ?? '');
        const abs = path.join(distDir, src.replace(/^\/+/, ''));
        const real = readImageIntrinsicSize(abs);
        if (!real) { offenders.push(`${rel}: cannot measure ${src}`); continue; }

        // The one rule, applied to all three declarations of the same file.
        if (Number(a.width) !== real.width || Number(a.height) !== real.height) {
          offenders.push(`${rel}: <img> says ${a.width}x${a.height}, ${src} is ${real.width}x${real.height}`);
        }
        const ogW = metaContent(html, 'og:image:width');
        const ogH = metaContent(html, 'og:image:height');
        if (Number(ogW) !== real.width || Number(ogH) !== real.height) {
          offenders.push(`${rel}: og:image says ${ogW}x${ogH}, ${src} is ${real.width}x${real.height}`);
        }
        for (const ld of jsonLdImages(html)) {
          if (ld.width !== undefined && ld.width !== real.width) {
            offenders.push(`${rel}: JSON-LD width ${ld.width}, ${src} is ${real.width}`);
          }
          if (ld.height !== undefined && ld.height !== real.height) {
            offenders.push(`${rel}: JSON-LD height ${ld.height}, ${src} is ${real.height}`);
          }
        }
      }

      expect(offenders.slice(0, 10).join('\n'), `${offenders.length}/${pages.length} pages`).toBe('');
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }, 300_000);
});

/**
 * The SECOND renderer. `build-plugins/staticPagesPlugin.ts` still owns every
 * article whose live slug has no `canonicalPath:` entry in the SEO sources —
 * ogPagesPlugin never emits those paths, so they fall through to the hub shell.
 * Measured live on 2026-08-07: 45 IT slugs, 180 URLs across the four locales,
 * all serving the HUB's hero (the newest article's image, identical on all of
 * them) while their own JSON-LD named the right file and og:image named a third.
 *
 * Source-level, because rendering one of these pages needs a fully built dist —
 * the same reason tests/article-hero-image-discover.test.ts gives.
 */
describe('the hub-shell renderer does not put the hub hero on article pages (#5001)', () => {
  const SOURCE = fs.readFileSync(path.join(rootDir, 'build-plugins/staticPagesPlugin.ts'), 'utf-8');
  // The assertions below compare BOOLEANS, never the 5.000-line source itself:
  // `expect(SOURCE).toContain(...)` prints the whole haystack on failure, which
  // buries the one line that matters under a megabyte of diff.
  const has = (needle: string | RegExp): boolean =>
    typeof needle === 'string' ? SOURCE.includes(needle) : needle.test(SOURCE);

  it('resolves a detail page hero from the article registry', () => {
    expect(has('const heroImageByArticleId'), 'no per-article hero index').toBe(true);
    // The detail branch must prefer the article's own hero over the hub's.
    expect(has(/const heroSrc = blogDetailHeroSrc \|\| blogHeroImageStatic;/), 'detail branch still uses the hub hero').toBe(true);
  });

  it('declares no hardcoded hero dimensions', () => {
    // A hardcoded 800x320 was carried by every page this branch emitted, on
    // files that are 1200 wide — a declared size the bytes contradict.
    expect(has('width="800" height="320"'), 'hardcoded 800x320 hero dimensions').toBe(false);
    expect(has('readImageIntrinsicSize'), 'dimensions are not measured from the file').toBe(true);
  });

  it('feeds og:image from the same hero as the <img>', () => {
    expect(has(/const ogImageUrl = glossaryHero[\s\S]{0,200}?blogDetailHeroSrc/), 'og:image ignores the article hero').toBe(true);
    expect(has(/const ogImageW = glossaryHero[\s\S]{0,120}?blogDetailHeroSize/), 'og:image:width is not measured').toBe(true);
    expect(has(/const ogImageH = glossaryHero[\s\S]{0,120}?blogDetailHeroSize/), 'og:image:height is not measured').toBe(true);
  });

  it('rewrites the JSON-LD ImageObject onto that same hero', () => {
    expect(has('const sdForPage'), 'JSON-LD is not reconciled with the hero').toBe(true);
    // and the shells must actually emit the reconciled copy, not the raw one.
    expect(has(/<script type="application\/ld\+json">\$\{seoData\.sd\}<\/script>/), 'a shell still emits the unreconciled JSON-LD').toBe(false);
  });
});
