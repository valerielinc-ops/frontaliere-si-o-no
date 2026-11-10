/**
 * Durable store of the Google Indexing API ledger (job pages + article
 * notifications + per-day request counter), in Firestore.
 *
 * ## Why not the Actions cache any more
 *
 * From 2026-10-24 to 2026-11-10 the ledger lived in `actions/cache`
 * (`indexing-api-jobs-ledger-*`). The repository runs well past the 10 GB
 * cache limit (one `og-jobs` entry alone is 1.1 GiB), so the entry was evicted
 * between two daily runs and every run logged "Cache not found": each day
 * started from an empty ledger. Measured on run 42678323947 (2026-11-09): of
 * the 211 URLs it sent, 143 had already been sent on 2026-11-07 — two thirds
 * of a 200-request daily quota spent on duplicates — and no URL_DELETED was
 * ever sent, because "this URL left the sitemaps" needs yesterday's ledger.
 *
 * ## Why Firestore
 *
 * - It is already this repository's durable store for CI state that must
 *   survive runs and be shared by workflows: `ci_leases/jobs-data-pipeline`
 *   (scripts/lib/global-data-pipeline-lease.mjs) uses the same REST API with
 *   the same service account and Node built-ins only.
 * - A committed data file was the other convention (`data/*-posted-*.json`),
 *   but the ledger is rewritten by every indexing run (daily + after each
 *   publish) and by the article publisher: on `main` it would be a commit
 *   every few hours, and through the data-refresh PR route the next run would
 *   read a ledger that has not merged yet — the duplicate sends this module
 *   exists to remove.
 * - The writers (`indexing` job of monitor-gsc-seo.yml and the
 *   `notify-search-engines` job of fast-publish-article.yml) do not install
 *   npm dependencies; the REST API keeps them dependency-free.
 *
 * ## Format
 *
 * The ledger is ~32k sitemap URLs (≈4 MB of JSON). A Firestore document holds
 * at most 1 MiB, so the JSON is gzipped and split into `CHUNK_BYTES` chunks:
 *
 *   ci_state/indexing-api-jobs-ledger          meta: chunks, sha256, sizes, writer
 *   ci_state/indexing-api-jobs-ledger-chunk-0  { data: bytes }
 *   ci_state/indexing-api-jobs-ledger-chunk-1  ...
 *
 * A push is ONE Firestore commit (all chunks + meta, atomic) with a
 * precondition on the meta document's `updateTime` seen by the pull: a writer
 * that did not pull, or pulled a version someone else has since replaced,
 * fails instead of overwriting the newer spend. A pull verifies the sha256 of
 * the reassembled bytes, so a torn read is detected and retried.
 *
 * CLI (exit codes: 0 ok, 1 store/integrity error, 2 configuration error):
 *   node scripts/lib/indexing-ledger-store.mjs pull --ledger /tmp/indexing-api-jobs-ledger.json
 *   node scripts/lib/indexing-ledger-store.mjs push --ledger /tmp/indexing-api-jobs-ledger.json
 *
 * `pull` writes the ledger file only when the store has one (a missing ledger
 * stays missing: only the job submitter may bootstrap it) and always writes
 * `<ledger>.store.json`, the receipt `push` requires.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createJwtAssertion, exchangeAssertionForToken } from './google-service-account-token.mjs';
import { isInvokedDirectly } from './is-invoked-directly.mjs';

export const LEDGER_DOC = 'ci_state/indexing-api-jobs-ledger';
export const CHUNK_DOC_PREFIX = `${LEDGER_DOC}-chunk-`;
/** Raw bytes per chunk document: well under the 1 MiB document limit. */
export const CHUNK_BYTES = 700_000;
/**
 * Firestore rejects a `documents:commit` request body above 10 MiB, and a push
 * is ONE commit carrying every chunk. A chunk travels as base64 (4/3 of its
 * raw bytes: 700,000 → 933,336 characters) inside the JSON of its write, so 12
 * chunks already exceed the limit. 10 chunks are ~9.3 MB of base64; the
 * request itself is measured against MAX_COMMIT_REQUEST_BYTES before any call.
 * 10 chunks = 7 MB of gzipped ledger, ~10x today's size: reaching it is a bug.
 */
