#!/usr/bin/env node
/**
 * purge-changed-cdn-assets.mjs — targeted Cloudflare purge for the CDN keys an
 * R2 sync actually re-uploaded.
 *
 * WHY THIS EXISTS (issues #5034/#5035/#5036/#5052/#5081/#5092/#5093/#5094 —
 * `CF 5xx: cdn.frontaliereticino.ch/assets/*` — and the version-skew family
 * #5062/#4644):
 *
 * `cdn.frontaliereticino.ch` is a Cloudflare R2 bucket custom domain (bucket
 * `frontaliere-cdn`, verified live via the R2 `domains/custom` API — NOT the
 * GitHub Pages repo of the same name, which several earlier triage passes
 * assumed). The zone cache rule `cdn-r2-passthrough-cache` (rule 5 of ruleset
 * d738dd4c3c32463ba40f1ac6bdd74d78, managed by cf-locale-failover-setup.mjs)
 * sets `edge_ttl: { mode: 'respect_origin' }` for that host, so the EDGE TTL is
 * whatever Cache-Control the R2 object carries.
 *
 * Bundle filenames on this site are STABLE, not content-hashed (see
 * tests/stable-asset-names.test.ts) — bytes change UNDER the same URL on every
 * code deploy. That makes a long edge TTL safe ONLY if something invalidates
 * the edge when those bytes change. The single mechanism that did so was
 * `cf-purge-cache.mjs` (`purge_everything`) in post-deploy-validate-live.yml,
 * which is (a) a reusable workflow reached only from deploy-publish.yml, itself
 * gated on `github.event.workflow_run.conclusion == 'success'`, (b) further
 * gated on `steps.propagation.outcome == 'success'`, and (c)
 * `continue-on-error: true`. In practice that gate chain does not clear: at the
 * time this script was added, deploy-publish.yml had 0 successful runs in its
 * last 60 (34 skipped / 5 failure / 1 cancelled), so the edge was never purged
 * while R2 kept receiving new bytes under the same stable keys.
 *
 * The result is unbounded edge staleness on mutable URLs: different PoPs (and
 * different chunks within one PoP) end up holding bytes from DIFFERENT builds,
 * which is exactly the cross-chunk version skew services/resilientImport.ts
 * exists to recover from — the SyntaxError "does not provide an export named X"
 * (#5062) and "error loading dynamically imported module" (#4644) shapes.
 *
 * THE FIX, and why it is targeted rather than `purge_everything`:
 *   - `purge_everything` is a zone-wide sledgehammer on a host serving ~634k
 *     eyeball requests/day at a ~93% hit ratio. Dropping all of that at once
 *     produces a cold-fill stampede against R2; the edge→origin failures that
 *     stampede causes are logged as `originResponseStatus: 0` (origin returned
 *     nothing at all) and surface to real users and to Googlebot as a synthetic
 *     502 — the literal signal the cf-5xx-monitor issues are reporting.
 *   - Only the objects rclone actually re-uploaded need invalidating. A deploy
 *     changes a handful of the 661 distinct `/assets/*` keys, so a targeted
 *     purge keeps ~all of the edge cache warm and touches origin for only the
 *     keys that genuinely changed.
 *
 * This reuses `scripts/cf-purge-cache.mjs --files=` (its documented TARGETED
 * mode, already used by scripts/publish-edge-files.mjs) rather than
 * re-implementing the purge call — AGENTS.md #6, no second copy of that
 * construct. Cloudflare's free plan caps a `files` purge at 30 URLs, and
 * cf-purge-cache.mjs treats >30 as a hard error rather than truncating
 * silently, so batching into groups of 30 is this script's job.
 *
 * FAILURE POSTURE: always exits 0. A missed purge degrades to "the edge serves
 * the previous bytes until the object's own max-age lapses" — the bounded
 * staleness the companion Cache-Control change in deploy-it-pages-prep.sh
 * guarantees — which must never fail a deploy that otherwise succeeded. Every
 * failure is surfaced as a ::warning:: instead.
 *
 * USAGE:
 *   node scripts/ci/purge-changed-cdn-assets.mjs <rclone-json-log> <key-prefix>
 *     <rclone-json-log>  file written by `rclone --use-json-log -v --log-file=…`
 *     <key-prefix>       R2 key prefix the sync targeted, e.g. `assets`
 *
 * Env: CF_API_TOKEN (needs Zone→Cache Purge) — absent is a no-op exit 0,
 *      handled by cf-purge-cache.mjs itself. CDN_PURGE_BASE overrides the
 *      public origin (default https://cdn.frontaliereticino.ch).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
// The purge cap lives in ONE place (AGENTS.md #6). cf-purge-cache.mjs — which
// enforces the same cap — cannot be imported for it: that script does its work
// at module scope and calls process.exit(), so importing it would fire a real
// purge as a side effect.
import { MAX_TARGETED_FILES } from '../lib/cf-purge-limits.mjs';

/** Cloudflare free-plan `files` purge cap, batched up to exactly. */
export const PURGE_BATCH_SIZE = MAX_TARGETED_FILES;

