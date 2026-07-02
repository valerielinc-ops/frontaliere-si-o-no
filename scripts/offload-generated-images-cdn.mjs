#!/usr/bin/env node
// offload-generated-images-cdn.mjs
//
// Offload BUILD-GENERATED assets out of the GitHub Pages artifact, rewriting
// their references to the dedicated CDN repo's Pages site (CDN_BASE). Three phases:
//   1. per-job OG cards (dist/og)  — rewrite static og:image refs in HTML
//   2. all data JSON/CSV (dist/data) — inject runtime CDN base AND rewrite static
//      same-origin /data/ refs (JSON-LD contentUrl, download hrefs) → CDN in HTML,
//      then delete every dist/data file present on the CDN. Only a /data/ ref that
//      survives same-origin (an XML-sitemap ref, or a ref to a file NOT in dist/data)
//      pins its file; robots.txt Allow/Disallow are crawl directives, not content
//      links, so they no longer pin (they kept 62 MB — incl. 55 MB expired-jobs.json
//      — in the artifact even though the bytes were already live on the CDN).
//   3. job-canon canton-drift 404-recovery shard map (dist/job-canon) — no static
//      HTML ref exists at all (public/404.html and the Worker both fetch it via a
//      CDN-absolute URL hardcoded at the consumer, not a runtime-injected base), so
//      this phase is a plain guarded delete once the CDN push has staged it.
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
//     HTML page — read at runtime by BOTH cdnDataUrl (services/cdnDataBase.ts) and
//     cdnImageUrl (services/cdnImageBase.ts, for the offloaded brand/logo images),
//     so the inject is unconditional whenever CDN_BASE is valid (NOT gated on
//     dist/data presence, #1709) — AND rewrites static same-origin /data/<file>
//     refs → ${CDN_BASE}/data/<file>, then deletes the now-CDN-served dist/data files.
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
import { ASSETS_SAME_ORIGIN_RX } from '../build-plugins/shared/cdnAssetOffloadRx.mjs';

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
//  • Self-hosted brand/logo/author images (`/images/{brands,insurers,providers,
//    logos,authors,publisher}/`): static SSG HTML references them (job cards,
//    employer cards, fuel pages, JSON-LD publisher/company logo) AND the SPA does
//    at runtime (resolveCompanyLogoUrl, getProviderLogoUrl, ProviderLogo,
//    FuelPriceStats, author photos). The SPA emits the CDN URL at render time via
//    services/cdnImageBase.ts cdnImageUrl() (reads window.__CDN_DATA_BASE__), and
//    the rewrite below catches every same-origin ref in static HTML. The deploy
//    pushes public/images/{brands,…} to ${CDN}/images/{brands,…} BEFORE this runs.
//    Per-target leak guard: if any same-origin `/images/<prefix>/…` ref survives
//    in static HTML post-rewrite, that dir is KEPT in dist (non-fatal — no 404).
//    `/images/places/` is NOT here: it stays same-origin (blog hero places), not
//    pushed to the CDN. (MUST stay in sync with CDN_OFFLOADED_IMAGE_PREFIXES in
//    services/cdnImageBase.ts and the deploy.yml CDN-push staging step.)
const TARGETS = [
  { dir: ['og'], url: '/og/' },
  { dir: ['images', 'blog', 'thumbnails'], url: '/images/blog/thumbnails/' },
  { dir: ['images', 'brands'], url: '/images/brands/' },
  { dir: ['images', 'insurers'], url: '/images/insurers/' },
  { dir: ['images', 'providers'], url: '/images/providers/' },
  { dir: ['images', 'logos'], url: '/images/logos/' },
  { dir: ['images', 'authors'], url: '/images/authors/' },
  { dir: ['images', 'publisher'], url: '/images/publisher/' },
  // Nationwide events feature (issue #3125): no-hotlink mirrored source images
  // (scripts/lib/events-utils.mjs mirrorEventImage -> public/images/events/).
  // MUST stay in sync with CDN_OFFLOADED_IMAGE_PREFIXES in
  // services/cdnImageBase.ts, the deploy-it-pages-prep.sh CDN-push staging
  // loop, and ensure-image-cdn-redirect.mjs OFFLOADED_PREFIXES.
  { dir: ['images', 'events'], url: '/images/events/' },
];

