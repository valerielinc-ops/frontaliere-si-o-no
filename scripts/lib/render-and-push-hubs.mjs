// scripts/lib/render-and-push-hubs.mjs — the hub half of the fast-publish
// pipeline, extracted so it has more than one caller (issue #5432 point 2).
//
// WHY THIS FILE EXISTS
// ────────────────────
// Steps 6 / 6b / 7 of scripts/publish-article-fast.mjs (render the section's
// `/tutti/` archive → render its `/…/argomenti/<topic>/` hubs → run the CDN
// offload over everything just written) were reachable ONLY by publishing an
// article. That made hub-page freshness a side effect of the editorial
// cadence: a section that does not publish keeps serving whatever renderer was
// current the last time it did, and a change to the RENDERER ITSELF has no way
// down at all — no workflow in this repo names seoHubsPlugin.ts,
// topicClusterHubsPlugin.ts, topicClusterHubsData.ts, articleHubPagesPlugin.ts
// or topicTaxonomy.ts in a `push: paths:` filter.
//
// Measured consequence (2026-08-09, issue #5432): `sitemap-topics-frontaliere.xml`
// reported `deepest 14` — the flat page-N ladder merged in #5422 had never
// reached a single served page — and `sitemap-topics-svizzera.xml` reported
// `reached 0`, because svizzera had not published since 2026-08-08T21:38Z.
//
// So the fix is not a second implementation of the render; it is a SECOND
// CALLER of the same one. This module is that one implementation:
//   - scripts/publish-article-fast.mjs  — per-article, unchanged behaviour
//   - scripts/rerender-article-hubs.mjs — per-section, reactive to the code
//
// THE ORDER IS THE CONTRACT (issue #5270)
// ───────────────────────────────────────
// archive → topic hubs → CDN offload. Never any other order.
//
// Both hub families emit `src="/assets/${entryJs}"` and the matching CSS/link
// refs as PLAIN TEXT (articleHubPagesPlugin.ts builds them by string
// concatenation — Rollup's renderBuiltUrl never sees them, they are not asset
// references). `offload-generated-images-cdn.mjs` is the only pass that
// rewrites those to the CDN, and the deploy DELETES `dist/assets`, so no
// origin on the serving path hosts them: a page written AFTER the offload
// ships 9 same-origin refs that are all guaranteed 404s — no CSS, no SPA
// bundle, no AdSense loader. Measured live on 2026-08-06 across all four
// locales and both sections; invisible to CI because a full build is immune
// (there the offload runs after the whole build) and the breakage healed at
// the next deploy.
//
// Keeping the two renders and the offload inside ONE function is what makes
// the order un-reorderable by a caller: there is no way to call the offload
// early without editing this file, and tests/fast-publish-cdn-offload-order.test.ts
// asserts the source order here and asserts that neither caller has grown its
// own copy of the call sites.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * The CDN origin every article-surface renderer and the offload script agree
 * on. Single literal (AGENTS.md #6): it is BOTH the `ASSET_CDN` that
 * build-plugins/constants.ts reads once at module evaluation to derive
 * CDN_PRECONNECT_HINT, AND the `CDN_BASE` the offload subprocess rewrites
 * `/assets/...` towards. deploy.yml's build-locale job hardcodes the same
 * value for every real deploy build, so matching it is a byte-identity
 * requirement, not configuration.
 */
export const CDN_BASE = 'https://cdn.frontaliereticino.ch';

/**
 * Set the two process-level knobs the hub renderers inherit from the deploy
 * build. MUST be called before the first import of build-plugins/constants.ts
 * (module evaluation is cached, and the CDN_PRECONNECT_HINT it derives is
 * computed by a top-level IIFE, not per call).
 *
 * Without ASSET_CDN, ogPagesPlugin emits no preconnect of its own, and the
 * offload — which DOES get CDN_BASE — then finds no same-origin preconnect to
 * dedup against and injects a redundant preconnect+dns-prefetch pair at the
 * very top of <head>: a real, reproduced byte-identity divergence from
 * production, not a staleness artifact.
 *
 * TZ is defence in depth. The byline formatters no longer read local calendar
 * fields (fixed at the source after ~142 articles shipped with a machine-
 * readable `datetime` one day off the visible text), but the archive pages
 * stamp `new Date().toISOString().slice(0, 10)` and any date handling added
 * later inherits the runner's zone for free at zero cost.
 */
export function pinRenderEnv() {
  process.env.ASSET_CDN = CDN_BASE;
  process.env.TZ = 'UTC';
}

/**
 * Steps 6 + 6b — the two hub families of one article section, into `distDir`.
 *
 * Step 6, the `/tutti/` archive + its pagination, calls the SAME
 * `renderArticleHubPagesCore` the full build's `emitSeoHubs` uses, so the
 * bytes are identical to a full build by construction (proven in
 * tests/render-article-hub-pages-narrow-vs-full.test.ts).
 *
 * Step 6b, the editorial topic hubs, calls the SAME `renderTopicHubSectionCore`
 * the full build's plugin calls. It re-renders the WHOLE section rather than
 * one topic: one more article shifts the TF-IDF model, so a borderline article
 * can change topic, and a topic crossing the floor rewrites the sibling-topic
 * nav on every hub.
 *
 * Step 6b is NON-BLOCKING, and that asymmetry is deliberate in both callers.
 * For a publish, a topic-hub failure must not cost the article its publish.
 * For a re-render, it must not cost the section its archive refresh — the
 * archive is the surface every article page links back to. A failure leaves
 * `topicHubResult` empty, which the callers spread defensively, so the push
 * simply carries no topic-hub paths rather than carrying broken ones.
 *
 * @param {{rootDir: string, distDir: string, section: 'frontaliere'|'svizzera',
 *          locales?: readonly string[], logPrefix?: string}} opts
 */
export async function renderSectionHubs(opts) {
  const { rootDir, distDir, section, locales, logPrefix = '[render-hubs]' } = opts;

  // ── Step 6: article-hub archive pages (issue #4881 Fase 1) ──
  const { renderArticleHubPages } = await import('../../build-plugins/seoHubsPlugin.ts');
  const hubResult = await renderArticleHubPages({ rootDir, distDir, section, locales });

  // ── Step 6b: topic-cluster hubs (issue #5001 follow-up) ──
  let topicHubResult = { written: 0, pathsByLocale: {}, sitemapPath: null, announcedUrlPaths: [] };
  try {
    const { renderTopicClusterHubPages } = await import(
      '../../build-plugins/topicClusterHubsPlugin.ts'
    );
    topicHubResult = await renderTopicClusterHubPages({ rootDir, distDir, section, locales });
    console.log(
      `${logPrefix} topic hubs: ${topicHubResult.written} file scritti per la sezione ${section}` +
        (topicHubResult.sitemapPath
          ? ` (+ ${topicHubResult.sitemapPath}, ${topicHubResult.announcedUrlPaths.length} URL annunciate)`
          : ' (nessun hub indicizzabile → nessuna sitemap)'),
    );
  } catch (err) {
    console.error(
      `${logPrefix} topic-hub render failed — continuing without them ` +
        '(they refresh at the next full build):',
      err,
    );
  }

  return { hubResult, topicHubResult };
}

/**
 * Step 7 — `scripts/offload-generated-images-cdn.mjs`, unmodified, as a
 * subprocess over the whole of `distDir`.
 *
 * The script hardcodes `distDir = path.resolve(process.cwd(), 'dist')`, so it
 * is spawned with `cwd` = a temp dir holding a `dist` symlink to the real
 * scratch dir — the same trick both callers already used, never a fork of its
 * logic. Its own TARGETS-existence gating makes it safe against a near-empty
 * scratch dist: only the guarded *delete* step requires a target dir to
 * physically exist, while the rewrite regexes run unconditionally.
 *
 * DANGER, learned by wiping ~850 MB of tracked files once: nothing may leave a
 * symlink to a real repo directory (e.g. `distDir/images` → `public/images`)
 * alive while this runs. The delete step treats a symlink as an INTERMEDIATE
 * path component transparently and deletes straight through it. Both callers
 * tear such links down before reaching this point.
 */
export function offloadGeneratedImagesCdn(opts) {
  const { rootDir, distDir, cdnBase = CDN_BASE, logPrefix = '[render-hubs]' } = opts;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-hubs-offload-'));
  try {
    fs.symlinkSync(distDir, path.join(tmpDir, 'dist'), 'dir');
    const offloadScript = path.join(rootDir, 'scripts', 'offload-generated-images-cdn.mjs');
    const result = spawnSync(process.execPath, [offloadScript], {
      cwd: tmpDir,
      env: { ...process.env, CDN_BASE: cdnBase },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(
        `${logPrefix} offload-generated-images-cdn.mjs exited ${result.status} — ` +
          'unexpected (the script catches its own errors and always exits 0); dist left as rendered pre-offload',
      );
    }
    return result.status;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Steps 6 → 6b → 7 in the one order that is correct (issue #5270).
 *
 * Callers get the composition, never the pieces in an order of their choosing.
 * The offload is a WHOLE-DIST pass, so calling this after per-article
 * post-processing (publish-article-fast.mjs's steps 2-5) covers those pages
 * too — which is exactly what the per-article caller needs and why the offload
 * belongs at the tail rather than inside `renderSectionHubs`.
 *
 * @returns {Promise<{hubResult: object, topicHubResult: object}>}
 */
export async function renderHubsAndOffload(opts) {
  const { rootDir, distDir, section, locales, cdnBase, logPrefix } = opts;
  const { hubResult, topicHubResult } = await renderSectionHubs({
    rootDir,
    distDir,
    section,
    locales,
    logPrefix,
  });
  offloadGeneratedImagesCdn({ rootDir, distDir, cdnBase, logPrefix });
  return { hubResult, topicHubResult };
}

/**
 * Every dist-relative path this section's hub render produced, grouped by the
 * locale whose shard repo it belongs in.
 *
 * Both families land under the SAME shard subtree — both are
 * `<indexSlug[locale]>/…`, and `ARTICLE_SECTION_CORE.<section>.indexSlug` is
 * what the shard slug in scripts/lib/section-shard-slugs.json mirrors — so no
 * new shard, key or push leg is involved. The topic list is spread defensively
 * because it is empty when step 6b failed.
 */
export function hubPathsByLocale({ hubResult, topicHubResult }, locales) {
  const out = {};
  for (const locale of locales) {
    out[locale] = [
      ...(hubResult.pathsByLocale?.[locale] ?? []),
      ...(topicHubResult?.pathsByLocale?.[locale] ?? []),
    ];
  }
  return out;
}

/**
 * `frontaliere` / `svizzera` → the shard token
 * scripts/lib/section-shard-slugs.json keys on and
 * push-article-shard-incremental.sh uppercases into
 * `SHARD_<SECTION>_<LOCALE>_DEPLOY_KEY`.
 *
 * A DERIVATION, not a duplicated literal — the same formula
 * scripts/rerender-article-corpus.mjs already uses, provably equivalent to
 * fast-publish-article.yml's `if [ "$section" = "svizzera" ]` branch for the
 * two known section names.
 */
export function shardTokenForSection(section) {
  return `articoli${section}`;
}
