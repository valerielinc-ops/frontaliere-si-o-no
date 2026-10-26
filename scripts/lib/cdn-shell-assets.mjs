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
 *
 * An object on R2 is not yet a file the pages get. Each edge location keeps
 * the 404 it gave a browser while the object was missing (about three minutes
 * on this host: HIT at 112 s, EXPIRED at 218 s, measured 2026-10-07), in one
 * cache entry per `Origin`. The probe cannot see those entries: this host never
 * answers a HEAD from its cache (`cf-cache-status: DYNAMIC`). So the URL the
 * pages use is asked for every file, in both cache variants; what the probe did
 * not show, or what does not answer there, is purged at that URL and must then
 * be served before anything is published.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Node built-ins and two commands, on purpose: this file travels byte-identical
// to the publisher repository, whose copies of the sibling modules differ or
// do not exist. Both repositories have upload-cdn-file.sh (the same file) and
// cf-purge-cache.mjs (their own, with the same `--files=` mode and the same
// success line); nothing is imported from either.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_HELPER = path.join(HERE, 'upload-cdn-file.sh');
const PURGE_SCRIPT = path.join(HERE, '..', 'cf-purge-cache.mjs');

/** Origin the shell assets are served from; the `assets/<name>` keys hang off it. */
export const SHELL_ASSET_CDN_ORIGIN = 'https://cdn.frontaliereticino.ch';

/**
 * Origin of the pages that load the assets. A request that carries it reads a
 * cache entry of its own (cf-purge-variants.mjs, VARY_ORIGINS):
 * cf-purge-cache.mjs clears it together with the plain one.
 */
export const SHELL_ASSET_PAGE_ORIGIN = 'https://frontaliereticino.ch';

/**
 * URLs in one `--files=` purge: Cloudflare's cap, and cf-purge-cache.mjs fails
 * a longer list instead of cutting it (MAX_TARGETED_FILES in the site's
 * cf-purge-limits.mjs; tests/cdn-shell-assets.test.ts compares the two).
 */
export const SHELL_ASSET_PURGE_BATCH = 30;

// cf-purge-cache.mjs exits 0 without purging when CF_API_TOKEN is not set;
// this line, printed only after Cloudflare accepted every variant, is the signal.
const PURGE_SUCCESS_LINE = '✅ Cloudflare edge cache purged for';
const PURGE_TIMEOUT_MS = 90_000;

// A purge is acknowledged at once and reaches every edge location within
// about thirty seconds; the pages' URL is asked again over that span.
const CONFIRM_DELAYS_MS = [0, 5_000, 15_000, 30_000];

// The two cache entries the edge keeps for a URL: the one of a plain <script>
// or <link>, and the one of a load that carries the page origin.
const CACHE_VARIANTS = [undefined, SHELL_ASSET_PAGE_ORIGIN];
const variantLabel = (pageOrigin) => (pageOrigin ? `Origin ${pageOrigin}` : 'no Origin');

/**
 * The value the full deploy gives stable root aliases (`_r2_sync … assets`
 * in deploy-it-pages-prep.sh), so an object written here and one written by a
 * deploy are served alike. The build-scoped executable graph is published
 * separately with immutable URLs; fast emitters intentionally write only
 * stable root shell assets. tests/cdn-shell-assets.test.ts compares the two.
 */
export const SHELL_ASSET_CACHE_CONTROL = 'public,max-age=600,must-revalidate';

// fetch() sends no User-Agent of its own, and the zone challenges a request
// without one: the probe would read every file as not served.
const PROBE_USER_AGENT = 'FrontaliereTicino-ShellAssets/1.0 (+https://frontaliereticino.ch)';
const PROBE_TIMEOUT_MS = 8_000;

// One confirmation variant gets the complete retry schedule plus the last
// request's bounded header wait. Earlier request latency consumes the same
// budget: a slow edge cannot silently extend the publication gate.
const EDGE_CONFIRMATION_WINDOW_MS = CONFIRM_DELAYS_MS.reduce((total, delay) => total + delay, 0)
  + PROBE_TIMEOUT_MS;

