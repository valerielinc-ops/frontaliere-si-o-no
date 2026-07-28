#!/usr/bin/env -S npx -y tsx
// publish-article-chunks.mjs (issue #4881 Fase 3-bis) — publish the CLIENT-SIDE
// article data chunks (`blog-articles-data.js`, `swiss-articles-data.js`) plus a
// slim news-ticker payload to the CDN, OUTSIDE the full Vite/Rollup build, so a
// fast-published article shows up in the in-app article list, in-app search
// (SiteSearch.tsx) AND the homepage news ticker (NewsFeed.tsx) without waiting
// for deploy.yml's full SSG build (30min-2h04m, see fast-publish-article.yml).
//
// MECHANISM: `data/blog-articles-data.ts` / `data/swiss-articles-data.ts` are
// standalone ESM modules with exactly ONE runtime import each
// (`../services/seo/blogImageCdn`), deliberately written with a relative (not
// `@/`) import so vite.config.ts's OWN config graph (which cannot resolve `@/`)
// can import them directly (see build-plugins/newsTickerDataPlugin.ts). That
// same property makes them independently bundleable with esbuild, no Rollup or
// vite.config involved: `esbuild <file> --bundle --format=esm --minify
// --alias:@=.` reproduces the live Rollup chunk near-byte-for-byte (verified:
// 704,466 bytes here vs the live chunk's 704,460 — a 6-byte delta from
// minifier internal-name numbering only; exported `ARTICLES`, all 3,021
// article ids, diff clean).
//
// STABLE CHUNK NAME (verified by READING vite.config.ts, not by running a full
// build — a full local SEO build OOMs, see AGENTS.md "Build And Test"):
// `rollupOptions.output.chunkFileNames` (~line 665) is a function that only
// special-cases facadeModuleIds matching a `services/locales/blog-body(-ch)?/
// <locale>/` regex (the per-locale article-BODY chunks). Neither
// `data/blog-articles-data.ts` nor `data/swiss-articles-data.ts` matches that
// regex, so both fall through to `assets/${adFilterSafeChunkName(chunk.name)}.js`.
// `adFilterSafeChunkName` (build-plugins/shared/adFilterSafeChunkName.ts) only
// rewrites `firebase`/`analytics`/`recaptcha`/`adblock` substrings — a no-op for
// both names. The emitted names are therefore STABLE / non-content-hashed:
//   assets/blog-articles-data.js
//   assets/swiss-articles-data.js
// — the whole site's documented chunk-naming architecture (every JS/CSS chunk
// is stable-named; see vite.config.ts's own rollupOptions.output doc comment),
// not something introduced here. `blog-articles-data.js` additionally has
// PRE-EXISTING literal-string references in shipped code
// (components/community/BlogArticles.tsx, components/shared/SiteSearch.tsx,
// components/community/JobBoard.tsx,
// tests/community/BlogArticles.resilient-import.test.tsx,
// build-plugins/newsTickerDataPlugin.ts) — independent, stronger evidence the
// name is already relied upon in production. `swiss-articles-data.js` has no
// such literal reference anywhere in the repo (only `.ts` source-path
// references), so its stability verdict rests on the vite.config.ts reasoning
// above alone, not on pre-existing production evidence.
//
// CDN CACHE / VERSION SKEW: the R2 `assets/` prefix is synced at full-deploy
// time with `Cache-Control: public, max-age=31536000, immutable`
// (scripts/lib/deploy-it-pages-prep.sh `_r2_sync`), and the Cloudflare zone
// rule `cdn-r2-passthrough-cache` (infra/cloudflare/rules.md) sets
// `edge_ttl: { mode: 'respect_origin' }` — so the EDGE itself can hold this key
// fresh for up to a year absent an explicit purge. The separate zone rule
// `cdn-assets-revalidate` (http_response_headers_transform phase) rewrites the
// Cache-Control the BROWSER receives to `public, max-age=600, must-revalidate`,
// but that is a response-header rewrite on the way OUT — a different, later
// phase than the one that decided whether the edge's OWN cached copy was
// fresh. The documented "~10 min worst case" is therefore a BROWSER-cache
// bound, not necessarily the edge one (the existence of the separate, stronger
// `early-boot-js-no-cache` rule for the one script that must self-heal every
// other chunk is itself evidence the general `/assets/*` rule's guarantee was
// judged browser-side only). Because this script's PUT bypasses the normal
// full-deploy → validate-live → cf-purge-cache.mjs `purge_everything` safety
// net entirely, it performs its OWN narrow, TARGETED purge (`purge_cache` with
// a `files` list — never `purge_everything`) for exactly the keys it just
// uploaded, immediately after each successful upload. It also asks
// upload-cdn-file.sh for a short Cache-Control on these specific keys instead
// of the full-deploy default, so any FUTURE edge fetch-through (after this
// purge, before the next full deploy re-syncs the immutable header) also
// settles quickly. Together: purge fixes the CURRENT publish regardless of
// which edge-caching interpretation is correct; the short TTL is defense in
// depth for the window between now and the next full deploy.
//
// resilientImport (services/resilientImport.ts) is ORTHOGONAL to this script's
// correctness: it only engages when a dynamic import throws (chunk-load
// error) or fails its shape check. A successful PUT that still validates
// (array present, non-empty) never triggers it — nothing "breaks" for the
// client to heal from. It remains an unchanged safety net for a genuinely
// malformed/partial upload.
//
// ZONE RESOLUTION: `resolveZoneId`/`REST_BASE`/`DEFAULT_ZONE_NAME` are
// imported from scripts/lib/cf-analytics.mjs — the module 8 of 11 sibling CF
// scripts already share (cf-otto-route-monitor.mjs, dmarc-monitor.mjs,
// build-cf-hot-404s.mjs, audit-ai-crawlers.mjs, cf-status-report.mjs,
// ensure-cdn-fonts-redirect.mjs, discover-404s-via-cloudflare.mjs,
// ensure-image-cdn-redirect.mjs), NOT redeclared inline here. cf-purge-cache.mjs
// / cf-email-worker-setup.mjs / cf-locale-failover-setup.mjs still carry their
// own pre-extraction inline copy — legacy outliers, not the pattern to follow
// for new code (AGENTS.md #6: this construct is already extracted; copying it
// again would be exactly the drift the extraction exists to prevent).
//
// `purgeCdnFiles()` below (targeted `{files:[...]}` purge) has no shared
// helper to import: cf-analytics.mjs is read-only (GraphQL analytics), and
// cf-purge-cache.mjs's own purge call is a private, non-exported statement
// inside a standalone script (`process.exit()` on failure — unsafe to import
// into this script's non-fatal, best-effort control flow) doing
// `{purge_everything:true}`, a different call shape than the targeted
// `{files:[...]}` this script needs. Kept local — a genuinely new construct,
// not a copy of an existing shared one.
//
// CLI (no npm ci in this job — see fast-publish-article.yml's own comment;
// esbuild is invoked via `npx -y` on demand, exactly like tsx@4 already is):
//   npx -y tsx scripts/publish-article-chunks.mjs [--dry-run]
// Always (re)publishes BOTH registries — cheap and idempotent (rclone
// --checksum skips an unchanged re-PUT), and this workflow step doesn't know
// in isolation which registry(ies) the just-rendered article touched.
//
// Exit: ALWAYS 0. Every failure mode (esbuild missing, shape mismatch, R2
// creds absent, upload failure, purge failure) is reported via
// `::warning::`/console.error and swallowed — this step sits in the
// fast-publish workflow with the SAME best-effort posture as the existing
// "Upload CDN assets (images)" step: the article is fully published even if
// this script never runs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeTickerArticles } from '../build-plugins/newsTickerDataPlugin.ts';
import { REST_BASE, DEFAULT_ZONE_NAME, resolveZoneId } from './lib/cf-analytics.mjs';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CDN_BASE = 'https://cdn.frontaliereticino.ch';
// Pinned to package.json's devDependencies "esbuild": "^0.25.12" — same
// determinism rationale as publish-article-fast.mjs pinning `tsx@4`.
const ESBUILD_VERSION = '0.25.12';

