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
 *   CI_SUITE_PROOF_MAX_READS       tetto di letture `gh` della prova CI degli item bloccati solo
 *                                  dalla guardia risorse locale (default 120; decisione I4 del 2026-10-05).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FOLLOWUP_ITEM_ID_SINGLE_RE,
  bucketState,
  dailyKeyFromBucketBody,
  dailyBucketInfo,
  dailyBucketTargetRepository,
  detectAlreadyResolved,
  followupItemDailyKey,
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
import { MAYBE_RESOLVED_RELEASE_MARKER, inertCommentText, itemMetricLine, parseItemMarkers } from './lib/followup-item-evidence.mjs';
import {
  applyBlockedRecheck,
  blockedRecheckSummary,
  bornTrueCommentBody,
  bucketBirthBoundIso,
  planBlockedRecheck,
  unblockedCommentBody,
} from './lib/followup-blocked-recheck.mjs';
import {
  CI_SUITE_REPORT_ARTIFACT,
  CI_SUITE_WORKFLOW_FILE,
  applyCiSuiteProof,
  ciSuiteProofCommentBody,
  ciSuiteProofSummary,
  latestCompletedRun,
  planCiSuiteProof,
  suiteResultsFromJobLog,
  suiteResultsFromVitestReport,
} from './lib/followup-ci-suite-proof.mjs';
import { VITEST_CHECK_NAME } from './lib/constants.mjs';
import { issueLabelDeleteArgs, labelDeleteResponseConfirms } from './lib/issue-label-release.mjs';
import { isTrustedAuthor } from './route-already-fixed.mjs';
import { rebuildDailyBody } from './gate-minted-followups.mjs';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

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
// Prova CI degli item bloccati solo dalla guardia locale: una PR costa al piu'
// 9 letture (PR, due run, due job, due elenchi di artifact, report o log).
const CI_SUITE_PROOF_MAX_READS = intFromEnv('CI_SUITE_PROOF_MAX_READS', 120);
const MARKER = '<!-- reconcile-bot -->';
const FLAG_MARKER = '<!-- reconcile-bot:flag -->';
const CLOSE_MARKER = '<!-- reconcile-bot:autoclose -->';
// `maybe-resolved` tolta da un automatismo (un item del bucket e' di nuovo
// `open`): azzera i flag precedenti, quindi non vale come obiezione umana.
export const RELEASE_MARKER = MAYBE_RESOLVED_RELEASE_MARKER;
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
 * Gli item con la prova `FU_ITEM_CI_SUITE` (decisione I4 del 2026-10-05): la
 * CI required della loro PR ha eseguito verde la suite di un item bloccato
 * solo dalla guardia risorse locale. Marker gia' filtrati per autore fidato.
 * @param {Array<{type: string, item: string}>} markers
 * @returns {Set<string>}
 */
export function ciSuiteProvenItemIds(markers) {
  return itemIdSet((Array.isArray(markers) ? markers : [])
    .filter((marker) => marker?.type === 'ci-suite')
    .map((marker) => marker.item));
}

/**
 * Gli input dei gate giornalieri, calcolati in UN punto: `gateArgs` sono gli
 * argomenti posizionali dal terzo in poi che `main()` passa a
 * `reconcileDailyItems` e a entrambe le chiamate di `dailyBucketCloseGate`
 * (chiave, repository e conteggio dal titolo, poi gli insiemi born-satisfied e
 * ci-suite dai commenti fidati), cosi' i tre punti di chiamata non possono divergere.
 * `null` se il titolo non e' un bucket giornaliero o se i commenti non sono
 * leggibili (senza commenti non si esclude un marker born-satisfied).
 * @returns {{daily: object, itemMarkers: object[], bornSatisfied: Set<string>, gateArgs: unknown[]}|null}
 */
