// blogImageCdnFinalizePlugin.ts
//
// Post-build step that offloads full blog hero images to the frontaliere-cdn
// Pages site (cdn.frontaliereticino.ch) and removes them from the main GitHub
// Pages artifact. Runs last (enforce: 'post').
//
// 1. Rewrite every SSG-emitted reference to a FULL blog image
//    (`/images/blog/<file>.webp`, origin-absolute or site-relative) to its
//    CDN URL, across dist HTML/XML/TXT. The 480w thumbnails under
//    `/images/blog/thumbnails/` are NOT touched here — they have no SSG-emitted
//    same-origin refs (the SPA's getResponsiveImageSet emits their CDN URL at
//    runtime) and are offloaded separately by
//    scripts/offload-generated-images-cdn.mjs (pushed to the CDN, then deleted).
// 2. GUARD: re-scan; if any full-blog reference survives, ABORT the offload
//    (keep the images in dist) rather than delete — never ship a 404, never
//    break the deploy. Non-fatal: worst case the artifact is unchanged.
// 3. Delete the full blog images from dist/images/blog (keep the thumbnails/
//    subdir for the offload script to push to the CDN and then delete).
//
// SPA runtime <img> references come from data/blog-articles-data.ts, whose
// ARTICLES export is already CDN-rewritten via cdnBlogImage — so this plugin
// only needs to handle the static HTML/XML the crawler sees. The deploy workflow
// pushes the git-tracked public/images/blog heroes to the CDN repo (raw@SHA is
// the <img> error fallback).

import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

import { CDN_BLOG_BASE } from './shared/blogImageCdn';
import { shouldEmitPath } from './shared/localeEmitFilter';

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
// blog/…` inside an emitted CDN/raw URL is excluded), excluding thumbnails.
const reLeak = new RegExp(
  '(?:' + ESC_ORIGIN + '/images/blog/|(?<![\\w.@])/images/blog/)(?!thumbnails/)' + FILE,
);

// Perf: the original finalize scanned every file TWICE (a rewrite pass + a
// separate guard pass). The single pass in closeBundle below rewrites and
// verifies each file in one read — halving the I/O — while the guard still
// covers EVERY emitted file (no dir is skipped), so a stray /images/blog
// reference anywhere (even in the job-board corpus, which today carries none)
// is still caught before any image is deleted.
function walk(dir: string, fn: (fp: string) => void, root: string = dir): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip ONLY the TOP-LEVEL dist/{assets,data,images} (vite JS/CSS/fonts,
      // CDN-offloaded *.json payloads, *.webp/*.png/og art — none carry the
      // .html/.xml/.txt in SCAN_EXT). Descending them stat-walked ~1.4M dirents
      // per build for zero rewrites (run 27528505424: 1.59M scanned → 21k
      // rewritten, wall 811s/cpu 374s = ~54% I/O wait). We gate on `dir === root`
      // so a NESTED dir merely sharing the name (a content slug, e.g.
      // dist/en/data/) is STILL walked — its *.html must be scanned because the
      // leak-guard below deletes dist/images/blog only when NO walked file keeps
      // a same-origin /images/blog ref; a content page hidden under a nested
      // assets|data|images dir would otherwise evade the guard and 404 after the
      // delete. Top-level-only restores the pre-#2237 full-coverage at any depth
      // while keeping the (huge) top-level dist/data skip. The dist/images/blog
      // deletion loop below is a separate explicit readdirSync of blogDir.
      if (dir === root && (e.name === 'assets' || e.name === 'data' || e.name === 'images')) continue;
      // Per-locale matrix shard (BUILD_LOCALE): skip a non-owned top-level locale
      // subtree (e.g. dist/en on the `it` shard, or any non-`en` tree on the `en`
      // shard). Those files are deleted post-build by prune-locale-shard.mjs, so
      // they never ship from this shard — walking + rewriting + leak-scanning
      // them is the bulk of this plugin's ~200s wasted I/O on each shard. The
      // leak-guard's no-404 contract is preserved because every file this shard
      // SHIPS (its owned locale + the root/`it`-classified shared tree) is still
      // walked and scanned. shouldEmitPath returns true for ALL paths on the
      // default all-locale build (EMIT_ALL_LOCALES) → no-op, full coverage.
      if (dir === root && !shouldEmitPath(fp, root)) continue;
      walk(fp, fn, root);
    } else if (SCAN_EXT.has(path.extname(e.name))) {
      // Same shard-ownership gate for root-level files (e.g. dist/index.html on
      // an en/de/fr shard) — pruned post-build, never shipped from here.
      if (!shouldEmitPath(fp, root)) continue;
      fn(fp);
    }
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

      const repl = (_m: string, file: string): string => `${CDN_BLOG_BASE}/${file}`;
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

      // Delete full images; keep the thumbnails/ subdirectory here for the
      // offload script (offload-generated-images-cdn.mjs) to push to the CDN and
      // then delete — they are NOT served same-origin.
      let deleted = 0;
      let freed = 0;
      for (const e of fs.readdirSync(blogDir, { withFileTypes: true })) {
        if (e.isDirectory()) continue; // thumbnails/ (offloaded separately)
        const fp = path.join(blogDir, e.name);
        freed += fs.statSync(fp).size;
        fs.rmSync(fp);
        deleted++;
      }
      console.log(
        `[blog-image-cdn] rewrote ${rewritten}/${scanned} files → CDN; ` +
          `deleted ${deleted} full blog images (${(freed / 1048576).toFixed(0)} MB freed; thumbnails kept local)`,
      );
    },
  };
}