export const MAX_CHUNKS = 10;
/** Firestore's commit request limit (10 MiB) minus headroom for headers/meta. */
export const MAX_COMMIT_REQUEST_BYTES = 10 * 1024 * 1024 - 256 * 1024;
export const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const PULL_ATTEMPTS = 3;

export class StoreConfigError extends Error {}
export class LedgerTooLargeError extends Error {}

/** Size in bytes of the `documents:commit` request body for these writes. */
export function commitRequestBytes(writes) {
  return Buffer.byteLength(JSON.stringify({ writes }), 'utf8');
}

/** Throws LedgerTooLargeError when the commit would exceed Firestore's request limit. */
export function assertCommitFits(writes) {
  const bytes = commitRequestBytes(writes);
  if (bytes > MAX_COMMIT_REQUEST_BYTES) {
    throw new LedgerTooLargeError(
      `ledger commit request is ${bytes} bytes, above ${MAX_COMMIT_REQUEST_BYTES} (Firestore limit 10 MiB)`,
    );
  }
  return bytes;
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * gzip + split. Returns base64 chunks (Firestore REST `bytesValue` is base64).
 * @param {string} json
 */
export function encodeLedger(json) {
  const raw = Buffer.from(json, 'utf8');
  const gz = gzipSync(raw, { level: 9 });
  const chunks = [];
  for (let off = 0; off < gz.length; off += CHUNK_BYTES) chunks.push(gz.subarray(off, off + CHUNK_BYTES).toString('base64'));
  if (chunks.length === 0) chunks.push('');
  if (chunks.length > MAX_CHUNKS) {
    throw new LedgerTooLargeError(
      `ledger too large: ${gz.length} gzipped bytes need ${chunks.length} chunks of ${CHUNK_BYTES} `
      + `(max ${MAX_CHUNKS}, so one Firestore commit stays under 10 MiB)`,
    );
  }
  return { chunks, sha256: sha256Hex(raw), rawBytes: raw.length, gzBytes: gz.length };
}

/**
 * Reassemble and verify. Throws on a sha256 mismatch (torn or corrupt read).
 * @param {string[]} chunks base64
 * @param {string} expectedSha256
 */
export function decodeLedger(chunks, expectedSha256) {
  const gz = Buffer.concat(chunks.map((c) => Buffer.from(c || '', 'base64')));
  const raw = gunzipSync(gz);
  const got = sha256Hex(raw);
  if (got !== expectedSha256) throw new Error(`ledger sha256 mismatch (stored ${expectedSha256}, read ${got})`);
  return raw.toString('utf8');
}

export function documentName(projectId, path) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

/** Firestore REST value → JS (only the types this module writes). */
function fieldValue(f) {
  if (!f) return undefined;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('stringValue' in f) return f.stringValue;
  if ('bytesValue' in f) return f.bytesValue;
  if ('timestampValue' in f) return f.timestampValue;
  return undefined;
}

/** Meta document → `{chunks, sha256}`; throws when it is not one this module wrote. */
export function parseMeta(doc) {
  const chunks = fieldValue(doc?.fields?.chunks);
  const sha256 = fieldValue(doc?.fields?.sha256);
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS || !/^[0-9a-f]{64}$/.test(sha256 || '')) {
    throw new Error(`${LEDGER_DOC} is malformed (chunks=${chunks}, sha256=${sha256})`);
  }
  return { chunks, sha256, updateTime: doc.updateTime };
}

/**
 * The single atomic commit of a push.
 * @param {{projectId: string, encoded: ReturnType<typeof encodeLedger>, previousChunks: number,
 *          precondition: {exists: false} | {updateTime: string}, writer: string, urlCount: number}} p
 */