export function dailyBucketGateInputs(title, comments) {
  const daily = dailyBucketInfo(title || '');
  if (!daily || !Array.isArray(comments)) return null;
  const itemMarkers = parseItemMarkers(comments, { isTrusted: isTrustedAuthor });
  const bornSatisfied = bornSatisfiedItemIds(itemMarkers);
  const ciSuiteProven = ciSuiteProvenItemIds(itemMarkers);
  return {
    daily,
    itemMarkers,
    bornSatisfied,
    ciSuiteProven,
    gateArgs: [daily.dailyKey, daily.targetRepository, daily.itemCount, bornSatisfied, ciSuiteProven],
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
 *
 * `ciSuiteProvenIds`: item `done` con il marker `FU_ITEM_CI_SUITE` (decisione
 * I4 del 2026-10-05). La loro conferma e' la run required che ha eseguito
 * verde la suite dell'item, non un token: contano come confermati con
 * evidenza forte. Senza `State: done` il marker da solo non conferma nulla.
 */
export function dailyBucketCloseGate(
  body,
  io,
  expectedDailyKey = null,
  expectedTargetRepository = null,
  expectedItemCount = null,
  bornSatisfiedIds = null,
  ciSuiteProvenIds = null,
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
  const ciProven = itemIdSet(ciSuiteProvenIds);
  const evidenceById = new Map();
  const unresolvedItems = [];
  const weakItems = [];
  const bornSatisfiedItems = [];
  for (const item of items) {
    const result = detectAlreadyResolved(item.text, io, { acceptanceToken: item.acceptanceToken });
    evidenceById.set(item.id, result.evidence || []);
    if (item.state === 'done' && ciProven.has(String(item.id ?? '').toUpperCase())) {
      // Un token per item: l'evidenza del bucket resta distinta item per item.
      evidenceById.set(item.id, [{ file: 'CI required', tok: `FU_ITEM_CI_SUITE ${item.id}` }]);
      continue;
    }
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

/**
 * La sequenza per bucket giornaliero di `main()`: veto strutturale → rimisura
 * dei `blocked` → `reconcileDailyItems` sul corpo che la rimisura ha prodotto.
 * La rimisura (`runRecheck(body)` → `{body, skipIssue, ...}`) gira SOLO su un
 * bucket strutturalmente valido e sigillato, e sempre PRIMA della
 * riconciliazione degli item `open`; `skipIssue` ferma il bucket senza
 * riconciliare (`reconciliation: null`).
 * @returns {{recheck: object|null, reconciliation: object|null}}
 */
export function recheckThenReconcileDailyItems(body, io, gateArgs, runRecheck) {
  let current = String(body || '');
  const args = Array.isArray(gateArgs) ? gateArgs : [];
  let recheck = null;
  if (!dailyBucketStructureReason(current, ...args.slice(0, 3))) {
    recheck = runRecheck(current);
    if (recheck?.skipIssue) return { recheck, reconciliation: null };
    if (typeof recheck?.body === 'string') current = recheck.body;
  }
  return { recheck, reconciliation: reconcileDailyItems(current, io, ...args) };
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
export function shouldEnsureVerifyLabel({ comments, labelNames, isTrusted = isTrustedAuthor }) {
  const hasLabel = Array.isArray(labelNames) && labelNames.includes(LABEL);
  if (hasLabel) return true;
  return !hasLiveReconcileFlag(comments, { isTrusted });
}

/**
 * Bucket giornalieri con `maybe-resolved` e almeno un item `open` o
 * `in-progress`: la label dice «forse risolto» mentre il corpo dice «c'e'
 * lavoro da fare». Prima il reconciler lo segnalava soltanto nell'allarme
 * (`bucketLabelConflicts`) e nessun processo la toglieva: 10831, 10283, 9609,
 * 8809, 8334 restavano in conflitto per sempre. Piano puro sulle issue come
 * lette; lo stato degli item e' quello letterale del parser.
 * @returns {Array<{number: number, ids: string[]}>}
 */
export function planMaybeResolvedRelease(issues) {
  const out = [];
  for (const iss of Array.isArray(issues) ? issues : []) {
    if (!dailyBucketInfo(iss?.title || '')) continue;
    const labels = (iss?.labels || []).map(labelName).filter(Boolean).map((name) => String(name).toLowerCase());
    if (!labels.includes(LABEL)) continue;
    const ids = parseFollowupItems(iss?.body || '')
      .filter((item) => item.id && (item.state === 'open' || item.state === 'in-progress'))
      .map((item) => item.id);
    if (ids.length) out.push({ number: iss.number, ids });
  }
  return out;
}

/** Il commento che accompagna la rimozione automatica di `maybe-resolved`. */
export function maybeResolvedReleaseCommentBody({ ids }) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => `\`${inertCommentText(String(id))}\``).join(', ');
  return `${RELEASE_MARKER}\n${MARKER}\n🔁 **Reconcile**: \`${LABEL}\` tolta perche' il bucket ha di nuovo item da lavorare (${list || 'item open'}). Non e' un'obiezione: quando tutti gli item saranno chiusi il ciclo di verifica riparte dal primo stadio.`;
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

/*
 * ── Allarme per i bucket illeggibili ──────────────────────────────────────
 *
 * Il corpo di un bucket giornaliero lo scrivono a testo libero il triage
 * (`post-merge-followup.yml`) e, a volte, sessioni di agenti. Quando esce dal
 * formato, `dailyBucketCloseGate` e `reconcileDailyItems` restituiscono un
 * veto STRUTTURALE e il ciclo principale stampa soltanto «bucket aperto
 * (<motivo>)»: lo stesso veto ferma il gate sul conio e il drainer, e nessuno
 * lo dice. Misurato su #8705 (corpo riscritto a mano il 29-09, titolo
 * «… 7 items — status reconciled 2026-09-29»): da allora ogni run dice
 * `bucket aperto (mismatched-target-repository)` e nessun item puo' cambiare
 * stato. Qui il veto diventa UNA issue di allarme a titolo stabile, che si
 * chiude da sola quando l'elenco torna vuoto. Nessun corpo viene riscritto da
 * qui: la riparazione passa da `scripts/ci/rebuild-daily-bucket.mjs`
 * (`rebuildDailyBody`). L'unica label che il reconciler toglie da se' e'
 * `maybe-resolved` su un bucket con un item `open` (`planMaybeResolvedRelease`).
 */

/**
 * I motivi che dicono «il corpo non e' leggibile», non «un item aspetta
 * ancora la prova». Elenco chiuso: `valid-item-unconfirmed`,
 * `weak-item-evidence`, `born-satisfied-token`, `bucket-collecting` e
 * `invalid-item` sono attese legittime e restano fuori. `round-trip-unstable`
 * e' il motivo della guardia di round-trip (`dailyBucketRoundTripReason`).
 */
export const STRUCTURAL_BUCKET_VETOES = Object.freeze([
  'mismatched-target-repository',
  'mismatched-item-count',
  'missing-stable-item-id',
  'mismatched-stable-item-id',
  'missing-daily-key',
  'mismatched-daily-key',
  'ambiguous-bucket-state',
  'unterminated-markdown-fence',
  'aggregate-unparsed',
  'round-trip-unstable',
]);
const STRUCTURAL_BUCKET_VETO_SET = new Set(STRUCTURAL_BUCKET_VETOES);

/** Il motivo e' un veto strutturale (corpo illeggibile) e non un'attesa? */
export function isStructuralBucketVeto(reason) {
  return STRUCTURAL_BUCKET_VETO_SET.has(String(reason ?? ''));
}

export const BUCKET_ALARM_TITLE = 'Bucket follow-up illeggibile dal parser';
// Lavoro per lo sweep autonomo, non per la coda del fixer: con
// `automation-deferred` `classifyIssue` da' route `none`. MAI `agent:fix`,
// `agent:fix-queued` o `follow-up` (quest'ultima la farebbe rileggere da qui).
export const BUCKET_ALARM_LABELS = Object.freeze(['automation-deferred']);
// Un bucket `collecting` piu' giovane di cosi' e' ancora nelle mani del triage.
export const BUCKET_ALARM_MIN_AGE_HOURS = 48;

// Un veto strutturale scatta sempre prima di qualunque lettura di file: per la
// sola diagnosi di forma basta un io che non legge niente.
const NO_FILE_IO = Object.freeze({ fileExists: () => false, readFile: () => '' });

/**
 * Guardia di round-trip, sola diagnosi: `parseFollowupItems` →
 * `rebuildDailyBody` (lo stesso ricostruttore del gate sul conio) → nuovo
 * parse. Numero, ID o stati diversi → `round-trip-unstable`: il prossimo
 * scrittore deterministico cambierebbe cio' che i gate vedono. NON riscrive
 * il corpo. `null` se stabile o se non c'e' alcun item (quello e' gia'
 * `aggregate-unparsed`).
 */
export function dailyBucketRoundTripReason(body) {
  const source = String(body || '');
  const items = parseFollowupItems(source);
  if (!items.length) return null;
  // Il ricostruttore riceve il testo GREZZO di ogni item (`item.raw`, heading
  // `### FU-…` compreso), cioe' esattamente la stringa che il parse ha letto.
  // NON `item.text`: comincia dopo l'heading, quindi il corpo ricostruito non
  // avrebbe item e ogni bucket sano diventerebbe un falso `round-trip-unstable`
  // (test «round-trip: il ricostruttore riceve...», corpi reali 8705 e 11003).
  const rawItems = items.map((item) => item.raw);
  const again = parseFollowupItems(rebuildDailyBody(source.slice(0, items[0].start), rawItems));
  const signature = (list) => list.map((item) => `${item.id}\0${item.state}`).join('\n');
  return again.length === items.length && signature(again) === signature(items) ? null : 'round-trip-unstable';
}

/**
 * Il veto strutturale di un bucket giornaliero letto da titolo e corpo, senza
 * I/O: lo stesso `dailyBucketCloseGate` del ciclo principale, poi la guardia
 * di round-trip. `null` se il titolo non e' di un bucket giornaliero o se il
 * corpo e' leggibile.
 */
export function bucketStructuralVeto(issue) {
  const daily = dailyBucketInfo(issue?.title || '');
  if (!daily) return null;
  const body = String(issue?.body || '');
  const gate = dailyBucketCloseGate(body, NO_FILE_IO, daily.dailyKey, daily.targetRepository, daily.itemCount, null);
  if (isStructuralBucketVeto(gate.reason)) return gate.reason;
  return dailyBucketRoundTripReason(body);
}

/**
 * Allarme dovuto per un bucket? Solo con veto strutturale, e solo se il
 * bucket e' `sealed` oppure piu' vecchio di `BUCKET_ALARM_MIN_AGE_HOURS`: un
 * `collecting` giovane e' ancora scritto dal triage. Data di creazione
 * illeggibile → allarme: il silenzio e' esattamente il difetto da chiudere.
 */
export function shouldAlarmBucket({ reason, body, createdAt, now }) {
  if (!isStructuralBucketVeto(reason)) return false;
  if (bucketState(body) === 'sealed') return true;
  const created = Date.parse(String(createdAt || ''));
  if (!Number.isFinite(created)) return true;
  return now - created >= BUCKET_ALARM_MIN_AGE_HOURS * 3_600_000;
}

const REPOSITORY_SLUG_RE = /^[\w.-]+\/[\w.-]+$/u;

/**
 * Le righe che violano il formato, dall'alto in basso (al piu' `limit`), per
 * dire nell'allarme DOVE riparare: titolo, recinto non chiuso, campi di testa
 * (`Daily key`, `State`, `Target repository`), heading degli item, `State`
 * degli item. Diagnosi euristica: il verdetto resta di `bucketStructuralVeto`.
 * @returns {Array<{where: string, text: string, why: string}>}
 */
export function bucketFormatViolations(title, body, { limit = 5 } = {}) {
  const source = String(body || '');
  const lines = source.split('\n');
  const lineAt = (offset) => source.slice(0, offset).split('\n').length;
  const out = [];
  const push = (where, text, why) => { if (out.length < limit) out.push({ where, text: String(text || '').trim().slice(0, 200), why }); };
  const daily = dailyBucketInfo(title || '');
  const items = parseFollowupItems(source);
  const headerRepository = dailyBucketTargetRepository(source);
  if (daily) {
    if (!REPOSITORY_SLUG_RE.test(daily.targetRepository)) {
      push('titolo', title, `il repository nel titolo («${daily.targetRepository}») non e' owner/repo`);
    } else if (headerRepository && headerRepository.toLowerCase() !== daily.targetRepository.toLowerCase()) {
      push('titolo', title, `il repository nel titolo non coincide con l'header (${headerRepository})`);
    }
    if (items.length && daily.itemCount !== items.length) {
      push('titolo', title, `il titolo dice ${daily.itemCount} item, il corpo ne ha ${items.length}`);
    }
  }
  let fenceLine = 0;
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (/^\s*>/.test(lines[i]) || !marker) continue;
    if (fence) {
      if (marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = null;
    } else {
      fence = { char: marker[1][0], length: marker[1].length };
      fenceLine = i + 1;
    }
  }
  if (fence) push(`riga ${fenceLine}`, lines[fenceLine - 1], 'recinto di codice aperto e mai chiuso');
  const headLines = source.slice(0, items[0]?.start ?? source.length).split('\n');
  let headStates = 0;
  for (let i = 0; i < headLines.length; i += 1) {
    const field = /^\s*(?:-\s+)?(State|Daily key|Target repository)\s*:\s*(.*?)\s*$/i.exec(headLines[i]);
    if (!field) continue;
    const name = field[1].toLowerCase();
    if (name === 'state') {
      headStates += 1;
      if (headStates > 1) push(`riga ${i + 1}`, headLines[i], 'secondo campo `State` di testa');
      else if (!/^(collecting|sealed)$/i.test(field[2])) push(`riga ${i + 1}`, headLines[i], 'lo `State` di testa deve essere esattamente `collecting` o `sealed`');
    } else if (name === 'daily key' && !/^\d{4}-\d{2}-\d{2}\b/.test(field[2])) {
      push(`riga ${i + 1}`, headLines[i], '`Daily key` senza data YYYY-MM-DD');
    } else if (name === 'target repository' && !REPOSITORY_SLUG_RE.test(field[2])) {
      push(`riga ${i + 1}`, headLines[i], '`Target repository` non e\' owner/repo');
    }
  }
  if (!headStates && items.length) push('testa', '', 'manca il campo `- State: collecting|sealed` prima del primo item');
  if (!items.length) push('corpo', '', 'nessun heading item `### FU-YYYY-MM-DD-NNN — titolo`');
  for (const item of items) {
    const headingLine = lineAt(item.start);
    if (!item.id || !FOLLOWUP_ITEM_ID_SINGLE_RE.test(item.id)
        || (daily && followupItemDailyKey(item.id) !== daily.dailyKey)) {
      push(`riga ${headingLine}`, lines[headingLine - 1], 'heading senza ID stabile `FU-<daily key>-NNN`');
      continue;
    }
    const rawLines = String(item.raw || '').split('\n');
    // Confronto LETTERALE, come `hasDailyBucketRepositoryConsistency`: un valore
    // fra backtick e' un altro repository per il parser (misurato su #11301).
    const repoIndex = rawLines.findIndex((line) => {
      const field = /^\s*-\s+Target repository\s*:\s*(.*?)\s*$/i.exec(line);
      return field && headerRepository && field[1].trim().toLowerCase() !== headerRepository.toLowerCase();
    });
    if (repoIndex >= 0) {
      const quoted = /`/.test(rawLines[repoIndex]);
      push(`riga ${headingLine + repoIndex}`, rawLines[repoIndex], quoted
        ? `\`Target repository\` dell'item fra backtick: il parser lo confronta alla lettera con l'header (${headerRepository})`
        : `\`Target repository\` dell'item diverso dall'header (${headerRepository})`);
    }
    if (item.state) continue;
    const stateIndex = rawLines.findIndex((line) => /^\s*-\s+State\s*:/i.test(line));
    if (stateIndex >= 0) {
      push(`riga ${headingLine + stateIndex}`, rawLines[stateIndex], 'lo `State` di un item deve essere esattamente `open`, `in-progress`, `done` o `blocked`');
    } else {
      push(`riga ${headingLine}`, lines[headingLine - 1], 'item senza riga `- State:`');
    }
  }
  return out;
}

/**
 * Coppie di label che tre script diversi scrivono senza un invariante comune.
 * Elenco chiuso; nessuna label viene tolta da qui (`maybe-resolved` con un item
 * `open` la toglie prima `planMaybeResolvedRelease`).
 * @param {Array<string|{name:string}>} labels
 * @param {{hasOpenItem?: boolean}} [state]
 * @returns {string[]} i conflitti, in forma leggibile (vuoto se nessuno)
 */
export function bucketLabelConflicts(labels, { hasOpenItem = false } = {}) {
  const set = new Set((Array.isArray(labels) ? labels : []).map(labelName).filter(Boolean).map((name) => String(name).toLowerCase()));
  const out = [];
  if (set.has(LABEL) && set.has('agent:fix-queued')) out.push('`maybe-resolved` + `agent:fix-queued`');
  if (set.has('fu-parked') && set.has('agent:fix-queued')) out.push('`fu-parked` + `agent:fix-queued`');
  for (const queue of ['agent:fix', 'agent:fix-queued']) {
    if (set.has('decomposed:1') && set.has(queue)) out.push(`\`decomposed:1\` + \`${queue}\``);
  }
  if (set.has(LABEL) && hasOpenItem) out.push('`maybe-resolved` con un item ancora `open`');
  return out;
}

/**
 * Piano puro dell'allarme su TUTTE le issue lette (anche quelle che il ciclo
 * principale salta per una PR in volo o per commenti illeggibili: la forma
 * del corpo non dipende da nessuna delle due).
 * @returns {{unparseable: object[], conflicts: object[]}}
 */
export function planBucketAlarm(issues, { now = Date.now() } = {}) {
  const unparseable = [];
  const conflicts = [];
  for (const iss of Array.isArray(issues) ? issues : []) {
    const daily = dailyBucketInfo(iss?.title || '');
    if (!daily) continue;
    const body = String(iss?.body || '');
    const reason = bucketStructuralVeto(iss);
    if (reason && shouldAlarmBucket({ reason, body, createdAt: iss?.createdAt, now })) {
      const created = Date.parse(String(iss?.createdAt || ''));
      unparseable.push({
        number: iss.number,
        title: String(iss.title || ''),
        reason,
        state: bucketState(body),
        ageHours: Number.isFinite(created) ? Math.floor((now - created) / 3_600_000) : null,
        dailyKey: daily.dailyKey,
        itemCount: parseFollowupItems(body).length,
        headerRepository: dailyBucketTargetRepository(body),
        titleRepository: daily.targetRepository,
        violations: bucketFormatViolations(iss.title, body),
      });
    }
    const hasOpenItem = parseFollowupItems(body).some((item) => item.state === 'open' || item.state === 'in-progress');
    const found = bucketLabelConflicts(iss?.labels, { hasOpenItem });
    if (found.length) conflicts.push({ number: iss.number, title: String(iss.title || ''), conflicts: found });
  }
  return { unparseable, conflicts };
}

/** La risposta GraphQL di `userContentEdits` → `[{editedAt, login}]`, o `null` se illeggibile. */
export function parseBodyEditsResponse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const nodes = JSON.parse(raw)?.data?.repository?.issue?.userContentEdits?.nodes;
    if (!Array.isArray(nodes)) return null;
    return nodes.map((node) => ({
      editedAt: String(node?.editedAt || ''),
      login: String(node?.editor?.login || 'sconosciuto'),
    }));
  } catch {
    return null;
  }
}

/** La riga «scrittori» di un bucket in allarme. */
export function formatBodyEditors(edits) {
  if (!Array.isArray(edits)) return 'scrittore non determinato';
  if (!edits.length) return 'nessuna modifica del corpo dopo la creazione';
  return edits.map((edit) => `${edit.editedAt || '?'} ${inertCommentText(edit.login)}`).join('; ');
}

/** Il corpo dell'allarme: un blocco per bucket illeggibile, poi i conflitti di label. */
export function bucketAlarmBody({ unparseable = [], conflicts = [], repository = '' } = {}) {
  const repo = REPOSITORY_SLUG_RE.test(String(repository)) ? String(repository) : '<owner/repo>';
  const lines = [
    `Il reconciler dei follow-up (\`scripts/ci/reconcile-followups.mjs\`) non riesce a leggere ${unparseable.length} bucket giornalieri e trova ${conflicts.length} bucket con label contraddittorie. Un bucket illeggibile non cambia mai stato: lo stesso veto ferma il gate sul conio e il drainer.`,
    '',
    'Questa issue si aggiorna a ogni run del reconciler e si chiude da sola quando entrambi gli elenchi sono vuoti.',
    '',
    `## Bucket illeggibili (${unparseable.length})`,
  ];
  if (!unparseable.length) lines.push('', '- Nessuno.');
  for (const entry of unparseable) {
    const [first, ...rest] = entry.violations || [];
    const where = (violation) => `${violation.where}${violation.text ? ` ${codeSpan(violation.text)}` : ''} — ${inertCommentText(violation.why)}`;
    lines.push(
      '',
      `### #${entry.number} — motivo \`${entry.reason}\``,
      `- Stato di testa: \`${entry.state || 'non leggibile'}\`; eta': ${entry.ageHours ?? '?'} h`,
      `- Prima riga fuori formato: ${first ? where(first) : 'non localizzata (vedi il motivo)'}`,
      ...rest.map((violation) => `- Anche: ${where(violation)}`),
      `- Ultime modifiche del corpo: ${formatBodyEditors(entry.editors)}`,
      '- Riparazione:',
    );
    const fixTitle = entry.headerRepository && REPOSITORY_SLUG_RE.test(entry.headerRepository)
      && entry.itemCount > 0
      && (entry.titleRepository !== entry.headerRepository || (entry.violations || []).some((v) => v.where === 'titolo'));
    if (fixTitle) {
      lines.push(`  - \`gh issue edit ${entry.number} --repo ${repo} --title "follow-up(daily:${entry.dailyKey}): ${entry.itemCount} items — ${entry.headerRepository}"\``);
    }
    lines.push(
      `  - rigenera titolo e corpo canonici con \`node scripts/ci/rebuild-daily-bucket.mjs --issue ${entry.number} --repo ${repo}\` (anteprima, nessuna scrittura), poi la stessa riga con \`--write\`: passa da \`rebuildDailyBody\` e rifiuta, senza scrivere, se uno \`State\` non e' leggibile`,
      `  - verifica: \`DRY_RUN=1 GH_REPO=${repo} node scripts/ci/reconcile-followups.mjs\` → la riga \`bucket #${entry.number}\` non porta piu' un motivo strutturale`,
    );
  }
  lines.push('', `## Label contraddittorie (${conflicts.length})`);
  if (!conflicts.length) lines.push('', '- Nessuna.');
  else lines.push('');
  for (const entry of conflicts) lines.push(`- #${entry.number}: ${entry.conflicts.join('; ')}`);
  lines.push('', `Il reconciler toglie da se' \`${LABEL}\` dai bucket con un item \`open\`: se il conflitto compare qui, la rimozione di questo giro e' fallita. Il resto e' osservazione: i corpi illeggibili si rigenerano col comando indicato sopra.`);
  return lines.join('\n');
}

/**
 * Esito dell'allarme: `open` (crea o aggiorna) se c'e' qualcosa da dire,
 * `resolve` se tutto e' pulito E l'elenco delle issue era completo, altrimenti
 * `none` (un elenco troncato non prova che i bucket mancanti siano sani).
 */
export function decideBucketAlarmAction({ unparseable = [], conflicts = [], listComplete = false, noAutoclose = false } = {}) {
  if (unparseable.length || conflicts.length) return 'open';
  return listComplete && !noAutoclose ? 'resolve' : 'none';
}

/**
 * Il piano dell'allarme senza mai lanciare: l'allarme e' sola osservazione e
 * un corpo inatteso non deve fermare flag, chiusure e richieste di verifica.
 * Su eccezione restituisce elenchi vuoti con `error` valorizzato:
 * `applyBucketAlarm` lo traduce in `error` (nessuna scrittura, mai una
 * chiusura su uno stato sconosciuto).
 * @returns {{unparseable: object[], conflicts: object[], error: string|null}}
 */
export function safePlanBucketAlarm(issues, { now = Date.now(), plan = planBucketAlarm, log = console.log } = {}) {
  try {
    const computed = plan(issues, { now });
    return { unparseable: computed?.unparseable || [], conflicts: computed?.conflicts || [], error: null };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 120);
    log(`::warning::reconcile-followups: piano allarme bucket non calcolabile (${error})`);
    return { unparseable: [], conflicts: [], error };
  }
}

