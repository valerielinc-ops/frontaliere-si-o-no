#!/usr/bin/env node
// offload-generated-images-cdn.mjs
//
// Offload BUILD-GENERATED assets out of the GitHub Pages artifact, rewriting
// their references to the dedicated CDN repo's Pages site (CDN_BASE). Two phases:
//   1. per-job OG cards (dist/og)  — rewrite static og:image refs in HTML
//   2. all data JSON/CSV (dist/data) — inject runtime CDN base AND rewrite static
//      same-origin /data/ refs (JSON-LD contentUrl, download hrefs) → CDN in HTML,
//      then delete every dist/data file present on the CDN. Only a /data/ ref that
//      survives same-origin (an XML-sitemap ref, or a ref to a file NOT in dist/data)
//      pins its file; robots.txt Allow/Disallow are crawl directives, not content
//      links, so they no longer pin (they kept 62 MB — incl. 55 MB expired-jobs.json
//      — in the artifact even though the bytes were already live on the CDN).
// (The JS/CSS bundle is offloaded separately: ASSET_CDN/renderBuiltUrl rebases it
//  at build time; the deploy verify step deletes dist/assets fail-safe.)
//
// (Blog 480w thumbnails ARE now offloaded: getResponsiveImageSet emits the CDN
// thumbnail URL at runtime — they have no same-origin refs — and the deploy
// pushes dist/images/blog/thumbnails to the CDN before this runs, so Phase 1's
// guarded delete frees ~49 MB. og:image refs ARE in static HTML so Phase 1
// rewrites them; job-detail JSON is runtime-fetched so Phase 2 injects a base.)
//
// Unlike the full blog hero images (git-tracked → served from jsDelivr@main by
// build-plugins/blogImageCdnFinalizePlugin), dist/og and dist/data/job-detail
// are generated at build time and are NOT in git. The deploy workflow first
// pushes both to the `frontaliere-cdn` repo (its own GitHub Pages site, Fastly
// edge, `access-control-allow-origin: *`, correct Content-Type, STABLE URLs) and
// exports its base URL as CDN_BASE; this script then, per phase:
//   • Phase 1 (og): rewrites the emitted og:image references in dist HTML to
//     ${CDN_BASE}/og/…, then deletes dist/og.
//   • Phase 2 (data): injects window.__CDN_DATA_BASE__=${CDN_BASE} into every dist
//     HTML page (read by services/cdnDataBase.ts → cdnDataUrl at runtime) AND
//     rewrites static same-origin /data/<file> refs → ${CDN_BASE}/data/<file>, then
//     deletes the now-CDN-served dist/data files.
//
// Pages (NOT raw / NOT jsDelivr): raw is rate-limited and serves JSON as
// text/plain; jsDelivr 403/502s on fresh orphan refs. The CDN repo's Pages site
// is a real Fastly-backed CDN, so it has neither problem.
//
// SAFETY — BEST-EFFORT / NON-FATAL: this runs in the deploy critical path, so it
// must NEVER break a deploy. On a missing CDN_BASE, a guard leak, or ANY thrown
// error it leaves dist exactly as-is and exits 0 — the assets simply ship in the
// artifact as before (no reduction, no breakage). The deploy step that invokes
// it also uses continue-on-error.
//
// Mirrors the proven rewrite+guard logic of blogImageCdnFinalizePlugin.

import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://frontaliereticino.ch';
const SCAN_EXT = new Set(['.html', '.xml', '.txt']);