/** The two client-loaded article registries this script keeps CDN-fresh. */
export const REGISTRIES = [
  {
    source: 'data/blog-articles-data.ts',
    cdnKey: 'assets/blog-articles-data.js',
    exportName: 'ARTICLES',
  },
  {
    source: 'data/swiss-articles-data.ts',
    cdnKey: 'assets/swiss-articles-data.js',
    exportName: 'SWISS_ARTICLES',
  },
];

// Short override so any edge fetch-through after this publish settles quickly
// (see header comment) — applies ONLY to these two out-of-band PUTs, not the
// full-deploy R2 sync (deploy-it-pages-prep.sh keeps its own 1-year immutable
// policy for the normal build path).
export const CHUNK_CACHE_CONTROL = 'public, max-age=300, must-revalidate';
export const TICKER_CDN_KEY = 'data/news-ticker-live.json';
export const TICKER_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

// Lazily resolved: `esbuild`'s own JS API is used when the package happens to
// be resolvable (the vitest CI job runs `npm ci` first, so it's always
// present there — no subprocess, no network, no flake risk in the test-gate
// path). The fast-publish workflow deliberately runs with NO `npm ci` (see
// its own comment), so `import('esbuild')` fails there and this falls back to
// the verified `npx -y esbuild@<pinned>` CLI invocation — the one actually
// exercised in production for this feature.
let esbuildApiPromise;
function getEsbuildApi() {
  if (!esbuildApiPromise) {
    esbuildApiPromise = import('esbuild').catch(() => null);
  }
  return esbuildApiPromise;
}

/**
 * Rebuild one registry module standalone with esbuild — no Rollup/vite.config
 * involved. Pure/testable: caller supplies rootDir + outFile so vitest can
 * point this at the real repo without any network/CDN side effect.
 */
