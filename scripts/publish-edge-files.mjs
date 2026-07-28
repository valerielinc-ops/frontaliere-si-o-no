#!/usr/bin/env node
/**
 * publish-edge-files.mjs — pushable-origin publish step (issue #4881 Fase 3).
 *
 * scripts/create-article.mjs already regenerates sitemap/RSS/llms.txt into
 * `public/` in the SAME commit as a fast-published article — the content is
 * correct the moment that commit lands. What is NOT fast is where those
 * apex paths are SERVED from: today they are pure Cloudflare passthrough to
 * the monolithic full-deploy origin, which can lag the fast-published commit
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
 * Local-file convention: a registered pathname `/foo.xml` is expected to
 * live at `public/foo.xml` in the checked-out repo — true for the current
 * (sitemap-blog-ch.xml) entry, which is a plain static file regenerated and
 * committed as-is. llms.txt is NOT static (see scripts/generate-llms-txt.mjs)
 * — it needs a render step before it can be PUT — so it deliberately is not
 * yet an EDGE_PUSHED_FILES entry; wiring that in is a separate, later step
 * of the same rollout, not something this script needs to special-case now.
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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EDGE_PUSHED_FILES, CDN_BASE, EDGE_PUSHED_CACHE_TTL } from '../infra/cloudflare-worker/locale-router.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const LIVE_ORIGIN = 'https://frontaliereticino.ch';

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

function main() {
  const purgeUrls = [];

  for (const [pathname, entry] of Object.entries(EDGE_PUSHED_FILES)) {
    const localFile = path.join(REPO_ROOT, 'public', pathname);
    if (!existsSync(localFile)) {
      console.warn(
        `::warning::[publish-edge-files] no local file at public${pathname} for registered path ${pathname} — skipping (edge just keeps serving the previous R2 copy or falls open to origin)`,
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

try {
  main();
} catch (err) {
  console.error(`::error::[publish-edge-files] unexpected failure: ${err.message}`);
  process.exit(1);
}
