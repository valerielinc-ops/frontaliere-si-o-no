#!/usr/bin/env node
/**
 * purge-changed-cdn-assets.mjs — targeted Cloudflare purge for the CDN keys whose
 * R2 bytes the edge has not yet been purged for (ledger diff ∪ this run's
 * uploads).
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
 *   - Only the objects rclone actually re-uploaded need invalidating, so a
 *     targeted purge touches origin for only the keys that genuinely changed.
 *     That is not "a handful": a code deploy re-uploads ~2000 `.js` chunks
 *     (see MAX_KEYS_PER_RUN), and every one a page imports must be purged in
 *     the same run or the edge serves chunks from two builds side by side.
 *
 * This reuses `scripts/cf-purge-cache.mjs --files=` (its documented TARGETED
 * mode, already used by scripts/publish-edge-files.mjs) rather than
 * re-implementing the purge call — AGENTS.md #6, no second copy of that
 * construct. Cloudflare's free plan caps a `files` purge at 30 URLs, and
 * cf-purge-cache.mjs treats >30 as a hard error rather than truncating
 * silently, so batching into groups of 30 is this script's job.
 *
 * STATE, NOT ONE RUN'S LOG (NX-SKEW-2, Refs #9465/#8612): the rclone log only
 * names what THIS invocation uploaded. A run that uploads `assets/*` and then
 * dies, or skips the purge, leaves those keys new in R2 and stale at the edge —
 * and the next run's `copy --checksum` sees them as "Unchanged skipping", so
 * its log is empty and nobody ever purges them (the 7-day max-age is the only
 * way out). `shared-services.js` stayed at the old bytes that way after deploy
 * 36706485937 (30-09). The fix is a ledger: an R2 object (LEDGER_KEY) holding,
 * per key, the fingerprint of the bytes the edge was last SUCCESSFULLY purged
 * for. The set to purge is "R2 now vs ledger" plus this run's log, and a key
 * only takes its new fingerprint in the ledger once its own purge batch
 * succeeded — so a missed purge stays dirty and is retried by the next deploy
 * instead of being forgotten.
 *
 * FAILURE POSTURE: always exits 0. A missed purge degrades to "the edge serves
 * the previous bytes until the next deploy retries it (ledger) or the object's
 * own max-age lapses" — which must never fail a deploy that otherwise
 * succeeded. A failed batch is an ::error:: (not a warning: the dirty state is
 * real and persistent until a later run clears it) plus a step-summary line.
 *
 * USAGE:
 *   node scripts/ci/purge-changed-cdn-assets.mjs <rclone-json-log> <key-prefix>
 *       [--state=<lsjson>] [--ledger-in=<json> | --ledger-absent]
 *       [--ledger-out=<json>] [--build-id=<id>]
 *     <rclone-json-log>  file written by `rclone --use-json-log -v --log-file=…`
 *                        (missing or empty is fine in stateful mode)
 *     <key-prefix>       R2 key prefix the sync targeted, e.g. `assets`
 *     --state            `rclone lsjson -R --files-only --hash` of that prefix in
 *                        R2 right now. Without it: log-only (the old behaviour).
 *     --ledger-in        the ledger as currently stored in R2.
 *     --ledger-absent    R2 said the ledger does not exist: seed it. Neither
 *                        flag = the ledger could not be read: purge from the
 *                        log only and write NO ledger (never clobber state we
 *                        could not see).
 *     --ledger-out       where to write the new ledger; the caller uploads it.
 *
 * Env: CF_API_TOKEN (needs Zone→Cache Purge) — absent is a no-op exit 0,
 *      handled by cf-purge-cache.mjs itself. CDN_PURGE_BASE overrides the
 *      public origin (default https://cdn.frontaliereticino.ch).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Defensive budget for one invocation. Code keys always go in full (see
 * `selectPurgeKeys`): capping them is how this bug happened. Non-code keys
 * fill whatever the code leaves, so the cap only ever drops keys whose
 * staleness is harmless.
 *
 * It used to be 1000, sized for a bucket of "~661 distinct `/assets/*` keys".
 * That stopped being true: deploy run 36088944074 (2026-09-25) re-uploaded
 * 3945 keys — 1975 `.js`, 1969 `.map`, 1 `.css` — and the old cap purged the
 * first 1000 in rclone's upload order, 498 of them source maps. The 9 chunks
 * uploaded last (shared-services.js, newsletterSubscribers.js, it-core.js,
 * router.js, …) stayed at the previous build's bytes at the edge while the new
 * JobBoard.js was purged, so the job pages threw
 * `SyntaxError: … './shared-services.js' does not provide an export named
 * 'JOBGATE_RC_KEYS'` for every visitor until a manual purge. With maps out of
 * the list a code deploy needs ~2000 keys; 3000 leaves headroom for the rest.
 */