// Offload targets: [dist subdir, url path prefix]. Only these prefixes are
// rewritten/guarded/deleted.
//
// Per-job OG cards + blog 480w thumbnails.
//  • OG refs (`<meta property="og:image">`) are in static HTML so the rewrite
//    below catches every one and the leak guard can verify it.
//  • Blog 480w thumbnails: getResponsiveImageSet (components/community/
//    BlogArticles.tsx) now emits the CDN thumbnail URL at runtime (the hero is
//    already a cdn.frontaliereticino.ch URL via cdnBlogImage), so the SPA fetches
//    thumbnails from the CDN, NOT same-origin; and there are ZERO same-origin
//    `/images/blog/thumbnails/` refs in static HTML. The deploy pushes
//    dist/images/blog/thumbnails to the CDN BEFORE this runs, so the guarded
//    delete just frees ~49 MB. The same-origin leak guard still protects the dir:
//    if any `/images/blog/thumbnails/` ref unexpectedly survives in HTML, the dir
//    is KEPT (non-fatal) — no 404. (Places thumbnails under /images/places/ are
//    NOT offloaded: they stay same-origin, not pushed to the CDN.)
const TARGETS = [
  { dir: ['og'], url: '/og/' },
  { dir: ['images', 'blog', 'thumbnails'], url: '/images/blog/thumbnails/' },
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

// File-tail patterns (capture group 1 = the relative path under the prefix).
const OG_FILE = "([^\"'\\s)?]+?\\.(?:webp|png|jpe?g|avif|svg))";
const ASSET_FILE = "([^\"'\\s)?]+?\\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico|json))";
const DATA_FILE = "([^\"'\\s)?<>]+?\\.(?:json|csv))";

// ── Single-pass offload over dist HTML/XML/TXT ───────────────────────────────
// Reads each emitted HTML/XML/TXT file ONCE and applies every CDN rewrite +
// scan, instead of walking the (huge) dist tree four times (was ~19 min → ~5 min):
//   1. OG cards: rewrite `…/og/<img>` refs → ${CDN}/og/… (+ leak guard).
//   2. Bundler/boot assets: rewrite same-origin `/assets/<file>` → ${CDN}/assets/…
//      (entry tags, modulepreload, boot <script>s incl. the AdSense loader, CSS
//      links). renderBuiltUrl already rebased the bundler-INTERNAL refs (JS chunk
//      imports, CSS url()). dist/assets is deleted later by the deploy verify step.
//   3. Data base inject: insert `<script>window.__CDN_DATA_BASE__="<CDN>"</script>`
//      after <head> so cdnDataUrl() resolves runtime /data/ fetches to the CDN.
//   4. Collect every literal same-origin /data/ ref (sitemap/href) so those files
//      stay same-origin (kept), while cdn-only data files are deleted.
// Then the guarded deletes (og dirs if no leak; cdn-only dist/data files).
function offloadAll(distDir, cdnBase) {
  const escOrigin = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // og rewrite/guard regexes per present target dir.
  const ogTargets = TARGETS.filter((t) => fs.existsSync(path.join(distDir, ...t.dir)));
  const ogCompiled = ogTargets.map((t) => {
    const escUrl = t.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      t,
      reAbs: new RegExp(escOrigin + escUrl + OG_FILE, 'g'),
      reRel: new RegExp('(?<![\\w.@])' + escUrl + OG_FILE, 'g'),
      reLeak: new RegExp('(?:' + escOrigin + escUrl + '|(?<![\\w.@])' + escUrl + ')' + OG_FILE),
      repl: (_m, file) => `${cdnBase}${t.url}${file}`,
    };
  });

  // assets rewrite regexes.
  const assetReAbs = new RegExp(escOrigin + '/assets/' + ASSET_FILE, 'g');
  // site-relative /assets/, NOT preceded by a word char (so an already-absolute
  // CDN URL `…cdn.frontaliereticino.ch/assets/…` — preceded by `h` — is skipped).
  const assetReRel = new RegExp('(?<![\\w.@])/assets/' + ASSET_FILE, 'g');
  const assetRepl = (_m, file) => `${cdnBase}/assets/${file}`;

  // data inject + ref-collect + same-origin→CDN rewrite setup.
  const dataDir = path.join(distDir, 'data');
  const hasData = fs.existsSync(dataDir);
  const injectTag = `<script>window.__CDN_DATA_BASE__=${JSON.stringify(cdnBase)}</script>`;
  // Every file present under dist/data was already pushed to the CDN repo (deploy
  // `cp -r dist/data` runs BEFORE this script), so a same-origin `/data/<rel>`
  // content ref to one of them can be rewritten to ${CDN}/data/<rel> and the file
  // dropped from the artifact. #1293 already wired the runtime fetches through
  // cdnDataUrl + the CDN push, but the keep-guard still pinned these files in dist
  // via their STATIC refs — JSON-LD `contentUrl`, `<a download href>` — and via
  // robots.txt Allow/Disallow (crawl directives, NOT content links). Both kept the
  // 62 MB of data JSON/CSV (expired-jobs.json alone is 55 MB) in the 10 GB artifact.
  const distDataRel = new Set();
  if (hasData) walkAll(dataDir, (fp) => {
    distDataRel.add('/' + path.relative(distDir, fp).split(path.sep).join('/'));
  });
  // Rewrite same-origin /data/<file> → ${CDN}/data/<file> for files present in
  // dist/data. Only the file part is captured; the replacer no-ops for refs whose
  // target is NOT in dist/data (e.g. /data/jobs.json stripped pre-deploy) so they
  // stay same-origin exactly as before.
  const dataReAbs = new RegExp(escOrigin + '/data/' + DATA_FILE, 'g');
  const dataReRel = new RegExp('(?<![\\w.@])/data/' + DATA_FILE, 'g');
  const dataRepl = (m, file) => (distDataRel.has('/data/' + file) ? `${cdnBase}/data/${file}` : m);
  // Same-origin keep-collector: matches the origin-absolute or site-relative form,
  // NOT the rewritten CDN host (preceded by a word char). A ref surviving here
  // points at a file NOT in dist/data → keep that file same-origin.
  const reDataKeep = new RegExp('(?:' + escOrigin + '/data/|(?<![\\w.@])/data/)' + DATA_FILE, 'g');
  const dataReferenced = new Set();

  let scanned = 0;
  let ogRewritten = 0;
  let assetRewritten = 0;
  let dataRefRewritten = 0;
  let injected = 0;
  let htmlSeen = 0;
  const ogLeaks = [];

  walk(distDir, (fp) => {
    scanned++;
    const orig = fs.readFileSync(fp, 'utf8');
    let out = orig;
    const isHtml = path.extname(fp) === '.html';

    // (1) og rewrites
    let ogChanged = false;
    for (const c of ogCompiled) {
      const before = out;
      out = out.replace(c.reAbs, c.repl).replace(c.reRel, c.repl);
      if (out !== before) ogChanged = true;
    }
    if (ogChanged) ogRewritten++;

    // (2) assets rewrites
    const beforeAssets = out;
    out = out.replace(assetReAbs, assetRepl).replace(assetReRel, assetRepl);
    if (out !== beforeAssets) assetRewritten++;

    // (2b) data refs: rewrite same-origin /data/<file> (present in dist/data) → CDN
    //      in HTML ONLY (JSON-LD contentUrl + download hrefs). XML sitemap refs are
    //      left untouched (pinned below, kept same-origin); robots.txt is skipped.
    const isTxt = path.extname(fp) === '.txt';
    if (hasData && isHtml) {
      const beforeData = out;
      out = out.replace(dataReAbs, dataRepl).replace(dataReRel, dataRepl);
      if (out !== beforeData) dataRefRewritten++;
    }

    // (3) data base inject (HTML only, idempotent)
    if (hasData && isHtml) {
      htmlSeen++;
      if (out.includes('__CDN_DATA_BASE__')) {
        injected++; // already present (idempotent re-run)
      } else {
        const m = out.match(/<head[^>]*>/i);
        if (m) {
          const at = m.index + m[0].length;
          out = out.slice(0, at) + injectTag + out.slice(at);
          injected++;
        }
        // no <head>: leave it (its SPA fetch degrades gracefully)
      }
    }

    if (out !== orig) fs.writeFileSync(fp, out);

    // og leak guard (no surviving same-origin og ref may remain post-rewrite)
    for (const c of ogCompiled) {
      if (c.reLeak.test(out)) ogLeaks.push(`${c.t.url} in ${path.relative(distDir, fp)}`);
    }

    // (4) collect surviving same-origin /data/ refs from HTML/XML — NOT robots
    //     .txt (Allow/Disallow are crawl directives, not content links; a rule on a
    //     now-CDN-served path is inert). A ref surviving here (HTML refs to dist/data
    //     files were rewritten to CDN above; XML refs are never rewritten) points at
    //     a file NOT in dist/data → keep it same-origin to avoid a 404.
    if (hasData && !isTxt) {
      reDataKeep.lastIndex = 0;
      let m;
      while ((m = reDataKeep.exec(out))) dataReferenced.add(decodeURIComponent('/data/' + m[1].split('?')[0]));
    }
  });

  // ── Guarded deletes ──
  // og: delete the offloaded dirs unless a same-origin ref survived (would 404).
  if (ogTargets.length > 0) {
    if (ogLeaks.length > 0) {
      log(`GUARD: ${ogLeaks.length} unrewritten og ref(s) survive — keeping og in dist (non-fatal): ${ogLeaks.slice(0, 5).join('; ')}`);
    } else {
      let freed = 0;
      for (const t of ogTargets) {
        const dir = path.join(distDir, ...t.dir);
        freed += dirSize(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      log(`offloaded ${ogTargets.map((t) => t.url).join(' + ')} → ${cdnBase} ; rewrote ${ogRewritten} files ; freed ${(freed / 1048576).toFixed(0)} MB`);
    }
  } else {
    log('no OG offload target dirs present — skipping og delete');
  }

  // data: delete cdn-only files, keep any /data/ path referenced same-origin in HTML.
  if (!hasData) {
    log('no dist/data — skipping data delete');
  } else if (injected === 0) {
    log(`GUARD: data base injected into 0/${htmlSeen} HTML pages — keeping dist/data`);
  } else {
    let freed = 0;
    let removed = 0;
    let kept = 0;
    walkAll(dataDir, (fp) => {
      const rel = '/' + path.relative(distDir, fp).split(path.sep).join('/'); // /data/…
      if (dataReferenced.has(rel)) { kept++; return; }
      freed += fs.statSync(fp).size;
      fs.rmSync(fp, { force: true });
      removed++;
    });
    log(`data → ${cdnBase} ; injected base into ${injected}/${htmlSeen} HTML ; rewrote /data/ refs in ${dataRefRewritten} HTML ; removed ${removed} files (kept ${kept} still-same-origin) ; freed ${(freed / 1048576).toFixed(0)} MB`);
  }

  log(`single-pass offload over ${scanned} HTML/XML/TXT files ; assets: rewrote /assets/ refs in ${assetRewritten} (dist/assets dropped by the deploy verify step)`);
}

function main() {
  // CDN_BASE is the full origin+path of the CDN repo's GitHub Pages site
  // (e.g. https://valerielinc-ops.github.io/frontaliere-cdn), exported by the
  // deploy step only after the assets were successfully pushed there. Pages
  // serves every file via Fastly with the correct Content-Type (application/json,
  // image/webp) and `access-control-allow-origin: *`, with STABLE URLs (no SHA
  // pin) — a real CDN, unlike raw (rate-limited, JSON as text/plain) or jsDelivr
  // (403/502 on fresh orphan refs). Main-tracked assets like blog heroes still
  // use jsDelivr@main separately.
  const cdnBase = (process.env.CDN_BASE || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/\S+$/.test(cdnBase)) {
    log(`no valid CDN_BASE (got "${cdnBase}") — skipping offload, assets stay in dist`);
    return;
  }
  const distDir = path.resolve(process.cwd(), 'dist');
  if (!fs.existsSync(distDir)) {
    log('no dist/ — skipping');
    return;
  }

  offloadAll(distDir, cdnBase);
}

try {
  main();
} catch (err) {
  // NON-FATAL: never break a deploy over an image-offload optimisation.
  console.log(`[offload-generated-cdn] error (non-fatal, images kept in dist): ${err && err.message ? err.message : err}`);
  process.exit(0);
}
