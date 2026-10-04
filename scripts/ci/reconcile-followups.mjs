#!/usr/bin/env node
/**
 * reconcile-followups.mjs — zero-Claude reconciliation of done-but-open follow-ups.
 *
 * Many `follow-up` issues are satisfied silently by a LATER organic PR that touches
 * the same file (adds the cited test / fix) without writing `Closes #N` — the author
 * didn't know the follow-up existed. They then accumulate as noise: they bloat the
 * issue list and (auto-routed to `agent:fix`) re-trigger the fixer on the shared Max
 * quota. `post-merge-followup.yml` only flags `🔗 Possibile supersede` on file-touch,
 * never on verified content. This closes that gap deterministically.
 *
 * For each open `follow-up` issue, it extracts the cited file(s) and the distinctive
 * CODE token(s) quoted in the body (`Original text` / `Suggested action`), then checks
 * whether those tokens are now present verbatim in the cited file. A hit means the
 * asserted behavior/symbol already exists → the item is likely done-but-open.
 *
 * TWO-TIER, double-confirm-across-time (replaces the old never-close rule, which left
 * the deterministically-detected `maybe-resolved` pile to a human who never came — the
 * #1 reason the follow-up backlog never converged):
 *   1. FIRST detection (issue not yet `maybe-resolved`): post ONE advisory comment + add
 *      the `maybe-resolved` label. A grace window — the human has until the next scheduled
 *      run to object (reopen scope / strip the label / add a keep-open signal).
 *   2. SECOND confirmation (issue ALREADY carries `maybe-resolved` from a prior run, is
 *      STILL resolved, is NOT a multi-item aggregate, and carries no keep-open/strategic
 *      label): AUTO-CLOSE with a citation comment + `fu-resolved-auto`, `--reason completed`.
 * Why this is safe (no quality loss): the close fires only on TWO independent deterministic
 * confirmations separated in time, after a human grace window, on the hardened matcher
 * (ALL distinctive prescribed code tokens present — the same bar that gates the issue-fix
 * pre-flight, which DROPS work, a strictly higher-stakes action than a reversible close).
 * Multi-item aggregates and keep-open/strategic issues never auto-close (a prose-only
 * sub-item contributes no gating token, so "all tokens present" can't prove every item is
 * done). A genuinely-pending fix recurs and reopens via the dedup-stable monitor title.
 *
 * Env:
 *   GH_TOKEN       required for gh writes (provided by Actions).
 *   GH_REPO        optional `owner/repo` (else gh infers from cwd).
 *   DRY_RUN        "1" → detect + print, no comment/label/close writes.
 *   MAX_ISSUES     cap issues scanned (default 100).
 *   NO_AUTOCLOSE   "1" → force tier-1 behavior only (flag, never close). Escape hatch.
 *   BLOCKED_RECHECK_MAX_READS      tetto di letture `gh api` della rimisura dei `blocked` (default 60).
 *   BLOCKED_RECHECK_MAX_REENTRIES  tetto di rientri `blocked` → `open` per run (default 3).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FOLLOWUP_ITEM_ID_SINGLE_RE,
  bucketState,
  dailyKeyFromBucketBody,
  dailyBucketInfo,
  detectAlreadyResolved,
  hasEnumeratedItems,
  hasDailyBucketRepositoryConsistency,
  hasFalsifiableAcceptance,
  hasStableItemIds,
  hasStableItemIdsForDailyKey,
  hasUnterminatedMarkdownFence,
  isDailyBucketTitle,
  normalizeAcceptanceToken,
  parseFollowupItems,
  updateFollowupItemState,
  splitFollowupItems,
} from './followup-resolution-match.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';
import { inertCommentText, itemMetricLine, parseItemMarkers } from './lib/followup-item-evidence.mjs';
import {
  applyBlockedRecheck,
  blockedRecheckSummary,
  bornTrueCommentBody,
  bucketStartIso,
  planBlockedRecheck,
  unblockedCommentBody,
} from './lib/followup-blocked-recheck.mjs';
import { isTrustedAuthor } from './route-already-fixed.mjs';

export { hasEnumeratedItems };

const DRY_RUN = process.env.DRY_RUN === '1';
const NO_AUTOCLOSE = process.env.NO_AUTOCLOSE === '1';
const MAX_ISSUES = intFromEnv('MAX_ISSUES', 100);
// Rimisura degli item `blocked`: tetti dichiarati per run. Le letture sono
// chiamate `gh api` (commit su un path, contenuto di un file a una data);
// oltre il tetto la lettura e' «non so» → nessun done, nessun rientro.
const BLOCKED_RECHECK_MAX_READS = intFromEnv('BLOCKED_RECHECK_MAX_READS', 60);
// Ogni rientro costa al piu' una run del fixer.
const BLOCKED_RECHECK_MAX_REENTRIES = intFromEnv('BLOCKED_RECHECK_MAX_REENTRIES', 3);
const MARKER = '<!-- reconcile-bot -->';
const FLAG_MARKER = '<!-- reconcile-bot:flag -->';
const CLOSE_MARKER = '<!-- reconcile-bot:autoclose -->';
const LABEL = 'maybe-resolved';
const CLOSED_LABEL = 'fu-resolved-auto';
export const UNCLASSIFIABLE_LABEL = 'reconcile-unclassifiable';
export const UNCLASSIFIABLE_MARKER_PREFIX = '<!-- reconcile-unclassifiable';
export const UNCLASSIFIABLE_MARKER_SCHEMA = 1;
export const UNCLASSIFIABLE_MARKER_RE = /<!-- reconcile-unclassifiable schema=(\d+) classifier=([0-9a-f]{64}) fingerprint=([0-9a-f]{64}) -->/;

function classifierVersion() {
  const source = [
    readClassifierSource(import.meta.url, 'scripts/ci/reconcile-followups.mjs'),
    readClassifierSource(new URL('./followup-resolution-match.mjs', import.meta.url), 'scripts/ci/followup-resolution-match.mjs'),
  ];
  return createHash('sha256')
    .update(source[0])
    .update('\0')
    .update(source[1])
    .digest('hex');
}

function readClassifierSource(url, fallbackPath) {
  try {
    return fs.readFileSync(fileURLToPath(url));
  } catch {
    return fs.readFileSync(path.resolve(process.cwd(), fallbackPath));
  }
}

export const RECONCILE_UNCLASSIFIABLE_CLASSIFIER_VERSION = classifierVersion();

// Labels that VETO auto-close (the issue wants human eyes regardless of token match):
// explicit keep-open pins + strategic trackers (revenue/tracker stay owner-gated).
export const KEEP_OPEN_LABELS = new Set(['pinned', 'keep-open', 'revenue', 'tracker', 'do-not-close']);

/**
 * A title like "follow-up(#X): 3 item deferred/deferiti — …" with N≥2 → multi-item aggregate.
 * The explicit count matches the pre-flight form; body enumeration is the conservative
 * fallback for titles that do not carry a count.
 * @param {string} title
 * @param {string} [body]
 * @returns {boolean}
 */
export function isAggregateTitle(title = '', body = '') {
  const t = String(title);
  const m = t.match(/\b(\d+)\s+items?\s+(?:deferred|deferit[oi])\b/i);
  // An explicit count is authoritative once present — trust it fully instead
  // of falling through to the keyword fallback below, which exists ONLY for
  // aggregates that never state a count. Otherwise a genuinely single-item
  // follow-up whose title contains "batch"/"sweep"/"bulk" as an ordinary word
  // (e.g. "1 item deferred ... batch backfill...") is misclassified as an
  // aggregate despite explicitly saying "1 item" (#3378).
  if (m) return Number(m[1]) >= 2;
  if (/\b(?:sweep|batch|bulk)\b/i.test(t)) return true;
  return hasEnumeratedItems(body);
}

const TECHNICAL_LABELS = new Set([UNCLASSIFIABLE_LABEL, LABEL, CLOSED_LABEL]);
const TECHNICAL_COMMENT_MARKERS = [UNCLASSIFIABLE_MARKER_PREFIX, MARKER, CLOSE_MARKER];

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function fingerprintLabels(issue) {
  return [...new Set((issue?.labels || [])
    .map(labelName)
    .filter(Boolean)
    .map(String)
    .filter((name) => !TECHNICAL_LABELS.has(name)))]
    .sort();
}