/** I campi letti da `gh issue list`: `createdAt` serve alla finestra di 48 ore dell'allarme. */
export const ISSUE_LIST_FIELDS = 'number,title,body,labels,createdAt';

/** La riga di riepilogo del reconciler, con i contatori dell'allarme bucket. */
export function reconcileSummaryLine({
  scanned = 0,
  cacheSkipped = 0,
  cacheMarked = 0,
  flagged = 0,
  autoClosed = 0,
  verifyRequested = 0,
  unparseableBuckets = 0,
  labelConflicts = 0,
  bucketAlarm = 'none',
  maybeResolvedReleased = 0,
  dryRun = false,
  noAutoclose = false,
} = {}) {
  return `Reconcile follow-ups: scanned ${scanned}, cache-skipped ${cacheSkipped}, cache-marked ${cacheMarked}, flagged ${flagged}, auto-closed ${autoClosed}, verify_requested=${verifyRequested}, unparseable_buckets=${unparseableBuckets}, label_conflicts=${labelConflicts}, bucket_alarm=${bucketAlarm}, maybe_resolved_released=${maybeResolvedReleased}${dryRun ? ' (dry-run)' : ''}${noAutoclose ? ' (no-autoclose)' : ''}.`;
}

/**
 * Applica il piano: attribuzione dello scrittore (una lettura per bucket in
 * allarme; lettura fallita → «scrittore non determinato», l'allarme si apre
 * comunque), poi crea/aggiorna l'issue a titolo stabile o la chiude. Le
 * dipendenze sono iniettate per i test. Non lancia mai: un guasto dell'allarme
 * non deve far fallire il reconciler.
 * @returns {Promise<{action: string, result: unknown}>}
 */
