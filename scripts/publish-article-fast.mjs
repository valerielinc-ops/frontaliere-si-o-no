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
//   6 / 6b / 7. renderHubsAndOffload() — the section's `/tutti/` archive +
//      pagination, then its `/…/argomenti/<topic>/` hubs, then the CDN
//      offload over everything written so far, in exactly that order
//      (issue #5270). All three now live in
//      scripts/lib/render-and-push-hubs.mjs, which is the ONLY place they are
//      implemented and the only place their order is expressed — see that
//      file's header for the full rationale of each step and for why
//      inverting them ships pages with 9 guaranteed-404 same-origin
//      `/assets/...` refs. Extracted there (issue #5432 point 2) so
//      scripts/rerender-article-hubs.mjs can re-render a section's hubs
//      without publishing an article, which is what gives a change to the hub
//      RENDERERS a way down to the served pages at all.
//
//      Steps 6/6b are deliberately NOT run through steps 2-5 above: those are
//      article-body specific (flat bridge, this article's own related-picks,
//      hero image) and do not apply to a listing page. The offload is the
//      opposite kind of pass — whole-dist, needed by every emitted page — so
//      it runs last, after the article pages have been post-processed.
//
// Writes a summary JSON describing what was rendered, for stream B
// (incremental shard push) and stream C (fast-publish workflow) to consume:
//   { id, section, shards: [{locale, subtree, paths, url}, ...],
//     cdnUploads: [{local, key}, ...], edgeFiles: [{pathname, distPath, urlCount}, ...] }
//   `paths` per shard = [article index.html, article flat bridge, ...that
//   locale's hub-archive pages from step 6, ...that locale's topic-hub pages
//   from step 6b].
//   `edgeFiles` = APEX artifacts, not shard ones: today just this section's
//   `sitemap-topics-<section>.xml`, written by step 6b from the very pages it
//   rendered. The workflow publishes it to R2 (EDGE_PUSHED_FILES) and commits
//   it into public/ so the next build's sitemap index names it.
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
// after step 1, BEFORE step 7 runs. offload-generated-images-cdn.mjs deletes
// files under its TARGETS dirs (thumbnails/brands/insurers/…), and a symlink
// as an INTERMEDIATE path component is transparent to that delete — it
// deleted through distDir/images straight into the real public/images/*,
// wiping ~850MB of tracked files in this worktree (recovered via
// `git checkout -- public/images`, zero permanent loss, but never again:
// the symlink must not be alive while any subprocess may write/delete
// through distDir). Nothing after step 1 needs distDir/images to exist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pinRenderEnv, renderHubsAndOffload } from './lib/render-and-push-hubs.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  // ASSET_CDN + TZ, both of which build-plugins/constants.ts and the renderers
  // read ONCE at module evaluation — so this must run BEFORE the first dynamic
  // import below, and does. Full rationale (including the confirmed
  // byte-identity divergence a missing ASSET_CDN produces in <head>) lives
  // with the function, in scripts/lib/render-and-push-hubs.mjs; kept in one
  // place so the per-article and per-section entry points cannot pin different
  // environments and render different bytes from the same code.
  pinRenderEnv();

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
  // before any of steps 2-7, none of which need distDir/images to exist.
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

  // ── Steps 6 / 6b / 7: hub archive → topic hubs → CDN offload ──
  //
  // One call, because the ORDER is the contract (issue #5270) and a caller
  // must not be able to express any other one. Both hub families emit
  // `src="/assets/…"` as plain text and the offload is the only pass that
  // rewrites those to the CDN, so a hub page written after the offload ships
  // 9 guaranteed-404 same-origin refs — no CSS, no SPA bundle, no AdSense
  // loader (measured live 2026-08-06, all 4 locales, both sections).
  //
  // The offload is a whole-dist pass and therefore also covers the article
  // pages steps 2-5 just rewrote above; that is why it belongs at the tail of
  // this pipeline and not inside the hub render.
  //
  // The implementation lives in scripts/lib/render-and-push-hubs.mjs so it has
  // a second caller — scripts/rerender-article-hubs.mjs, which re-renders a
  // section's hubs WITHOUT publishing an article. Before that split, a change
  // to the hub renderers had no way of reaching the served pages except as a
  // side effect of the editorial cadence (issue #5432).
  const { hubResult, topicHubResult } = await renderHubsAndOffload({
    rootDir: ROOT_DIR,
    distDir,
    section: args.section,
    logPrefix: '[publish-article-fast]',
  });

  // ── Summary JSON for stream B (shard push) / stream C (workflow) ──
  const sectionShardKey = args.section === 'frontaliere' ? 'articolifrontaliere' : 'articolisvizzera';
  const shardSlugs = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'lib', 'section-shard-slugs.json'), 'utf-8'),
  );
  const slugMap = shardSlugs[sectionShardKey];

  // subtree convention matches scripts/lib/section-shard-slugs.json's own
  // documented formula: it -> <slug>, en/de/fr -> <loc>/<slug>.
  // Hub-archive relpaths for this locale are appended after the article's
  // own 2 paths — push-article-shard-incremental.sh takes an arbitrary list
  // of relpaths per locale/section invocation, so no separate push call or
  // workflow change is needed (.github/workflows/fast-publish-article.yml
  // already forwards every entry in `paths[]`).
  //
  // Topic-hub relpaths (step 6b) ride the same list. They land under the SAME
  // shard subtree as the archive — both are `<indexSlug[locale]>/…`, and
  // `ARTICLE_SECTION_CORE.<section>.indexSlug` is what the shard slug in
  // section-shard-slugs.json mirrors — so no new shard, key or push leg is
  // involved. The list is empty when step 6b failed, which is why it is
  // spread defensively rather than indexed.
  const shards = locales.map((locale) => ({
    locale,
    subtree: locale === 'it' ? slugMap.it : `${locale}/${slugMap[locale]}`,
    paths: [
      entry.paths[locale],
      entry.flatPaths[locale],
      ...hubResult.pathsByLocale[locale],
      ...(topicHubResult.pathsByLocale[locale] ?? []),
    ],
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

  // Apex artifacts this run produced, for stream C to publish to the edge and
  // commit into public/. Kept OUT of `shards[].paths` on purpose: those go
  // into a section shard subtree, and this file is served from the apex.
  //
  // `renderTopicClusterHubPages` writes it from the pages it just wrote, so
  // the list of URLs in it is exactly the list of pages the shard push below
  // is about to deliver — the two halves of "announce what someone actually
  // wrote" travel together or not at all. Empty when step 6b failed or
  // produced no indexable hub; the workflow skips the publish rather than
  // pushing a stale copy.
  const edgeFiles = [];
  if (topicHubResult.sitemapPath) {
    edgeFiles.push({
      pathname: `/${topicHubResult.sitemapPath}`,
      distPath: topicHubResult.sitemapPath,
      urlCount: topicHubResult.announcedUrlPaths.length,
    });
  }

  const summary = { id: args.id, section: args.section, shards, cdnUploads, edgeFiles };
  const summaryPath = path.resolve(args.summary);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  const wallMs = Date.now() - t0;
  console.log(
    `[publish-article-fast] done — id=${args.id} section=${args.section} wrote=${written} article files + ${hubResult.written} hub pages, wall=${(wallMs / 1000).toFixed(1)}s`,
  );
  console.log(`[publish-article-fast] summary written to ${summaryPath}`);
}

main().catch((err) => {
  console.error('[publish-article-fast] fatal error:', err);
  process.exit(1);
});