export function buildCommitWrites({ projectId, encoded, previousChunks, precondition, writer, urlCount }) {
  const writes = encoded.chunks.map((data, i) => ({
    update: { name: documentName(projectId, `${CHUNK_DOC_PREFIX}${i}`), fields: { data: { bytesValue: data } } },
  }));
  for (let i = encoded.chunks.length; i < previousChunks; i++) {
    writes.push({ delete: documentName(projectId, `${CHUNK_DOC_PREFIX}${i}`) });
  }
  writes.push({
    update: {
      name: documentName(projectId, LEDGER_DOC),
      fields: {
        chunks: { integerValue: String(encoded.chunks.length) },
        sha256: { stringValue: encoded.sha256 },
        rawBytes: { integerValue: String(encoded.rawBytes) },
        gzBytes: { integerValue: String(encoded.gzBytes) },
        urlCount: { integerValue: String(urlCount) },
        writer: { stringValue: writer },
        writtenAt: { timestampValue: new Date().toISOString() },
      },
    },
    currentDocument: precondition,
  });
  return writes;
}

function loadCredentials(env = process.env) {
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      throw new StoreConfigError(`GOOGLE_APPLICATION_CREDENTIALS is not valid JSON: ${err.message}`);
    }
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try { return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON); } catch (err) {
      throw new StoreConfigError(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
    }
  }
  throw new StoreConfigError('no service account (GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_JSON)');
}

async function connect(env = process.env) {
  const creds = loadCredentials(env);
  if (!creds.project_id) throw new StoreConfigError('service account JSON has no project_id');
  let token;
  try {
    token = await exchangeAssertionForToken(createJwtAssertion(creds, FIRESTORE_SCOPE));
  } catch (err) {
    throw new StoreConfigError(`service account token exchange failed: ${err.message}`);
  }
  const base = `${FIRESTORE_API}/projects/${creds.project_id}/databases/(default)/documents`;
  const request = async (url, options = {}) => {
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const err = new Error(`Firestore ${options.method || 'GET'} ${res.status}: ${body?.error?.message || text.slice(0, 200)}`);
      err.status = res.status;
      if (res.status === 401 || res.status === 403) Object.setPrototypeOf(err, StoreConfigError.prototype);
      throw err;
    }
    return body;
  };
  return { projectId: creds.project_id, base, request };
}