function commentField(comment, camel, snake) {
  return comment?.[camel] ?? comment?.[snake] ?? '';
}

function isTechnicalComment(body) {
  return TECHNICAL_COMMENT_MARKERS.some((marker) => String(body || '').includes(marker));
}

function fingerprintComment(comment) {
  return {
    id: String(comment?.id || ''),
    author: String(comment?.author?.login || comment?.author?.name || comment?.author || ''),
    createdAt: String(commentField(comment, 'createdAt', 'created_at')),
    updatedAt: String(commentField(comment, 'updatedAt', 'updated_at')),
    body: String(comment?.body || ''),
  };
}

export function unclassifiableIssueFingerprint(issue, comments) {
  if (!Array.isArray(comments)) return null;
  const humanComments = comments
    .filter((comment) => !isTechnicalComment(comment?.body))
    .map(fingerprintComment)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const input = JSON.stringify({
    title: String(issue?.title || ''),
    body: String(issue?.body || ''),
    labels: fingerprintLabels(issue),
    comments: humanComments,
  });
  return createHash('sha256').update(input).digest('hex');
}

function markerCommentOrder(comment, index) {
  return `${commentField(comment, 'createdAt', 'created_at')}\0${commentField(comment, 'updatedAt', 'updated_at')}\0${String(index).padStart(8, '0')}`;
}

function latestUnclassifiableMarker(comments) {
  if (!Array.isArray(comments)) return null;
  const candidates = comments
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => String(comment?.body || '').includes(UNCLASSIFIABLE_MARKER_PREFIX))
    .sort((a, b) => markerCommentOrder(a.comment, a.index).localeCompare(markerCommentOrder(b.comment, b.index)));
  if (!candidates.length) return null;

  const { comment } = candidates[candidates.length - 1];
  const body = String(comment?.body || '');
  if (body.indexOf(UNCLASSIFIABLE_MARKER_PREFIX) !== body.lastIndexOf(UNCLASSIFIABLE_MARKER_PREFIX)) {
    return { valid: false };
  }
  const match = UNCLASSIFIABLE_MARKER_RE.exec(body);
  if (!match) return { valid: false };
  return {
    valid: true,
    schema: Number(match[1]),
    classifierVersion: match[2],
    fingerprint: match[3],
  };
}

export function isUnclassifiableAggregate(title = '', body = '') {
  return isAggregateTitle(title, body) && splitFollowupItems(body).length === 0;
}

export function unclassifiableMarker(issue, comments, {
  classifierVersion: expectedClassifierVersion = RECONCILE_UNCLASSIFIABLE_CLASSIFIER_VERSION,
} = {}) {
  if (!isUnclassifiableAggregate(issue?.title, issue?.body)) return null;
  const fingerprint = unclassifiableIssueFingerprint(issue, comments);
  const normalizedClassifier = String(expectedClassifierVersion || '').toLowerCase();
  if (!fingerprint || !/^[0-9a-f]{64}$/.test(normalizedClassifier)) {
    return null;
  }
  return `${UNCLASSIFIABLE_MARKER_PREFIX} schema=${UNCLASSIFIABLE_MARKER_SCHEMA} classifier=${normalizedClassifier} fingerprint=${fingerprint} -->`;
}

export function isCurrentUnclassifiable(issue, comments, {
  classifierVersion: expectedClassifierVersion = RECONCILE_UNCLASSIFIABLE_CLASSIFIER_VERSION,
} = {}) {
  const labels = (issue?.labels || []).map(labelName);
  if (!labels.includes(UNCLASSIFIABLE_LABEL) || !isUnclassifiableAggregate(issue?.title, issue?.body)) return false;
  const expectedFingerprint = unclassifiableIssueFingerprint(issue, comments);
  const expectedClassifier = String(expectedClassifierVersion || '').toLowerCase();
  if (!expectedFingerprint || !/^[0-9a-f]{64}$/.test(expectedClassifier)) return false;
  const marker = latestUnclassifiableMarker(comments);
  return !!marker
    && marker.valid
    && marker.schema === UNCLASSIFIABLE_MARKER_SCHEMA
    && marker.classifierVersion === expectedClassifier
    && marker.fingerprint === expectedFingerprint;
}

/**
 * Evidence strong enough to AUTO-CLOSE (vs merely flag). A single common dot-member like
 * `meta.model` matches in countless unrelated files → too coincidental to close on. Require
 * MULTIPLE distinct prescribed tokens all present. A single token, even if it looks like a
 * rich expression, can be the status quo that the follow-up asks to change. The one-token
 * exception is an explicit stable-item Acceptance token, whose contract is already scoped
 * to the item and is checked by the matcher. Weak-but-resolved legacy evidence stays flagged
 * for a human (never silently closed).
 * @param {string[]} matchedTokens tokens that were found verbatim in a cited file
 * @param {{acceptanceToken?: string}} [options] explicit stable-item acceptance token
 * @returns {boolean}
 */
export function isStrongAutoCloseEvidence(matchedTokens, { acceptanceToken = '' } = {}) {
  const uniq = [...new Set((matchedTokens || []).map((t) => String(t)))];
  const explicit = normalizeAcceptanceToken(acceptanceToken);
  if (explicit && uniq.includes(explicit)) return true;
  return uniq.length >= 2;
}

/** Insieme normalizzato di ID item (Set, array o null). */
function itemIdSet(ids) {
  if (!ids) return new Set();
  return new Set([...ids].map((id) => String(id ?? '').trim().toUpperCase()).filter(Boolean));
}

/**
 * Gli item che il gate sul conio ha marcato `FU_ITEM_BORN_SATISFIED`: il loro
 * token di accettazione era GIA' vero quando l'item e' nato, quindi trovarlo
 * oggi nel file non misura nessun lavoro. Riceve i marker gia' filtrati per
 * autore fidato (`parseItemMarkers`).
 * @param {Array<{type: string, item: string}>} markers
 * @returns {Set<string>}
 */
export function bornSatisfiedItemIds(markers) {
  return itemIdSet((Array.isArray(markers) ? markers : [])
    .filter((marker) => marker?.type === 'born-satisfied')
    .map((marker) => marker.item));
}

/**
 * Gli input dei gate giornalieri, calcolati in UN punto: `gateArgs` sono gli
 * argomenti posizionali dal terzo in poi che `main()` passa a
 * `reconcileDailyItems` e a entrambe le chiamate di `dailyBucketCloseGate`
 * (chiave, repository e conteggio dal titolo, poi l'insieme born-satisfied dai
 * commenti fidati), cosi' i tre punti di chiamata non possono divergere.
 * `null` se il titolo non e' un bucket giornaliero o se i commenti non sono
 * leggibili (senza commenti non si esclude un marker born-satisfied).
 * @returns {{daily: object, itemMarkers: object[], bornSatisfied: Set<string>, gateArgs: unknown[]}|null}
 */
export function dailyBucketGateInputs(title, comments) {
  const daily = dailyBucketInfo(title || '');
  if (!daily || !Array.isArray(comments)) return null;
  const itemMarkers = parseItemMarkers(comments, { isTrusted: isTrustedAuthor });
  const bornSatisfied = bornSatisfiedItemIds(itemMarkers);
  return {
    daily,
    itemMarkers,
    bornSatisfied,
    gateArgs: [daily.dailyKey, daily.targetRepository, daily.itemCount, bornSatisfied],
  };
}

/**
 * Item-level close gate for a sealed daily bucket. Every item must be structurally
 * readable, accepted, explicitly `done`, token-confirmed, and backed by strong evidence.
 * A single unresolved/ambiguous/weak item vetoes the whole issue.
 *
 * `bornSatisfiedIds`: item il cui token era gia' vero al conio. Il token non
 * prova nulla per loro, quindi bloccano con `born-satisfied-token` anche se
 * sono `done`: il bucket lo chiude una persona con evidenza, non il reconciler.
 */
