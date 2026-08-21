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

const EMPTY = { version: 1, updatedAt: null, candidates: {} };

/**
 * @param {string} [file]
 */
export function loadCandidates(file = CANDIDATES_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw?.candidates) return structuredClone(EMPTY);
    return raw;
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} [file]
 */
export function saveCandidates(store, file = CANDIDATES_PATH) {
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
 */
export function setStatus(store, key, status, patch = {}) {
  const c = store.candidates[key];
  if (!c) return null;
  const prev = c.status;
  // `dead` and `rejected` are terminal verdicts a later stage may legitimately
  // set; everything else only moves forward, so a re-run cannot rewind a
  // candidate that already reached production.
  const forward = status === 'dead' || status === 'rejected'
    || ORDER.indexOf(status) >= ORDER.indexOf(prev);
  if (forward) c.status = status;
  Object.assign(c, patch, { updatedAt: new Date().toISOString() });
  if (prev !== c.status) appendLedger({ key, from: prev, to: c.status, at: c.updatedAt, reason: patch.reason });
  return c;
}

/**
 * @param {Record<string, any>} entry
 * @param {string} [file]
 */
export function appendLedger(entry, file = LEDGER_PATH) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch { /* the ledger is diagnostic; never fail a run over it */ }
}

/**
 * Drop terminal candidates older than `maxAgeDays`.
 *
 * The queue is committed on every remote run, so it must not grow without
 * bound: `dead` and `rejected` entries are the loop's scar tissue — useful for
 * a few months so a re-run does not re-probe the same unreachable site, useless
 * for ever. Everything else is kept regardless of age, because a promoted or
 * traced candidate IS the coverage.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {number} [maxAgeDays]
 * @returns {number} how many were dropped
 */
export function pruneTerminal(store, maxAgeDays = 90) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let dropped = 0;
  for (const [key, c] of Object.entries(store.candidates)) {
    if (c.status !== 'dead' && c.status !== 'rejected') continue;
    const seen = Date.parse(c.updatedAt || c.firstSeenAt || '');
    if (Number.isFinite(seen) && seen < cutoff) { delete store.candidates[key]; dropped++; }
  }
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
