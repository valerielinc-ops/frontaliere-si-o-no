/**
 * cdn-shell-assets.mjs — the static shell scripts are on the CDN before the
 * HTML that references them is published.
 *
 * build-plugins/staticScriptsPlugin.ts writes these files into dist/assets, and
 * dist/assets reaches the CDN only at the end of a full deploy, hours after a
 * merge (scripts/lib/deploy-it-pages-prep.sh). The fast emitters — the
 * single-article publish, the corpus re-render, the hub re-render — push shell
 * HTML within minutes, rendered from the same constants and without a build.
 * A file the last deploy did not upload is therefore referenced before it
 * exists:
 *
 *   - a name derived from its content is new at every change of that content.
 *     On 2026-10-07 every re-rendered article page loaded
 *     /assets/gtag-init-<hash>.js as a 404, and with it lost its static GA4
 *     page_view, from the first re-render to the upload done by hand (#12270);
 *   - a stable name is new once, when it is introduced (partnerize-tag.js,
 *     #7366).
 *
 * scripts/lib/cdn-asset-existence.mjs already SAYS so after the fact, as a
 * `::warning::` in a green run; on 2026-10-07 it did, twice, and nothing
 * changed. `ensureCdnShellAssets` removes the cause instead: before any page
 * is pushed, an emitter uploads the files the CDN does not have, from the
 * module it renders with, and stops when it cannot.
 *
 * It never replaces an object. The bytes behind a stable name stay the full
 * deploy's business: rewriting one here would change every published page
 * ahead of the build that goes with it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Node built-ins and upload-cdn-file.sh only, on purpose: this file travels
// byte-identical to the publisher repository, whose copies of the sibling
// modules differ or do not exist.
const UPLOAD_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'upload-cdn-file.sh');

/** Origin the shell assets are served from; the `assets/<name>` keys hang off it. */
export const SHELL_ASSET_CDN_ORIGIN = 'https://cdn.frontaliereticino.ch';

/**
 * The value the full deploy gives the whole assets/ class (`_r2_sync … assets`
 * in deploy-it-pages-prep.sh), so an object written here and one written by a
 * deploy are served alike. tests/cdn-shell-assets.test.ts compares the two.
 */
export const SHELL_ASSET_CACHE_CONTROL = 'public,max-age=604800';

// fetch() sends no User-Agent of its own, and the zone challenges a request
// without one: the probe would read every file as not served.
const PROBE_USER_AGENT = 'FrontaliereTicino-ShellAssets/1.0 (+https://frontaliereticino.ch)';
const PROBE_TIMEOUT_MS = 8_000;

// A 200 whose body is HTML is not a script or a stylesheet: an origin that
// serves the SPA on any path answers that way for a file it does not have.
const isHtml = (contentType) => /^\s*text\/html\b/i.test(String(contentType || ''));

// upload-cdn-file.sh bounds each rclone call itself (R2_TIMEOUT_OBJECT_S, two
// attempts on the upload) and may first download rclone; this is the backstop.
const HELPER_TIMEOUT_MS = 6 * 60_000;

/** CDN keys of the files `listStaticScriptFiles()` returns. */
export function shellAssetsFromStaticScripts(files) {
  const assets = [];
  const seen = new Set();
  for (const [name, content] of files) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`static shell script has no usable file name: ${JSON.stringify(name)}`);
    }
    if (typeof content !== 'string' || content === '') {
      throw new Error(`static shell script ${name} has no content to publish`);
    }
    if (seen.has(name)) throw new Error(`static shell script ${name} is listed twice`);
    seen.add(name);
    assets.push({ key: `assets/${name}`, content });
  }
  if (assets.length === 0) throw new Error('no static shell script to check');
  return assets;
}

/**
 * What the CDN answers for `key`: 'present', 'absent' (the object is not
 * there), or 'unknown' (anything that is not an answer about the object — a
 * challenge, a 5xx, a timeout).
 *
 * The query string is one the edge has never seen: this host caches a 404 for
 * ten minutes, and that copy must not answer for an object uploaded since.
 */