export async function buildRegistryChunk(rootDir, sourceRel, outFile) {
  const src = path.join(rootDir, sourceRel);
  const api = await getEsbuildApi();
  if (api) {
    await api.build({
      entryPoints: [src],
      bundle: true,
      format: 'esm',
      minify: true,
      alias: { '@': rootDir },
      absWorkingDir: rootDir,
      outfile: outFile,
    });
    return;
  }
  execFileSync(
    'npx',
    [
      '-y',
      `esbuild@${ESBUILD_VERSION}`,
      src,
      '--bundle',
      '--format=esm',
      '--minify',
      '--alias:@=.',
      `--outfile=${outFile}`,
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
}

/**
 * Structural validation before anything gets uploaded: the rebuilt module
 * must import cleanly and export a non-empty array under `exportName`. Throws
 * on failure — callers decide whether that's fatal for their context (the CLI
 * `main()` below treats it as non-fatal, per this script's best-effort
 * posture; the vitest test treats it as a real failure).
 */
export async function validateRegistryChunk(outFile, exportName) {
  const mod = await import(pathToFileURL(outFile).href);
  const value = mod[exportName];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[publish-article-chunks] ${outFile} export "${exportName}" is not a non-empty array`);
  }
  return value;
}

async function cf(token, method, apiPath, body) {
  const res = await fetch(`${REST_BASE}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Targeted purge — `files` list, never `purge_everything` (see header comment). */
export async function purgeCdnFiles(token, resolvedZoneId, urls) {
  const { json } = await cf(token, 'POST', `/zones/${resolvedZoneId}/purge_cache`, { files: urls });
  if (!json?.success) {
    throw new Error(`[publish-article-chunks] targeted purge failed: ${JSON.stringify(json?.errors)}`);
  }
}

async function uploadViaScript(localFile, cdnKey, cacheControl) {
  execFileSync('bash', [path.join(ROOT_DIR, 'scripts/lib/upload-cdn-file.sh'), localFile, cdnKey, cacheControl], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-article-chunks-'));
  const uploadedKeys = [];
  let blogArticles = null;

  for (const registry of REGISTRIES) {
    const outFile = path.join(tmpDir, path.basename(registry.cdnKey));
    try {
      console.log(`[publish-article-chunks] rebuilding ${registry.source} -> ${outFile}`);
      await buildRegistryChunk(ROOT_DIR, registry.source, outFile);
      const value = await validateRegistryChunk(outFile, registry.exportName);
      console.log(`[publish-article-chunks] ${registry.exportName}: ${value.length} entries`);
      if (registry.exportName === 'ARTICLES') blogArticles = value;

      if (dryRun) {
        console.log(`[publish-article-chunks] --dry-run: skipping upload of ${registry.cdnKey}`);
        continue;
      }
      uploadViaScript(outFile, registry.cdnKey, CHUNK_CACHE_CONTROL);
      uploadedKeys.push(registry.cdnKey);
    } catch (err) {
      console.log(
        `::warning::[publish-article-chunks] ${registry.source} publish failed — client keeps serving the last full-build chunk: ${err.message}`,
      );
    }
  }

  // News-ticker payload — reuses computeTickerArticles unchanged (same
  // fallback-chain logic the build-time module already ships), just fed the
  // FRESH registry above instead of a stale static import. Only meaningful
  // for the frontaliere registry (the ticker has only ever tracked
  // data/blog-articles-data.ts — see build-plugins/newsTickerDataPlugin.ts).
  if (blogArticles) {
    try {
      const ticker = computeTickerArticles(fs, path, ROOT_DIR, blogArticles);
      if (ticker.length === 0) {
        throw new Error('computeTickerArticles returned 0 articles');
      }
      const tickerFile = path.join(tmpDir, 'news-ticker-live.json');
      fs.writeFileSync(tickerFile, JSON.stringify(ticker));
      if (dryRun) {
        console.log(`[publish-article-chunks] --dry-run: skipping upload of ${TICKER_CDN_KEY}`);
      } else {
        uploadViaScript(tickerFile, TICKER_CDN_KEY, TICKER_CACHE_CONTROL);
        uploadedKeys.push(TICKER_CDN_KEY);
      }
    } catch (err) {
      console.log(`::warning::[publish-article-chunks] news-ticker payload publish failed — client ticker keeps its build-time top-5: ${err.message}`);
    }
  }

  if (dryRun || uploadedKeys.length === 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.log('[publish-article-chunks] CF_API_TOKEN not set — skipping targeted CDN purge (non-fatal; short Cache-Control override still bounds staleness).');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  try {
    const zoneId = await resolveZoneId(token, process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME, process.env.CF_ZONE_ID);
    const urls = uploadedKeys.map((key) => `${CDN_BASE}/${key}`);
    await purgeCdnFiles(token, zoneId, urls);
    console.log(`[publish-article-chunks] purged ${urls.length} CDN url(s): ${urls.join(', ')}`);
  } catch (err) {
    console.log(`::warning::[publish-article-chunks] targeted CDN purge failed — edge may serve a stale chunk until Cache-Control: ${CHUNK_CACHE_CONTROL} expires: ${err.message}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((err) => {
    // Never fail the workflow step from an uncaught rejection — see header
    // "Exit: ALWAYS 0".
    console.log(`::warning::[publish-article-chunks] unexpected error: ${err?.message ?? err}`);
  });
}