export function dailyBucketCloseGate(
  body,
  io,
  expectedDailyKey = null,
  expectedTargetRepository = null,
  expectedItemCount = null,
  bornSatisfiedIds = null,
) {
  if (hasUnterminatedMarkdownFence(body)) {
    return { blocks: true, reason: 'unterminated-markdown-fence', validItems: [], unresolvedItems: [] };
  }
  const items = parseFollowupItems(body);
  if (!items.length) return { blocks: true, reason: 'aggregate-unparsed', validItems: [], unresolvedItems: [] };
  if (expectedItemCount !== null
      && (!Number.isInteger(Number(expectedItemCount))
        || Number(expectedItemCount) < 1
        || Number(expectedItemCount) !== items.length)) {
    return { blocks: true, reason: 'mismatched-item-count', validItems: items, unresolvedItems: items };
  }
  if (!hasStableItemIds(body)) return { blocks: true, reason: 'missing-stable-item-id', validItems: [], unresolvedItems: items };
  const bodyDailyKey = dailyKeyFromBucketBody(body);
  if (!bodyDailyKey) return { blocks: true, reason: 'missing-daily-key', validItems: items, unresolvedItems: items };
  if (expectedDailyKey && bodyDailyKey !== String(expectedDailyKey).trim()) {
    return { blocks: true, reason: 'mismatched-daily-key', validItems: items, unresolvedItems: items };
  }
  if (!hasStableItemIdsForDailyKey(items, bodyDailyKey)) {
    return { blocks: true, reason: 'mismatched-stable-item-id', validItems: items, unresolvedItems: items };
  }
  if (!hasDailyBucketRepositoryConsistency(body, expectedTargetRepository || '')) {
    return { blocks: true, reason: 'mismatched-target-repository', validItems: items, unresolvedItems: items };
  }
  const state = bucketState(body);
  if (!state) return { blocks: true, reason: 'ambiguous-bucket-state', validItems: items, unresolvedItems: items };
  if (state !== 'sealed') return { blocks: true, reason: 'bucket-collecting', validItems: items, unresolvedItems: items };
  const invalid = items.filter((item) => !hasFalsifiableAcceptance(item.text));
  if (invalid.length) return { blocks: true, reason: 'invalid-item', validItems: items.filter((item) => !invalid.includes(item)), unresolvedItems: invalid };
  const born = itemIdSet(bornSatisfiedIds);
  const evidenceById = new Map();
  const unresolvedItems = [];
  const weakItems = [];
  const bornSatisfiedItems = [];
  for (const item of items) {
    const result = detectAlreadyResolved(item.text, io, { acceptanceToken: item.acceptanceToken });
    evidenceById.set(item.id, result.evidence || []);
    if (born.has(item.id)) {
      bornSatisfiedItems.push(item);
      continue;
    }
    if (item.state !== 'done' || !result.resolved) unresolvedItems.push(item);
    if (!isStrongAutoCloseEvidence(
      (result.evidence || []).map((entry) => entry.tok),
      { acceptanceToken: item.acceptanceToken },
    )) weakItems.push(item);
  }
  if (unresolvedItems.length) {
    return { blocks: true, reason: 'valid-item-unconfirmed', validItems: items, unresolvedItems, bornSatisfiedItems, evidenceById };
  }
  if (bornSatisfiedItems.length) {
    return { blocks: true, reason: 'born-satisfied-token', validItems: items, unresolvedItems: bornSatisfiedItems, bornSatisfiedItems, evidenceById };
  }
  if (weakItems.length) {
    return { blocks: true, reason: 'weak-item-evidence', validItems: items, unresolvedItems: weakItems, bornSatisfiedItems, evidenceById };
  }
  return { blocks: false, reason: null, validItems: items, unresolvedItems: [], bornSatisfiedItems, evidenceById };
}

/**
 * Il veto strutturale di un bucket giornaliero sulle SCRITTURE di stato degli
 * item: `null` se il corpo e' leggibile, coerente con titolo (chiave,
 * repository, conteggio) e `sealed`; altrimenti il motivo. Lo stesso controllo
 * precede `reconcileDailyItems` e la rimisura degli item `blocked`.
 * @returns {string|null}
 */
export function dailyBucketStructureReason(
  body,
  expectedDailyKey = null,
  expectedTargetRepository = null,
  expectedItemCount = null,
) {
  const source = String(body || '');
  if (hasUnterminatedMarkdownFence(source)) return 'unterminated-markdown-fence';
  const items = parseFollowupItems(source);
  if (!items.length || !hasStableItemIds(source)) return 'missing-stable-item-id';
  if (expectedItemCount !== null
      && (!Number.isInteger(Number(expectedItemCount))
        || Number(expectedItemCount) < 1
        || Number(expectedItemCount) !== items.length)) {
    return 'mismatched-item-count';
  }
  const bodyDailyKey = dailyKeyFromBucketBody(source);
  if (!bodyDailyKey) return 'missing-daily-key';
  if (expectedDailyKey && bodyDailyKey !== String(expectedDailyKey).trim()) return 'mismatched-daily-key';
  if (!hasStableItemIdsForDailyKey(items, bodyDailyKey)) return 'mismatched-stable-item-id';
  if (!hasDailyBucketRepositoryConsistency(source, expectedTargetRepository || '')) return 'mismatched-target-repository';
  if (bucketState(source) !== 'sealed') return 'bucket-collecting';
  return null;
}

/**
 * Mark only token-confirmed daily items as done; never infer completion from prose.
 * Un item in `bornSatisfiedIds` resta com'e': il suo token era vero gia' al
 * conio e non conferma nulla (finisce in `bornSatisfied`, non in `changes`).
 */
export function reconcileDailyItems(
  body,
  io,
  expectedDailyKey = null,
  expectedTargetRepository = null,
  expectedItemCount = null,
  bornSatisfiedIds = null,
) {
  const source = String(body || '');
  const structureReason = dailyBucketStructureReason(source, expectedDailyKey, expectedTargetRepository, expectedItemCount);
  if (structureReason) {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: structureReason };
  }
  const items = parseFollowupItems(source);
  const born = itemIdSet(bornSatisfiedIds);
  let nextBody = source;
  const changes = [];
  const bornSatisfied = [];
  const evidenceById = new Map();
  for (const item of items) {
    const result = hasFalsifiableAcceptance(item.text)
      ? detectAlreadyResolved(item.text, io, { acceptanceToken: item.acceptanceToken })
      : { resolved: false, evidence: [] };
    evidenceById.set(item.id, result.evidence || []);
    if (result.resolved && (item.state === 'open' || item.state === 'in-progress')) {
      if (born.has(item.id)) {
        bornSatisfied.push(item.id);
        continue;
      }
      const updated = updateFollowupItemState(nextBody, item.id, 'done');
      if (updated) {
        nextBody = updated;
        changes.push({ id: item.id, state: 'done', evidence: result.evidence || [] });
      }
    }
  }
  return { body: nextBody, changed: nextBody !== source, changes, bornSatisfied, evidenceById, reason: null };
}

export const BUCKET_VERIFY_REQUEST_MARKER = 'FU_BUCKET_VERIFY_REQUEST';
const BUCKET_VERIFY_REQUEST_RE = new RegExp(`<!--\\s*${BUCKET_VERIFY_REQUEST_MARKER}:\\s*items=([^\\s>]*)\\s*-->`, 'gu');

/** `<!-- FU_BUCKET_VERIFY_REQUEST: items=FU-…,FU-… -->` (ID validati, ordine stabile). */
export function bucketVerifyRequestMarker(ids) {
  const list = [...itemIdSet(ids)];
  if (!list.length || list.some((id) => !FOLLOWUP_ITEM_ID_SINGLE_RE.test(id))) {
    throw new TypeError(`item-id-invalidi:${list.join(',')}`);
  }
  return `<!-- ${BUCKET_VERIFY_REQUEST_MARKER}: items=${list.sort().join(',')} -->`;
}

/**
 * Unione degli ID gia' coperti da richieste di verifica precedenti, letta dai
 * SOLI commenti di autori fidati (chiunque puo' commentare una issue pubblica:
 * un marker falso non deve zittire una richiesta dovuta).
 * @returns {Set<string>}
 */
export function bucketVerifyRequestCoverage(comments, { isTrusted } = {}) {
  const covered = new Set();
  if (!Array.isArray(comments) || typeof isTrusted !== 'function') return covered;
  for (const comment of comments) {
    if (!isTrusted(comment)) continue;
    for (const match of String(comment?.body ?? '').matchAll(BUCKET_VERIFY_REQUEST_RE)) {
      for (const raw of match[1].split(',')) {
        const id = raw.trim().toUpperCase();
        if (FOLLOWUP_ITEM_ID_SINGLE_RE.test(id)) covered.add(id);
      }
    }
  }
  return covered;
}

