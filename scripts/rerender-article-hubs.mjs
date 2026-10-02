#!/usr/bin/env -S npx -y tsx
// scripts/rerender-article-hubs.mjs — re-render an article section's hub pages,
// publish the matching client chunks, and push the pages to the shard repos.
//
// WHAT THIS IS FOR (issue #5432 point 2)
// ──────────────────────────────────────
// The hub pages — a section's `/tutti/` archive + pagination and its
// `/…/argomenti/<topic>/` topic clusters — had exactly one producer on the
// serving path: `scripts/publish-article-fast.mjs`, reachable only by
// publishing an article, and only for THAT article's section. Two consequences,
// both measured on 2026-08-09:
//
//   - A change to the RENDERERS never arrives. No workflow in this repo named
//     seoHubsPlugin.ts, topicClusterHubsPlugin.ts, topicClusterHubsData.ts,
//     articleHubPagesPlugin.ts or topicTaxonomy.ts in a `push: paths:` filter,
//     and the full build does not emit these pages at all
//     (ARTICOLI*_BUILD_EMIT_SKIP=true, plus the rehydrate REPLACE that puts the
//     old shard back). #5422's flat page-N ladder was merged, correct, on main
//     — and `sitemap-topics-frontaliere.xml` still reported `deepest 14`,
//     because not one served page had ever been re-rendered with it.
//   - A section that does not publish falls behind indefinitely. `svizzera`
//     last published at 2026-08-08T21:38Z, 64 minutes before the merge, so
//     `sitemap-topics-svizzera.xml` reported `reached 0` — the whole tier
//     unreachable, which is what held `audit:max-bfs-depth` red and skipped
//     `publish` (IndexNow, Google Indexing API, GSC, social) on every deploy.
//
// This driver is the missing producer: reactive to the CODE (the workflow's
// `push: paths:` names the five renderer files) and periodic (its `schedule`),
// instead of reactive to the editorial cadence.
//
// NOT A SECOND IMPLEMENTATION. The render is `renderHubsAndOffload` from
// scripts/lib/render-and-push-hubs.mjs — the exact function
// publish-article-fast.mjs calls, in the exact order (archive → topic hubs →
// CDN offload, issue #5270). The push is the exact merge-only, never-force
// scripts/lib/push-article-shard-incremental.sh every other article path uses.
// This file contributes the enumeration, the validation, the client-chunk
// publication and the push fan-out. The workflow supplies the shared R2 lease
// around the last three operations so the registry and the hub cannot cross
// another article publisher (#5819).
//
// WHY NOT rerender-article-corpus.yml. That workflow exists for template
// drift and is the obvious host — but it re-renders 3571 articles under a
// 180-minute timeout and serialises on `rerender-corpus-<section>`. Putting a
// repair that takes minutes behind a lock that takes hours means the repair is
// unavailable exactly when a hub regression is live. Its TODO at :38-42 now
// points here instead.
//
// WHY NOT the corpus repo. `topicClusterHubsPlugin.ts` is 1000+ lines and
// depends on `build-plugins/shared/`; it is not under `packages/articles/engine/`,
// so no mirror carries it, and moving it there first is a much larger change.
// It would also put the repair in a repo where the gate that detects the
// failure (`audit:max-bfs-depth`, run by this repo's validate-dist) does not
// run.
//
// CLI:
//   npx -y tsx@4.23.15 scripts/rerender-article-hubs.mjs \
//     --section <all|frontaliere|svizzera> --out <scratchDir> --summary <path> \
//     [--locale <all|it|en|de|fr>] [--dry-run]
//
// `--dry-run` renders and VALIDATES and pushes nothing. It is a complete
// exercise of everything that can go wrong locally, which is why the workflow
// defaults a manual dispatch to dry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { spawn } from 'node:child_process';
import { ARTICLES_API_BASE } from './lib/articles-api-base.mjs';
import {
  ARTICLE_PATH_BASE,
  ARTICLE_REGISTRY_FILES,
  readSlugRegistryWithRows,
} from './lib/article-slug-registry.mjs';
import { renderedSlugs } from './lib/hydratedParity.mjs';

import {
  pinRenderEnv,
  renderHubsAndOffload,
  hubPathsByLocale,
  shardTokenForSection,
} from './lib/render-and-push-hubs.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const SECTIONS = ['frontaliere', 'svizzera'];
const LOG = '[rerender-article-hubs]';

