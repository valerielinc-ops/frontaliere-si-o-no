#!/usr/bin/env -S npx -y tsx
// publish-article-fast.mjs (#4837 stream A — near-instant single-article publish)
//
// Renders ONE blog article's static HTML for all 4 locales WITHOUT running the
// full `vite build` (~25-34 min, OOM-prone). Reuses the EXACT same functions
// the full build's closeBundle hooks call, in the same order, so the output is
// byte-identical to what a full build would emit for this one article (see
// scripts/check-article-byte-identity.mjs). Do NOT reimplement any transform
// here — import + call the shared function; a fork would silently drift the
// fast path and the full build apart.
//
// CLI:
//   npx -y tsx scripts/publish-article-fast.mjs --id <articleId> --section <frontaliere|svizzera> --out <scratchDistDir> --summary <summaryJsonPath>
//
// Pipeline (mirrors postWalkCoordinatorPlugin.ts's real per-file order —
// see build-plugins/postWalkWorker.mjs for the production analogue):
//   1. renderArticlePages({onlyArticleId}) — 4 locale index.html (+ a
//      placeholder flat .html sibling, immediately replaced by step 2).
//   2. flat-redirect transform — buildFlatBridgeFromSibling() derives the
//      redirect-bridge sibling from the JUST-rendered index.html. Built from
//      the pre-postprocess content, exactly like ogPagesPlugin's own
//      full-build write loop and the doc-comment-endorsed direct-call use of
//      buildFlatBridgeFromSibling. This is provably byte-identical to
//      building it post-steps-3/4: the bridge only extracts <title> + OG/
//      description meta tags, neither of which steps 3 or 4 ever touch.
//   3. contextual links (index.html only) — injectContextualLinks(). Pure
//      function of (html, locale); no cross-article state, so a single
//      article renders identically whether run standalone or in the full
//      walk. Never applied to the flat bridge (matches
//      blogContextualLinksPlugin's own "persist only to the directory form"
//      contract).
//   4. hreflang postprocess — transformHreflang() strips any alternate whose
//      target file does not exist in distDir. All 4 locale index.html for
//      THIS article are already on disk by this point, so self-referencing
//      hreflang (the only kind an article page emits) always resolves.
//   5. hero-image CDN rewrite — rewriteBlogImageRefs() rewrites same-origin
//      `/images/blog/<file>` refs to the CDN URL. Applied to every written
//      file (index + bridge), matching blogImageCdnFinalizePlugin's
//      unconditional whole-dist walk in the full build.
//   6. scripts/offload-generated-images-cdn.mjs, unmodified, as a subprocess
//      (CDN_BASE=https://cdn.frontaliereticino.ch — the same value deploy.yml
//      exports for the en/de/fr shard runners, which process an analogously
//      pruned single-locale dist). Converts the hardcoded `/assets/...`
//      strings ogPagesPlugin's html() closure emits to CDN URLs (Rollup's
//      renderBuiltUrl never sees these — they are plain text, not asset
//      references) and injects window.__CDN_DATA_BASE__ for client-side
//      data/image fetches. The script's own TARGETS-existence gating makes it
//      safe to run against a near-empty scratch dist (confirmed: only the
//      guarded *delete* step is gated on a target dir physically existing —
//      the rewrite regexes run unconditionally, exactly the shard-dist case
//      the script's own comments already document).
//
// Writes a summary JSON describing what was rendered, for stream B
// (incremental shard push) and stream C (fast-publish workflow) to consume:
//   { id, section, shards: [{locale, subtree, paths, url}, ...], cdnUploads: [{local, key}, ...] }
//
// Known gap fixed here, not in the shared renderer: ogPagesPlugin's
// resolveImagePath() verifies a candidate hero image exists by checking
// fs.existsSync(distDir/<publicPath>) — true in a full build (Vite copies
// public/ into dist/ before closeBundle runs) but never true in a bare
// scratch --out dir. Without the images/ symlink below, EVERY article would
// silently resolve to DEFAULT_IMG here. See step 0.
//
// DANGER (learned the hard way while building this script — see git history
// for the incident): the images/ symlink is torn down again immediately
// after step 1, BEFORE step 6 runs. offload-generated-images-cdn.mjs deletes
// files under its TARGETS dirs (thumbnails/brands/insurers/…), and a symlink
// as an INTERMEDIATE path component is transparent to that delete — it
// deleted through distDir/images straight into the real public/images/*,
// wiping ~850MB of tracked files in this worktree (recovered via
// `git checkout -- public/images`, zero permanent loss, but never again:
// the symlink must not be alive while any subprocess may write/delete
// through distDir). Nothing after step 1 needs distDir/images to exist.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDN_BASE = 'https://cdn.frontaliereticino.ch';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') out.id = argv[++i];
    else if (a === '--section') out.section = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--summary') out.summary = argv[++i];
  }
  const missing = ['id', 'section', 'out', 'summary'].filter((k) => !out[k]);
  if (missing.length > 0) {
    console.error(`[publish-article-fast] missing required flag(s): ${missing.map((k) => `--${k}`).join(', ')}`);
    console.error('Usage: npx -y tsx scripts/publish-article-fast.mjs --id <articleId> --section <frontaliere|svizzera> --out <scratchDistDir> --summary <summaryJsonPath>');
    process.exit(1);
  }
  if (out.section !== 'frontaliere' && out.section !== 'svizzera') {
    console.error(`[publish-article-fast] --section must be "frontaliere" or "svizzera", got "${out.section}"`);
    process.exit(1);
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const distDir = path.resolve(args.out);
  fs.mkdirSync(distDir, { recursive: true });

  // build-plugins/constants.ts reads process.env.ASSET_CDN ONCE, at module
  // top-level evaluation (an IIFE, not a function call re-read per use), to
  // derive CDN_PRECONNECT_HINT (consumed by ogPagesPlugin.ts). deploy.yml's
  // build-locale job hardcodes ASSET_CDN: 'https://cdn.frontaliereticino.ch'
  // for every real deploy build (including the `it` shard whose vite build
  // renders this exact article HTML) — matching that here is required for
  // byte-identity, not optional config. Must be set BEFORE the first import
  // of ogPagesPlugin.ts/constants.ts below (module evaluation is cached —
  // setting it later would be a no-op on a second call in the same process,
  // and this script only ever does ONE render per invocation anyway).
  // Without this, CDN_PRECONNECT_HINT is empty at render time, ogPagesPlugin
  // never emits its own preconnect (normally placed right before the
  // blog-chunk preload links), and step 6's offload script — which DOES get
  // CDN_BASE below — then finds no existing same-origin preconnect to dedup
  // against and injects a redundant preconnect+dns-prefetch pair of its own
  // at the very top of <head> instead: a real, confirmed byte-identity
  // divergence from production (see scripts/check-article-byte-identity.mjs),
  // not a live-staleness artifact — verified by tracing both code paths and
  // reproducing the exact live vs. fast-path <head> diff.
  process.env.ASSET_CDN = CDN_BASE;

  // ogPagesPlugin.ts's formatHumanDate/formatHumanDateTime (the visible
  // "Pubblicato il ..." byline + article:published_time meta) parse an
  // explicit-offset ISO string (normalizeDateTime appends "+01:00" to a
  // bare YYYY-MM-DD) with `new Date(...)`, then read the calendar day via
  // LOCAL accessors (`d.getDate()`/`getMonth()`/`getFullYear()`) — not
  // `getUTC*()`. For a midnight-CET date this instant is 23:00 the PRIOR day
  // in UTC, so the displayed day depends on the executing process's system
  // timezone: a UTC-TZ process (GitHub Actions runners — confirmed via
  // production still showing the pre-fix day for this exact article) prints
  // one calendar day EARLIER than a CET/CEST-TZ process (e.g. this
  // developer machine). This is a genuine PRE-EXISTING latent bug in the
  // shared renderer (present in the full build too, dormant only because CI
  // always runs in UTC) — out of scope to fix here (it is shared code used
  // by every SSG plugin's date formatting, not something owned by this
  // stream). Pinning TZ=UTC makes THIS script's output match what the real
  // deploy build produces regardless of the invoking machine's timezone,
  // without touching ogPagesPlugin.ts. Must be set before the dynamic
  // import below (Node reads TZ once, at startup/first Date use).
  process.env.TZ = 'UTC';

  // ── Step 0: make public/images visible to resolveImagePath's existence
  // checks (see the "Known gap" note in the file header). Symlink, not copy
  // — ~3.5k files, no need to duplicate them per invocation. Torn down again
  // right after step 1 — see the DANGER note above for why its lifetime must
  // stay confined to the renderArticlePages call only.
  const scratchImagesLink = path.join(distDir, 'images');
  try {
    fs.symlinkSync(path.join(ROOT_DIR, 'public', 'images'), scratchImagesLink, 'dir');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // ── Step 1: render the 4 locale pages (Deliverables 1+2, #4837 stream A) ──
  const { renderArticlePages } = await import('../build-plugins/ogPagesPlugin.ts');
  const { written, entries } = await renderArticlePages({
    rootDir: ROOT_DIR,
    distDir,
    section: args.section,
    onlyArticleId: args.id,
  });

  // Remove the symlink itself (unlink — the final path component IS the
  // symlink, so this never follows it into public/images). Must happen
  // before any of steps 2-6, none of which need distDir/images to exist.
  fs.rmSync(scratchImagesLink, { force: true });

  if (entries.length === 0) {
    console.error(
      `[publish-article-fast] article id "${args.id}" not found in section "${args.section}" — check --id/--section`,
    );
    process.exit(1);
  }
  const entry = entries[0];

  // ── Steps 2-5: flat-redirect -> contextual links -> hreflang -> hero-image CDN ──
  const { buildFlatBridgeFromSibling } = await import('../build-plugins/flatHtmlRedirectPlugin.ts');
  const { injectContextualLinks } = await import('../build-plugins/blogContextualLinksPlugin.ts');
  const { transformHreflang } = await import('../build-plugins/hreflangPostprocessPlugin.ts');
  const { rewriteBlogImageRefs } = await import('../build-plugins/blogImageCdnFinalizePlugin.ts');
  const { BASE_URL } = await import('../build-plugins/constants.ts');

  const locales = ['it', 'en', 'de', 'fr'];
  for (const locale of locales) {
    const indexRel = entry.paths[locale];
    const flatRel = entry.flatPaths[locale];
    if (!indexRel || !flatRel) continue; // locale not rendered (defensive — both sections render all 4)

    const indexAbs = path.join(distDir, indexRel);
    const flatAbs = path.join(distDir, flatRel);
    const slashUrl = entry.urls[locale];

    const freshIndexHtml = fs.readFileSync(indexAbs, 'utf-8');

    // 2. flat-redirect transform (built from the fresh, pre-postprocess content)
    const bridgeHtml = buildFlatBridgeFromSibling(freshIndexHtml, slashUrl);

    // 3. contextual links (index.html only)
    const linked = injectContextualLinks(freshIndexHtml, locale);
    let indexHtml = linked.html;

    // 4. hreflang postprocess — all 4 locale index.html for this article
    // already exist in distDir, so existsCheck can hit the real filesystem.
    const hreflangResult = transformHreflang(indexHtml, distDir, BASE_URL, (absPath) => fs.existsSync(absPath));
    if (hreflangResult) indexHtml = hreflangResult.html;

    // 5. hero-image CDN rewrite — applied to both files, matching
    // blogImageCdnFinalizePlugin's unconditional whole-dist walk.
    indexHtml = rewriteBlogImageRefs(indexHtml);
    const finalBridgeHtml = rewriteBlogImageRefs(bridgeHtml);

    fs.writeFileSync(indexAbs, indexHtml, 'utf-8');
    fs.writeFileSync(flatAbs, finalBridgeHtml, 'utf-8');
  }

  // ── Step 6: offload-generated-images-cdn.mjs, unmodified, via subprocess ──
  // The script hardcodes distDir = path.resolve(process.cwd(), 'dist'), so we
  // spawn it with cwd = a temp dir containing a `dist` symlink to our real
  // scratch --out dir — the same trick, not a fork of its logic.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-article-fast-'));
  try {
    fs.symlinkSync(distDir, path.join(tmpDir, 'dist'), 'dir');
    const offloadScript = path.join(ROOT_DIR, 'scripts', 'offload-generated-images-cdn.mjs');
    const result = spawnSync(process.execPath, [offloadScript], {
      cwd: tmpDir,
      env: { ...process.env, CDN_BASE },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(
        `[publish-article-fast] offload-generated-images-cdn.mjs exited ${result.status} — ` +
          'unexpected (the script catches its own errors and always exits 0); dist left as rendered pre-offload',
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── Summary JSON for stream B (shard push) / stream C (workflow) ──
  const sectionShardKey = args.section === 'frontaliere' ? 'articolifrontaliere' : 'articolisvizzera';
  const shardSlugs = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'lib', 'section-shard-slugs.json'), 'utf-8'),
  );
  const slugMap = shardSlugs[sectionShardKey];

  // subtree convention matches scripts/lib/section-shard-slugs.json's own
  // documented formula: it -> <slug>, en/de/fr -> <loc>/<slug>.
  const shards = locales.map((locale) => ({
    locale,
    subtree: locale === 'it' ? slugMap.it : `${locale}/${slugMap[locale]}`,
    paths: [entry.paths[locale], entry.flatPaths[locale]],
    url: entry.urls[locale],
  }));

  // Derive cdnUploads from entry.img's ACTUAL resolved directory — NOT a
  // hardcoded `images/blog/`. resolveImagePath() (ogPagesPlugin.ts) resolves
  // most articles to a per-article /images/blog/<slug>.<ext> hero, but a
  // meaningful minority (47/3018 in data/blog-articles-data.ts, e.g. the
  // shared `lugano-view.webp` stock photo used by 11 articles) resolve to a
  // shared generic photo under /images/places/<name>.<ext> instead. Both
  // directories follow the same `thumbnails/<basename>-480w.webp` sibling
  // convention (confirmed: public/images/places/thumbnails/ exists with the
  // same naming as public/images/blog/thumbnails/). Hardcoding `images/blog/`
  // here would emit a nonexistent local path for every places/-resolved
  // article, breaking stream B/C's CDN push. DEFAULT_IMG ('/og-image.png',
  // last-resort fallback, not under images/) has no thumbnail and is already
  // a static site asset — never listed here.
  const heroImgRel = entry.img.replace(/^\/+/, ''); // e.g. "images/blog/foo.webp" | "images/places/lugano-view.webp"
  const heroDir = path.dirname(heroImgRel); // e.g. "images/blog" | "images/places"
  const cdnUploads = [];
  if (heroDir.startsWith('images/') || heroDir === 'images') {
    const heroExt = path.extname(heroImgRel) || '.webp';
    const heroBase = path.basename(heroImgRel, heroExt);
    const heroLocal = path.join('public', heroDir, `${heroBase}${heroExt}`);
    const thumbLocal = path.join('public', heroDir, 'thumbnails', `${heroBase}-480w.webp`);
    if (fs.existsSync(path.join(ROOT_DIR, heroLocal))) {
      cdnUploads.push({ local: heroLocal, key: path.join(heroDir, `${heroBase}${heroExt}`) });
    } else {
      console.error(`[publish-article-fast] resolved hero "${heroLocal}" does not exist on disk — omitting from cdnUploads`);
    }
    if (fs.existsSync(path.join(ROOT_DIR, thumbLocal))) {
      cdnUploads.push({ local: thumbLocal, key: path.join(heroDir, 'thumbnails', `${heroBase}-480w.webp`) });
    } else {
      console.error(`[publish-article-fast] expected thumbnail "${thumbLocal}" does not exist on disk — omitting from cdnUploads`);
    }
  }

  const summary = { id: args.id, section: args.section, shards, cdnUploads };
  const summaryPath = path.resolve(args.summary);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  const wallMs = Date.now() - t0;
  console.log(
    `[publish-article-fast] done — id=${args.id} section=${args.section} wrote=${written} files, wall=${(wallMs / 1000).toFixed(1)}s`,
  );
  console.log(`[publish-article-fast] summary written to ${summaryPath}`);
}

main().catch((err) => {
  console.error('[publish-article-fast] fatal error:', err);
  process.exit(1);
});
