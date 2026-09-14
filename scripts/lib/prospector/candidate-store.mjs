/**
 * The candidate queue — one JSON document plus an append-only ledger.
 *
 * Deliberately a file, not a database: the queue has to be reviewable in a
 * pull request and replayable from a checkout, and at the scale that matters
 * (tens of thousands of employers) a keyed object costs nothing to load.
 *
 * A candidate advances through states, and each stage script only ever reads
 * the states it can act on:
 *
 *   new         -> discovered, nothing resolved yet
 *   resolved    -> employer domain known and verified
 *   traced      -> careers trail followed; platform or self-hosted known
 *   dead        -> no site, no careers page, or no vacancies anywhere
 *   synthesized -> a crawler exists for it
 *   validated   -> extraction graded against the live page
 *   promoted    -> graded good; eligible for the promotion gate
 *   promoting   -> shipped into an OPEN promotion PR, not merged yet
 *   production  -> passed the promotion gate and shipped as a real crawler
 *   rejected    -> measured and dismissed, with a reason
 *
 * The ledger records every transition so a later run can answer "why is this
 * employer not in production" without re-crawling anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CANDIDATES_PATH, LEDGER_PATH } from './config.mjs';
import { registrableDomain } from './registrable.mjs';
import { normalizeCompanyName } from './coverage.mjs';

/** @typedef {'new'|'resolved'|'traced'|'dead'|'synthesized'|'validated'|'promoted'|'promoting'|'production'|'rejected'} CandidateStatus */

/**
 * Stable key for an employer. Domain when we have one — it is the only truly
 * unique handle — else the normalised name plus town, which keeps two
 * "Ristorante Centrale" in different villages apart.
 *
 * @param {{ name?: string, domain?: string, city?: string }} c
 * @returns {string}
 */
export function candidateKey(c) {
  if (c.domain) return registrableDomain(c.domain);
  const n = normalizeCompanyName(c.name || '').replace(/\s+/g, '-');
  const city = String(c.city || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [n, city].filter(Boolean).join('@') || `unknown-${Math.abs(hash(JSON.stringify(c)))}`;
}

/** @param {string} s */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

const STORE_VERSION = 2;

/**
 * Rejected candidates are terminal verdicts, so their full diagnostic record
 * may age out without making the same key eligible again. The inventory is
 * deliberately capped: it is a dedupe guard, not a second diagnostic store.
 */
export const MAX_REJECTED_TOMBSTONES = 10_000;

const EMPTY = { version: STORE_VERSION, updatedAt: null, candidates: {}, rejectedTombstones: {} };
const TOMBSTONE_COUNTS = new WeakMap();

/** @param {unknown} value */
function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {ReturnType<typeof loadCandidates>} store */
function tombstonesFor(store) {
  if (!isObjectMap(store.rejectedTombstones)) {
    store.rejectedTombstones = {};
    TOMBSTONE_COUNTS.set(store.rejectedTombstones, 0);
  }
  return store.rejectedTombstones;
}

/** @param {Record<string, any>} tombstones */
function tombstoneCount(tombstones) {
  const known = TOMBSTONE_COUNTS.get(tombstones);
  if (known !== undefined) return known;
  const count = Object.keys(tombstones).length;
  TOMBSTONE_COUNTS.set(tombstones, count);
  return count;
}

/** @param {Record<string, any>} candidate */
function rejectionDate(candidate) {
  return String(candidate.rejectedAt || candidate.updatedAt || candidate.firstSeenAt || new Date().toISOString());
}

/** @param {ReturnType<typeof loadCandidates>} store */
function boundTombstones(store) {
  const tombstones = tombstonesFor(store);
  if (tombstoneCount(tombstones) <= MAX_REJECTED_TOMBSTONES) return;
  const keep = Object.entries(tombstones)
    .sort(([keyA, a], [keyB, b]) => String(b.rejectedAt).localeCompare(String(a.rejectedAt)) || keyA.localeCompare(keyB))
    .slice(0, MAX_REJECTED_TOMBSTONES)
    .map(([key]) => key);
  const keepSet = new Set(keep);
  for (const key of Object.keys(tombstones)) if (!keepSet.has(key)) delete tombstones[key];
  TOMBSTONE_COUNTS.set(tombstones, keep.length);
}

/**
 * Keep only the key and its first useful timestamp. Reasons, histories and
 * source payloads belong to the candidate record/ledger, not this guard.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {Record<string, any>} candidate
 */
function rememberRejected(store, candidate) {
  const key = String(candidate?.key || '').trim();
  if (!key) return;
  const tombstones = tombstonesFor(store);
  const rejectedAt = rejectionDate(candidate);
  const hasKey = Object.prototype.hasOwnProperty.call(tombstones, key);
  const countBefore = tombstoneCount(tombstones);
  const current = tombstones[key];
  if (!current || String(current.rejectedAt).localeCompare(rejectedAt) < 0) {
    tombstones[key] = { rejectedAt };
  }
  if (!hasKey) TOMBSTONE_COUNTS.set(tombstones, countBefore + 1);
  boundTombstones(store);
}

/**
 * @param {Record<string, any>} raw
 * @returns {ReturnType<typeof loadCandidates>}
 */
function normalizeStore(raw) {
  const store = {
    ...raw,
    version: Math.max(Number(raw.version) || 1, STORE_VERSION),
    rejectedTombstones: {},
  };
  if (isObjectMap(raw.rejectedTombstones)) {
    for (const [key, value] of Object.entries(raw.rejectedTombstones)) {
      const rejectedAt = typeof value === 'string' ? value : value?.rejectedAt;
      if (key && rejectedAt) store.rejectedTombstones[key] = { rejectedAt: String(rejectedAt) };
    }
  }
  // Backfill the compact index for stores written before tombstones existed.
  for (const candidate of Object.values(store.candidates)) {
    if (candidate?.status === 'rejected') rememberRejected(store, candidate);
  }
  return store;
}

/**
 * @param {string} [file]
 */
export function loadCandidates(file = CANDIDATES_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw?.candidates) return structuredClone(EMPTY);
    return normalizeStore(raw);
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} [file]
 */