export const MAX_KEYS_PER_RUN = 3000;

/** Keys a browser executes or applies: a stale copy of one of these breaks the page. */
const CODE_KEY_RE = /\.(?:m?js|css)$/i;

/**
 * Source maps are fetched only by devtools and error symbolication, never by
 * the page itself, so a stale `.map` at the edge cannot break a visitor. They
 * are half of every code deploy's transfers, and purging them spent half the
 * budget above on keys no user reads.
 */
const SOURCE_MAP_KEY_RE = /\.map$/i;

/**
 * Which transferred keys to purge: EVERY code key, then the other non-map keys
 * up to what `cap` leaves. rclone logs in upload order, which has nothing to do
 * with how much a stale copy hurts. One stale chunk among fresh ones is a
 * module that fails to link, so no count of code keys is ever "too many to
 * purge" — a code set above `cap` is reported (`codeOverCap`) and still
 * purged in full; only the harmless keys are ever dropped.
 *
 * @param {string[]} keys R2 keys from parseTransferredKeys
 * @param {number} [cap]
 * @returns {{ selected: string[], skippedMaps: number, droppedOther: number, codeOverCap: boolean }}
 */
export function selectPurgeKeys(keys, cap = MAX_KEYS_PER_RUN) {
  const code = [];
  const other = [];
  let skippedMaps = 0;
  for (const key of keys) {
    if (SOURCE_MAP_KEY_RE.test(key)) skippedMaps += 1;
    else if (CODE_KEY_RE.test(key)) code.push(key);
    else other.push(key);
  }
  const otherKept = other.slice(0, Math.max(0, cap - code.length));
  return {
    selected: [...code, ...otherKept],
    skippedMaps,
    droppedOther: other.length - otherKept.length,
    codeOverCap: code.length > cap,
  };
}

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


// ── Purge ledger (NX-SKEW-2) ─────────────────────────────────────────────────
//
// The ledger lives OUTSIDE `assets/` on purpose: `_janitor_cdn_r2` only scans
// `assets/`, and the `rclone copy` of the stage dirs never writes this prefix,
// so neither can delete or overwrite it. It is public (same bucket, same host)
// and holds only paths and MD5s of assets that are themselves public.

/** R2 key of the purge ledger for the `assets/` prefix. */
export const LEDGER_KEY = 'purge-ledger/assets.json';
export const LEDGER_VERSION = 1;

/**
 * Fingerprint of one `rclone lsjson --hash` entry: the MD5 when rclone gives
 * one (single-part S3 ETag — every asset here), else `<size>:<modtime>`. With
 * `--use-server-modtime` the modtime is R2's LastModified, which moves on every
 * PUT, so the fallback still changes exactly when an upload happened.
 *
 * @param {{ Size?: number, ModTime?: string, Hashes?: { md5?: string } }} entry
 * @returns {string|null} null when the entry carries nothing to compare
 */
export function fingerprintOf(entry) {
  const md5 = entry?.Hashes?.md5;
  if (typeof md5 === 'string' && /^[0-9a-f]{32}$/i.test(md5)) return md5.toLowerCase();
  if (typeof entry?.Size === 'number' && typeof entry?.ModTime === 'string' && entry.ModTime) {
    return `${entry.Size}:${entry.ModTime}`;
  }
  return null;
}

/**
 * Parse `rclone lsjson -R --files-only --hash` of `<bucket>/<keyPrefix>` into
 * `{ "<prefix>/<path>": fingerprint }`. Source maps are left out for the same
 * reason `selectPurgeKeys` never purges them: no page loads them.
 *
 * @param {string} text
 * @param {string} keyPrefix
 * @returns {Record<string,string>|null} null when the listing is not a JSON array
 */