/**
 * Decisione pura: chiedere una verifica esplicita per un bucket `sealed` che
 * non ha piu' item `open` ne' `in-progress` ma ha almeno un item non
 * confermato (non `done`, oppure `done` su un token gia' vero al conio).
 * Idempotente per COPERTURA: se l'unione degli ID dei marker precedenti
 * contiene gia' tutti gli ID in attesa, non si riposta. Non chiude mai nulla.
 * @returns {{action: 'request'|'none', reason: string, items: object[], newIds: string[]}}
 */
export function decideBucketVerifyRequest({ body, bornSatisfiedIds = null, comments = [], isTrusted } = {}) {
  const none = (reason, items = []) => ({ action: 'none', reason, items, newIds: [] });
  if (bucketState(body) !== 'sealed') return none('bucket-not-sealed');
  const items = parseFollowupItems(body);
  if (!items.length) return none('no-items');
  if (items.some((item) => item.state === 'open' || item.state === 'in-progress')) return none('items-open');
  const born = itemIdSet(bornSatisfiedIds);
  const pending = items.filter((item) => item.state !== 'done' || born.has(item.id));
  if (!pending.length) return none('all-done');
  const covered = bucketVerifyRequestCoverage(comments, { isTrusted });
  const newIds = pending.map((item) => item.id).filter((id) => !covered.has(id));
  if (!newIds.length) return none('already-requested', pending);
  return { action: 'request', reason: 'awaiting-verification', items: pending, newIds };
}

/**
 * Se la richiesta di verifica puo' (ri)mettere `maybe-resolved`. No quando un
 * flag del reconciler e' gia' stato postato e la label manca: e' l'obiezione
 * umana di `decideReconcileAction` (label tolta dopo il flag), e rimetterla la
 * cancellerebbe, aprendo la via alla chiusura al giro in cui tutto e' `done`.
 */
export function shouldEnsureVerifyLabel({ comments, labelNames }) {
  const hasLabel = Array.isArray(labelNames) && labelNames.includes(LABEL);
  if (hasLabel) return true;
  return !(Array.isArray(comments) && comments.some((c) => isReconcileFlagComment(c?.body)));
}

function lastMarkerFor(markers, type, itemId) {
  return (Array.isArray(markers) ? markers : []).filter((marker) => marker?.type === type && marker.item === itemId).at(-1) ?? null;
}

function codeSpan(value) {
  const text = inertCommentText(String(value ?? '').replace(/`/gu, ''));
  return text ? `\`${text}\`` : '';
}

/**
 * Il commento di richiesta di verifica. Per ogni item: stato, motivo del
 * blocco (`FU_ITEM_BLOCKED`), evidenza (`FU_ITEM_EVIDENCE`), `Target file` e
 * riga METRICA della scheda. Il testo dell'item passa da `inertCommentText`:
 * il commento e' firmato da un bot fidato e non deve poter comporre marker.
 * @param {{items: object[], markers?: object[], bornSatisfiedIds?: Iterable<string>|null}} input
 */
export function bucketVerifyRequestBody({ items, markers = [], bornSatisfiedIds = null }) {
  const born = itemIdSet(bornSatisfiedIds);
  const lines = [
    bucketVerifyRequestMarker(items.map((item) => item.id)),
    '🔎 **Richiesta di verifica**: questo bucket non ha piu\' item `open` ne\' `in-progress`, ma non tutti gli item sono `done` confermati. Il reconciler non lo chiude: serve una verifica esplicita, item per item.',
    '',
    '**Misura la METRICA: PR mergiata, commit e run verde provano che la PR esiste, non che l\'item sia risolto.**',
  ];
  for (const item of items) {
    const blocked = lastMarkerFor(markers, 'blocked', item.id);
    const evidence = lastMarkerFor(markers, 'evidence', item.id);
    const evidenceText = evidence
      ? [
        evidence.pr ? `PR #${evidence.pr}` : null,
        `commit \`${String(evidence.commit).slice(0, 12)}\``,
        `run ${evidence.run}`,
        `legame \`${evidence.link}\``,
      ].filter(Boolean).join(', ')
      : 'nessuna evidenza registrata';
    const metric = itemMetricLine(item);
    lines.push(
      '',
      `**\`${item.id}\`**`,
      `- Stato: \`${item.state || 'non leggibile'}\``,
      `- Motivo del blocco: ${blocked ? `\`${blocked.reason}\`` : 'nessun marker di blocco'}`,
      `- Evidenza: ${evidenceText}`,
      `- Target file: ${codeSpan(item.targetFile) || 'non dichiarato'}`,
      `- METRICA dell'item, da rimisurare: ${metric || 'assente nella scheda'}`,
      born.has(item.id)
        ? '- Token di accettazione gia\' vero al conio (FU_ITEM_BORN_SATISFIED): trovarlo nel file non conferma l\'item.'
        : null,
    );
  }
  lines.push(
    '',
    'Esito: se la METRICA e\' al bersaglio, chiudi il bucket con l\'evidenza della misura; se il difetto c\'e\' ancora, riporta l\'item a `State: open`, togli `maybe-resolved` e ri-aggiungi `agent:fix`. Il reconciler non chiude da qui: chiude una persona con evidenza o il token di accettazione.',
  );
  return lines.filter((line) => line !== null).join('\n');
}

/**
 * Riga di log per bucket, una per issue giornaliera:
 * `bucket #N: done=<a> open=<b> blocked=<c> awaiting=<ID,…> born_satisfied=<ID,…> reason=<motivo>`.
 * `open` conta anche `in-progress`; `awaiting` sono gli item ne' aperti ne' `done`.
 */
export function dailyBucketSummaryLine({ number, body, bornSatisfiedIds = null, reason }) {
  const items = parseFollowupItems(body);
  const born = itemIdSet(bornSatisfiedIds);
  const isOpen = (item) => item.state === 'open' || item.state === 'in-progress';
  const list = (ids) => (ids.length ? ids.join(',') : '-');
  const done = items.filter((item) => item.state === 'done').length;
  const open = items.filter(isOpen).length;
  const blocked = items.filter((item) => item.state === 'blocked').length;
  const awaiting = items.filter((item) => !isOpen(item) && item.state !== 'done').map((item) => item.id);
  const bornIds = items.filter((item) => born.has(item.id)).map((item) => item.id);
  return `bucket #${number}: done=${done} open=${open} blocked=${blocked} awaiting=${list(awaiting)} born_satisfied=${list(bornIds)} reason=${reason || 'closable'}`;
}

/**
 * Il veto dell'aggregata, per CONTENUTO invece che per titolo.
 *
 * Prima bastava «il titolo dice K≥2 item» per non chiudere mai. Il motivo
 * dichiarato era corretto — «a prose-only sub-item contributes no gating
 * token, so "all tokens present" can't prove every item is done» — ma la
 * conseguenza era che l'aggregata non si chiudeva MAI, perché nessuno arriva a
 * chiuderla a mano. Misurato il 2026-09-05: il detector marcava
 * `maybe-resolved` su 21 issue e ne chiudeva 2; le altre 19 erano aggregate.
 *
 * La riclassificazione NON abbassa la barra di chiusura, la sposta su ciò che
 * era davvero un item: un rischio in prosa senza condizione di accettazione
 * falsificabile non era un item valido, ma se compare accanto a un item valido
 * lascia comunque lavoro pendente e fa da veto esplicito. Gli item validi che
 * restano devono essere TUTTI token-confermati, uno per uno — bar più alta del
 * vecchio controllo issue-wide, che leggeva i token di tutto il corpo insieme.
 *
 * Il guardrail contro l'incidente #5849 (aggregata chiusa con due item ancora
 * deferiti) è il ramo `no-valid-item`: se dopo la riclassificazione NON resta
 * nessun item valido, non si chiude. Un mix di item validi e prosa pendente usa
 * invece `mixed-prose-pending`; chiudere lì sarebbe chiudere su evidenza
 * assente, che è esattamente il caso vietato.
 *
 * @returns {{blocks: boolean, reason: string|null}}
 */
export function aggregateCloseGate(body, io) {
  if (hasUnterminatedMarkdownFence(body)) return { blocks: true, reason: 'unterminated-markdown-fence' };
  if (bucketState(body) || hasStableItemIds(body)) return dailyBucketCloseGate(body, io);
  const items = splitFollowupItems(body);
  // Corpo senza struttura a item: non abbiamo riclassificato nulla, quindi
  // resta il veto storico. Mai interpretare «non so leggerlo» come «vuoto».
  if (!items.length) return { blocks: true, reason: 'aggregate-unparsed' };
  const valid = items.filter(hasFalsifiableAcceptance);
  if (!valid.length) return { blocks: true, reason: 'no-valid-item' };
  if (valid.length !== items.length) return { blocks: true, reason: 'mixed-prose-pending' };
  const allConfirmed = valid.every((s) => detectAlreadyResolved(s, io).resolved);
  return allConfirmed ? { blocks: false, reason: null } : { blocks: true, reason: 'valid-item-unconfirmed' };
}

/**
 * Pure tier decision. Returns 'close' | 'flag' | 'none'.
 *   - not resolved                                          → 'none'  (leave alone)
 *   - human objection (we flagged before, label since gone) → 'none'  (respect, don't re-flag)
 *   - eligible + strong + flagged-before + still labelled   → 'close' (second confirmation)
 *   - resolved but not close-eligible, already flagged      → 'none'  (held, no dup comment)
 *   - resolved but not close-eligible, first seen           → 'flag'  (grace / explain)
 *   - comment history unreadable (`hasPriorFlag === null`)  → 'none'  (unknown, no action)
 *
 * Close-eligible = single-item, unblocked, auto-close on, AND strong evidence. `hasPriorFlag`
 * = THIS bot already left its advisory comment on a prior run; auto-close requires BOTH that
 * prior flag AND the `maybe-resolved` label still present (two confirmations across time +
 * an un-rescinded grace window). Removing the label after a flag = human objection → quiet.
 * @param {{resolved:boolean, hasMaybeResolved:boolean, hasPriorFlag:boolean|null,
 *          isAggregate:boolean, blocked:boolean, noAutoclose?:boolean, strongEvidence?:boolean}} s
 * @returns {'close'|'flag'|'none'}
 */
export function decideReconcileAction({ resolved, hasMaybeResolved, hasPriorFlag, isAggregate, blocked, noAutoclose, strongEvidence }) {
  if (!resolved) return 'none';
  if (hasPriorFlag === null) return 'none';
  if (hasPriorFlag && !hasMaybeResolved) return 'none'; // label rescinded after our flag = objection
  const closeEligible = !noAutoclose && !blocked && !isAggregate && !!strongEvidence;
  if (closeEligible && hasPriorFlag && hasMaybeResolved) return 'close'; // second confirmation
  return hasPriorFlag ? 'none' : 'flag'; // held (already flagged) vs first detection
}

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // Empty stdout is a valid result for some read/write commands.  A distinct
    // sentinel is required by the daily lifecycle: an edit failure must not be
    // mistaken for a successful empty response and followed by audit/close.
    if (allowFail) return null;
    throw e;
  }
}

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

