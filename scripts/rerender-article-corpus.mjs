#!/usr/bin/env -S npx -y tsx
// rerender-article-corpus.mjs — issue #4881 Fase 4: periodic full-corpus
// article re-render, off the site's critical path.
//
// WHY THIS EXISTS (measured, not assumed): buildRelatedArticlesHtml
// (build-plugins/ogPagesPlugin.ts) always slots a newly-published article at
// index 0 of entriesByDate, which enters BOTH `sameCategory.slice(0,3)` and
// `others.slice(0,>=2)` for every OTHER article's related-articles block —
// i.e. publishing ONE article changes the related block of 100% of the
// section (548/548 svizzera, 3023/3023 frontaliere at measurement time). The
// per-article fast-publish path (scripts/publish-article-fast.mjs, #4837)
// deliberately does NOT re-render siblings for this reason (it was evaluated
// and found not incrementally cheap: the "changed set" IS the whole section).
// This script is the corpus-wide catch-up: it re-renders every article in a
// section and pushes only what actually changed to the shard repos, via the
// SAME merge-aware, never-force incremental push script the fast path uses.
// It also doubles as the template-drift safety net that used to come for
// free from periodic full `vite build` deploys touching every article page.
//
// ONE IMPLEMENTATION, NEVER A FORK (same constraint as publish-article-fast.mjs
// states about itself): this script calls the exact renderArticlePages()
// export (build-plugins/ogPagesPlugin.ts) and the exact same post-render
// pipeline functions (flatHtmlRedirectPlugin, blogContextualLinksPlugin,
// hreflangPostprocessPlugin, blogImageCdnFinalizePlugin) publish-article-fast.mjs
// uses, in the same order, generalized from "one article" to "a batch of
// article ids" via renderArticlePages's onlyArticleIds option (#4881). A fix
// to any of those functions benefits the single-article fast path, the full
// `vite build`, AND this corpus re-render for free; a fork would silently
// drift the three apart.
//
// ── Memory-bounded batching (the main design constraint) ────────────────────
// renderArticlePages() WITHOUT onlyArticleId/onlyArticleIds parses+holds every
// article's metadata for the whole section AND reads every body file for
// every locale (services/locales/<bodyDir>/<locale>/*.ts) into memory at once
// — the exact whole-section-in-one-process pattern the task brief for #4881
// Fase 4 flags as unsafe to assume: full `vite build` peaks ~9.8GB (measured,
// #2909/#3144 history), GH-hosted standard runners have ~7GB, and parallel
// SSG builds were tested and OOM'd (see docs/AGENTS-HISTORY.md). This script
// never calls renderArticlePages unbounded: every render happens in a FRESH
// child process (`npx tsx` re-invoking this same file in "worker mode"),
// scoped to a bounded batch of article ids via onlyArticleIds. A fresh process
// per batch is the actual memory-safety mechanism — it guarantees the
// previous batch's parsed entries/body-text are released by the OS on exit,
// which sequential in-process batching inside one long-lived Node process
// cannot guarantee (V8 GC is not obligated to reclaim eagerly, and the
// require/import module cache would keep growing). DEFAULT_BATCH_SIZE below
// is a REASONED target, not a measured one (no full local build is available
// to profile against — see AGENTS.md "NEVER run a full local build"): the
// per-batch body-file read scales with batch size (small, ~5-20KB per file x
// up to 4 locales), while the per-call section-wide metadata parse is a
// roughly CONSTANT cost paid on every invocation regardless of batch size —
// so batch size mainly trades off (fewer, larger batches = less redundant
// per-invocation parse overhead and fewer `npx tsx` cold-starts) against
// (smaller batches = smaller, more conservative worst-case peak RSS per
// child process, with no real profiling data to size it against precisely).
// If a real dispatched run's logs show OOM or memory pressure, the fix is to
// lower --batch-size (and re-run) — see the report this script's author
// filed alongside it for the explicit revert-trigger statement.
//
// ── Usage ────────────────────────────────────────────────────────────────
//   npx -y tsx@4 scripts/rerender-article-corpus.mjs \
//     --section <frontaliere|svizzera|all> [default: all — CI wires ONE
//         matrix job per section instead, so each job's wall-time/memory
//         footprint stays bounded to one section; --section all is a manual/
//         local-testing convenience, not the wiring the workflow uses]
//     --locale <it|en|de|fr|all>   [default: all — renderArticlePages always
//         renders all 4 locale pages per article in one pass (no partial-
//         locale render exists); this flag ONLY scopes which locale shard(s)
//         get PUSHED, e.g. to recover a single broken shard without re-
//         touching the other 3]
//     [--batch-size 300] [--push-batch-size 400] [--limit N] [--dry-run]
//     [--only-ids id1,id2,...] [--out <scratchDistDir>] [--manifest <path>]
//
// Internal (worker mode — spawned by this same file, never invoke directly):
//   --worker-section <name> --worker-ids-file <path> --worker-out <dir> --worker-result <path>

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), '..');
const CDN_BASE = 'https://cdn.frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Pinned to the SAME tsx major version fast-publish-article.yml pins for its
// top-level invocation (`npx -y tsx@4 scripts/publish-article-fast.mjs`), so a
// self-spawned batch worker (below) can never resolve a different tsx version
// than whatever invoked this script's own top-level (orchestrator) run.
const TSX_INVOCATION = ['-y', 'tsx@4'];