/**
 * Defensive ceiling on how many keys one invocation will purge. The bucket only
 * holds ~661 distinct `/assets/*` keys, so a run asking for more than this means
 * the log parse went wrong (or a full re-upload happened, e.g. the first sync
 * after a Cache-Control change re-PUTs everything). Purging is still correct in
 * that case, but doing it in ~23+ API calls back-to-back is worth flagging.
 */
export const MAX_KEYS_PER_RUN = 1000;

export const DEFAULT_CDN_BASE = 'https://cdn.frontaliereticino.ch';

/**
 * Extract the object keys rclone actually TRANSFERRED from its JSON log.
 *
 * rclone emits one JSON object per line with `--use-json-log`; a byte transfer
 * is logged at level `info` with a msg of the `Copied (new)` /
 * `Copied (replaced existing)` family and an `object` field holding the path
 * RELATIVE to the sync source dir. Metadata-only events ("Updated modification
 * time"), skips ("Unchanged skipping") and stats lines carry a different msg and
 * are deliberately NOT matched: purging a key whose bytes did not change would
 * evict a warm edge entry for nothing, which is the exact cost this script
 * exists to avoid.
 *
 * Malformed/partial lines are skipped rather than thrown on — the log is
 * best-effort diagnostic output, and one truncated line must not cost the whole
 * purge.
 *
 * @param {string} logText   raw contents of the rclone JSON log
 * @param {string} keyPrefix R2 key prefix the sync wrote to (e.g. `assets`)
 * @returns {string[]} de-duplicated R2 keys, e.g. `assets/SiteSearch.js`
 */
export function parseTransferredKeys(logText, keyPrefix) {
  const prefix = String(keyPrefix || '').replace(/^\/+|\/+$/g, '');
  const keys = new Set();
  for (const line of String(logText || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // truncated / interleaved line — ignore, never throw
    }
    const msg = typeof entry?.msg === 'string' ? entry.msg : '';
    const object = typeof entry?.object === 'string' ? entry.object : '';
    if (!object) continue;
    // `Copied (new)`, `Copied (replaced existing)`, `Multi-thread Copied (new)`.
    if (!/\bCopied\b/.test(msg)) continue;
    const rel = object.replace(/^\/+/, '');
    keys.add(prefix ? `${prefix}/${rel}` : rel);
  }
  return [...keys];
}

/** Split `items` into consecutive batches of at most `size`. */
export function batch(items, size = PURGE_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Absolute, correctly-encoded public URL for an R2 key. Built through `URL` so
 * a key containing a character that must be percent-encoded cannot produce a
 * malformed purge entry (Cloudflare rejects the whole batch on one bad URL).
 */
export function keyToUrl(key, base = DEFAULT_CDN_BASE) {
  return new URL(key.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`).href;
}

function main(argv) {
  const [logPath, keyPrefix] = argv;
  if (!logPath || !keyPrefix) {
    console.log('[purge-changed-cdn-assets] usage: <rclone-json-log> <key-prefix> — skipping');
    return;
  }

  let logText = '';
  try {
    logText = readFileSync(logPath, 'utf8');
  } catch (err) {
    console.log(`[purge-changed-cdn-assets] no rclone log at ${logPath} (${err.code}) — nothing to purge`);
    return;
  }

  const keys = parseTransferredKeys(logText, keyPrefix);
  if (keys.length === 0) {
    console.log(`[purge-changed-cdn-assets] no ${keyPrefix}/ objects re-uploaded — edge stays warm, no purge needed`);
    return;
  }
  if (keys.length > MAX_KEYS_PER_RUN) {
    console.log(
      `::warning::[purge-changed-cdn-assets] ${keys.length} changed ${keyPrefix}/ keys exceeds MAX_KEYS_PER_RUN=${MAX_KEYS_PER_RUN} — purging the first ${MAX_KEYS_PER_RUN} (rest fall back to their Cache-Control max-age)`,
    );
    keys.length = MAX_KEYS_PER_RUN;
  }

  const base = process.env.CDN_PURGE_BASE || DEFAULT_CDN_BASE;
  const batches = batch(keys.map((k) => keyToUrl(k, base)));
  const purgeScript = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cf-purge-cache.mjs');

  let purged = 0;
  for (const [i, urls] of batches.entries()) {
    try {
      execFileSync('node', [purgeScript, `--files=${urls.join(',')}`], { stdio: 'inherit' });
      purged += urls.length;
    } catch (err) {
      // Non-fatal by design: the object's own max-age still bounds staleness.
      console.log(
        `::warning::[purge-changed-cdn-assets] batch ${i + 1}/${batches.length} failed (${err.message}) — those keys stay edge-cached until max-age lapses`,
      );
    }
  }
  // "dispatched", not "purged": cf-purge-cache.mjs is itself a no-op exit-0
  // when CF_API_TOKEN is absent, so a clean run here does not by itself prove
  // the edge was invalidated — that script's own output is authoritative.
  console.log(
    `[purge-changed-cdn-assets] dispatched purge for ${purged}/${keys.length} changed ${keyPrefix}/ key(s) in ${batches.length} batch(es)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