/** Parse a `gh --json` response without turning an API failure into `null` data. */
function parseIssueJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Matcher (isDistinctiveToken / citedFiles / citedTokens / detectAlreadyResolved) lives
// in ./followup-resolution-match.mjs — shared verbatim with the issue-fix.yml pre-flight
// gate (check-issue-already-resolved.mjs) so the two can never drift on what counts as
// "already resolved" (AGENTS.md #6). Disk-backed IO resolver for this scheduled pass:
const fileCache = new Map();
const issueCommentCache = new Map();
const diskIo = {
  fileExists: (p) => fs.existsSync(p),
  readFile: (p) => {
    if (!fileCache.has(p)) fileCache.set(p, fs.readFileSync(p, 'utf-8'));
    return fileCache.get(p);
  },
};

/**
 * Parse the comments response while preserving the wrapper's outcome.
 * `null` means that `gh` could not be invoked or returned unusable JSON;
 * an empty successful stdout is a valid no-comments response.
 */
export function parseIssueCommentsResponse(raw) {
  if (typeof raw !== 'string') return null;
  if (!raw.trim()) return [];
  try {
    const comments = JSON.parse(raw).comments;
    return Array.isArray(comments) ? comments : null;
  } catch {
    return null;
  }
}

function readIssueComments(number) {
  if (issueCommentCache.has(number)) return issueCommentCache.get(number);
  const out = gh(['issue', 'view', String(number), ...repoArgs, '--json', 'comments'], { allowFail: true });
  const result = parseIssueCommentsResponse(out);
  issueCommentCache.set(number, result);
  return result;
}

// Letture GitHub della rimisura dei `blocked`, con tetto per run e cache.
let blockedRecheckReads = 0;
const blockedRecheckCache = new Map();

/** `gh api` in sola lettura: `ok` con stdout, `not-found` (404), `error` o `budget`. */
function ghApiRead(args) {
  if (blockedRecheckReads >= BLOCKED_RECHECK_MAX_READS) return { status: 'budget' };
  blockedRecheckReads += 1;
  try {
    const stdout = execFileSync('gh', ['api', ...args], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 'ok', stdout };
  } catch (e) {
    return /HTTP 404\b/u.test(String(e?.stderr ?? '')) ? { status: 'not-found' } : { status: 'error' };
  }
}

function cachedRead(key, read) {
  if (!blockedRecheckCache.has(key)) blockedRecheckCache.set(key, read());
  return blockedRecheckCache.get(key);
}

/** Il primo commit della risposta `commits` (`null` se vuota), o `undefined` se illeggibile. */
function firstCommitOf(read) {
  if (read.status !== 'ok') return undefined;
  try {
    const list = JSON.parse(read.stdout);
    if (!Array.isArray(list)) return undefined;
    const head = list[0];
    if (!head) return null;
    return { sha: String(head.sha ?? ''), date: String(head.commit?.committer?.date ?? '') };
  } catch {
    return undefined;
  }
}

/**
 * Lettori iniettati in `planBlockedRecheck` per un repository:
 * - `commitAfter(path, since)`: l'ultimo commit su `main` che tocca `path` dal `since`;
 * - `fileAt(path, iso)`: il file com'era su `main` a quell'istante.
 */