const DEFAULT_BATCH_SIZE = 300; // see header comment — reasoned, not measured
const DEFAULT_PUSH_BATCH_SIZE = 400; // relpaths per push-article-shard-incremental.sh call; well under ARG_MAX, chosen for predictability independent of render batch size

function parseArgs(argv) {
  const out = {
    section: 'all',
    locale: 'all',
    batchSize: DEFAULT_BATCH_SIZE,
    pushBatchSize: DEFAULT_PUSH_BATCH_SIZE,
    dryRun: false,
    limit: undefined,
    onlyIds: undefined,
    out: undefined,
    manifest: undefined,
    workerSection: undefined,
    workerIdsFile: undefined,
    workerOut: undefined,
    workerResult: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--section') out.section = argv[++i];
    else if (a === '--locale') out.locale = argv[++i];
    else if (a === '--batch-size') out.batchSize = Number(argv[++i]);
    else if (a === '--push-batch-size') out.pushBatchSize = Number(argv[++i]);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only-ids') out.onlyIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--worker-section') out.workerSection = argv[++i];
    else if (a === '--worker-ids-file') out.workerIdsFile = argv[++i];
    else if (a === '--worker-out') out.workerOut = argv[++i];
    else if (a === '--worker-result') out.workerResult = argv[++i];
  }
  if (!['frontaliere', 'svizzera', 'all'].includes(out.section)) {
    console.error(`[rerender-article-corpus] --section must be frontaliere|svizzera|all, got "${out.section}"`);
    process.exit(1);
  }
  if (!['it', 'en', 'de', 'fr', 'all'].includes(out.locale)) {
    console.error(`[rerender-article-corpus] --locale must be it|en|de|fr|all, got "${out.locale}"`);
    process.exit(1);
  }
  return out;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    child.on('close', (status) => resolve({ status }));
    child.on('error', (err) => {
      console.error(`[rerender-article-corpus] failed to spawn ${cmd}:`, err);
      resolve({ status: 1 });
    });
  });
}

// Id enumeration is imported from build-plugins/shared/articleSectionDescriptors.ts
// (enumerateSectionArticleIds) — shared with scripts/audit-article-corpus-drift.mjs
// (issue #4881 Fase 4, AGENTS.md #6: same "every article id in this section"
// need, one implementation, not a second copy-pasted enumerator).