// A 200 whose body is HTML is not a script or a stylesheet: an origin that
// serves the SPA on any path answers that way for a file it does not have.
const isHtml = (contentType) => /^\s*text\/html\b/i.test(String(contentType || ''));

// upload-cdn-file.sh bounds each rclone call itself (R2_TIMEOUT_OBJECT_S, two
// attempts on the upload) and may first download rclone; this is both the
// per-helper backstop and the total budget for all serial R2 work in one batch.
const HELPER_TIMEOUT_MS = 6 * 60_000;
const monotonicNow = () => performance.now();

/** One monotonic deadline shared by every R2 lookup/upload in an asset batch. */
export function r2UploadDeadline(startedAt = monotonicNow()) {
  return startedAt + HELPER_TIMEOUT_MS;
}

/** One monotonic deadline for a cache variant's complete edge confirmation. */
export function edgeConfirmationDeadline(startedAt = monotonicNow()) {
  return startedAt + EDGE_CONFIRMATION_WINDOW_MS;
}

class R2UploadDeadlineExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'R2UploadDeadlineExceededError';
    this.code = 'R2_UPLOAD_DEADLINE_EXCEEDED';
  }
}

class EdgeConfirmationDeadlineExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EdgeConfirmationDeadlineExceededError';
    this.code = 'EDGE_CONFIRMATION_DEADLINE_EXCEEDED';
  }
}

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

// 'present', 'absent' (the object is not there), or 'unknown' (anything that is
// not an answer about the object — a challenge, a 5xx, a timeout).
function answerOf(response) {
  if (response.ok) return isHtml(response.headers?.get?.('content-type')) ? 'absent' : 'present';
  return response.status === 404 || response.status === 410 ? 'absent' : 'unknown';
}

/**
 * Whether the object behind `key` can be read through the CDN: 'present',
 * 'absent' or 'unknown'.
 *
 * A HEAD, which this host passes to R2 every time, with a query string the
 * edge has never seen in case that changes: the answer is about the object,
 * never about a copy the edge kept. It creates no cache entry either, so
 * asking for a file that is not there leaves nothing behind.
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
    return answerOf(response);
  } catch {
    return 'unknown';
  }
}

/**
 * What a page gets for `key`: a GET of the URL the HTML references, read from
 * the edge cache like a browser's. `pageOrigin` selects the cache entry of a
 * cross-origin load; without it, the one of a plain <script> or <link>.
 *
 * Only for an object that is on R2: asked for a missing one, this request is
 * what makes the edge keep the 404.
 *
 * @param {string} key
 * @param {{ pageOrigin?: string, cdnOrigin?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<'present' | 'absent' | 'unknown'>}
 */