function blockedRecheckReaders(repository) {
  const repo = String(repository || '').trim();
  const valid = /^[\w.-]+\/[\w.-]+$/u.test(repo);
  const mainShaAt = (iso) => cachedRead(`sha\0${repo}\0${iso}`, () => {
    const commit = firstCommitOf(ghApiRead(['-X', 'GET', `repos/${repo}/commits`, '-f', 'sha=main', '-f', `until=${iso}`, '-f', 'per_page=1']));
    return commit === undefined ? { status: 'error' } : { status: 'ok', sha: commit?.sha || null };
  });
  return {
    commitAfter(file, sinceIso) {
      if (!valid) return { status: 'error' };
      return cachedRead(`after\0${repo}\0${file}\0${sinceIso}`, () => {
        const commit = firstCommitOf(ghApiRead(['-X', 'GET', `repos/${repo}/commits`, '-f', 'sha=main', '-f', `path=${file}`, '-f', `since=${sinceIso}`, '-f', 'per_page=1']));
        return commit === undefined ? { status: 'error' } : { status: 'ok', commit };
      });
    },
    fileAt(file, iso) {
      if (!valid) return { status: 'error' };
      const at = mainShaAt(iso);
      if (at.status !== 'ok') return { status: 'error' };
      if (!at.sha) return { status: 'absent' }; // nessun commit su main prima di quell'istante
      return cachedRead(`file\0${repo}\0${file}\0${at.sha}`, () => {
        const encoded = String(file).split('/').map(encodeURIComponent).join('/');
        const read = ghApiRead(['-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${encoded}?ref=${at.sha}`]);
        if (read.status === 'ok') return { status: 'ok', content: read.stdout };
        return read.status === 'not-found' ? { status: 'absent' } : { status: 'error' };
      });
    },
  };
}

/**
 * Item-done comments share the historical `MARKER`; only an aggregate reconcile
 * flag counts as the prior grace-window confirmation. Keep accepting old flag
 * comments while giving new flags a marker that cannot collide with item state.
 */
export function isReconcileFlagComment(body) {
  const text = String(body || '');
  return text.includes(FLAG_MARKER)
    || (text.includes(MARKER) && text.includes('🤖 **Reconcile (auto)**'));
}

function alreadyCommented(number, comments = undefined) {
  const resolvedComments = comments === undefined ? readIssueComments(number) : comments;
  if (!Array.isArray(resolvedComments)) return null;
  return resolvedComments.some((c) => isReconcileFlagComment(c.body));
}

function evidenceLines(evidence) {
  return evidence
    .slice(0, 6)
    .map((e) => `- \`${e.tok}\` già presente in \`${e.file}\``)
    .join('\n');
}

function writeBodyFile(text) {
  const file = path.join('/tmp', `reconcile-followup-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, String(text || ''));
  return file;
}

/** Il commento che accompagna un item marcato `done` dal matcher. */
function itemDoneCommentBody(id, evidence, note = '') {
  return `${MARKER}\n✅ Item \`${id}\` marcato \`done\` dopo verifica deterministica del matcher.${note}\n\n${evidenceLines(evidence || [])}`;
}

/**
 * Rimisura gli item `blocked` di un bucket giornaliero (piano puro in
 * `lib/followup-blocked-recheck.mjs`) e ne applica gli esiti. Ordine delle
 * scritture, scelto perche' un guasto lasci al piu' UN rientro:
 *   1. marker `FU_ITEM_BORN_SATISFIED` per i token gia' veri al conio (l'item
 *      resta `blocked`; il marker entra subito nell'insieme born-satisfied
 *      della run, cosi' reconcile e gate lo vedono gia' in questo giro);
 *   2. rilettura-confronto del corpo, poi il commento `FU_ITEM_UNBLOCKED` di
 *      ogni rientro PRIMA dell'edit: se l'edit fallisce il rientro e' perso,
 *      mai ripetuto;
 *   3. un solo edit del corpo (`done` + rientri), poi i commenti dei `done`;
 *   4. dopo un rientro il bucket ha di nuovo un item `open`: via un
 *      `maybe-resolved` residuo. La coda (`agent:fix-queued`) la rimette il
 *      gate sul conio al giro dopo, non questo script.
 * Un esito che non arriva a scrittura diventa `unknown` nel riepilogo.
 * @returns {{results: object[], body: string, labelNames: string[], skipIssue: boolean}}
 */
function runBlockedRecheck({ iss, daily, itemMarkers, bornSatisfied, labelNames, reentryBudget }) {
  const body = iss.body || '';
  const plan = planBlockedRecheck({
    body,
    labels: labelNames,
    dailyKey: daily.dailyKey,
    markers: itemMarkers,
    io: diskIo,
    readers: blockedRecheckReaders(daily.targetRepository),
    now: Date.now(),
    reentryBudget,
  });
  const results = plan.results.map((entry) => ({ ...entry, number: iss.number }));
  const unchanged = { results, body, labelNames, skipIssue: false };
  if (plan.skipped) {
    if (plan.skipped === 'decomposed') console.log(`#${iss.number}: bucket decomposto, rimisura dei blocked saltata (il lavoro e' nelle figlie).`);
    return unchanged;
  }
  const demote = (entry, why) => { entry.outcome = 'unknown'; entry.why = why; };
  const startIso = bucketStartIso(daily.dailyKey);

  for (const entry of results.filter((candidate) => candidate.outcome === 'born-true')) {
    console.log(`#${iss.number}: item ${entry.id} blocked, token gia' vero all'inizio del bucket → FU_ITEM_BORN_SATISFIED, resta blocked.`);
    if (!DRY_RUN) {
      const posted = gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
        bornTrueCommentBody({ id: entry.id, evidence: entry.evidence, startIso })], { allowFail: true });
      if (posted === null) { demote(entry, 'born-marker-not-posted'); continue; }
    }
    bornSatisfied.add(entry.id);
  }

  const done = results.filter((entry) => entry.outcome === 'done');
  let reenter = results.filter((entry) => entry.outcome === 'reenter');
  if (!done.length && !reenter.length) return unchanged;

  if (!DRY_RUN) {
    const latest = parseIssueJson(gh(['issue', 'view', String(iss.number), ...repoArgs, '--json', 'title,body'], { allowFail: true }));
    if (!latest
        || String(latest.title || '') !== String(iss.title || '')
        || String(latest.body || '') !== body) {
      console.log(`#${iss.number}: titolo/body cambiato/non leggibile durante la rimisura dei blocked → skip, nessun overwrite.`);
      for (const entry of [...done, ...reenter]) demote(entry, 'body-changed');
      return { ...unchanged, skipIssue: true };
    }
    for (const entry of reenter) {
      const posted = gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body', unblockedCommentBody(entry)], { allowFail: true });
      if (posted === null) demote(entry, 'unblocked-marker-not-posted');
    }
    reenter = reenter.filter((entry) => entry.outcome === 'reenter');
  }

  const { body: nextBody, applied } = applyBlockedRecheck(body, {
    done: done.map((entry) => entry.id),
    reentered: reenter.map((entry) => entry.id),
  });
  const appliedIds = new Set([...applied.done, ...applied.reentered]);
  for (const entry of [...done, ...reenter]) if (!appliedIds.has(entry.id)) demote(entry, 'state-not-updatable');
  for (const entry of reenter.filter((candidate) => candidate.outcome === 'reenter')) {
    console.log(`#${iss.number}: item ${entry.id} blocked → open (rientro unico: commit ${entry.commit.sha.slice(0, 12)} su ${entry.target} dopo ${entry.blockedAt}).`);
  }
  for (const entry of done.filter((candidate) => candidate.outcome === 'done')) {
    console.log(`#${iss.number}: item ${entry.id} blocked → done (token confermato, assente all'inizio del bucket).`);
  }
  if (nextBody === body) return unchanged;
  const nextLabels = applied.reentered.length ? labelNames.filter((name) => name !== LABEL) : labelNames;
  if (DRY_RUN) return { results, body: nextBody, labelNames: nextLabels, skipIssue: false };

  const bodyFile = writeBodyFile(nextBody);
  const edited = gh(['issue', 'edit', String(iss.number), ...repoArgs, '--body-file', bodyFile], { allowFail: true });
  fs.rmSync(bodyFile, { force: true });
  if (edited === null) {
    console.log(`::warning::reconcile-followups: rimisura dei blocked su #${iss.number} non scritta; un rientro con marker gia' postato e' perso (al piu' una volta, mai due).`);
    for (const entry of [...done, ...reenter]) demote(entry, 'body-edit-failed');
    return { ...unchanged, skipIssue: true };
  }
  for (const entry of done.filter((candidate) => candidate.outcome === 'done')) {
    gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
      itemDoneCommentBody(entry.id, entry.evidence, ' Era `blocked`: il token non era presente all\'inizio del giorno del bucket.')], { allowFail: true });
  }
  if (applied.reentered.length && labelNames.includes(LABEL)) {
    const removed = gh(['issue', 'edit', String(iss.number), ...repoArgs, '--remove-label', LABEL], { allowFail: true });
    if (removed === null) return { results, body: nextBody, labelNames, skipIssue: false };
  }
  return { results, body: nextBody, labelNames: nextLabels, skipIssue: false };
}