// ── Worker mode: render ONE bounded batch of ids in this (fresh) process ──
// Mirrors scripts/publish-article-fast.mjs steps 1-5 exactly, generalized
// from one article to N via renderArticlePages's onlyArticleIds. Step 6
// (offload-generated-images-cdn.mjs) runs ONCE per section in orchestrator
// mode below, after all of a section's batches are on disk — it is a
// stateless whole-dist walker (see its own header comment), so running it
// once at the end is equivalent to, and cheaper than, running it per batch.
async function renderBatchWorker(sectionName, idsFile, distDir, resultFile) {
  // See publish-article-fast.mjs for why both env vars must be set before the
  // first import of ogPagesPlugin.ts/constants.ts below (module-load-time
  // evaluation, required for byte-identity with the real deploy build).
  process.env.ASSET_CDN = CDN_BASE;
  process.env.TZ = 'UTC';

  const ids = JSON.parse(fs.readFileSync(idsFile, 'utf-8'));
  fs.mkdirSync(distDir, { recursive: true });

  // Step 0: make public/images visible to resolveImagePath's existence
  // checks, exactly like publish-article-fast.mjs's step 0 — see its DANGER
  // comment for why this symlink's lifetime must stay confined to the
  // renderArticlePages call only (torn down immediately after step 1, before
  // anything that could write/delete through distDir).
  const scratchImagesLink = path.join(distDir, 'images');
  try {
    fs.symlinkSync(path.join(ROOT_DIR, 'public', 'images'), scratchImagesLink, 'dir');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const { renderArticlePages } = await import('../build-plugins/ogPagesPlugin.ts');
  const { entries } = await renderArticlePages({
    rootDir: ROOT_DIR,
    distDir,
    section: sectionName,
    onlyArticleIds: ids,
  });

  fs.rmSync(scratchImagesLink, { force: true });

  const { buildFlatBridgeFromSibling } = await import('../build-plugins/flatHtmlRedirectPlugin.ts');
  const { injectContextualLinks } = await import('../build-plugins/blogContextualLinksPlugin.ts');
  const { transformHreflang } = await import('../build-plugins/hreflangPostprocessPlugin.ts');
  const { rewriteBlogImageRefs } = await import('../build-plugins/blogImageCdnFinalizePlugin.ts');
  const { BASE_URL } = await import('../build-plugins/constants.ts');

  for (const entry of entries) {
    for (const locale of LOCALES) {
      const indexRel = entry.paths[locale];
      const flatRel = entry.flatPaths[locale];
      if (!indexRel || !flatRel) continue;

      const indexAbs = path.join(distDir, indexRel);
      const flatAbs = path.join(distDir, flatRel);
      const slashUrl = entry.urls[locale];

      const freshIndexHtml = fs.readFileSync(indexAbs, 'utf-8');
      const bridgeHtml = buildFlatBridgeFromSibling(freshIndexHtml, slashUrl);

      const linked = injectContextualLinks(freshIndexHtml, locale);
      let indexHtml = linked.html;

      const hreflangResult = transformHreflang(indexHtml, distDir, BASE_URL, (absPath) => fs.existsSync(absPath));
      if (hreflangResult) indexHtml = hreflangResult.html;

      indexHtml = rewriteBlogImageRefs(indexHtml);
      const finalBridgeHtml = rewriteBlogImageRefs(bridgeHtml);

      fs.writeFileSync(indexAbs, indexHtml, 'utf-8');
      fs.writeFileSync(flatAbs, finalBridgeHtml, 'utf-8');
    }
  }

  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify({ entries }), 'utf-8');
}

