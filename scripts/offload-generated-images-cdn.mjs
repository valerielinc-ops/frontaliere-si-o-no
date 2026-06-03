#!/usr/bin/env node
// offload-generated-images-cdn.mjs
//
// Offload BUILD-GENERATED assets from the GitHub Pages artifact to
// raw.githubusercontent, pinned to a cdn-assets commit SHA. Two phases:
//   1. per-job OG cards (dist/og)            — rewrite static og:image refs
//   2. per-job detail JSON (dist/data/job-detail) — inject runtime CDN base
// (raw, not jsDelivr: jsDelivr 403/502s on the fresh orphan ref — see cdnBase.)
//
// (Blog 480w thumbnails are NOT offloaded — their URLs are built at runtime in
// the JS bundle, not in HTML, so an HTML-only rewrite can't cover them; they
// stay same-origin. og:image refs ARE in static HTML so Phase 1 rewrites them;
// job-detail JSON is also runtime-fetched so Phase 2 injects a runtime base.)
//
// Unlike the full blog hero images (git-tracked → served from main@sha by
// build-plugins/blogImageCdnFinalizePlugin), dist/og and dist/data/job-detail
// are generated at build time and are NOT in git. The deploy workflow first
// force-pushes both to an orphan `cdn-assets` branch and passes that commit SHA
// as CDN_ASSETS_SHA; this script then, per phase:
//   • Phase 1 (og): rewrites the emitted og:image references in dist HTML to the
//     raw.githubusercontent URL, then deletes dist/og.
//   • Phase 2 (job-detail): injects window.__CDN_DATA_BASE__=<raw base> into
//     every dist HTML page (read by services/cdnDataBase.ts → cdnDataUrl at
//     runtime), then deletes dist/data/job-detail.
//
// SAFETY — BEST-EFFORT / NON-FATAL: this runs in the deploy critical path, so it
// must NEVER break a deploy. On a missing SHA, a guard leak, or ANY thrown
// error it leaves dist exactly as-is and exits 0 — the assets simply ship in the
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

// ── Phase 1: OG-card images (rewrite static og:image refs in HTML) ───────────
// og:image refs are emitted into static HTML, so an HTML rewrite catches every
// one and a guard can verify nothing leaks before the dir is deleted.
function offloadOgImages(distDir, cdnBase) {
  // Build rewrite + guard regexes per target. A target file is any path under
  // the url prefix ending in a known image extension (no quote/space/paren).
  const fileTail = "([^\"'\\s)?]+?\\.(?:webp|png|jpe?g|avif|svg))";
  const escOrigin = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const presentTargets = TARGETS.filter((t) => fs.existsSync(path.join(distDir, ...t.dir)));
  if (presentTargets.length === 0) {
    log('no OG offload target dirs present in dist — skipping image phase');
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
    log(`GUARD: ${leaks.length} unrewritten ref(s) survive — ABORTING image offload (images kept in dist): ${leaks.slice(0, 5).join('; ')}`);
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

// ── Phase 2: generated runtime-fetched data (per-job detail JSON) ─────────────
// dist/data/job-detail/<id>.json (~225 MB) is fetched on demand by the SPA
// (components/community/JobBoard.tsx → fetchJobDetail) using a URL built at
// RUNTIME in the JS bundle — it is NOT referenced in static HTML, so it cannot
// be rewritten like og:image. Instead we inject the CDN base as a global the
// fetch helper reads (services/cdnDataBase.ts → cdnDataUrl), then delete the dir.
//
// GRACEFUL DEGRADATION: the static SSG job pages already contain the full job
// content in HTML (crawler-visible SEO is unaffected). job-detail.json only
// enriches the hydrated SPA detail view, and fetchJobDetail() catches any
// failure → {} (no enrichment, page still renders). So a missed inject or a raw
// hiccup degrades the interactive detail view but never breaks a page or SEO.
const DATA_DIRS = [['data', 'job-detail']];

function offloadGeneratedData(distDir, cdnBase) {
  const present = DATA_DIRS.filter((d) => fs.existsSync(path.join(distDir, ...d)));
  if (present.length === 0) {
    log('no generated-data dirs present in dist — skipping data phase');
    return;
  }

  // Inject `<script>window.__CDN_DATA_BASE__="<cdnBase>"</script>` right after the
  // first <head> of every HTML page so the base is set before the SPA boots.
  // Idempotent (skip if already present). Runs only over .html (the SPA shell +
  // SSG pages — any of which can client-nav to a job detail).
  const injectTag = `<script>window.__CDN_DATA_BASE__=${JSON.stringify(cdnBase)}</script>`;
  let injected = 0;
  let htmlSeen = 0;
  walk(distDir, (fp) => {
    if (path.extname(fp) !== '.html') return;
    htmlSeen++;
    const html = fs.readFileSync(fp, 'utf8');
    if (html.includes('__CDN_DATA_BASE__')) { injected++; return; } // already done
    const m = html.match(/<head[^>]*>/i);
    if (!m) return; // no <head>: leave it (its SPA fetch degrades gracefully)
    const at = m.index + m[0].length;
    fs.writeFileSync(fp, html.slice(0, at) + injectTag + html.slice(at));
    injected++;
  });

  // Only delete if at least one page carries the base — otherwise every
  // job-detail fetch would 404 (still graceful, but pointless). If nothing was
  // injected, keep the data in dist.
  if (injected === 0) {
    log(`GUARD: base injected into 0/${htmlSeen} HTML pages — keeping data in dist`);
    return;
  }
  let freed = 0;
  for (const d of present) {
    const dir = path.join(distDir, ...d);
    freed += dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log(`offloaded ${present.map((d) => '/' + d.join('/') + '/').join(' + ')} → ${cdnBase} ; injected base into ${injected}/${htmlSeen} HTML ; freed ${(freed / 1048576).toFixed(0)} MB`);
}

function main() {
  const sha = (process.env.CDN_ASSETS_SHA || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    log(`no valid CDN_ASSETS_SHA (got "${sha}") — skipping offload, assets stay in dist`);
    return;
  }
  const distDir = path.resolve(process.cwd(), 'dist');
  if (!fs.existsSync(distDir)) {
    log('no dist/ — skipping');
    return;
  }
  // Serve via raw.githubusercontent, NOT jsDelivr: jsDelivr 403/502s on a fresh
  // orphan-branch ref ("Failed to fetch version info" — its per-repo version
  // refresh chokes on this giant repo for cold refs), whereas raw serves each
  // file directly with the correct Content-Type (image/webp; application/json
  // parses fine via fetch().json()) and CORS `*`. The offloaded assets are
  // sparse/per-session fetches so raw's rate limits are acceptable; it is NOT a
  // general CDN. (Main-tracked assets like blog heroes DO use jsDelivr@main.)
  const cdnBase = `https://raw.githubusercontent.com/${REPO}/${sha}`;

  offloadOgImages(distDir, cdnBase);
  offloadGeneratedData(distDir, cdnBase);
}

try {
  main();
} catch (err) {
  // NON-FATAL: never break a deploy over an image-offload optimisation.
  console.log(`[offload-generated-cdn] error (non-fatal, images kept in dist): ${err && err.message ? err.message : err}`);
  process.exit(0);
}