async function getDoc(conn, path) {
  try { return await conn.request(`${conn.base}/${path}`); } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Read the stored ledger.
 * @returns {Promise<{exists: false} | {exists: true, json: string, chunks: number, sha256: string, updateTime: string}>}
 */
export async function pullLedger(conn) {
  let lastErr;
  for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt++) {
    const metaDoc = await getDoc(conn, LEDGER_DOC);
    if (!metaDoc) return { exists: false };
    const meta = parseMeta(metaDoc);
    const chunks = [];
    for (let i = 0; i < meta.chunks; i++) {
      const doc = await getDoc(conn, `${CHUNK_DOC_PREFIX}${i}`);
      chunks.push(fieldValue(doc?.fields?.data) ?? '');
    }
    try {
      return { exists: true, json: decodeLedger(chunks, meta.sha256), ...meta };
    } catch (err) {
      // A commit landed between the meta and chunk reads: read again.
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * @param {{projectId: string, base: string, request: Function}} conn
 * @param {ReturnType<typeof encodeLedger>} encoded encode BEFORE connecting:
 *   a ledger too large to commit must fail without any Firestore call
 */
export async function pushLedger(conn, encoded, receipt, { writer, urlCount }) {
  if (receipt.exists && receipt.sha256 === encoded.sha256) return { written: false, encoded };
  const writes = buildCommitWrites({
    projectId: conn.projectId,
    encoded,
    previousChunks: receipt.exists ? receipt.chunks : 0,
    precondition: receipt.exists ? { updateTime: receipt.updateTime } : { exists: false },
    writer,
    urlCount,
  });
  assertCommitFits(writes);
  await conn.request(`${conn.base}:commit`, { method: 'POST', body: JSON.stringify({ writes }) });
  return { written: true, encoded };
}

export function receiptPath(ledgerPath) {
  return `${ledgerPath}.store.json`;
}

/** Strict: exactly one `--ledger <path>`, nothing else (a typo must not pick another file). */
export function parseCli(argv) {
  const [command, ...rest] = argv;
  const args = { command, ledger: null, error: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--ledger') { args.error = `unknown option ${JSON.stringify(rest[i])}`; break; }
    if (args.ledger !== null) { args.error = '--ledger given more than once'; break; }
    const value = rest[++i];
    if (!value || value.startsWith('--')) { args.error = '--ledger needs a path'; break; }
    args.ledger = value;
  }
  return args;
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path);
}

function writer(env = process.env) {
  return env.GITHUB_RUN_ID
    ? `${env.GITHUB_WORKFLOW || 'workflow'}#${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT || 1}`
    : 'local';
}

export async function runCli(argv, env = process.env) {
  const args = parseCli(argv);
  if (!['pull', 'push'].includes(args.command) || !args.ledger || args.error) {
    console.log(`::error::usage: indexing-ledger-store.mjs pull|push --ledger <path>${args.error ? ` (${args.error})` : ''}`);
    return 2;
  }
  let receipt = null;
  let encoded = null;
  let urlCount = 0;
  if (args.command === 'push') {
    // Checked before any network: a push without the receipt of a successful
    // pull would overwrite the stored spend with a ledger that never saw it.
    if (!fs.existsSync(receiptPath(args.ledger))) {
      console.log(`::error::No pull receipt ${receiptPath(args.ledger)} — refusing to push a ledger that was not pulled (it would overwrite the stored spend).`);
      return 1;
    }
    if (!fs.existsSync(args.ledger)) {
      console.log('ℹ️ No local ledger to push (nothing was bootstrapped or changed)');
      return 0;
    }
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath(args.ledger), 'utf8'));
      if (!receipt || typeof receipt.exists !== 'boolean') throw new Error('missing `exists`');
    } catch (err) {
      console.log(`::error::Pull receipt ${receiptPath(args.ledger)} is unreadable (${err.message}) — not pushed`);
      return 1;
    }
    const json = fs.readFileSync(args.ledger, 'utf8');
    try { urlCount = Object.keys(JSON.parse(json).urls || {}).length; } catch {
      console.log(`::error::Local ledger ${args.ledger} is not JSON — not pushed`);
      return 1;
    }
    try { encoded = encodeLedger(json); } catch (err) {
      console.log(`::error::Indexing API ledger push refused before any Firestore call: ${err.message}`);
      return 1;
    }
  }
  try {
    const conn = await connect(env);
    if (args.command === 'pull') {
      const stored = await pullLedger(conn);
      if (stored.exists) writeAtomic(args.ledger, stored.json);
      const pulled = stored.exists
        ? { exists: true, chunks: stored.chunks, sha256: stored.sha256, updateTime: stored.updateTime }
        : { exists: false };
      writeAtomic(receiptPath(args.ledger), JSON.stringify(pulled));
      console.log(stored.exists
        ? `📥 Indexing API ledger pulled from Firestore ${LEDGER_DOC} (${stored.chunks} chunk(s), updated ${stored.updateTime})`
        : `📥 No Indexing API ledger in Firestore ${LEDGER_DOC} yet — the job submitter bootstraps it`);
      return 0;
    }
    const { written } = await pushLedger(conn, encoded, receipt, { writer: writer(env), urlCount });
    console.log(written
      ? `📤 Indexing API ledger pushed to Firestore ${LEDGER_DOC}: ${urlCount} URLs, ${encoded.gzBytes} gzipped bytes in ${encoded.chunks.length} chunk(s)`
      : '📤 Indexing API ledger unchanged — nothing to push');
    return 0;
  } catch (err) {
    const config = err instanceof StoreConfigError;
    console.log(`::error::Indexing API ledger ${args.command} failed (${config ? 'configuration/auth' : 'store'}): ${err.message}`);
    if (args.command === 'push' && (err.status === 400 || err.status === 409 || /FAILED_PRECONDITION/.test(err.message))) {
      console.log('::error::The stored ledger changed after this run pulled it: another writer ran outside the `indexing-api-jobs-ledger` concurrency group.');
    }
    return config ? 2 : 1;
  }
}

if (isInvokedDirectly(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