async function runOrchestrator(args) {
  const { ARTICLE_SECTION_DESCRIPTORS, enumerateSectionArticleIds } = await import('../build-plugins/shared/articleSectionDescriptors.ts');
  const sections = ARTICLE_SECTION_DESCRIPTORS.filter((s) => args.section === 'all' || s.name === args.section);

  const distDir = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'rerender-corpus-'));
  fs.mkdirSync(distDir, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), distDir, sections: {} };
  let anyFailure = false;

  for (const section of sections) {
    let ids = args.onlyIds && args.onlyIds.length ? args.onlyIds : enumerateSectionArticleIds(section, ROOT_DIR);
    if (args.limit) ids = ids.slice(0, args.limit);
    const batches = chunkArray(ids, args.batchSize);
    console.log(
      `[rerender-article-corpus] section=${section.name} ids=${ids.length} batches=${batches.length} batchSize=${args.batchSize}`,
    );

    const allEntries = [];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `rerender-corpus-work-${section.name}-`));
    let sectionFailed = false;
    try {
      for (let i = 0; i < batches.length; i++) {
        const batchIds = batches[i];
        const idsFile = path.join(workDir, `batch-${i}-ids.json`);
        const resultFile = path.join(workDir, `batch-${i}-result.json`);
        fs.writeFileSync(idsFile, JSON.stringify(batchIds), 'utf-8');

        const t0 = Date.now();
        const result = spawnSync(
          'npx',
          [...TSX_INVOCATION, SELF_PATH,
            '--worker-section', section.name,
            '--worker-ids-file', idsFile,
            '--worker-out', distDir,
            '--worker-result', resultFile,
          ],
          { stdio: 'inherit', env: process.env },
        );
        const wallSec = ((Date.now() - t0) / 1000).toFixed(1);

        if (result.status !== 0) {
          console.error(
            `[rerender-article-corpus] batch ${i + 1}/${batches.length} for section=${section.name} FAILED (exit ${result.status}) — aborting this section's remaining batches and skipping its shard push (no partial/unverified push)`,
          );
          sectionFailed = true;
          anyFailure = true;
          break;
        }

        const batchResult = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        allEntries.push(...batchResult.entries);
        console.log(
          `[rerender-article-corpus] batch ${i + 1}/${batches.length} section=${section.name} requested=${batchIds.length} rendered=${batchResult.entries.length} wall=${wallSec}s`,
        );
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    if (sectionFailed) continue;

    // Step 6 (offload-generated-images-cdn.mjs), ONCE for this section's
    // whole accumulated scratch dist — see renderBatchWorker's comment above.
    const offloadTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rerender-corpus-offload-'));
    try {
      fs.symlinkSync(distDir, path.join(offloadTmp, 'dist'), 'dir');
      const offloadScript = path.join(ROOT_DIR, 'scripts', 'offload-generated-images-cdn.mjs');
      const offloadResult = spawnSync(process.execPath, [offloadScript], {
        cwd: offloadTmp,
        env: { ...process.env, CDN_BASE },
        stdio: 'inherit',
      });
      if (offloadResult.status !== 0) {
        console.error(
          `[rerender-article-corpus] offload-generated-images-cdn.mjs exited ${offloadResult.status} — unexpected (the script catches its own errors and always exits 0); dist left as rendered pre-offload`,
        );
      }
    } finally {
      fs.rmSync(offloadTmp, { recursive: true, force: true });
    }

    manifest.sections[section.name] = {
      requestedIds: ids.length,
      rendered: allEntries.length,
      entries: allEntries.map((e) => ({ articleId: e.articleId, paths: e.paths, flatPaths: e.flatPaths, urls: e.urls })),
    };
  }

  const manifestPath = args.manifest ? path.resolve(args.manifest) : path.join(distDir, 'rerender-corpus-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`[rerender-article-corpus] manifest written to ${manifestPath}`);
  console.log(`[rerender-article-corpus] scratch dist at ${distDir}`);

  if (args.dryRun) {
    console.log('[rerender-article-corpus] --dry-run set — skipping shard push');
    if (anyFailure) process.exitCode = 1;
    return;
  }

  // ── Push step: per section, per target locale (parallel across locales —
  // 4 independent shard repos/deploy keys, safe to push concurrently, mirrors
  // fast-publish-article.yml's own per-locale parallel-push fan-out), chunked
  // per locale (sequential within a locale — same repo, avoid needless
  // non-fast-forward retries from racing against ourselves).
  const targetLocales = args.locale === 'all' ? LOCALES : [args.locale];

  for (const [sectionName, data] of Object.entries(manifest.sections)) {
    // "articoli" + section name is a DERIVATION (not a duplicated literal):
    // matches the shard-token naming convention already fixed by
    // scripts/lib/section-shard-slugs.json's own key names
    // (articolifrontaliere/articolisvizzera) and fast-publish-article.yml's
    // equivalent branch — see that workflow's `if [ "$section" = "svizzera" ]`
    // step, which this formula is provably equivalent to for the two known
    // section names.
    const shardToken = `articoli${sectionName}`;

    const localePushes = targetLocales.map(async (locale) => {
      const relpaths = [];
      for (const e of data.entries) {
        if (e.paths[locale]) relpaths.push(e.paths[locale]);
        if (e.flatPaths[locale]) relpaths.push(e.flatPaths[locale]);
      }
      if (relpaths.length === 0) return;

      const pushChunks = chunkArray(relpaths, args.pushBatchSize);
      console.log(
        `[rerender-article-corpus] pushing ${relpaths.length} relpath(s) to ${shardToken}-${locale} in ${pushChunks.length} chunk(s)`,
      );
      const pushScript = path.join(ROOT_DIR, 'scripts', 'lib', 'push-article-shard-incremental.sh');
      for (let i = 0; i < pushChunks.length; i++) {
        const { status } = await spawnAsync('bash', [pushScript, shardToken, locale, distDir, ...pushChunks[i]], {
          stdio: 'inherit',
          env: process.env,
        });
        if (status !== 0) {
          console.error(
            `[rerender-article-corpus] push chunk ${i + 1}/${pushChunks.length} to ${shardToken}-${locale} FAILED (exit ${status})`,
          );
          anyFailure = true;
        }
      }
    });

    await Promise.all(localePushes);
  }

  if (anyFailure) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.workerIdsFile) {
    if (!args.workerSection || !args.workerOut || !args.workerResult) {
      console.error('[rerender-article-corpus] worker mode requires --worker-section, --worker-ids-file, --worker-out and --worker-result');
      process.exit(1);
    }
    await renderBatchWorker(args.workerSection, args.workerIdsFile, args.workerOut, args.workerResult);
    return;
  }

  await runOrchestrator(args);
}

main().catch((err) => {
  console.error('[rerender-article-corpus] fatal error:', err);
  process.exit(1);
});