export async function applyBucketAlarm(plan, {
  listComplete = false,
  noAutoclose = false,
  dryRun = false,
  repository = '',
  readBodyEdits = () => null,
  create = createGithubIssue,
  resolve = resolveGithubIssue,
  log = console.log,
} = {}) {
  if (plan?.error) return { action: 'error', result: null };
  const unparseable = (plan?.unparseable || []).map((entry) => {
    let editors = null;
    try { editors = readBodyEdits(entry.number); } catch { editors = null; }
    return { ...entry, editors: Array.isArray(editors) ? editors : null };
  });
  const conflicts = plan?.conflicts || [];
  const action = decideBucketAlarmAction({ unparseable, conflicts, listComplete, noAutoclose });
  if (action === 'none') return { action, result: null };
  if (dryRun) {
    log(`bucket alarm: ${action} (dry-run, nessuna scrittura)`);
    return { action, result: null };
  }
  try {
    if (action === 'resolve') {
      return { action, result: resolve(BUCKET_ALARM_TITLE, { workflow: 'followup-reconcile', exactTitle: true }) };
    }
    const result = await create({
      title: BUCKET_ALARM_TITLE,
      exactTitle: true,
      description: bucketAlarmBody({ unparseable, conflicts, repository }),
      priority: 3,
      labels: [...BUCKET_ALARM_LABELS],
      workflow: 'followup-reconcile',
      signals: {
        cosa: 'bucket follow-up giornalieri che il parser non legge o con label contraddittorie',
        metrica: { osservato: `unparseable_buckets=${unparseable.length} label_conflicts=${conflicts.length}`, atteso: 'unparseable_buckets=0 label_conflicts=0' },
        comando: 'DRY_RUN=1 node scripts/ci/reconcile-followups.mjs',
      },
    });
    return { action, result };
  } catch (e) {
    log(`::warning::reconcile-followups: allarme bucket non scritto (${String(e?.message ?? e).slice(0, 120)})`);
    return { action, result: null };
  }
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

const BODY_EDITS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){userContentEdits(first:5){nodes{editedAt editor{login}}}}}}';