export async function probeCdnAsset(key, {
  cdnOrigin = SHELL_ASSET_CDN_ORIGIN,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  try {
    const response = await fetchImpl(`${cdnOrigin}/${key}?ensure=${now()}`, {
      method: 'HEAD',
      headers: { 'User-Agent': PROBE_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return isHtml(response.headers?.get?.('content-type')) ? 'absent' : 'present';
    return response.status === 404 || response.status === 410 ? 'absent' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function runUploadHelper(args, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn('bash', [UPLOAD_HELPER, ...args], { encoding: 'utf8', env, timeout: HELPER_TIMEOUT_MS });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** What R2 holds for `key`: 'exists', 'missing', or 'indeterminate' (R2 was not read). */
export function checkStoredAsset(key, options) {
  // Whole lines: `✅ exists assets/a.js.map` is not an answer about assets/a.js.
  const lines = runUploadHelper(['--check', key], options).split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(`✅ exists ${key}`)) return 'exists';
  if (lines.includes(`❌ missing ${key}`)) return 'missing';
  return 'indeterminate';
}

/**
 * Additive single-key PUT. upload-cdn-file.sh exits 0 on every runtime failure
 * by design; its "✅ uploaded" line is the signal.
 */
export function uploadShellAsset(key, content, options) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cdn-shell-asset-'));
  try {
    const file = path.join(dir, path.basename(key));
    writeFileSync(file, content, 'utf-8');
    const output = runUploadHelper([file, key, SHELL_ASSET_CACHE_CONTROL], options);
    process.stdout.write(output);
    return output.includes('✅ uploaded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Leaves every asset available on the CDN, or throws.
 *
 * The CDN is asked first: one HEAD per file, no credentials, and in the normal
 * run nothing else happens. R2 is read only for a file the CDN did not show,
 * and it is R2 — not the probe — that decides an upload: a runner the edge
 * challenges must neither replace an object that is there nor stop publishing.
 *
 * @param {{
 *   assets: Array<{ key: string, content: string }>,
 *   probe?: (key: string) => Promise<'present' | 'absent' | 'unknown'>,
 *   checkStored?: (key: string) => 'exists' | 'missing' | 'indeterminate' | Promise<'exists' | 'missing' | 'indeterminate'>,
 *   upload?: (key: string, content: string) => boolean | Promise<boolean>,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<Array<{ key: string, outcome: 'served' | 'stored' | 'uploaded' }>>}
 */
export async function ensureCdnShellAssets({
  assets,
  probe = probeCdnAsset,
  checkStored = checkStoredAsset,
  upload = uploadShellAsset,
  log = console.log,
}) {
  const probed = await Promise.all(assets.map(({ key }) => probe(key)));
  const results = [];
  for (const [index, { key, content }] of assets.entries()) {
    if (probed[index] === 'present') {
      results.push({ key, outcome: 'served' });
      continue;
    }
    const stored = await checkStored(key);
    if (stored === 'exists') {
      log(`${key}: on R2, not confirmed through the CDN (probe: ${probed[index]})`);
      results.push({ key, outcome: 'stored' });
      continue;
    }
    if (stored !== 'missing') {
      throw new Error(`${key}: the CDN did not serve it (probe: ${probed[index]}) and R2 could not be read — HTML that references it must not be published`);
    }
    log(`${key}: not on the CDN — uploading it`);
    if (!(await upload(key, content))) {
      throw new Error(`${key}: not on the CDN and the upload failed — HTML that references it must not be published`);
    }
    results.push({ key, outcome: 'uploaded' });
  }
  const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
  log(`[cdn-shell-assets] ${results.length} file(s): ${count('served')} served, ${count('stored')} on R2, ${count('uploaded')} uploaded`);
  return results;
}
