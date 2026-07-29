#!/usr/bin/env node
/**
 * publish-edge-files.mjs — pushable-origin publish step (issue #4881 Fase 3).
 *
 * scripts/create-article.mjs already regenerates sitemap/RSS into `public/`
 * in the SAME commit as a fast-published article — the content is correct
 * the moment that commit lands. What is NOT fast is where those apex paths
 * are SERVED from: today they are pure Cloudflare passthrough to the
 * monolithic full-deploy origin, which can lag the fast-published commit
 * by hours (see infra/cloudflare-worker/locale-router.js's file-header
 * comment). This script closes that gap for the handful of paths registered
 * in EDGE_PUSHED_FILES: it PUTs the checked-out repo's current copy of each
 * one to R2 (via scripts/lib/upload-cdn-file.sh), then purges just those
 * exact URLs so the Worker's next request for them (servePushedEdgeFile in
 * locale-router.js) sees the fresh copy immediately instead of waiting out
 * EDGE_PUSHED_CACHE_TTL.
 *
 * Single source of truth: EDGE_PUSHED_FILES / CDN_BASE / EDGE_PUSHED_CACHE_TTL
 * are imported straight from locale-router.js (named exports, same pattern
 * already used by SECTION_ROUTES) rather than a second hardcoded copy of the
 * path/key table — adding a rollout path is then ONE object-literal entry
 * there (+ one wrangler.toml route), never two places that can drift apart.
 *
 * Local-file convention, two sources depending on the entry:
 *   - default (no `source` field): a registered pathname `/foo.xml` is
 *     expected to live at `public/foo.xml` in the checked-out repo — a plain
 *     static file regenerated and committed as-is (sitemap-blog-ch.xml).
 *   - `source: 'generated'`: NOT static — scripts/create-article.mjs never
 *     touches llms.txt, and public/llms.txt itself is a stale placeholder
 *     that must never be patched in place (see generate-llms-txt.mjs's own
 *     header on why — its date/count substitutions are only idempotent
 *     against the pristine seed). Before the main loop, runLlmsGenerator()
 *     below renders the current llms.txt family into a scratch dir via
 *     `npx -y tsx@4 scripts/generate-llms-txt.mjs` (needs tsx: the generator
 *     transitively imports build-plugins/sitemapAliasPlugin.ts), and
 *     'generated' entries resolve their local file from THAT scratch dir
 *     instead of public/ — same relative path (pathname minus the leading
 *     slash), since generateLlmsTxtFamily writes distDir/llms.txt,
 *     distDir/llms-full.txt, distDir/.well-known/llms.txt, mirroring the
 *     pathnames exactly. Fails open like everything else here: if the
 *     generator subprocess errors, the scratch dir simply won't have that
 *     file, and the existing existsSync check below skips it with the same
 *     ::warning:: as any other missing local file — no special-casing needed.
 *
 * Fail-open, matching every other step in the fast-publish pipeline: a
 * missing local file, missing R2 credentials, or a failed upload/purge is
 * logged (::warning::) and never exits non-zero for that reason alone — the
 * fast-published article stays live via the render/shard-push steps that ran
 * before this one regardless, and the next full deploy.yml run re-syncs
 * everything from scratch anyway. Exit 1 is reserved for a genuinely
 * unexpected top-level failure (so it's still visible in the Actions run
 * summary under `continue-on-error: true`), not for these expected skips.
 *
 * Usage: node scripts/publish-edge-files.mjs
 * Requires the same R2_* env vars as scripts/lib/upload-cdn-file.sh, plus
 * CF_API_TOKEN + CF_ZONE_ID for the purge (all provisioned in CI by
 * `node scripts/load-rc-env.mjs`, already run earlier in this workflow for
 * the CDN image-upload step).
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EDGE_PUSHED_FILES, CDN_BASE, EDGE_PUSHED_CACHE_TTL } from '../infra/cloudflare-worker/locale-router.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const LIVE_ORIGIN = 'https://frontaliereticino.ch';
const GENERATED_SCRATCH_DIR = path.join(os.tmpdir(), 'publish-edge-files-llms');

/**
 * Runs upload-cdn-file.sh for one file and reports whether the PUT actually
 * happened. upload-cdn-file.sh's own documented "Failure posture" is: exit 0
 * for EVERY runtime failure mode (missing local file, missing R2 creds,
 * rclone install failure, upload failure) — only a bad-usage arg-count
 * mismatch is non-zero. Its own header says the reliable signal is grepping
 * stdout for "✅ uploaded", so that's what this checks rather than the exit
 * code (which would otherwise make every skip look like a success).
 */