/**
 * Le ultime 5 modifiche del corpo di una issue (chi ha riscritto il bucket):
 * una lettura `gh api graphql` per bucket in allarme. `null` se il repository
 * non e' noto o la lettura fallisce. `first`, non `last`: la connessione
 * `userContentEdits` e' ordinata dalla piu' recente (misurato su #8705, 9
 * modifiche: `last:5` restituiva le cinque del 15-09 e nascondeva la
 * riscrittura del 29-09).
 */
function readBodyEdits(number) {
  const [owner, name] = String(process.env.GH_REPO || '').split('/');
  if (!owner || !name) return null;
  const out = gh(['api', 'graphql', '-f', `query=${BODY_EDITS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${Number(number)}`], { allowFail: true });
  return parseBodyEditsResponse(out);
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
    // Uno sha anomalo e' «non so», non un commit: il marker FU_ITEM_UNBLOCKED lo rifiuterebbe.
    const sha = String(head.sha ?? '');
    if (!/^[0-9a-f]{40}$/u.test(sha)) return undefined;
    return { sha, date: String(head.commit?.committer?.date ?? '') };
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

// Letture GitHub della prova CI (decisione I4), con tetto per run e cache.
let ciSuiteReads = 0;
const ciSuiteCache = new Map();

/** `gh` in sola lettura per la prova CI: `ok` con stdout, `not-found`, `error` o `budget`. */
function ghCiRead(args) {
  if (ciSuiteReads >= CI_SUITE_PROOF_MAX_READS) return { status: 'budget' };
  ciSuiteReads += 1;
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 'ok', stdout };
  } catch (e) {
    return /HTTP 404\b/u.test(String(e?.stderr ?? '')) ? { status: 'not-found' } : { status: 'error' };
  }
}