/**
 * The published corpus manifest is the coarse cross-repo count check. The
 * published slug registry and the live Italian hub below add identity-level
 * checks, so an equal count cannot hide a different article set.
 */
const MANIFEST_URL = `${ARTICLES_API_BASE}/manifest.json`;
const PUBLISHED_SLUGS_URL = `${ARTICLES_API_BASE}/slugs.json`;
const LIVE_SITE_BASE = (process.env.ARTICLE_HUB_SITE_BASE ?? 'https://frontaliereticino.ch').replace(/\/$/, '');
const LIVE_HUB_TIMEOUT_MS = 20_000;
const FETCH_HEADERS = {
  'User-Agent': 'frontaliere-article-hub-refresh/1.0',
};

/**
 * How far behind the published corpus this repo's checked-out registry may be
 * before the push is refused.
 *
 * THE REGRESSION THIS PREVENTS. The archive pages on the shards are written by
 * whoever rendered last, and the corpus's own fast-publish renders from the
 * corpus's registry — always current by construction. This driver renders from
 * THIS repo's `packages/articles/content/`, which is a pull:
 * sync-articles-sitemaps.yml commits it on nanako's `articles-published`
 * dispatch, with a 12-hourly cron as the only backstop. If that pull is stuck
 * and this driver runs anyway, it re-renders an archive that is missing the
 * newest articles and pushes it over a live one that had them — a silent
 * un-publish, and the failure would look exactly like a successful run.
 *
 * The two counts ARE the same measurement when both sides are in sync —
 * measured 2026-08-09 against origin/main e88c4af8, svizzera: the archive
 * listed 649 and `manifest.counts.swissArticles` was 649, to the article. So
 * the tolerance is not slack for a systematic offset, it is slack for
 * TRANSIT: the manifest is read seconds after the render, and a publish
 * landing in between legitimately separates the two. A handful of articles is
 * normal; a pull that is stuck for hours is tens or hundreds.
 */
const MAX_ARTICLES_BEHIND = 25;

const publishedSlugsPromiseBySection = new Map();

function readLocalRegistry(section) {
  const config = ARTICLE_REGISTRY_FILES[section];
  if (!config) throw new Error(`unknown article section ${section}`);
  const parsed = readSlugRegistryWithRows(path.join(ROOT_DIR, config.file), config.constName);
  const ids = Object.keys(parsed.registry);
  if (parsed.rows === 0 || ids.length !== parsed.rows) {
    throw new Error(
      `${section}: local article registry ${config.file} parsed ${ids.length} of ${parsed.rows} rows`,
    );
  }
  return parsed.registry;
}

function publishedSectionKey(section) {
  return section === 'svizzera' ? 'swiss' : 'blog';
}