function log(msg) {
  console.log(`[offload-generated-cdn] ${msg}`);
}

function walk(dir, fn, root = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip ONLY the TOP-LEVEL dist/{assets,data,images} (vite JS/CSS/fonts,
      // *.json offload payloads, binary art — none carry the .html/.xml/.txt in
      // SCAN_EXT). dist/data alone is ~1.04M dirs, so descending it stat-walked
      // the whole tree for zero rewrites. We gate on `dir === root` (the initial
      // dist dir) so a NESTED dir that merely shares the name — a content slug
      // such as dist/en/data/ — is STILL walked: its *.html must be seen so the
      // same-origin /assets/ marker we emit (read by the deploy "Drop dist/assets"
      // step) stays a faithful ANY-DEPTH superset of that step's old full-tree
      // grep. Top-level-only here, unlike postWalk/blogImageCdn which skip by
      // name at any depth — those are fail-safe (leak-guard / coordinator), but
      // this pass's marker is the Drop step's delete authority so it must not
      // miss a nested content page. The data-delete pass below uses the separate
      // walkAll(), so top-level dist/data is still fully enumerated for cleanup.
      if (dir === root && (e.name === 'assets' || e.name === 'data' || e.name === 'images')) continue;
      walk(fp, fn, root);
    } else if (SCAN_EXT.has(path.extname(e.name))) fn(fp);
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
// OG_FILE covers og cards AND the brand/logo/author image TARGETS, so its
// extension set spans every image type those dirs hold (incl. .ico/.gif).
const OG_FILE = "([^\"'\\s)?]+?\\.(?:webp|png|jpe?g|avif|svg|ico|gif))";
const ASSET_FILE = "([^\"'\\s)?]+?\\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico|json))";
// Guard-B parity: the SUPERSET regex the deploy "Drop dist/assets" step greps
// for, kept 1:1 with its bash ERE. A same-origin /assets/<file>.<ext> ref that
// SURVIVES the rewrite below (e.g. a custom SSG path that didn't go through
// ASSET_FILE) must KEEP dist/assets — exactly that step's Guard B. Non-global
// (stateless .test); applied to HTML only at the callsite to match grep's
// --include='*.html'. Since walk() above is now top-level-only, this marker sees
// every content *.html at any depth, so it is the authoritative gate (the Drop
// step reads our marker), kept byte-faithful to the old grep.
// SINGLE SOURCE OF TRUTH (no copy-paste, AGENTS.md #6): ASSETS_SAME_ORIGIN_RX is
// imported from build-plugins/shared/cdnAssetOffloadRx.mjs, which ALSO exports the
// matching bash ERE (ASSETS_SAME_ORIGIN_ERE) consumed by the deploy "Drop dist/assets"
// step — so the marker producer and the workflow grep can never drift (a divergence
// would 404 offloaded /assets/ refs). See that module's header.
const DATA_FILE = "([^\"'\\s)?<>]+?\\.(?:json|csv))";

// ── Single-pass offload over dist HTML/XML/TXT ───────────────────────────────
// Reads each emitted HTML/XML/TXT file ONCE and applies every CDN rewrite +
// scan, instead of walking the (huge) dist tree four times (was ~19 min → ~5 min):
//   1. OG cards: rewrite `…/og/<img>` refs → ${CDN}/og/… (+ leak guard).
//   2. Bundler/boot assets: rewrite same-origin `/assets/<file>` → ${CDN}/assets/…
//      (entry tags, modulepreload, boot <script>s incl. the AdSense loader, CSS
//      links). renderBuiltUrl already rebased the bundler-INTERNAL refs (JS chunk
//      imports, CSS url()). dist/assets is deleted later by the deploy verify step.
//   3. Data base inject: insert a `<link rel="preconnect">` (+ dns-prefetch) to the
//      CDN host followed by `<script>window.__CDN_DATA_BASE__="<CDN>"</script>`
//      after <head>, so the cross-origin connection is warm before cdnDataUrl()/
//      cdnImageUrl() issue the first runtime /data/ or image fetch to the CDN.
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

  // job-canon (canton-drift 404-recovery shard map): runtime-fetch only, via a
  // CDN-absolute URL hardcoded in public/404.html and the Worker — unlike
  // og/data/images there is NO static HTML ref to rewrite or guard (confirmed:
  // no `/job-canon/` literal exists in any dist HTML), so once the push to the
  // CDN repo succeeds, the dist copy is simply redundant and can be deleted.
  const jobCanonDir = path.join(distDir, 'job-canon');
  const hasJobCanon = fs.existsSync(jobCanonDir);
  // Escape `<` so the inline <script> can't be broken out of — same class as
  // build-plugins/shared/inlineJsonScript.ts (inlined here: this .mjs runs under
  // plain Node and can't import the TS helper). cdnBase is a controlled config
  // URL so the risk is low, but the class fix must be complete.
  // Resource hint: warm DNS+TLS to the data/image CDN host BEFORE the SPA issues
  // its first cross-origin fetch. The data CDN (CDN_BASE, e.g. valerielinc-ops
  // .github.io) is a DISTINCT host from both the origin (frontaliereticino.ch) and
  // the asset CDN (cdn.frontaliereticino.ch, already preconnected by asyncCssPlugin)
  // — so without this hint the first `/data/*.json` shard fetch (jobsService) AND
  // the first cdnImageUrl() logo/brand image (rendered on nearly every page) pay a
  // cold-connection RTT on the critical path, worst on mobile/high-RTT (~75% of
  // traffic). `crossorigin` (anonymous) is REQUIRED: the JSON/image fetches are
  // cross-origin with default `credentials:'same-origin'` → anonymous, and browsers
  // pool credentialed vs anonymous sockets separately, so a non-crossorigin
  // preconnect would NOT be reused. dns-prefetch is the legacy fallback. Origin only
  // (scheme+host) — preconnect ignores the path. Skipped if cdnBase is unparseable.
  let cdnOrigin = '';
  try { cdnOrigin = new URL(cdnBase).origin; } catch { cdnOrigin = ''; }
  const hintTags = cdnOrigin
    ? `<link rel="preconnect" href="${cdnOrigin}" crossorigin><link rel="dns-prefetch" href="${cdnOrigin}">`
    : '';
  const injectTag = `${hintTags}<script>window.__CDN_DATA_BASE__=${JSON.stringify(cdnBase).replace(/</g, '\\u003c')}</script>`;
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
  const assetsLeaks = [];

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
    // Guard-B parity: record any same-origin /assets/ ref that SURVIVES the
    // rewrite (HTML only — matches the Drop step's --include='*.html'). The data
    // rewrite + CDN-base inject below never touch /assets/ refs, so the set is
    // final here. The deploy Drop step keeps dist/assets iff this list is non-empty.
    if (isHtml && ASSETS_SAME_ORIGIN_RX.test(out)) assetsLeaks.push(path.relative(distDir, fp));

    // (2b) data refs: rewrite same-origin /data/<file> (present in dist/data) → CDN
    //      in HTML ONLY (JSON-LD contentUrl + download hrefs). XML sitemap refs are
    //      left untouched (pinned below, kept same-origin); robots.txt is skipped.
    const isTxt = path.extname(fp) === '.txt';
    if (hasData && isHtml) {
      const beforeData = out;
      out = out.replace(dataReAbs, dataRepl).replace(dataReRel, dataRepl);
      if (out !== beforeData) dataRefRewritten++;
    }

    // (3) CDN-base inject (HTML only, idempotent). Decoupled from `hasData`
    //     (#1709): window.__CDN_DATA_BASE__ is read by BOTH cdnDataUrl (data
    //     offload) AND cdnImageUrl (the brand/logo/author/provider/insurer images
    //     this script also offloads + deletes from dist). Gating the inject on
    //     hasData meant a deploy with no dist/data would still delete the image
    //     dirs yet never set the base → runtime cdnImageUrl() falls back to the
    //     just-deleted same-origin path → 404 on every SPA logo. The base must be
    //     present whenever cdnBase is valid (this script only runs then).
    if (isHtml) {
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

  // Emit the same-origin /assets/ verdict so the deploy "Drop dist/assets" step
  // can SKIP its redundant full-tree grep (it reads this marker, and falls back
  // to the grep if the marker is absent — e.g. this script crashed mid-walk).
  // walk() is top-level-only, so this covers every content *.html at ANY depth;
  // the Drop step still belt-greps the top-level dist/{assets,data,images} for
  // the last gap. ASSETS_SAME_ORIGIN_RX is the single source of truth. CI-only
  // (RUNNER_TEMP set); local runs skip it (the workflow's grep fallback covers it).
  const runnerTmp = process.env.RUNNER_TEMP;
  if (runnerTmp) {
    const markerPath = path.join(runnerTmp, 'assets-same-origin.marker');
    if (assetsLeaks.length > 0) {
      fs.writeFileSync(markerPath, 'LEAK\n' + assetsLeaks.join('\n') + '\n');
      log(`assets guard: ${assetsLeaks.length} same-origin /assets/ ref(s) survive in HTML — Drop step will KEEP dist/assets (e.g. ${assetsLeaks.slice(0, 3).join(', ')})`);
    } else {
      fs.writeFileSync(markerPath, 'CLEAN\n');
      log('assets guard: no same-origin /assets/ refs survive — Drop step may drop dist/assets');
    }
  }

  // ── Guarded deletes ──
  // og + thumbnails: delete each offloaded dir UNLESS a same-origin ref to THAT
  // target survived the rewrite (would 404). Per-target so a leak in one (e.g. a
  // stray /og/ ref) can't suppress deleting the other (e.g. the ~49MB thumbnails).
  if (ogTargets.length > 0) {
    let freed = 0;
    const deleted = [];
    const kept = [];
    for (const t of ogTargets) {
      const leaked = ogLeaks.filter((l) => l.startsWith(t.url));
      if (leaked.length > 0) {
        kept.push(`${t.url} (${leaked.length} ref(s): ${leaked.slice(0, 3).join('; ')})`);
        continue;
      }
      // #1709 safety net: the /images/* dirs are also resolved at RUNTIME via
      // cdnImageUrl (window.__CDN_DATA_BASE__). If the base reached no HTML page,
      // deleting them would 404 the SPA logos — keep them (mirrors the data-delete
      // `injected === 0` guard below). /og/ is static-ref-only (rewritten above),
      // so it's exempt. With the inject now decoupled from hasData this only fires
      // in the degenerate no-HTML-with-<head> case, but the guard makes the latent
      // 404 impossible by construction.
      if (t.url.startsWith('/images/') && injected === 0) {
        kept.push(`${t.url} (CDN base injected into 0/${htmlSeen} HTML — keeping to avoid runtime cdnImageUrl 404)`);
        continue;
      }
      const dir = path.join(distDir, ...t.dir);
      freed += dirSize(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      deleted.push(t.url);
    }
    if (deleted.length > 0) {
      log(`offloaded ${deleted.join(' + ')} → ${cdnBase} ; rewrote ${ogRewritten} files ; freed ${(freed / 1048576).toFixed(0)} MB`);
    }
    if (kept.length > 0) {
      log(`GUARD: unrewritten same-origin ref(s) survive — keeping in dist (non-fatal): ${kept.join(' | ')}`);
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

  // job-canon: no refs to check — the CDN push (deploy-it-pages-prep.sh
  // step_push_cdn) already staged it under the SAME payload as og/data before
  // this script runs, so its presence on the CDN is as certain as theirs.
  if (!hasJobCanon) {
    log('no dist/job-canon — skipping job-canon delete');
  } else {
    const freed = dirSize(jobCanonDir);
    fs.rmSync(jobCanonDir, { recursive: true, force: true });
    log(`job-canon → ${cdnBase} ; freed ${(freed / 1048576).toFixed(0)} MB`);
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