function ciCached(key, read) {
  if (!ciSuiteCache.has(key)) ciSuiteCache.set(key, read());
  return ciSuiteCache.get(key);
}

function parseJsonRead(read) {
  if (read.status !== 'ok') return undefined;
  try {
    return JSON.parse(read.stdout);
  } catch {
    return undefined;
  }
}

/** Il report JSON di vitest dell'artifact della run, o `null` (scaduto, assente, illeggibile). */
function downloadVitestReport(repo, runId) {
  const listing = parseJsonRead(ghCiRead(['api', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`]));
  const artifact = (Array.isArray(listing?.artifacts) ? listing.artifacts : [])
    .find((entry) => entry?.name === CI_SUITE_REPORT_ARTIFACT && entry?.expired === false);
  if (!artifact) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-ci-suite-'));
  try {
    const read = ghCiRead(['run', 'download', String(runId), '--repo', repo, '-n', CI_SUITE_REPORT_ARTIFACT, '-D', dir]);
    if (read.status !== 'ok') return null;
    const file = path.join(dir, `${CI_SUITE_REPORT_ARTIFACT}.json`);
    if (!fs.existsSync(file)) return null;
    return suiteResultsFromVitestReport(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Lettori iniettati in `planCiSuiteProof` per un repository (forma in
 * `readCiSuiteCandidates`). Gli esiti per file vengono dal report JSON di
 * vitest finche' l'artifact esiste (7 giorni), poi dal log del job.
 */
function ciSuiteProofReaders(repository) {
  const repo = String(repository || '').trim();
  const valid = /^[\w.-]+\/[\w.-]+$/u.test(repo);
  const fail = { status: 'error' };
  return {
    pull(number) {
      if (!valid) return fail;
      return ciCached(`pull\0${repo}\0${number}`, () => {
        const pr = parseJsonRead(ghCiRead(['api', `repos/${repo}/pulls/${Number(number)}`]));
        if (!pr || typeof pr !== 'object') return fail;
        return { status: 'ok', merged: Boolean(pr.merged_at), mergeSha: String(pr.merge_commit_sha ?? ''), headSha: String(pr.head?.sha ?? '') };
      });
    },
    latestRun(sha) {
      if (!valid) return fail;
      return ciCached(`run\0${repo}\0${sha}`, () => {
        const data = parseJsonRead(ghCiRead(['api', '-X', 'GET', `repos/${repo}/actions/workflows/${CI_SUITE_WORKFLOW_FILE}/runs`, '-f', `head_sha=${sha}`, '-f', 'per_page=30']));
        if (!Array.isArray(data?.workflow_runs)) return fail;
        const run = latestCompletedRun(data.workflow_runs);
        return { status: 'ok', run: run ? { id: Number(run.id), conclusion: run.conclusion ?? null } : null };
      });
    },
    vitestJob(runId) {
      if (!valid) return fail;
      return ciCached(`job\0${repo}\0${runId}`, () => {
        const data = parseJsonRead(ghCiRead(['api', `repos/${repo}/actions/runs/${Number(runId)}/jobs?per_page=100`]));
        if (!Array.isArray(data?.jobs)) return fail;
        const job = data.jobs.find((entry) => entry?.name === VITEST_CHECK_NAME);
        return { status: 'ok', job: job ? { id: Number(job.id), conclusion: job.conclusion ?? null } : null };
      });
    },
    results(runId, jobId) {
      if (!valid) return fail;
      return ciCached(`results\0${repo}\0${runId}\0${jobId}`, () => {
        const report = downloadVitestReport(repo, Number(runId));
        if (report) return { status: 'ok', results: report, source: 'report' };
        const log = ghCiRead(['api', `repos/${repo}/actions/jobs/${Number(jobId)}/logs`]);
        if (log.status === 'not-found') return { status: 'ok', results: null, source: null };
        if (log.status !== 'ok') return fail;
        return { status: 'ok', results: suiteResultsFromJobLog(log.stdout), source: 'log' };
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

/**
 * Un flag del reconciler ancora valido: postato DOPO l'ultimo rilascio
 * automatico di `maybe-resolved` (`RELEASE_MARKER`, solo da autore fidato:
 * chiunque puo' commentare una issue pubblica, e un marker falso non deve
 * cancellare un'obiezione umana). Senza questo azzeramento, la label tolta dal
 * bot su un bucket riaperto varrebbe per sempre come obiezione (`decideReconcileAction`
 * → `none`, `shouldEnsureVerifyLabel` → false): il bucket non si chiuderebbe piu'.
 * `null` se i commenti non sono leggibili.
 * @returns {boolean|null}
 */
export function hasLiveReconcileFlag(comments, { isTrusted = isTrustedAuthor } = {}) {
  if (!Array.isArray(comments)) return null;
  let live = false;
  for (const comment of comments) {
    const body = String(comment?.body || '');
    if (body.includes(RELEASE_MARKER) && typeof isTrusted === 'function' && isTrusted(comment)) live = false;
    else if (isReconcileFlagComment(body)) live = true;
  }
  return live;
}

function alreadyCommented(number, comments = undefined) {
  const resolvedComments = comments === undefined ? readIssueComments(number) : comments;
  return hasLiveReconcileFlag(resolvedComments);
}

/**
 * Toglie `maybe-resolved` per conto del reconciler in modo fail-closed:
 * rilettura con label presente, rimozione, rilettura senza label, poi marker.
 * Se la rimozione o una delle riletture non e' confermata, il marker non viene
 * scritto e il flag precedente resta vivo. Se il commento del marker fallisce,
 * la label viene rimessa per rendere il rilascio ritentabile al giro seguente.
 * @param {number} number
 * @param {string[]} ids
 * @param {{execute?: (args: string[], options?: object) => string|null}} [deps]
 * @returns {boolean} true solo se la label e il marker sono stati confermati
 */
export function releaseMaybeResolved(number, ids, { execute = gh } = {}) {
  const run = (args, options) => execute(args, options);
  const hasLabel = () => {
    const current = parseIssueJson(run(['issue', 'view', String(number), ...repoArgs, '--json', 'labels'], { allowFail: true }));
    if (!current || !Array.isArray(current.labels)) return null;
    return current.labels.some((label) => String(labelName(label) ?? '').toLowerCase() === LABEL);
  };
  const restoreLabel = () => {
    const restored = run(['issue', 'edit', String(number), ...repoArgs, '--add-label', LABEL], { allowFail: true });
    if (restored === null) console.log(`::warning::reconcile-followups: impossibile ripristinare \`${LABEL}\` su #${number} dopo un rilascio incompleto`);
  };

  // Una label gia' tolta da un altro processo non e' una rimozione del
  // reconciler: senza questa guardia il marker azzererebbe un'obiezione umana.
  if (hasLabel() !== true) return false;
  // `gh issue edit --remove-label` is idempotent: a concurrent human removal
  // still exits 0. REST DELETE returns 404 in that case, so only its confirmed
  // response can authorize the release marker.
  const removed = run(issueLabelDeleteArgs({ issue: number, label: LABEL, repo: process.env.GH_REPO }), { allowFail: true });
  if (removed === null || !labelDeleteResponseConfirms(removed, LABEL)) {
    if (removed !== null) restoreLabel();
    return false;
  }
  if (hasLabel() !== false) {
    restoreLabel();
    return false;
  }

  const posted = run(['issue', 'comment', String(number), ...repoArgs, '--body', maybeResolvedReleaseCommentBody({ ids })], { allowFail: true });
  if (posted === null) {
    restoreLabel();
    return false;
  }
  issueCommentCache.delete(number);
  return true;
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
    // Lo stato di oggi si legge dal disco (il checkout di GH_REPO): un bucket che
    // punta a un altro repository non si rimisura.
    targetRepository: daily.targetRepository,
    localRepository: process.env.GH_REPO || '',
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
  const birthBoundIso = bucketBirthBoundIso(daily.dailyKey);

  for (const entry of results.filter((candidate) => candidate.outcome === 'born-true')) {
    console.log(`#${iss.number}: item ${entry.id} blocked, token gia' vero entro la fine del giorno del bucket → FU_ITEM_BORN_SATISFIED, resta blocked.`);
    if (!DRY_RUN) {
      const posted = gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
        bornTrueCommentBody({ id: entry.id, evidence: entry.evidence, atIso: birthBoundIso })], { allowFail: true });
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
    console.log(`#${iss.number}: item ${entry.id} blocked → done (token confermato, assente alla fine del giorno del bucket).`);
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
      itemDoneCommentBody(entry.id, entry.evidence, ' Era `blocked`: il token non era presente alla fine del giorno del bucket.')], { allowFail: true });
  }
  if (applied.reentered.length && labelNames.includes(LABEL)) {
    if (!releaseMaybeResolved(iss.number, applied.reentered)) return { results, body: nextBody, labelNames, skipIssue: false };
  }
  return { results, body: nextBody, labelNames: nextLabels, skipIssue: false };
}