export function parseR2Listing(text, keyPrefix) {
  let entries;
  try {
    entries = JSON.parse(String(text || ''));
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const prefix = String(keyPrefix || '').replace(/^\/+|\/+$/g, '');
  /** @type {Record<string,string>} */
  const out = {};
  for (const entry of entries) {
    if (!entry || entry.IsDir) continue;
    const rel = typeof entry.Path === 'string' ? entry.Path.replace(/^\/+/, '') : '';
    if (!rel) continue;
    const key = prefix ? `${prefix}/${rel}` : rel;
    if (SOURCE_MAP_KEY_RE.test(key)) continue;
    const fp = fingerprintOf(entry);
    if (fp) out[key] = fp;
  }
  return out;
}

/**
 * Parse a stored ledger. Anything that is not a version-1 ledger with a `keys`
 * object is treated as unusable (null) — the caller then reseeds, because a
 * ledger nobody can read would otherwise never be rewritten.
 *
 * @param {string} text
 * @returns {{ version: number, updatedAt?: string, build_id?: string, keys: Record<string,string> }|null}
 */
export function parseLedger(text) {
  let ledger;
  try {
    ledger = JSON.parse(String(text || ''));
  } catch {
    return null;
  }
  if (!ledger || ledger.version !== LEDGER_VERSION) return null;
  if (!ledger.keys || typeof ledger.keys !== 'object' || Array.isArray(ledger.keys)) return null;
  return ledger;
}

/**
 * Keys whose bytes in R2 the edge has not been purged for yet: present now and
 * either missing from the ledger or recorded with a different fingerprint. A
 * key the ledger knows with the same fingerprint is NOT returned — its edge
 * copy is already the current one, and evicting it would cost a cold fill for
 * nothing.
 *
 * @param {Record<string,string>} current  parseR2Listing output
 * @param {{ keys?: Record<string,string> }|null} ledger
 * @returns {string[]} sorted keys
 */
export function diffAgainstLedger(current, ledger) {
  const known = ledger?.keys || {};
  return Object.keys(current || {})
    .filter((key) => known[key] !== current[key])
    .sort();
}

/**
 * First-run baseline when no ledger exists: everything NOT uploaded by this run
 * is assumed already fresh at the edge (exactly today's assumption), so a
 * missing ledger never turns into a purge of the whole bucket — ~2,000 cold
 * URLs at once is the stampede against R2 this script exists to avoid.
 * This run's uploads are left out, i.e. dirty until their purge succeeds.
 *
 * @param {Record<string,string>} current
 * @param {Iterable<string>} logKeys
 */
export function seedBaseline(current, logKeys) {
  const uploaded = new Set(logKeys);
  /** @type {Record<string,string>} */
  const keys = {};
  for (const [key, fp] of Object.entries(current || {})) {
    if (!uploaded.has(key)) keys[key] = fp;
  }
  return { version: LEDGER_VERSION, keys };
}

/**
 * A listing that names fewer than half the keys the ledger knows is not trusted
 * to say what is GONE from R2: `lsjson` can exit 0 on an empty or short LIST
 * (wrong bucket or prefix, a transient empty page). Merging it as-is would wipe
 * the ledger, and the next deploy would then purge every assets/ URL at once —
 * the cold-fill stampede the seed path exists to avoid. What the listing DOES
 * name is still compared and purged normally; only the "dropped from R2"
 * inference is suspended (see `keepUnlisted` in `mergeLedger`).
 *
 * @param {Record<string,string>|null} current
 * @param {{ keys?: Record<string,string> }|null} ledger
 */
export function listingLooksTruncated(current, ledger) {
  const known = Object.keys(ledger?.keys || {}).length;
  if (known === 0) return false;
  return Object.keys(current || {}).length * 2 < known;
}

/**
 * The ledger to store after this run. ONLY keys whose purge batch succeeded take
 * their current fingerprint; every other key keeps the fingerprint the edge was
 * last purged for (or stays absent), so it is still dirty for the next run.
 * Keys no longer in R2 drop out — unless `keepUnlisted`, set when the listing
 * looks truncated, in which case keys the listing does not name keep their
 * previous fingerprint instead of being forgotten.
 *
 * @param {{ previous: { keys?: Record<string,string> }|null, current: Record<string,string>,
 *           purgedKeys: Iterable<string>, buildId?: string, now: Date, keepUnlisted?: boolean }} args
 */
export function mergeLedger({ previous, current, purgedKeys, buildId, now, keepUnlisted = false }) {
  const purged = new Set(purgedKeys);
  const prev = previous?.keys || {};
  const listed = current || {};
  const names = new Set(Object.keys(listed));
  if (keepUnlisted) for (const key of Object.keys(prev)) names.add(key);
  /** @type {Record<string,string>} */
  const keys = {};
  for (const key of [...names].sort()) {
    const inR2 = Object.prototype.hasOwnProperty.call(listed, key);
    if (inR2 && purged.has(key)) keys[key] = listed[key];
    else if (Object.prototype.hasOwnProperty.call(prev, key)) keys[key] = prev[key];
  }
  return {
    version: LEDGER_VERSION,
    updatedAt: now.toISOString(),
    build_id: buildId || '',
    keys,
  };
}

/**
 * Decide what to purge and against which baseline the new ledger is merged.
 *
 *   - no R2 listing            → `log-only`: this run's uploads, no ledger write
 *   - ledger could not be read → `log-only`: same, never clobber unseen state
 *   - ledger absent/corrupt    → `seed`: this run's uploads, ledger seeded
 *   - ledger present           → `ledger`: R2-vs-ledger diff ∪ this run's uploads;
 *                                `truncated` when the listing names under half the
 *                                ledger's keys (merge then keeps the unlisted ones)
 *
 * @param {{ logKeys: string[], current: Record<string,string>|null,
 *           ledgerState: 'present'|'absent'|'unreadable', ledger: object|null }} args
 * @returns {{ mode: 'log-only'|'seed'|'ledger', candidates: string[], baseline: object|null, truncated?: boolean }}
 */
export function planPurge({ logKeys, current, ledgerState, ledger }) {
  if (!current || ledgerState === 'unreadable') {
    return { mode: 'log-only', candidates: [...logKeys], baseline: null };
  }
  if (ledgerState === 'absent' || !ledger) {
    return { mode: 'seed', candidates: [...logKeys], baseline: seedBaseline(current, logKeys) };
  }
  const seen = new Set(logKeys);
  const candidates = [...logKeys];
  for (const key of diffAgainstLedger(current, ledger)) {
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(key);
    }
  }
  return { mode: 'ledger', candidates, baseline: ledger, truncated: listingLooksTruncated(current, ledger) };
}