export async function confirmCdnAsset(key, {
  pageOrigin,
  cdnOrigin = SHELL_ASSET_CDN_ORIGIN,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  try {
    const response = await fetchImpl(`${cdnOrigin}/${key}`, {
      method: 'GET',
      headers: { 'User-Agent': PROBE_USER_AGENT, ...(pageOrigin ? { Origin: pageOrigin } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The status and the type are the answer. The bytes are not read, and
    // dropping them is not waited for: the time limit of the request ends with
    // the headers, and a stream that never closes must not hold the step.
    try {
      response.body?.cancel?.()?.catch?.(() => {});
    } catch {
      // nothing to drop
    }
    return answerOf(response);
  } catch {
    return 'unknown';
  }
}

function runUploadHelper(args, {
  spawn = spawnSync,
  env = process.env,
  deadlineAt,
  now = monotonicNow,
} = {}) {
  let timeout = HELPER_TIMEOUT_MS;
  if (deadlineAt !== undefined) {
    timeout = Math.min(timeout, Math.floor(deadlineAt - now()));
    if (timeout <= 0) {
      throw new R2UploadDeadlineExceededError('R2 upload deadline expired before the helper could start');
    }
  }
  const result = spawn('bash', [UPLOAD_HELPER, ...args], { encoding: 'utf8', env, timeout });
  if (deadlineAt !== undefined && result.error?.code === 'ETIMEDOUT') {
    throw new R2UploadDeadlineExceededError('R2 upload deadline expired while the helper was running');
  }
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
 * Drops what the edge keeps for the pages' URL of each key, at every location
 * and in both cache variants. False unless cf-purge-cache.mjs confirmed it.
 *
 * @param {string[]} keys
 * @param {{
 *   spawn?: (command: string, args: string[], options: { encoding: 'utf8', env: Record<string, string | undefined>, timeout: number }) => { status: number | null, stdout: string, stderr: string },
 *   env?: Record<string, string | undefined>,
 *   cdnOrigin?: string,
 * }} [options]
 * @returns {boolean}
 */
export function purgeCdnAssets(keys, {
  spawn = spawnSync,
  env = process.env,
  cdnOrigin = SHELL_ASSET_CDN_ORIGIN,
} = {}) {
  for (let start = 0; start < keys.length; start += SHELL_ASSET_PURGE_BATCH) {
    const urls = keys.slice(start, start + SHELL_ASSET_PURGE_BATCH).map((key) => `${cdnOrigin}/${key}`);
    const result = spawn(process.execPath, [PURGE_SCRIPT, `--files=${urls.join(',')}`], {
      encoding: 'utf8',
      env,
      timeout: PURGE_TIMEOUT_MS,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);
    if (result.status !== 0 || !output.includes(PURGE_SUCCESS_LINE)) return false;
  }
  return true;
}

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Leaves every asset served at the URL the pages use, or throws.
 *
 * The CDN is asked first: one HEAD per file, no credentials, and in the normal
 * run nothing else happens. R2 is read only for a file the CDN did not show,
 * and it is R2 — not the probe — that decides an upload: a runner the edge
 * challenges must not replace an object that is there.
 *
 * A file the first probe did not show was missing a moment ago, or could not
 * be read. Once it is on R2 its URL is purged and asked again; a purge that
 * cannot be done or a URL that still does not answer stops the run, whether
 * the file was uploaded here or found on R2.
 *
 * A file the probe did show is asked for at the URL the pages use as well: the
 * object can be on R2, uploaded by anyone, while this edge location still
 * answers with the 404 it kept. Only a file that does not answer is purged.
 *
 * @param {{
 *   assets: Array<{ key: string, content: string }>,
 *   probe?: (key: string) => Promise<'present' | 'absent' | 'unknown'>,
 *   checkStored?: (key: string) => 'exists' | 'missing' | 'indeterminate' | Promise<'exists' | 'missing' | 'indeterminate'>,
 *   upload?: (key: string, content: string) => boolean | Promise<boolean>,
 *   purge?: (keys: string[]) => boolean | Promise<boolean>,
 *   confirm?: (key: string, options: { pageOrigin?: string, timeoutMs?: number }) => Promise<'present' | 'absent' | 'unknown'>,
 *   wait?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<Array<{ key: string, outcome: 'served' | 'stored' | 'uploaded' }>>}
 */
export async function ensureCdnShellAssets({
  assets,
  probe = probeCdnAsset,
  checkStored = checkStoredAsset,
  upload = uploadShellAsset,
  purge = purgeCdnAssets,
  confirm = confirmCdnAsset,
  wait = waitFor,
  now = monotonicNow,
  log = console.log,
}) {
  let r2DeadlineAt;
  const withR2Deadline = async (key, phase, operation) => {
    if (r2DeadlineAt === undefined) r2DeadlineAt = r2UploadDeadline(now());
    const deadlineFailure = () => new R2UploadDeadlineExceededError(
      `${key}: R2 ${phase} exceeded the shared ${HELPER_TIMEOUT_MS / 1000}s deadline — HTML that references it must not be published`,
    );
    if (now() >= r2DeadlineAt) throw deadlineFailure();

    let result;
    try {
      result = await operation({ deadlineAt: r2DeadlineAt, now });
    } catch (error) {
      if (error instanceof R2UploadDeadlineExceededError) throw deadlineFailure();
      throw error;
    }
    if (now() >= r2DeadlineAt) throw deadlineFailure();
    return result;
  };

  const probed = await Promise.all(assets.map(({ key }) => probe(key)));
  const results = [];
  for (const [index, { key, content }] of assets.entries()) {
    if (probed[index] === 'present') {
      results.push({ key, outcome: 'served' });
      continue;
    }
    const stored = await withR2Deadline(key, 'lookup', (options) => checkStored(key, options));
    if (stored === 'exists') {
      log(`${key}: on R2, not shown by the CDN (probe: ${probed[index]})`);
      results.push({ key, outcome: 'stored' });
      continue;
    }
    if (stored !== 'missing') {
      throw new Error(`${key}: the CDN did not serve it (probe: ${probed[index]}) and R2 could not be read — HTML that references it must not be published`);
    }
    log(`${key}: not on the CDN — uploading it`);
    if (!(await withR2Deadline(key, 'upload', (options) => upload(key, content, options)))) {
      throw new Error(`${key}: not on the CDN and the upload failed — HTML that references it must not be published`);
    }
    results.push({ key, outcome: 'uploaded' });
  }

  // Every object is on R2 from here on, so asking for the pages' URL can only
  // show what the edge kept: it cannot make it keep a 404.
  const unseen = results.filter((result) => result.outcome !== 'served').map((result) => result.key);
  const shown = results.filter((result) => result.outcome === 'served').map((result) => result.key);
  const shownAnswers = await Promise.all(shown.map((key) => (
    Promise.all(CACHE_VARIANTS.map((pageOrigin) => confirm(key, { pageOrigin })))
  )));
  const kept = shown.filter((key, index) => {
    const unanswered = shownAnswers[index].findIndex((answer) => answer !== 'present');
    if (unanswered === -1) return false;
    log(`${key}: readable through the CDN, but the URL the pages use answered ${shownAnswers[index][unanswered]} (${variantLabel(CACHE_VARIANTS[unanswered])}) — purging it`);
    return true;
  });

  const purged = [...unseen, ...kept];
  if (purged.length > 0) {
    if (!(await purge(purged))) {
      throw new Error(`${purged.join(', ')}: on R2, but the edge cache could not be purged — a location that kept the 404 would go on answering with it; HTML that references ${purged.length === 1 ? 'it' : 'them'} must not be published`);
    }
    for (const key of purged) {
      for (const pageOrigin of CACHE_VARIANTS) {
        const deadlineAt = edgeConfirmationDeadline(now());
        let answer = 'unknown';
        let confirmed = false;
        for (const delay of CONFIRM_DELAYS_MS) {
          if (delay > 0) {
            const remainingBeforeWait = Math.floor(deadlineAt - now());
            if (remainingBeforeWait <= 0) break;
            await wait(Math.min(delay, remainingBeforeWait));
          }
          const remainingForRequest = Math.floor(deadlineAt - now());
          if (remainingForRequest <= 0) break;
          answer = await confirm(key, {
            pageOrigin,
            timeoutMs: Math.min(PROBE_TIMEOUT_MS, remainingForRequest),
          });
          if (answer === 'present' && now() <= deadlineAt) {
            confirmed = true;
            break;
          }
          if (now() >= deadlineAt) break;
        }
        if (!confirmed) {
          throw new EdgeConfirmationDeadlineExceededError(
            `${key}: on R2 and purged, but the URL the pages use still does not serve it; edge confirmation exceeded the ${EDGE_CONFIRMATION_WINDOW_MS / 1000}s cumulative deadline (${variantLabel(pageOrigin)}: ${answer}) — HTML that references it must not be published`,
          );
        }
      }
    }
  }

  const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
  log(`[cdn-shell-assets] ${results.length} file(s): ${count('served')} served, ${count('stored')} on R2, ${count('uploaded')} uploaded`);
  return results;
}