/**
 * Prova CI degli item bloccati SOLO dalla guardia risorse locale (decisione I4
 * del 2026-10-05; piano puro in `lib/followup-ci-suite-proof.mjs`). Ordine
 * delle scritture, scelto perche' un guasto non lasci mai un `done` senza
 * prova: rilettura-confronto del corpo → commento `FU_ITEM_CI_SUITE` di ogni
 * item (se un marker fidato non c'e' gia') → un solo edit del corpo. Un
 * marker postato con l'edit fallito resta e si riusa al giro dopo, che
 * rimisura comunque la run. Il marker entra subito in `ciSuiteProven`.
 * @returns {{results: object[], body: string, skipIssue: boolean}}
 */
function runCiSuiteProof({ iss, daily, itemMarkers, ciSuiteProven, labelNames }) {
  const body = iss.body || '';
  const plan = planCiSuiteProof({
    body,
    labels: labelNames,
    readers: ciSuiteProofReaders(daily.targetRepository),
    targetRepository: daily.targetRepository,
    localRepository: process.env.GH_REPO || '',
  });
  const results = plan.results.map((entry) => ({ ...entry, number: iss.number }));
  const unchanged = { results, body, skipIssue: false };
  const done = results.filter((entry) => entry.outcome === 'done');
  if (plan.skipped || !done.length) return unchanged;
  const demote = (entry, why) => { entry.outcome = 'unknown'; entry.why = why; };

  if (!DRY_RUN) {
    const latest = parseIssueJson(gh(['issue', 'view', String(iss.number), ...repoArgs, '--json', 'title,body'], { allowFail: true }));
    if (!latest
        || String(latest.title || '') !== String(iss.title || '')
        || String(latest.body || '') !== body) {
      console.log(`#${iss.number}: titolo/body cambiato/non leggibile durante la prova CI → skip, nessun overwrite.`);
      for (const entry of done) demote(entry, 'body-changed');
      return { ...unchanged, skipIssue: true };
    }
    for (const entry of done) {
      const already = (itemMarkers || []).some((marker) => marker?.type === 'ci-suite' && marker.item === entry.id);
      if (already) continue;
      let text;
      try {
        text = ciSuiteProofCommentBody({ id: entry.id, pr: entry.pr, proof: entry.proof, repository: daily.targetRepository });
      } catch {
        demote(entry, 'proof-marker-invalid');
        continue;
      }
      const posted = gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body', text], { allowFail: true });
      if (posted === null) demote(entry, 'proof-marker-not-posted');
    }
  }
  const proven = done.filter((entry) => entry.outcome === 'done');
  const { body: nextBody, applied } = applyCiSuiteProof(body, proven.map((entry) => entry.id));
  for (const entry of proven) {
    if (!applied.includes(entry.id)) { demote(entry, 'state-not-updatable'); continue; }
    ciSuiteProven.add(entry.id);
    console.log(`#${iss.number}: item ${entry.id} → done (decisione I4: CI required della PR #${entry.pr}, ${entry.proof.kind} ${entry.proof.sha.slice(0, 12)}, run ${entry.proof.run}, job ${entry.proof.job}, ${entry.proof.source}: ${entry.proof.files.join(' ')})${DRY_RUN ? ' (dry-run)' : ''}.`);
  }
  if (nextBody === body) return unchanged;
  if (DRY_RUN) return { results, body: nextBody, skipIssue: false };

  const bodyFile = writeBodyFile(nextBody);
  const edited = gh(['issue', 'edit', String(iss.number), ...repoArgs, '--body-file', bodyFile], { allowFail: true });
  fs.rmSync(bodyFile, { force: true });
  if (edited === null) {
    console.log(`::warning::reconcile-followups: prova CI su #${iss.number} non scritta nel corpo; i marker postati restano e il giro dopo rimisura.`);
    for (const entry of proven) {
      if (entry.outcome === 'done') { demote(entry, 'body-edit-failed'); ciSuiteProven.delete(entry.id); }
    }
    return { ...unchanged, skipIssue: true };
  }
  return { results, body: nextBody, skipIssue: false };
}