/**
 * Purge `keys` in batches through an injected `purgeBatch(urls)` (throws on a
 * failed batch) and report which KEYS made it — per batch, because that is the
 * granularity at which Cloudflare accepts or rejects a purge.
 *
 * @param {string[]} keys
 * @param {{ purgeBatch: (urls: string[]) => void, base?: string, size?: number }} opts
 * @returns {{ purgedKeys: string[], failed: { index: number, keys: string[], error: string }[], batches: number }}
 */
export function purgeInBatches(keys, { purgeBatch, base = DEFAULT_CDN_BASE, size = PURGE_BATCH_SIZE }) {
  const groups = batch(keys, size);
  const purgedKeys = [];
  const failed = [];
  for (const [index, group] of groups.entries()) {
    try {
      purgeBatch(group.map((k) => keyToUrl(k, base)));
      purgedKeys.push(...group);
    } catch (err) {
      failed.push({ index, keys: group, error: err?.message || String(err) });
    }
  }
  return { purgedKeys, failed, batches: groups.length };
}

function parseFlags(args) {
  const positional = [];
  /** @type {Record<string,string|true>} */
  const flags = {};
  for (const arg of args) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else positional.push(arg);
  }
  return { positional, flags };
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function stepSummary(line) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // best-effort: the ::error:: line in the log is the primary signal
  }
}