async function fetchPublishedSectionIds(section) {
  if (!publishedSlugsPromiseBySection.has(section)) {
    const promise = (async () => {
      const response = await fetch(PUBLISHED_SLUGS_URL, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(LIVE_HUB_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${PUBLISHED_SLUGS_URL}`);
      const payload = await response.json();
      const records = payload?.[publishedSectionKey(section)];
      if (!records || typeof records !== 'object' || Array.isArray(records)) {
        throw new Error(`slugs.json has no usable ${publishedSectionKey(section)} registry`);
      }
      const ids = new Set(Object.keys(records).filter(Boolean));
      if (ids.size === 0) throw new Error(`slugs.json ${publishedSectionKey(section)} registry is empty`);
      return ids;
    })();
    publishedSlugsPromiseBySection.set(section, promise);
  }
  return publishedSlugsPromiseBySection.get(section);
}

async function fetchLiveHubSlugs(section) {
  const hubPath = ARTICLE_PATH_BASE[section]?.it;
  if (!hubPath) throw new Error(`no Italian hub path configured for ${section}`);
  const url = `${LIVE_SITE_BASE}${hubPath}`;
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(LIVE_HUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const slugs = renderedSlugs(await response.text(), hubPath);
  if (slugs.length === 0) throw new Error(`no article cards found in the live hub ${url}`);
  return { url, slugs };
}

function missingPublishedIds(localRegistry, publishedIds) {
  const localIds = new Set(Object.keys(localRegistry));
  return [...publishedIds].filter((id) => !localIds.has(id));
}

function unpublishedLocalIds(localRegistry, publishedIds) {
  const publishedIdSet = new Set(publishedIds);
  return Object.keys(localRegistry).filter((id) => !publishedIdSet.has(id));
}

function missingLiveHubSlugs(localRegistry, liveSlugs) {
  const localItalianSlugs = new Set(
    Object.values(localRegistry)
      .map((slugs) => slugs?.it)
      .filter((slug) => typeof slug === 'string' && slug),
  );
  return liveSlugs.filter((slug) => !localItalianSlugs.has(slug));
}

function parseArgs(argv) {
  const out = { section: 'all', locale: 'all', dryRun: false, out: null, summary: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--section') out.section = argv[++i];
    else if (a === '--locale') out.locale = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--summary') out.summary = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else {
      console.error(`${LOG} unknown argument "${a}"`);
      process.exit(1);
    }
  }
  if (out.section !== 'all' && !SECTIONS.includes(out.section)) {
    console.error(`${LOG} --section must be all|frontaliere|svizzera, got "${out.section}"`);
    process.exit(1);
  }
  if (out.locale !== 'all' && !LOCALES.includes(out.locale)) {
    console.error(`${LOG} --locale must be all|it|en|de|fr, got "${out.locale}"`);
    process.exit(1);
  }
  if (!out.out) {
    console.error(`${LOG} --out <scratchDir> is required`);
    process.exit(1);
  }
  return out;
}

function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    child.on('close', (status) => resolve({ status }));
    child.on('error', (err) => {
      console.error(`${LOG} spawn ${cmd} failed:`, err);
      resolve({ status: 1 });
    });
  });
}

/**
 * Fail closed before a client-chunk upload or shard push when the workflow's
 * lease watcher has reported a loss. The watcher is deliberately external to
 * this driver so the same R2 lock remains shared with fast-publish/resync.
 * Dry runs may omit the enforcement flag because they do not publish. Every
 * non-dry invocation must be armed by the workflow's lease enforcement before
 * it can reach a client-chunk upload or shard push.
 */
function assertArticleChunkLease({ required = false } = {}) {
  if (process.env.ARTICLE_CHUNK_LOCK_ENFORCE !== 'true') {
    if (required) {
      throw new Error(`${LOG} article chunk lock enforcement is required for non-dry publication`);
    }
    return;
  }

  const failureFile = process.env.ARTICLE_CHUNK_LOCK_FAILURE_FILE;
  const pidFile = process.env.ARTICLE_CHUNK_LOCK_PID_FILE;
  if (!failureFile || !pidFile) {
    throw new Error(`${LOG} article chunk lock watcher paths are not configured`);
  }
  if (fs.existsSync(failureFile) && fs.statSync(failureFile).size > 0) {
    const reason = fs.readFileSync(failureFile, 'utf8').trim();
    throw new Error(`${LOG} article chunk lock was lost${reason ? `: ${reason}` : ''}`);
  }

  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${LOG} article chunk lock watcher PID is invalid`);
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    throw new Error(`${LOG} article chunk lock watcher is no longer alive: ${err.message}`);
  }
}

async function publishClientChunks(sections, dryRun) {
  const args = [
    '-y',
    'tsx@4.23.15',
    path.join(ROOT_DIR, 'scripts', 'publish-article-chunks.mjs'),
  ];
  if (sections.length === 1) args.push('--section', sections[0]);
  args.push('--strict', '--no-ticker');
  if (dryRun) args.push('--dry-run');

  console.log(
    `${LOG} publishing client article chunks before hub shards` +
      (dryRun ? ' (dry run)' : ''),
  );
  const { status } = await spawnAsync('npx', args, {
    stdio: 'inherit',
    env: process.env,
    cwd: ROOT_DIR,
  });
  if (status !== 0) {
    throw new Error(`${LOG} client article chunk publication failed (exit ${status})`);
  }
}

/**
 * The one page in a locale's archive family that is not a `page-N` — i.e. the
 * `/tutti/` landing itself.
 *
 * Found by shape rather than by index. `pathsByLocale[locale][0]` happens to
 * be it today, but the ordering is an emission detail of
 * `renderArticleHubPagesCore`, and a validation that silently starts checking
 * page-2 instead is worse than no validation. Locale-agnostic on purpose: the
 * slug differs per locale (`tutti` / `all` / `alle` / `tous`) and hardcoding
 * the four would be a fifth copy of a table that already exists.
 *
 * Matched POSITIVELY on the directory form. "Not a page-N" alone is not
 * enough: the hub families also emit a FLAT `…/page-2.html` bridge next to
 * every `…/page-2/index.html`, and a `/page-\d+\//` test does not see it — so
 * a family whose landing ever went missing would silently validate a redirect
 * bridge instead.
 */
function findArchiveLanding(paths) {
  return (
    paths.find((p) => p.endsWith('/index.html') && !/\/page-\d+\/index\.html$/.test(p)) ?? null
  );
}

/**
 * Refuse to publish bytes that would break the pages they replace.
 *
 * Every check here defends a failure that renders "successfully". None of them
 * are hypothetical: each one has a live incident behind it, recorded in the
 * comment on the check.
 */
function validateRenderedSection({ section, distDir, pathsByLocale, archivePathsByLocale }) {
  const errors = [];
  const notes = [];

  // 1. Every promised path must exist and be non-empty. A path in the summary
  //    that is not on disk fails push-article-shard-incremental.sh's own
  //    source check half-way through a locale, leaving a partially-pushed
  //    section.
  for (const locale of Object.keys(pathsByLocale)) {
    for (const rel of pathsByLocale[locale]) {
      let size = -1;
      try {
        size = fs.statSync(path.join(distDir, rel)).size;
      } catch {
        /* stays -1 */
      }
      if (size <= 0) errors.push(`${section}/${locale}: missing or empty rendered file: ${rel}`);
    }
  }

  // 2. Each locale must have an archive family with a landing page. An empty
  //    `pathsByLocale` entry means the render produced nothing for that locale
  //    and the push would be a no-op that looks like a success.
  for (const locale of Object.keys(archivePathsByLocale)) {
    const landing = findArchiveLanding(archivePathsByLocale[locale]);
    if (!landing) {
      errors.push(
        `${section}/${locale}: no non-paginated archive landing among ${archivePathsByLocale[locale].length} archive page(s)`,
      );
    }
  }

  // 3. The archive must LIST something. `renderArticleHubPagesCore` emits an
  //    empty archive by design when the registry resolves to nothing — it does
  //    not fail, it publishes nothing over a live page that had 3129 entries.
  //    This is the check that caught the first corpus-side render producing
  //    four pages with zero <li> items because the registry symlinks were
  //    missing.
  //
  //    Counted across the WHOLE `it` family, not just the landing: the landing
  //    holds one page of 100, so a landing-only count is a constant that says
  //    nothing about the corpus behind it — and it is this number check 5
  //    compares against the published manifest. Measured 2026-08-09 on
  //    svizzera: 100+100+100+100+100+100+49 = 649, exactly
  //    `manifest.counts.swissArticles`. The bare `<li>` pattern is what makes
  //    that exact — pagination and nav emit `<li class="…">`, which it does
  //    not match — and it is the same pattern the corpus workflow's own
  //    empty-archive gate uses.
  let itemCount = 0;
  const itArchive = archivePathsByLocale.it ?? [];
  for (const rel of itArchive) {
    const abs = path.join(distDir, rel);
    if (!fs.existsSync(abs)) continue;
    itemCount += (fs.readFileSync(abs, 'utf-8').match(/<li>/g) ?? []).length;
  }
  if (itArchive.length > 0 && itemCount < 1) {
    errors.push(
      `${section}: the IT archive (${itArchive.length} page(s)) lists 0 articles — refusing to publish an empty archive over the live one`,
    );
  } else if (itArchive.length > 0) {
    notes.push(`${section}: IT archive lists ${itemCount} items across ${itArchive.length} page(s)`);
  }

  // 4. No page may leave with a same-origin `/assets/` reference (issue
  //    #5270). This is the BYTE gate, deliberately separate from the
  //    source-order test: it holds even if the rewrite ever moves elsewhere.
  //    The deploy deletes `dist/assets`, so such a ref is a guaranteed 404 —
  //    no CSS, no SPA bundle, no AdSense loader on every page pushed.
  //
  //    Anchored on `src="` / `href="`: a healthy page still contains
  //    `href*="/assets/"` inside an inline CSS selector (the print-media swap),
  //    which is not a resource reference and must not fail anything.
  const assetRx = /(src|href)="\/assets\/[^"]/;
  const offenders = [];
  for (const locale of Object.keys(pathsByLocale)) {
    for (const rel of pathsByLocale[locale]) {
      const abs = path.join(distDir, rel);
      if (!fs.existsSync(abs)) continue;
      if (assetRx.test(fs.readFileSync(abs, 'utf-8'))) offenders.push(rel);
    }
  }
  if (offenders.length > 0) {
    errors.push(
      `${section}: ${offenders.length} rendered page(s) still carry same-origin /assets/ refs (404 in production — issue #5270). First: ${offenders.slice(0, 5).join(', ')}`,
    );
  }

  return { errors, notes, itemCount };
}

/**
 * Compare what the archive just listed against the published corpus manifest.
 * See MAX_ARTICLES_BEHIND for the regression this exists to prevent.
 *
 * The count is only a coarse guard. A published fast-path article can make the
 * live hub and `slugs.json` move ahead without changing the manifest count that
 * this checkout reads. The identity checks below therefore compare the local
 * registry with both published IDs and the cards already served by the hub.
 * Any unreadable external source fails closed: this function authorises a
 * destructive replacement of live bytes, so an unproved snapshot is not safe
 * to publish.
 */
export async function checkCorpusFreshness(section, itemCount, { localRegistry = readLocalRegistry(section) } = {}) {
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(LIVE_HUB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    return {
      ok: false,
      note: `${section}: corpus manifest unreachable (${err.message}) — refusing publication without a freshness proof`,
    };
  }
  const published =
    section === 'svizzera' ? manifest?.counts?.swissArticles : manifest?.counts?.articles;
  if (typeof published !== 'number') {
    return { ok: false, note: `${section}: manifest carries no usable count — refusing publication without a freshness proof` };
  }
  const behind = published - itemCount;
  if (behind > MAX_ARTICLES_BEHIND) {
    return {
      ok: false,
      note:
        `${section}: this checkout's archive lists ${itemCount} articles, the published corpus has ${published} ` +
        `(${behind} behind, tolerance ${MAX_ARTICLES_BEHIND}). Refusing to push a stale archive over a fresher live one — ` +
        'the corpus pull (sync-articles-sitemaps.yml) is behind; re-run this once it has caught up.',
    };
  }

  let publishedIds;
  try {
    publishedIds = await fetchPublishedSectionIds(section);
  } catch (err) {
    return {
      ok: false,
      note: `${section}: published registry unreadable (${err.message}) — refusing publication without an identity proof`,
    };
  }
  const missingIds = missingPublishedIds(localRegistry, publishedIds);
  const unpublishedIds = unpublishedLocalIds(localRegistry, publishedIds);
  if (missingIds.length > 0 || unpublishedIds.length > 0) {
    const mismatchDetails = [
      missingIds.length > 0 &&
        `published ids absent locally (${missingIds.slice(0, 5).join(', ')})`,
      unpublishedIds.length > 0 &&
        `local ids absent from the published registry (${unpublishedIds.slice(0, 5).join(', ')})`,
    ].filter(Boolean).join('; ');
    return {
      ok: false,
      note:
        `${section}: local and published article registry identities differ (${mismatchDetails}); ` +
        'refusing to publish a non-converged client registry',
    };
  }

  let liveHub;
  try {
    liveHub = await fetchLiveHubSlugs(section);
  } catch (err) {
    return {
      ok: false,
      note: `${section}: live hub unreadable (${err.message}) — refusing publication without a served-snapshot proof`,
    };
  }
  const missingLiveSlugs = missingLiveHubSlugs(localRegistry, liveHub.slugs);
  if (missingLiveSlugs.length > 0) {
    return {
      ok: false,
      note:
        `${section}: the live hub ${liveHub.url} contains ${missingLiveSlugs.length} article slug(s) absent from this checkout ` +
        `(for example ${missingLiveSlugs.slice(0, 5).join(', ')}); refusing to move the client behind the hub`,
    };
  }

  return {
    ok: true,
    note:
      `${section}: archive lists ${itemCount}, published corpus has ${published} ` +
      `(${behind} behind, tolerance ${MAX_ARTICLES_BEHIND}); registry and live hub identities converge`,
  };
}

/** Test seam — a test must not retain a mocked published registry between cases. */
export function __resetCorpusFreshnessCache() {
  publishedSlugsPromiseBySection.clear();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const leaseRequired = !args.dryRun;

  // Refuse an armed direct invocation before rendering or publishing anything.
  // The workflow is the only supported non-dry caller because it owns the
  // shared R2 section lease and its watcher paths.
  assertArticleChunkLease({ required: leaseRequired });

  // Before the first dynamic import of any build plugin — see the function's
  // own doc comment for why later is a no-op.
  pinRenderEnv();

  const sections = args.section === 'all' ? SECTIONS : [args.section];
  const targetLocales = args.locale === 'all' ? LOCALES : [args.locale];
  const outRoot = path.resolve(args.out);
  fs.mkdirSync(outRoot, { recursive: true });

  const summary = { generatedAt: new Date().toISOString(), dryRun: args.dryRun, sections: {} };
  let fatal = false;

  // The hub HTML and the client registry are two representations of the same
  // article snapshot. Render and validate every target section before
  // publishing any client chunk: the corpus-freshness guard needs the rendered
  // item count, and a stale checkout must not upload a registry only to fail
  // before its matching hub can be pushed. Once every section has passed its
  // local and freshness gates, strict companion/registry publication happens
  // before the shard push so a hub never becomes servable before its matching
  // client assets exist. On the armed workflow this all runs inside the shared
  // section lease.

  for (const section of sections) {
    // A scratch dist PER SECTION. Not an optimisation — the CDN offload is a
    // whole-dist walk and the topic sitemap is written per section, so sharing
    // one dist across sections would make each section's offload re-walk the
    // other's pages and give the push fan-out no way to tell them apart.
    const distDir = path.join(outRoot, section);
    fs.mkdirSync(distDir, { recursive: true });

    console.log(`${LOG} ── rendering ${section} hubs into ${distDir}`);
    const { hubResult, topicHubResult } = await renderHubsAndOffload({
      rootDir: ROOT_DIR,
      distDir,
      section,
      logPrefix: LOG,
    });

    const archivePathsByLocale = {};
    for (const locale of LOCALES) {
      archivePathsByLocale[locale] = hubResult.pathsByLocale?.[locale] ?? [];
    }
    const pathsByLocale = hubPathsByLocale({ hubResult, topicHubResult }, LOCALES);
    const totalPaths = Object.values(pathsByLocale).reduce((n, l) => n + l.length, 0);
    console.log(
      `${LOG} ${section}: ${hubResult.written} archive file(s) + ${topicHubResult.written} topic-hub file(s) written; ${totalPaths} path(s) to push`,
    );

    // A topic-hub render that produced nothing is NOT fatal — step 6b is
    // non-blocking by contract, and pushing the archive alone still repairs
    // half the problem. It is loud, though: this driver's whole reason to
    // exist is that nothing else re-renders the topic hubs at all.
    if (topicHubResult.written === 0) {
      console.warn(
        `::warning::${LOG} ${section}: the topic-hub render produced no files — pushing the archive only`,
      );
    }

    const { errors, notes, itemCount } = validateRenderedSection({
      section,
      distDir,
      pathsByLocale,
      archivePathsByLocale,
    });
    for (const n of notes) console.log(`${LOG} ${n}`);

    const freshness = await checkCorpusFreshness(section, itemCount);
    console.log(`${LOG} ${freshness.note}`);
    if (!freshness.ok) errors.push(freshness.note);

    if (errors.length > 0) {
      for (const e of errors) console.error(`::error::${LOG} ${e}`);
      fatal = true;
    }

    summary.sections[section] = {
      shardToken: shardTokenForSection(section),
      distDir,
      archiveWritten: hubResult.written,
      topicHubWritten: topicHubResult.written,
      archiveLandingByLocale: Object.fromEntries(
        LOCALES.map((l) => [l, findArchiveLanding(archivePathsByLocale[l])]),
      ),
      pathsByLocale,
      sitemapPath: topicHubResult.sitemapPath ?? null,
      announcedUrlCount: topicHubResult.announcedUrlPaths?.length ?? 0,
      validationErrors: errors,
    };
  }

  if (args.summary) {
    const summaryPath = path.resolve(args.summary);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
    console.log(`${LOG} summary written to ${summaryPath}`);
  }

  if (fatal) {
    console.error(`${LOG} validation failed — nothing pushed`);
    process.exit(1);
  }

  // No external client asset may move until every rendered section has passed
  // the freshness check above. Strict mode requires every upload and purge to
  // succeed; the lease is rechecked after the render, which may be long enough
  // for the watcher to report a loss.
  assertArticleChunkLease({ required: leaseRequired });
  await publishClientChunks(sections, args.dryRun);

  if (args.dryRun) {
    console.log(`${LOG} --dry-run set — rendered and validated, pushed nothing`);
    console.log(`${LOG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // The chunk publisher may take long enough for the lease watcher to report a
  // loss after its final purge. Do not start a shard mutation in that window.
  assertArticleChunkLease({ required: leaseRequired });

  // ── Push: ONE invocation per (section, locale) ────────────────────────────
  //
  // One, not several. Two pushes to the same shard repo seconds apart start
  // two concurrent GitHub Pages builds, and one of them goes `errored`
  // systematically — visible for days in frontaliere-articolisvizzera-it's
  // history as a PAIR of builds at the same minute. On 2026-08-06 11:34 both
  // failed and the origin served a 404 for hours with the commit sitting in
  // the shard. So the archive and the topic hubs travel together in a single
  // call, and this loop is deliberately not chunked:
  // push-article-shard-incremental.sh takes an arbitrary relpath list, and a
  // section+locale is ~30 archive pages + ~100 topic hubs ≈ 8 KB of argv,
  // three orders of magnitude under ARG_MAX. Chunking would reintroduce the
  // exact multi-build race this comment is about.
  //
  // Serial ACROSS locales: the watcher must be checked after each completed
  // mutation and before the next one. Four distinct shard repos could be
  // pushed in parallel, but doing so would start every mutation before a
  // failure file written during the first push could be observed. A failing
  // locale is still recorded and does not abort the other locales unless the
  // shared lease itself has been lost.
  const pushScript = path.join(ROOT_DIR, 'scripts', 'lib', 'push-article-shard-incremental.sh');
  const { pushFailed } = await pushRenderedLocales({
    sections,
    targetLocales,
    summary,
    pushScript,
  });

  if (args.summary) {
    fs.writeFileSync(path.resolve(args.summary), JSON.stringify(summary, null, 2) + '\n', 'utf-8');
  }

  console.log(`${LOG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (pushFailed) process.exit(1);
}

/**
 * Push one section's locale shards in order, rechecking the shared lease
 * between every mutation. `spawn` is injectable so the lease-loss boundary is
 * covered without starting real shard pushes in the unit test.
 */
export async function pushRenderedLocales({
  sections,
  targetLocales,
  summary,
  pushScript,
  spawn: spawnCommand = spawnAsync,
}) {
  let pushFailed = false;

  for (const section of sections) {
    const entry = summary.sections[section];
    const results = [];
    for (const locale of targetLocales) {
      const relpaths = entry.pathsByLocale[locale] ?? [];
      if (relpaths.length === 0) {
        console.log(`${LOG} ${entry.shardToken}-${locale}: nothing to push`);
        results.push({ locale, status: 0 });
        continue;
      }
      // This check is deliberately adjacent to the mutation. If the watcher
      // writes the failure file while the previous locale is pushing, this
      // throws before the next locale can invoke the shard push.
      assertArticleChunkLease({ required: true });
      console.log(`${LOG} pushing ${relpaths.length} path(s) to ${entry.shardToken}-${locale}`);
      const { status } = await spawnCommand(
        'bash',
        [pushScript, entry.shardToken, locale, entry.distDir, ...relpaths],
        { stdio: 'inherit', env: process.env, cwd: ROOT_DIR },
      );
      results.push({ locale, status });
    }
    entry.pushedLocales = results.filter((r) => r.status === 0).map((r) => r.locale);
    for (const r of results) {
      if (r.status !== 0) {
        console.error(
          `::warning::${LOG} ${entry.shardToken}-${r.locale} push failed (exit ${r.status}) — continuing with the other locales`,
        );
        pushFailed = true;
      }
    }
  }

  return { pushFailed };
}

// Standalone only when invoked directly (repo idiom — see
// scripts/rerender-article-corpus.mjs), so a plain `import` of this module
// cannot execute a whole side-effecting run.
if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error(`${LOG} fatal error:`, err);
    process.exit(1);
  });
}