function uploadFile(localFile, cdnKey, cacheControl) {
  const result = spawnSync(
    'bash',
    [path.join(REPO_ROOT, 'scripts/lib/upload-cdn-file.sh'), localFile, cdnKey, cacheControl],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  return output.includes('✅ uploaded');
}

/**
 * Renders the llms.txt family into GENERATED_SCRATCH_DIR so 'generated'-source
 * EDGE_PUSHED_FILES entries have a fresh local file to PUT (see the header
 * comment's "Local-file convention"). Fail-open: any subprocess error is
 * logged (::warning::) and swallowed — the scratch dir then simply lacks the
 * rendered files, which the main loop's existing existsSync check already
 * treats as "nothing to publish this run" for each affected entry, same as a
 * missing public/ file today.
 */
function runLlmsGenerator() {
  const result = spawnSync(
    'npx',
    ['-y', 'tsx@4', path.join(REPO_ROOT, 'scripts/generate-llms-txt.mjs'), '--root', REPO_ROOT, '--out', GENERATED_SCRATCH_DIR],
    { encoding: 'utf8' },
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    console.warn(
      '::warning::[publish-edge-files] scripts/generate-llms-txt.mjs failed — generated EDGE_PUSHED_FILES entries will be skipped this run (edge just keeps serving the previous R2 copy or falls open to origin).',
    );
  }
}

function main() {
  const purgeUrls = [];

  if (Object.values(EDGE_PUSHED_FILES).some((entry) => entry.source === 'generated')) {
    runLlmsGenerator();
  }

  for (const [pathname, entry] of Object.entries(EDGE_PUSHED_FILES)) {
    const localFile =
      entry.source === 'generated'
        ? path.join(GENERATED_SCRATCH_DIR, pathname.slice(1))
        : path.join(REPO_ROOT, 'public', pathname);
    if (!existsSync(localFile)) {
      console.warn(
        `::warning::[publish-edge-files] no local file at ${localFile} for registered path ${pathname} — skipping (edge just keeps serving the previous R2 copy or falls open to origin)`,
      );
      continue;
    }

    const cacheControl = `public, max-age=${EDGE_PUSHED_CACHE_TTL}`;
    const uploaded = uploadFile(localFile, entry.cdnKey, cacheControl);
    if (!uploaded) {
      console.warn(
        `::warning::[publish-edge-files] upload-cdn-file.sh did not report a successful PUT for ${entry.cdnKey} — not purging (nothing changed at that key; see upload-cdn-file.sh's own warning above for the reason)`,
      );
      continue;
    }

    purgeUrls.push(`${LIVE_ORIGIN}${pathname}`);
    purgeUrls.push(new URL(entry.cdnKey, CDN_BASE).toString());
  }

  if (purgeUrls.length === 0) {
    console.log('[publish-edge-files] nothing published this run — nothing to purge');
    return;
  }

  console.log(`[publish-edge-files] purging ${purgeUrls.length} URL(s): ${purgeUrls.join(', ')}`);
  const purge = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/cf-purge-cache.mjs'), `--files=${purgeUrls.join(',')}`],
    { stdio: 'inherit' },
  );
  if (purge.status !== 0) {
    // cf-purge-cache.mjs already emits its own ::warning:: with the real
    // staleness window on this path (targeted-purge failure) — no need to
    // duplicate that message, just don't let it fail this step.
    console.warn('[publish-edge-files] cf-purge-cache.mjs reported a non-zero exit — see its warning above.');
  }
}

// Run as standalone only if invoked directly (repo idiom — see
// scripts/audit-footer-root-presence.mjs). Guards against a plain `import`
// of this module executing its whole side-effecting run.
const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`::error::[publish-edge-files] unexpected failure: ${err.message}`);
    process.exit(1);
  }
}