export function saveCandidates(store, file = CANDIDATES_PATH) {
  for (const candidate of Object.values(store.candidates || {})) {
    if (candidate?.status === 'rejected') rememberRejected(store, candidate);
  }
  boundTombstones(store);
  store.version = Math.max(Number(store.version) || 1, STORE_VERSION);
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Insert or merge a candidate. Merging never downgrades a status and never
 * loses a source attribution — the same employer legitimately arrives from the
 * SECO feed, a map extract and a tenant sweep, and knowing it came from three
 * independent channels is itself a quality signal.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {Object} incoming
 * @param {string} source
 * @returns {{ key: string, created: boolean }}
 */
export function upsertCandidate(store, incoming, source) {
  const key = incoming.key || candidateKey(incoming);
  const now = new Date().toISOString();
  const existing = store.candidates[key];
  if (!existing && tombstonesFor(store)[key]) return { key, created: false };
  // A repeated sighting must not refresh a rejected record's retention clock
  // or merge new diagnostic payload into a verdict that is already terminal.
  if (existing?.status === 'rejected') {
    rememberRejected(store, existing);
    return { key, created: false };
  }
  if (!existing) {
    store.candidates[key] = {
      key,
      status: 'new',
      sources: [source],
      firstSeenAt: now,
      updatedAt: now,
      ...incoming,
    };
    return { key, created: true };
  }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'status' || k === 'sources') continue;
    if (existing[k] === undefined || existing[k] === '' || existing[k] === null) existing[k] = v;
  }
  if (!existing.sources.includes(source)) existing.sources.push(source);
  existing.updatedAt = now;
  return { key, created: false };
}

const ORDER = ['rejected', 'dead', 'new', 'resolved', 'traced', 'synthesized', 'validated', 'promoted', 'promoting', 'production'];

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} key
 * @param {CandidateStatus} status
 * @param {Record<string, any>} [patch]
 * @param {string} [ledgerFile] dove scrivere la voce di registro; un test che
 *   esercita una transizione non deve appendere al registro committato.
 */
export function setStatus(store, key, status, patch = {}, ledgerFile = LEDGER_PATH) {
  const c = store.candidates[key];
  if (!c) return null;
  const prev = c.status;
  // A rejected verdict is terminal. Reopening it would make the compact
  // tombstone ineffective; a future policy can add an explicit reopen API
  // that removes the tombstone instead of treating an ordinary transition as
  // permission to retry.
  if (prev === 'rejected' && status !== 'rejected') {
    rememberRejected(store, c);
    return c;
  }
  // `dead` and `rejected` are terminal verdicts a later stage may legitimately
  // set; everything else only moves forward, so a re-run cannot rewind a
  // candidate that already reached production.
  const forward = status === 'dead' || status === 'rejected'
    || ORDER.indexOf(status) >= ORDER.indexOf(prev);
  if (forward) c.status = status;
  Object.assign(c, patch, { updatedAt: new Date().toISOString() });
  if (c.status === 'rejected' && !c.rejectedAt) c.rejectedAt = c.updatedAt;
  if (prev === 'rejected' || c.status === 'rejected') rememberRejected(store, c);
  if (prev !== c.status) appendLedger({ key, from: prev, to: c.status, at: c.updatedAt, reason: patch.reason }, ledgerFile);
  return c;
}

/**
 * @param {Record<string, any>} entry
 * @param {string} [file]
 */
export function appendLedger(entry, file = LEDGER_PATH) {
  // `null` esplicito = non registrare: serve a una dry-run, che applica la
  // transizione in memoria per stamparla e poi butta via lo store.
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch { /* the ledger is diagnostic; never fail a run over it */ }
}

/**
 * Drop terminal candidates older than `maxAgeDays`.
 *
 * The queue is committed on every remote run, so it must not grow without
 * bound: `dead` entries are transient scar tissue and may be rediscovered after
 * the window. A `rejected` record is compacted to a bounded tombstone instead:
 * the explicit verdict survives the diagnostic retention window without
 * keeping its full history and source payload.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {number} [maxAgeDays]
 * @returns {number} how many were dropped
 */
export function pruneTerminal(store, maxAgeDays = 90) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let dropped = 0;
  for (const [key, c] of Object.entries(store.candidates)) {
    if (c.status === 'rejected') rememberRejected(store, c);
    else if (c.status !== 'dead') continue;
    const seen = Date.parse(c.status === 'rejected'
      ? (c.rejectedAt || c.updatedAt || c.firstSeenAt || '')
      : (c.updatedAt || c.firstSeenAt || ''));
    if (Number.isFinite(seen) && seen < cutoff) { delete store.candidates[key]; dropped++; }
  }
  boundTombstones(store);
  return dropped;
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {CandidateStatus|CandidateStatus[]} status
 * @returns {any[]}
 */
export function byStatus(store, status) {
  const want = new Set(Array.isArray(status) ? status : [status]);
  return Object.values(store.candidates).filter((c) => want.has(c.status));
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @returns {Record<string, number>}
 */
export function statusCounts(store) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const c of Object.values(store.candidates)) out[c.status] = (out[c.status] || 0) + 1;
  return out;
}