async function main() {
  const raw = gh([
    'issue', 'list', '--label', 'follow-up', '--state', 'open',
    ...repoArgs, '--json', ISSUE_LIST_FIELDS, '--limit', String(MAX_ISSUES),
  ]);
  const issues = JSON.parse(raw || '[]');
  // `maybe-resolved` su un bucket con un item `open`: la toglie il reconciler,
  // non un umano che non arriva. Prima dell'allarme e del ciclo, cosi' entrambi
  // vedono le label dopo la riparazione; in dry-run nulla cambia e il conflitto
  // resta contato (la metrica non anticipa una scrittura non fatta).
  let released = 0;
  for (const entry of planMaybeResolvedRelease(issues)) {
    if (DRY_RUN) {
      console.log(`#${entry.number}: \`${LABEL}\` con item open (${entry.ids.join(',')}) → verrebbe tolta (dry-run).`);
      continue;
    }
    if (!releaseMaybeResolved(entry.number, entry.ids)) {
      console.log(`::warning::reconcile-followups: \`${LABEL}\` non tolta da #${entry.number}; resta nell'allarme e si riprova al prossimo giro`);
      continue;
    }
    released += 1;
    console.log(`#${entry.number}: \`${LABEL}\` tolta, item open: ${entry.ids.join(',')}.`);
    const iss = issues.find((candidate) => candidate.number === entry.number);
    if (iss) iss.labels = (iss.labels || []).filter((label) => labelName(label) !== LABEL);
  }
  // Sui corpi e sulle label COME LETTI (salvo il rilascio qui sopra), prima di
  // qualunque altra scrittura del giro: un veto strutturale ferma ogni scrittura
  // sul suo bucket, quindi la diagnosi non dipende dall'ordine.
  const bucketAlarmPlan = safePlanBucketAlarm(issues, { now: Date.now() });

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
  const ciSuiteResults = [];
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
      const { itemMarkers, bornSatisfied, ciSuiteProven } = gateInputs;
      // Rimisura degli item `blocked` (token o un rientro su commit nuovo),
      // PRIMA di reconcileDailyItems e solo su un bucket strutturalmente valido.
      // Daily buckets are reconciled item-by-item. An issue-wide token hit would let
      // one completed item hide another open item, which is precisely the aggregate
      // closure bug this format removes.
      // Prima la prova CI degli item bloccati solo dalla guardia locale
      // (decisione I4), poi la rimisura dei `blocked` sul corpo che ne esce.
      const step = recheckThenReconcileDailyItems(iss.body || '', diskIo, gateInputs.gateArgs, () => {
        const proof = runCiSuiteProof({ iss, daily, itemMarkers, ciSuiteProven, labelNames });
        ciSuiteResults.push(...proof.results);
        if (proof.skipIssue) return { results: [], body: iss.body || '', labelNames, skipIssue: true };
        const result = runBlockedRecheck({ iss: { ...iss, body: proof.body }, daily, itemMarkers, bornSatisfied, labelNames, reentryBudget });
        blockedResults.push(...result.results);
        return result;
      });
      if (step.recheck) {
        if (step.recheck.skipIssue) continue;
        iss = { ...iss, body: step.recheck.body };
        labelNames = step.recheck.labelNames;
      }
      const itemReconciliation = step.reconciliation;
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

  // Allarme dei bucket illeggibili / con label contraddittorie. La chiusura
  // richiede un elenco completo: con `--limit` raggiunto un bucket illeggibile
  // potrebbe essere fuori dalla pagina letta.
  for (const entry of bucketAlarmPlan.unparseable) {
    console.log(`#${entry.number}: bucket illeggibile dal parser (${entry.reason}) → allarme «${BUCKET_ALARM_TITLE}»`);
  }
  for (const entry of bucketAlarmPlan.conflicts) {
    console.log(`#${entry.number}: label contraddittorie: ${entry.conflicts.join('; ').replace(/`/g, '')}`);
  }
  const alarm = await applyBucketAlarm(bucketAlarmPlan, {
    listComplete: issues.length < MAX_ISSUES,
    noAutoclose: NO_AUTOCLOSE,
    dryRun: DRY_RUN,
    repository: process.env.GH_REPO || '',
    readBodyEdits,
  });

  const summary = reconcileSummaryLine({
    scanned: issues.length,
    cacheSkipped: unclassifiableSkipped,
    cacheMarked: unclassifiableCandidates.length,
    flagged: flagged.length,
    autoClosed: closed.length,
    verifyRequested: verifyRequests.length,
    unparseableBuckets: bucketAlarmPlan.unparseable.length,
    labelConflicts: bucketAlarmPlan.conflicts.length,
    bucketAlarm: alarm.action,
    maybeResolvedReleased: released,
    dryRun: DRY_RUN,
    noAutoclose: NO_AUTOCLOSE,
  });
  console.log(summary);
  const blockedLine = `Blocked recheck: ${blockedRecheckSummary(blockedResults)} reads=${blockedRecheckReads}/${BLOCKED_RECHECK_MAX_READS} reentry_cap=${BLOCKED_RECHECK_MAX_REENTRIES}`;
  console.log(blockedLine);
  const ciSuiteLine = `CI suite proof (I4): ${ciSuiteProofSummary(ciSuiteResults)} reads=${ciSuiteReads}/${CI_SUITE_PROOF_MAX_READS}`;
  console.log(ciSuiteLine);
  for (const entry of blockedResults.filter((candidate) => candidate.outcome === 'unknown' || candidate.outcome === 'waiting')) {
    console.log(`  #${entry.number} ${entry.id}: ${entry.outcome} (${entry.why}), bloccato da ${entry.ageDays ?? '?'} giorni (${entry.blockedSource}${entry.reason ? `, reason=${entry.reason}` : ''})`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const uc = unclassifiableCandidates.map((c) => `- 🔎 #${c.number} ${c.title} (aggregate non classificabile, resta aperta)`).join('\n');
    const fl = flagged.map((f) => `- 🟡 #${f.number} ${f.title} (flag: ${f.reason}, ${f.evidence.length} match)`).join('\n');
    const cl = closed.map((c) => `- ✅ #${c.number} ${c.title} (auto-closed, ${c.evidence.length} match)`).join('\n');
    const vr = verifyRequests.map((v) => `- 🔎 #${v.number} richiesta di verifica: ${v.ids.join(',')}`).join('\n');
    const bk = bucketLines.map((line) => `- \`${line}\``).join('\n');
    const bl = `- \`${blockedLine}\`\n- \`${ciSuiteLine}\``;
    const ub = bucketAlarmPlan.unparseable.map((entry) => `- 🚨 #${entry.number} bucket illeggibile dal parser (${entry.reason})`).join('\n');
    const lc = bucketAlarmPlan.conflicts.map((entry) => `- ⚠️ #${entry.number} label contraddittorie: ${entry.conflicts.join('; ')}`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${[uc, cl, fl, vr, ub, lc, bk, bl].filter(Boolean).join('\n')}\n`);
  }
}

// Run only as a CLI entrypoint — importing for tests (pure decision helpers above) must
// not trigger the gh-driven scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
