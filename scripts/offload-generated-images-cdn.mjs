#!/usr/bin/env node
// offload-generated-images-cdn.mjs
//
// Offload BUILD-GENERATED per-job OG cards (dist/og) from the GitHub Pages
// artifact to raw.githubusercontent, pinned to a cdn-assets commit SHA.
// (raw, not jsDelivr: jsDelivr 502s on the large orphan commit — see cdnBase.)
//
// (Blog 480w thumbnails are NOT offloaded — their URLs are built at runtime in
// the JS bundle, not in HTML, so an HTML-only rewrite can't cover them; they
// stay same-origin. Only og:image refs, which ARE in static HTML, move.)
//
// Unlike the full blog hero images (git-tracked → served from main@sha by
// build-plugins/blogImageCdnFinalizePlugin), og/jobs is generated at build time
// and is NOT in git. The deploy workflow first force-pushes dist/og to an
// orphan `cdn-assets` branch and passes that commit SHA as CDN_ASSETS_SHA;
// this script then rewrites
// the emitted dist references to the jsDelivr URL and deletes the offloaded
// directories from dist.
//
// SAFETY — BEST-EFFORT / NON-FATAL: this runs in the deploy critical path, so it
// must NEVER break a deploy. On a missing SHA, a guard leak, or ANY thrown
// error it leaves dist exactly as-is and exits 0 — the images simply ship in the
// artifact as before (no reduction, no breakage). The deploy step that invokes
// it also uses continue-on-error.
//
// Mirrors the proven rewrite+guard logic of blogImageCdnFinalizePlugin.

import fs from 'node:fs';
import path from 'node:path';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const ORIGIN = 'https://frontaliereticino.ch';
const SCAN_EXT = new Set(['.html', '.xml', '.txt']);

// Offload targets: [dist subdir, url path prefix]. Only these prefixes are
// rewritten/guarded/deleted.
//
// ONLY per-job OG cards. Their refs (`<meta property="og:image">`) are emitted
// into the static HTML, so the HTML rewrite below catches every one and the
// guard can verify it. Blog 480w thumbnails are NOT offloaded: the SPA builds
// those URLs at runtime in the JS bundle (getResponsiveImageSet → srcSet), not
// in HTML, so an HTML-only rewrite would miss them and deleting the dir would
// 404 them on hydrated pages. Thumbnails stay same-origin (~49 MB).
const TARGETS = [
  { dir: ['og'], url: '/og/' },
];

function log(msg) {
  console.log(`[offload-generated-cdn] ${msg}`);
}

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, fn);
    else if (SCAN_EXT.has(path.extname(e.name))) fn(fp);
  }
}

function dirSize(dir) {
  let bytes = 0;
  if (!fs.existsSync(dir)) return 0;
  walkAll(dir, (fp) => { bytes += fs.statSync(fp).size; });
  return bytes;
}
function walkAll(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(fp, fn);
    else fn(fp);
  }
}

function main() {
  const sha = (process.env.CDN_ASSETS_SHA || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    log(`no valid CDN_ASSETS_SHA (got "${sha}") — skipping offload, images stay in dist`);
    return;
  }
  const distDir = path.resolve(process.cwd(), 'dist');
  if (!fs.existsSync(distDir)) {
    log('no dist/ — skipping');
    return;
  }
  // Serve via raw.githubusercontent, NOT jsDelivr: jsDelivr returns 502 trying
  // to package the cdn-assets orphan branch's large single commit (~168 MB /
  // 6000 files), whereas raw serves each file directly with the correct
  // Content-Type (image/webp, 200). og:image is crawler/social-fetched (sparse)
  // so raw's rate limits are acceptable here; it is NOT a general CDN.
  const cdnBase = `https://raw.githubusercontent.com/${REPO}/${sha}`;

  // Build rewrite + guard regexes per target. A target file is any path under
  // the url prefix ending in a known image extension (no quote/space/paren).
  const fileTail = "([^\"'\\s)?]+?\\.(?:webp|png|jpe?g|avif|svg))";
  const escOrigin = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const presentTargets = TARGETS.filter((t) => fs.existsSync(path.join(distDir, ...t.dir)));
  if (presentTargets.length === 0) {
    log('no offload target dirs present in dist — nothing to do');
    return;
  }

  // Precompile per-target regexes once (og:image refs live in EVERY page's
  // <head>, so no dir can be skipped — but a single pass over each file that
  // rewrites AND verifies in-memory avoids a second filesystem scan).
  const compiled = presentTargets.map((t) => {
    const escUrl = t.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      t,
      reAbs: new RegExp(escOrigin + escUrl + fileTail, 'g'),
      reRel: new RegExp('(?<![\\w.@])' + escUrl + fileTail, 'g'),
      reLeak: new RegExp('(?:' + escOrigin + escUrl + '|(?<![\\w.@])' + escUrl + ')' + fileTail),
      repl: (_m, file) => `${cdnBase}${t.url}${file}`,
    };
  });

  let scanned = 0;
  let rewritten = 0;
  // Single pass: rewrite every target in the file, then verify the result
  // in-memory. GUARD — no surviving origin/relative ref to an offloaded path
  // may remain (it would 404 once the dir is deleted). On a leak, abort
  // WITHOUT deleting.
  const leaks = [];
  walk(distDir, (fp) => {
    scanned++;
    const orig = fs.readFileSync(fp, 'utf8');
    let out = orig;
    for (const c of compiled) out = out.replace(c.reAbs, c.repl).replace(c.reRel, c.repl);
    if (out !== orig) {
      fs.writeFileSync(fp, out);
      rewritten++;
    }
    for (const c of compiled) {
      if (c.reLeak.test(out)) leaks.push(`${c.t.url} in ${path.relative(distDir, fp)}`);
    }
  });
  if (leaks.length > 0) {
    log(`GUARD: ${leaks.length} unrewritten ref(s) survive — ABORTING offload (images kept in dist): ${leaks.slice(0, 5).join('; ')}`);
    return; // non-fatal: keep images, deploy proceeds
  }

  // Delete the offloaded dirs from dist.
  let freed = 0;
  for (const t of presentTargets) {
    const dir = path.join(distDir, ...t.dir);
    freed += dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log(`offloaded ${presentTargets.map((t) => t.url).join(' + ')} → ${cdnBase} ; rewrote ${rewritten}/${scanned} files ; freed ${(freed / 1048576).toFixed(0)} MB`);
}

try {
  main();
} catch (err) {
  // NON-FATAL: never break a deploy over an image-offload optimisation.
  console.log(`[offload-generated-cdn] error (non-fatal, images kept in dist): ${err && err.message ? err.message : err}`);
  process.exit(0);
}