function main(argv) {
  const { positional, flags } = parseFlags(argv);
  const [logPath, keyPrefix] = positional;
  if (!logPath || !keyPrefix) {
    console.log('[purge-changed-cdn-assets] usage: <rclone-json-log> <key-prefix> [--state=…] — skipping');
    return;
  }
  const tag = '[purge-changed-cdn-assets]';

  const logText = readText(logPath);
  if (logText === null) console.log(`${tag} no rclone log at ${logPath} — this run uploaded nothing it can name`);
  const transferred = parseTransferredKeys(logText || '', keyPrefix);

  // Current R2 state of the prefix (stateful mode).
  let current = null;
  if (typeof flags.state === 'string') {
    current = parseR2Listing(readText(flags.state) ?? '', keyPrefix);
    if (!current) console.log(`::warning::${tag} R2 listing at ${flags.state} unreadable — purging this run's uploads only, ledger untouched`);
  }
  let ledgerState = 'unreadable';
  let ledger = null;
  if (typeof flags['ledger-in'] === 'string') {
    ledgerState = 'present';
    ledger = parseLedger(readText(flags['ledger-in']) ?? '');
    if (!ledger) console.log(`::warning::${tag} stored purge ledger is not a v${LEDGER_VERSION} ledger — reseeding it`);
  } else if (flags['ledger-absent'] === true) {
    ledgerState = 'absent';
  } else if (current) {
    console.log(`::warning::${tag} purge ledger could not be read — purging this run's uploads only, ledger untouched`);
  }

  const { mode, candidates, baseline, truncated } = planPurge({ logKeys: transferred, current, ledgerState, ledger });
  if (truncated) {
    console.log(
      `::warning::${tag} R2 listing names ${Object.keys(current).length} ${keyPrefix}/ key(s) but the ledger knows ${Object.keys(baseline.keys).length} — listing treated as possibly truncated: keys it does not name keep their ledger entry instead of being dropped (if the bucket really shrank, delete ${LEDGER_KEY} to reseed)`,
    );
  }
  if (mode === 'seed') {
    console.log(`::notice::${tag} purge ledger seeded: ${Object.keys(baseline.keys).length} key(s) assumed fresh, ${transferred.length} uploaded by this run queued for purge`);
  } else if (mode === 'ledger') {
    const stale = candidates.length - transferred.length;
    console.log(`${tag} ledger: ${transferred.length} key(s) uploaded by this run, ${stale} more changed in R2 since the last successful purge`);
  }

  const writeLedger = (purgedKeys) => {
    if (mode === 'log-only' || typeof flags['ledger-out'] !== 'string') return;
    const next = mergeLedger({
      previous: baseline,
      current,
      purgedKeys,
      buildId: typeof flags['build-id'] === 'string' ? flags['build-id'] : '',
      now: new Date(),
      keepUnlisted: truncated === true,
    });
    writeFileSync(flags['ledger-out'], `${JSON.stringify(next)}\n`);
    const dirty = diffAgainstLedger(current, next).filter((k) => !SOURCE_MAP_KEY_RE.test(k)).length;
    console.log(`${tag} ledger written: ${Object.keys(next.keys).length} key(s), ${dirty} still dirty`);
  };

  if (candidates.length === 0) {
    console.log(
      mode === 'log-only'
        ? `${tag} this run uploaded nothing and the ledger was not consulted — no purge`
        : `${tag} no ${keyPrefix}/ object changed since the last successful purge — edge stays warm, no purge needed`,
    );
    writeLedger([]);
    return;
  }
  const { selected: keys, skippedMaps, droppedOther, codeOverCap } = selectPurgeKeys(candidates);
  if (skippedMaps > 0) {
    console.log(`${tag} ${skippedMaps} source map(s) not purged — no page loads them`);
  }
  if (codeOverCap) {
    console.log(
      `::warning::${tag} more changed code keys than MAX_KEYS_PER_RUN=${MAX_KEYS_PER_RUN} — purging all of them anyway (a stale chunk breaks module linking); check the rclone log parse if this is unexpected`,
    );
  }
  if (droppedOther > 0) {
    console.log(
      `::warning::${tag} ${droppedOther} non-code ${keyPrefix}/ key(s) over MAX_KEYS_PER_RUN=${MAX_KEYS_PER_RUN} not purged (left dirty in the ledger for the next run)`,
    );
  }
  if (keys.length === 0) {
    writeLedger([]);
    return;
  }

  // cf-purge-cache.mjs exits 0 as a no-op without a token, which would read as
  // a successful purge and mark every key clean. Without a token nothing is
  // purged, and the ledger must say so.
  if (!process.env.CF_API_TOKEN) {
    console.log(`::warning::${tag} CF_API_TOKEN not set — ${keys.length} ${keyPrefix}/ key(s) not purged, left dirty`);
    writeLedger([]);
    return;
  }

  const base = process.env.CDN_PURGE_BASE || DEFAULT_CDN_BASE;
  const purgeScript = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cf-purge-cache.mjs');
  const { purgedKeys, failed, batches } = purgeInBatches(keys, {
    base,
    purgeBatch: (urls) => execFileSync('node', [purgeScript, `--files=${urls.join(',')}`], { stdio: 'inherit' }),
  });
  for (const f of failed) {
    console.log(`${tag} batch ${f.index + 1}/${batches} failed (${f.error})`);
  }
  if (failed.length > 0) {
    const dirtyKeys = failed.reduce((n, f) => n + f.keys.length, 0);
    const msg = `${failed.length}/${batches} purge batch(es) failed — ${dirtyKeys} ${keyPrefix}/ key(s) stay stale at the edge and dirty in ${LEDGER_KEY}; the next deploy retries them`;
    console.log(`::error::${tag} ${msg}`);
    stepSummary(`- :x: CDN asset purge: ${msg}`);
  }
  // "dispatched", not "purged": cf-purge-cache.mjs's own output is the
  // authoritative record of what the edge accepted.
  console.log(`${tag} dispatched purge for ${purgedKeys.length}/${keys.length} changed ${keyPrefix}/ key(s) in ${batches} batch(es)`);
  writeLedger(purgedKeys);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