function main() {
  const raw = gh([
    'issue', 'list', '--label', 'follow-up', '--state', 'open',
    ...repoArgs, '--json', 'number,title,body,labels', '--limit', String(MAX_ISSUES),
  ]);
  const issues = JSON.parse(raw || '[]');

  // In-flight exclusion: an open PR for issue #N means the work is in progress, NOT done
  // — its cited status-quo code is still in the file. Skip those (mirrors FOLLOWUP.md §
  // Dedup "in-flight overlap"). Match by `fix/issue-N` branch or `#N` in PR title/body.
  const openPrs = JSON.parse(
    gh(['pr', 'list', '--state', 'open', ...repoArgs, '--json', 'number,headRefName,title,body', '--limit', '100'], { allowFail: true }) || '[]',
  );
  function inFlight(n) {
    const tag = `#${n}`;
    return openPrs.some((pr) =>
      pr.headRefName?.includes(`issue-${n}`) ||
      new RegExp(`(^|[^\\d])${tag}([^\\d]|$)`).test(`${pr.title}\n${pr.body || ''}`),
    );
  }

  if (!DRY_RUN) {
    // Best-effort: ensure the advisory, cache, and auto-close labels exist (no-op if already there).
    gh(['label', 'create', UNCLASSIFIABLE_LABEL, '--color', 'cfd3d7',
        '--description', 'Reconcile: aggregate esaminata ma non classificabile; riesame su modifica/versione',
        ...repoArgs], { allowFail: true });
    gh(['label', 'create', LABEL, '--color', 'c5def5',
        '--description', 'Reconcile bot: cited code present in file — likely done-but-open',
        ...repoArgs], { allowFail: true });
    gh(['label', 'create', CLOSED_LABEL, '--color', '0e8a16',
        '--description', 'Reconcile bot: auto-closed on second deterministic done-but-open confirmation',
        ...repoArgs], { allowFail: true });
  }

  const flagged = [];
  const closed = [];
  const unclassifiableCandidates = [];
  const bucketLines = [];
  const verifyRequests = [];
  const blockedResults = [];
  const reentryBudget = { remaining: BLOCKED_RECHECK_MAX_REENTRIES };
  let unclassifiableSkipped = 0;

  for (let iss of issues) {
    if (inFlight(iss.number)) { console.log(`#${iss.number}: in-flight PR open, skip`); continue; }
    let labelNames = (iss.labels || []).map(labelName);
    const hasUnclassifiableLabel = labelNames.includes(UNCLASSIFIABLE_LABEL);
    const unclassifiable = isUnclassifiableAggregate(iss.title, iss.body || '');
    let comments;

    if (hasUnclassifiableLabel) {
      comments = readIssueComments(iss.number);
      if (comments && isCurrentUnclassifiable(iss, comments)) {
        unclassifiableSkipped += 1;
        console.log(`#${iss.number}: aggregate non classificabile già esaminata, cache corrente → skip`);
        continue;
      }
      if (comments) {
        console.log(`#${iss.number}: cache non classificabile assente/scaduta, riesame`);
        gh(['issue', 'edit', String(iss.number), ...repoArgs, '--remove-label', UNCLASSIFIABLE_LABEL], { allowFail: true });
      }
    }

    const daily = dailyBucketInfo(iss.title || '');
    let resolved;
    let evidence;
    let gateInputs = null;
    if (daily) {
      // I marker a grana item stanno nei commenti. Senza commenti leggibili non
      // si sa se un token era gia' vero al conio: niente `done`, niente chiusura.
      if (comments === undefined) comments = readIssueComments(iss.number);
      gateInputs = dailyBucketGateInputs(iss.title, comments);
      if (!gateInputs) {
        console.log(`::warning::reconcile-followups: impossibile leggere i commenti di #${iss.number}; bucket lasciato invariato (nessun done, nessuna richiesta di verifica)`);
        continue;
      }
      const { itemMarkers, bornSatisfied } = gateInputs;
      // Rimisura degli item `blocked` (token o un rientro su commit nuovo),
      // PRIMA di reconcileDailyItems e solo su un bucket strutturalmente valido.
      if (!dailyBucketStructureReason(iss.body || '', ...gateInputs.gateArgs.slice(0, 3))) {
        const recheck = runBlockedRecheck({ iss, daily, itemMarkers, bornSatisfied, labelNames, reentryBudget });
        blockedResults.push(...recheck.results);
        if (recheck.skipIssue) continue;
        iss = { ...iss, body: recheck.body };
        labelNames = recheck.labelNames;
      }
      // Daily buckets are reconciled item-by-item. An issue-wide token hit would let
      // one completed item hide another open item, which is precisely the aggregate
      // closure bug this format removes.
      const itemReconciliation = reconcileDailyItems(iss.body || '', diskIo, ...gateInputs.gateArgs);
      for (const id of itemReconciliation.bornSatisfied || []) {
        console.log(`#${iss.number}: item ${id} token presente ma gia' vero al conio (FU_ITEM_BORN_SATISFIED) → non marcato done.`);
      }
      let reconciledBody = itemReconciliation.body;
      if (itemReconciliation.changed) {
        if (DRY_RUN) {
          console.log(`#${iss.number}: ${itemReconciliation.changes.length} item già provati → dry-run, body non riscritto.`);
        } else {
          const latest = parseIssueJson(gh(['issue', 'view', String(iss.number), ...repoArgs, '--json', 'title,body'], { allowFail: true }));
          if (!latest
              || String(latest.title || '') !== String(iss.title || '')
              || String(latest.body || '') !== String(iss.body || '')) {
            console.log(`#${iss.number}: titolo/body cambiato/non leggibile durante la riconciliazione → skip, nessun overwrite.`);
            continue;
          }
          const bodyFile = writeBodyFile(reconciledBody);
          const edited = gh(['issue', 'edit', String(iss.number), ...repoArgs, '--body-file', bodyFile], { allowFail: true });
          fs.rmSync(bodyFile, { force: true });
          if (edited === null) {
            console.log(`#${iss.number}: aggiornamento item done non riuscito → resta aperta.`);
            continue;
          }
          for (const change of itemReconciliation.changes) {
            gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body', itemDoneCommentBody(change.id, change.evidence)], { allowFail: true });
          }
        }
      }
      const bucketGate = dailyBucketCloseGate(reconciledBody, diskIo, ...gateInputs.gateArgs);
      const bucketLine = dailyBucketSummaryLine({
        number: iss.number,
        body: reconciledBody,
        bornSatisfiedIds: bornSatisfied,
        reason: bucketGate.blocks ? bucketGate.reason : null,
      });
      console.log(bucketLine);
      bucketLines.push(bucketLine);
      if (bucketGate.blocks) {
        console.log(`#${iss.number} daily:${daily.dailyKey}: bucket aperto (${bucketGate.reason}), item non ancora tutti provati.`);
        // Solo su un bucket strutturalmente valido e sigillato: un difetto di
        // forma (chiave, repository, conteggio) non e' un item da verificare.
        if (itemReconciliation.reason === null) {
          const request = decideBucketVerifyRequest({
            body: reconciledBody,
            bornSatisfiedIds: bornSatisfied,
            comments,
            isTrusted: isTrustedAuthor,
          });
          if (request.action === 'request') {
            try {
              verifyRequests.push({
                number: iss.number,
                ids: request.items.map((item) => item.id),
                ensureLabel: shouldEnsureVerifyLabel({ comments, labelNames }),
                body: bucketVerifyRequestBody({ items: request.items, markers: itemMarkers, bornSatisfiedIds: bornSatisfied }),
              });
            } catch (e) {
              console.log(`::warning::reconcile-followups: richiesta di verifica per #${iss.number} non componibile (${String(e?.message ?? e).slice(0, 80)})`);
            }
          } else if (request.reason === 'already-requested') {
            console.log(`#${iss.number}: richiesta di verifica gia' postata per ${request.items.map((item) => item.id).join(',')} → nessun nuovo commento.`);
          }
        }
        continue;
      }
      iss = { ...iss, body: reconciledBody };
      resolved = true;
      evidence = [...(bucketGate.evidenceById?.values() || [])].flat();
    } else {
      ({ resolved, evidence } = detectAlreadyResolved(iss.body || '', diskIo));
    }

    // The marker records the exact structural veto. It is deliberately written even
    // when the token detector is negative: the next pass must not pay to rediscover
    // that this aggregate cannot be parsed, while the close predicates stay unchanged.
    if (unclassifiable) {
      if (comments === undefined) comments = readIssueComments(iss.number);
      const marker = comments ? unclassifiableMarker(iss, comments) : null;
      if (marker) unclassifiableCandidates.push({ number: iss.number, title: iss.title, marker });
    }

    if (!resolved) continue;

    const hasMaybeResolved = labelNames.includes(LABEL);
    const blocked = labelNames.some((n) => KEEP_OPEN_LABELS.has(n));
    let aggGate = isAggregateTitle(iss.title, iss.body || '')
      ? aggregateCloseGate(iss.body || '', diskIo)
      : { blocks: false, reason: null };
    if (isDailyBucketTitle(iss.title || '')) {
      // Stessi argomenti delle due chiamate sopra (stesso titolo, stessi commenti).
      aggGate = dailyBucketCloseGate(iss.body || '', diskIo, ...(gateInputs?.gateArgs ?? []));
    }
    const isAggregate = aggGate.blocks;
    const hasPriorFlag = alreadyCommented(iss.number);
    if (hasPriorFlag === null) {
      console.log(`::warning::reconcile-followups: impossibile leggere i commenti di #${iss.number}; flag/chiusura non determinabili, issue lasciata nel ciclo`);
    }
    const strongEvidence = isStrongAutoCloseEvidence(evidence.map((e) => e.tok));
    const action = decideReconcileAction({
      resolved, hasMaybeResolved, hasPriorFlag, isAggregate, blocked, noAutoclose: NO_AUTOCLOSE, strongEvidence,
    });

    if (action === 'close') {
      closed.push({ number: iss.number, title: iss.title, evidence, daily: !!daily });
    } else if (action === 'flag') {
      const reason = blocked ? 'keep-open'
        : isAggregate ? aggGate.reason
        : NO_AUTOCLOSE ? 'no-autoclose'
        : !strongEvidence ? 'weak-evidence'
        : 'first-seen';
      flagged.push({ number: iss.number, title: iss.title, evidence, reason });
    } else { // 'none' — leave alone (not resolved / objection / held at tier-1)
      if (hasPriorFlag) console.log(`#${iss.number}: held (objection / weak / tier-1), skip`);
    }
  }

  // Cache only the structural non-classifiable veto. The issue stays open, keeps
  // `follow-up`, and remains visible; this label/comment pair is a reread cache,
  // not a resolution state.
  for (const c of unclassifiableCandidates) {
    const comment = `🔎 **Reconcile cache**: questa aggregata è stata esaminata ma il corpo non contiene una struttura a item classificabile. Resta aperta e visibile; un cambiamento alla issue o alla versione del classificatore farà scattare un nuovo riesame.

${c.marker}`;
    console.log(`#${c.number} "${c.title}" → cache non classificabile`);
    if (DRY_RUN) continue;
    gh(['issue', 'edit', String(c.number), ...repoArgs, '--add-label', UNCLASSIFIABLE_LABEL], { allowFail: true });
    gh(['issue', 'comment', String(c.number), ...repoArgs, '--body', comment], { allowFail: true });
  }

  // Tier 1 — flag (grace window): comment + maybe-resolved label.
  for (const f of flagged) {
    const note = f.reason === 'no-valid-item'
      ? '\n\n⚠️ Nessun item con condizione di accettazione falsificabile: l\'auto-close **non** scatta (chiuderla qui sarebbe chiudere su evidenza assente) — **chiusura umana**.'
      : f.reason === 'valid-item-unconfirmed'
      ? '\n\n⚠️ Restano item validi non ancora token-confermati: l\'auto-close non scatta finché ognuno non è confermato — **chiusura umana**.'
      : f.reason === 'aggregate-unparsed'
      ? '\n\n⚠️ Multi-item non riclassificabile (corpo senza struttura a item): l\'auto-close non scatta — **chiusura umana**.'
      : f.reason === 'keep-open'
      ? '\n\n📌 Label keep-open/strategica: resta aperta per revisione umana, niente auto-close.'
      : f.reason === 'weak-evidence'
      ? '\n\nℹ️ Evidenza debole (singolo token poco specifico): **non** verrà auto-chiusa — verifica e chiudi a mano se lo scope è coperto.'
      : '\n\nSe al prossimo run risulterà ancora risolta, verrà **auto-chiusa** (finestra di grazia: obietta rimuovendo `maybe-resolved` o aggiungendo `keep-open`).';
    const comment = `${FLAG_MARKER}
${MARKER}
🤖 **Reconcile (auto)**: i token citati da questa issue risultano già presenti nei file citati — probabile **done-but-open** (coperto da una PR successiva senza \`Closes #${f.number}\`).

${evidenceLines(f.evidence)}${note}`;
    console.log(`#${f.number} "${f.title}" → flag (${f.reason}, ${f.evidence.length} match)`);
    if (DRY_RUN) continue;
    gh(['issue', 'comment', String(f.number), ...repoArgs, '--body', comment], { allowFail: true });
    gh(['issue', 'edit', String(f.number), ...repoArgs, '--add-label', LABEL], { allowFail: true });
  }

  // Tier 2 — auto-close (second confirmation, grace window elapsed, eligible).
  for (const c of closed) {
    const comment = `${CLOSE_MARKER}
✅ **Reconcile auto-close**: seconda conferma deterministica (\`maybe-resolved\` da un run precedente, finestra di grazia trascorsa senza obiezioni, ancora risolta, ${c.daily ? 'daily bucket con TUTTI gli item validi done' : 'single-item'}, nessuna label keep-open). Tutti i token-codice prescritti sono presenti nei file citati:

${evidenceLines(c.evidence)}

Chiusa come **completed** (done-but-open). Si **riapre da sola** se il segnale sottostante ricorre (titoli monitor dedup-stabili) — o riapri a mano se lo scope non era davvero coperto.`;
    console.log(`#${c.number} "${c.title}" → AUTO-CLOSE (${c.evidence.length} match)`);
    if (DRY_RUN) continue;
    gh(['issue', 'comment', String(c.number), ...repoArgs, '--body', comment], { allowFail: true });
    gh(['issue', 'edit', String(c.number), ...repoArgs, '--add-label', CLOSED_LABEL], { allowFail: true });
    gh(['issue', 'close', String(c.number), ...repoArgs, '--reason', 'completed'], { allowFail: true });
  }

  // Richiesta di verifica: bucket sigillati senza item aperti e con item non
  // confermati. Un commento consultivo + `maybe-resolved` (stadio di verifica);
  // mai una chiusura da qui.
  for (const v of verifyRequests) {
    console.log(`#${v.number} → richiesta di verifica (${v.ids.join(',')})`);
    if (DRY_RUN) continue;
    const posted = gh(['issue', 'comment', String(v.number), ...repoArgs, '--body', v.body], { allowFail: true });
    if (posted === null) {
      console.log(`::warning::reconcile-followups: richiesta di verifica per #${v.number} non postata; si ripete al prossimo giro`);
      continue;
    }
    if (!v.ensureLabel) {
      console.log(`#${v.number}: \`${LABEL}\` tolta dopo un flag (obiezione umana) → solo il commento, label non rimessa.`);
      continue;
    }
    gh(['issue', 'edit', String(v.number), ...repoArgs, '--add-label', LABEL], { allowFail: true });
  }

  const summary = `Reconcile follow-ups: scanned ${issues.length}, cache-skipped ${unclassifiableSkipped}, cache-marked ${unclassifiableCandidates.length}, flagged ${flagged.length}, auto-closed ${closed.length}, verify_requested=${verifyRequests.length}${DRY_RUN ? ' (dry-run)' : ''}${NO_AUTOCLOSE ? ' (no-autoclose)' : ''}.`;
  console.log(summary);
  const blockedLine = `Blocked recheck: ${blockedRecheckSummary(blockedResults)} reads=${blockedRecheckReads}/${BLOCKED_RECHECK_MAX_READS} reentry_cap=${BLOCKED_RECHECK_MAX_REENTRIES}`;
  console.log(blockedLine);
  for (const entry of blockedResults.filter((candidate) => candidate.outcome === 'unknown' || candidate.outcome === 'waiting')) {
    console.log(`  #${entry.number} ${entry.id}: ${entry.outcome} (${entry.why}), bloccato da ${entry.ageDays ?? '?'} giorni (${entry.blockedSource}${entry.reason ? `, reason=${entry.reason}` : ''})`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const uc = unclassifiableCandidates.map((c) => `- 🔎 #${c.number} ${c.title} (aggregate non classificabile, resta aperta)`).join('\n');
    const fl = flagged.map((f) => `- 🟡 #${f.number} ${f.title} (flag: ${f.reason}, ${f.evidence.length} match)`).join('\n');
    const cl = closed.map((c) => `- ✅ #${c.number} ${c.title} (auto-closed, ${c.evidence.length} match)`).join('\n');
    const vr = verifyRequests.map((v) => `- 🔎 #${v.number} richiesta di verifica: ${v.ids.join(',')}`).join('\n');
    const bk = bucketLines.map((line) => `- \`${line}\``).join('\n');
    const bl = `- \`${blockedLine}\``;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${[uc, cl, fl, vr, bk, bl].filter(Boolean).join('\n')}\n`);
  }
}

// Run only as a CLI entrypoint — importing for tests (pure decision helpers above) must
// not trigger the gh-driven scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
