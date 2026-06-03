// blogImageCdnFinalizePlugin.ts
//
// Post-build step that offloads full blog hero images to jsDelivr and removes
// them from the GitHub Pages artifact. Runs last (enforce: 'post').
//
// 1. Rewrite every SSG-emitted reference to a FULL blog image
//    (`/images/blog/<file>.webp`, origin-absolute or site-relative) to its
//    jsDelivr CDN URL, across dist HTML/XML/TXT. The 480w thumbnails under
//    `/images/blog/thumbnails/` are NOT touched — they stay same-origin.
// 2. GUARD: re-scan; if any full-blog reference survives, ABORT the offload
//    (keep the images in dist) rather than delete — never ship a 404, never
//    break the deploy. Non-fatal: worst case the artifact is unchanged.
// 3. Delete the full blog images from dist/images/blog (keep thumbnails/).
//
// SPA runtime <img> references come from data/blog-articles-data.ts, whose
// ARTICLES export is already CDN-rewritten via cdnBlogImage — so this plugin
// only needs to handle the static HTML/XML the crawler sees. The repo is
// public, so jsDelivr (and the raw.githubusercontent fallback) can serve the
// images pinned to the build commit SHA.

import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

import { JSDELIVR_BLOG_BASE } from './shared/blogImageCdn';

const ORIGIN = 'https://frontaliereticino.ch';
const SCAN_EXT = new Set(['.html', '.xml', '.txt']);

// A FULL blog image: `/images/blog/<file>.<ext>` with no further path segment
// (so `/images/blog/thumbnails/...` never matches — it has an extra `/`).
const FILE = "([^\"'\\s/?)]+?\\.(?:webp|png|jpe?g|avif))";
const ESC_ORIGIN = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Rewrite targets: origin-absolute, and site-relative NOT preceded by a word
// char. The `(?<![\w.@])` guard means CDN/raw URLs (`…/public/images/blog/…`,
// the `c` of `public` is a word char) are never matched — they're left intact.
const reAbs = new RegExp(ESC_ORIGIN + '/images/blog/' + FILE, 'g');
const reRel = new RegExp('(?<![\\w.@])/images/blog/' + FILE, 'g');
// Guard: a SURVIVING full-blog reference that would 404 once the dir is gone —
// origin-absolute, or relative not preceded by a word char (so `/public/images/
// blog/…` inside an emitted jsDelivr/raw URL is excluded), excluding thumbnails.
const reLeak = new RegExp(
  '(?:' + ESC_ORIGIN + '/images/blog/|(?<![\\w.@])/images/blog/)(?!thumbnails/)' + FILE,
);

// Perf: the original finalize scanned every file TWICE (a rewrite pass + a
// separate guard pass). The single pass in closeBundle below rewrites and
// verifies each file in one read — halving the I/O — while the guard still
// covers EVERY emitted file (no dir is skipped), so a stray /images/blog
// reference anywhere (even in the job-board corpus, which today carries none)
// is still caught before any image is deleted.
function walk(dir: string, fn: (fp: string) => void): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, fn);
    else if (SCAN_EXT.has(path.extname(e.name))) fn(fp);
  }
}

export function blogImageCdnFinalizePlugin(rootDir: string): Plugin {
  return {
    name: 'blog-image-cdn-finalize',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const blogDir = path.join(distDir, 'images', 'blog');
      if (!fs.existsSync(blogDir)) {
        console.log('[blog-image-cdn] no dist/images/blog — skipping');
        return;
      }

      const repl = (_m: string, file: string): string => `${JSDELIVR_BLOG_BASE}/${file}`;
      let scanned = 0;
      let rewritten = 0;
      // Single pass: rewrite each file, then verify the RESULT in-memory (no
      // second filesystem scan). Guard — nothing full-blog (non-thumbnail,
      // non-CDN) may remain. If any does, ABORT the offload (keep the images
      // in dist) rather than throw: a missed reference must never break the
      // deploy. Worst case the artifact ships the blog images as before (no
      // reduction) — never a 404 or a failed build.
      const leaks: string[] = [];
      walk(distDir, (fp) => {
        scanned++;
        const orig = fs.readFileSync(fp, 'utf8');
        const out = orig.replace(reAbs, repl).replace(reRel, repl);
        if (out !== orig) {
          fs.writeFileSync(fp, out);
          rewritten++;
        }
        if (reLeak.test(out)) leaks.push(path.relative(distDir, fp));
      });
      if (leaks.length > 0) {
        console.warn(
          `[blog-image-cdn] ${leaks.length} file(s) still reference full /images/blog images after CDN ` +
            `rewrite — ABORTING offload, images kept in dist (no 404, no reduction): ` +
            `${leaks.slice(0, 8).join(', ')}${leaks.length > 8 ? ' …' : ''}`,
        );
        return;
      }

      // Delete full images; keep the thumbnails/ subdirectory (served local).
      let deleted = 0;
      let freed = 0;
      for (const e of fs.readdirSync(blogDir, { withFileTypes: true })) {
        if (e.isDirectory()) continue; // thumbnails/
        const fp = path.join(blogDir, e.name);
        freed += fs.statSync(fp).size;
        fs.rmSync(fp);
        deleted++;
      }
      console.log(
        `[blog-image-cdn] rewrote ${rewritten}/${scanned} files → jsDelivr; ` +
          `deleted ${deleted} full blog images (${(freed / 1048576).toFixed(0)} MB freed; thumbnails kept local)`,
      );
    },
  };
}
