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
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bucketState,
  dailyKeyFromBucketBody,
  dailyBucketInfo,
  detectAlreadyResolved,
  hasDailyBucketRepositoryConsistency,
  hasFalsifiableAcceptance,
  hasStableItemIds,
  hasStableItemIdsForDailyKey,
  hasUnterminatedMarkdownFence,
  isDailyBucketTitle,
  parseFollowupItems,
  updateFollowupItemState,
  splitFollowupItems,
} from './followup-resolution-match.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const NO_AUTOCLOSE = process.env.NO_AUTOCLOSE === '1';
const MAX_ISSUES = intFromEnv('MAX_ISSUES', 100);
const MARKER = '<!-- reconcile-bot -->';
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
const KEEP_OPEN_LABELS = new Set(['pinned', 'keep-open', 'revenue', 'tracker', 'do-not-close']);

function stripFencedBlocks(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let fence = null;
  let fenceStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^([ \t]*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closes = match
        && match[2][0] === fence.char
        && match[2].length >= fence.length
        && match[1].length >= fence.indent;
      if (closes) fence = null;
      continue;
    }
    if (match) {
      fence = { char: match[2][0], length: match[2].length, indent: match[1].length };
      fenceStart = i;
      continue;
    }
    out.push(line);
  }

  return fence ? [...out, ...lines.slice(fenceStart)].join('\n') : out.join('\n');
}

function isBoldTitleLead(rest, lines = [], start = 0) {
  const bold = /^\*\*(?![ \t])(?:[^*]|\*(?!\*))+\*\*/;
  let candidate = String(rest || '');
  if (bold.test(candidate)) return true;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*(?:\d+[.)]|[-*])[ \t]+/.test(line)) break;
    candidate += '\n' + line;
    if (bold.test(candidate)) return true;
  }
  return false;
}

export function hasEnumeratedItems(body) {
  const b = stripFencedBlocks(body);
  const numberedSections = (b.match(/^#{2,4}[ \t]*(?:Item[ \t]*)?\d+[ \t]*[.)—–](?=[ \t]|$)/gim) || []).length;
  if (numberedSections >= 2) return true;
  const lines = b.split('\n');
  const orderedBoldItems = lines.reduce((count, line, index) => {
    const match = /^[ \t]*\d+[.)][ \t]+(.*)$/.exec(line);
    return count + (match && isBoldTitleLead(match[1], lines, index + 1) ? 1 : 0);
  }, 0);
  if (orderedBoldItems >= 2) return true;
  const boldLeadBullets = lines.reduce((count, line, index) => {
    const match = /^[-*][ \t]+(?:\[[ xX]\][ \t]*)?(.*)$/.exec(line);
    return count + (match && isBoldTitleLead(match[1], lines, index + 1) ? 1 : 0);
  }, 0);
  return boldLeadBullets >= 2;
}

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
 * rich expression, can be the status quo that the follow-up asks to change. Weak-but-resolved
 * stays flagged for a human (never silently closed).
 * @param {string[]} matchedTokens tokens that were found verbatim in a cited file
 * @returns {boolean}
 */
export function isStrongAutoCloseEvidence(matchedTokens) {
  const uniq = [...new Set((matchedTokens || []).map((t) => String(t)))];
  return uniq.length >= 2;
}

/**
 * Item-level close gate for a sealed daily bucket. Every item must be structurally
 * readable, accepted, explicitly `done`, token-confirmed, and backed by strong evidence.
 * A single unresolved/ambiguous/weak item vetoes the whole issue.
 */
export function dailyBucketCloseGate(body, io, expectedDailyKey = null, expectedTargetRepository = null) {
  if (hasUnterminatedMarkdownFence(body)) {
    return { blocks: true, reason: 'unterminated-markdown-fence', validItems: [], unresolvedItems: [] };
  }
  const items = parseFollowupItems(body);
  if (!items.length) return { blocks: true, reason: 'aggregate-unparsed', validItems: [], unresolvedItems: [] };
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
  const evidenceById = new Map();
  const unresolvedItems = [];
  const weakItems = [];
  for (const item of items) {
    const result = detectAlreadyResolved(item.text, io);
    evidenceById.set(item.id, result.evidence || []);
    if (item.state !== 'done' || !result.resolved) unresolvedItems.push(item);
    if (!isStrongAutoCloseEvidence((result.evidence || []).map((entry) => entry.tok))) weakItems.push(item);
  }
  if (unresolvedItems.length) {
    return { blocks: true, reason: 'valid-item-unconfirmed', validItems: items, unresolvedItems, evidenceById };
  }
  if (weakItems.length) {
    return { blocks: true, reason: 'weak-item-evidence', validItems: items, unresolvedItems: weakItems, evidenceById };
  }
  return { blocks: false, reason: null, validItems: items, unresolvedItems: [], evidenceById };
}

/** Mark only token-confirmed daily items as done; never infer completion from prose. */
export function reconcileDailyItems(body, io, expectedDailyKey = null, expectedTargetRepository = null) {
  const source = String(body || '');
  if (hasUnterminatedMarkdownFence(source)) {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: 'unterminated-markdown-fence' };
  }
  const items = parseFollowupItems(source);
  if (!items.length || !hasStableItemIds(source)) {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: 'missing-stable-item-id' };
  }
  const bodyDailyKey = dailyKeyFromBucketBody(source);
  if (!bodyDailyKey) {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: 'missing-daily-key' };
  }
  if (expectedDailyKey && bodyDailyKey !== String(expectedDailyKey).trim()) {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: 'mismatched-daily-key' };
  }
  if (!hasStableItemIdsForDailyKey(items, bodyDailyKey)) {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: 'mismatched-stable-item-id' };
  }
  if (!hasDailyBucketRepositoryConsistency(source, expectedTargetRepository || '')) {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: 'mismatched-target-repository' };
  }
  if (bucketState(source) !== 'sealed') {
    return { body: source, changed: false, changes: [], evidenceById: new Map(), reason: 'bucket-collecting' };
  }
  let nextBody = source;
  const changes = [];
  const evidenceById = new Map();
  for (const item of items) {
    const result = hasFalsifiableAcceptance(item.text)
      ? detectAlreadyResolved(item.text, io)
      : { resolved: false, evidence: [] };
    evidenceById.set(item.id, result.evidence || []);
    if (result.resolved && (item.state === 'open' || item.state === 'in-progress')) {
      const updated = updateFollowupItemState(nextBody, item.id, 'done');
      if (updated) {
        nextBody = updated;
        changes.push({ id: item.id, state: 'done', evidence: result.evidence || [] });
      }
    }
  }
  return { body: nextBody, changed: nextBody !== source, changes, evidenceById, reason: null };
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
 * falsificabile non era un item valido, quindi non fa da gate. Gli item validi
 * che restano devono essere TUTTI token-confermati, uno per uno — bar più alta
 * del vecchio controllo issue-wide, che leggeva i token di tutto il corpo
 * insieme.
 *
 * Il guardrail contro l'incidente #5849 (aggregata chiusa con due item ancora
 * deferiti) è il ramo `no-valid-item`: se dopo la riclassificazione NON resta
 * nessun item valido, non si chiude. Chiudere lì sarebbe chiudere su evidenza
 * assente, che è esattamente il caso vietato. Misurate 5 issue su 17 in questo
 * ramo.
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
    if (allowFail) return '';
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

function readIssueComments(number) {
  if (issueCommentCache.has(number)) return issueCommentCache.get(number);
  const out = gh(['issue', 'view', String(number), ...repoArgs, '--json', 'comments'], { allowFail: true });
  if (!out) {
    issueCommentCache.set(number, null);
    return null;
  }
  try {
    const comments = JSON.parse(out).comments;
    const result = Array.isArray(comments) ? comments : null;
    issueCommentCache.set(number, result);
    return result;
  } catch {
    issueCommentCache.set(number, null);
    return null;
  }
}

function alreadyCommented(number, comments = undefined) {
  const resolvedComments = comments === undefined ? readIssueComments(number) : comments;
  if (!Array.isArray(resolvedComments)) return null;
  return resolvedComments.some((c) => (c.body || '').includes(MARKER));
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
  let unclassifiableSkipped = 0;

  for (let iss of issues) {
    if (inFlight(iss.number)) { console.log(`#${iss.number}: in-flight PR open, skip`); continue; }
    const labelNames = (iss.labels || []).map(labelName);
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
    if (daily) {
      // Daily buckets are reconciled item-by-item. An issue-wide token hit would let
      // one completed item hide another open item, which is precisely the aggregate
      // closure bug this format removes.
      const itemReconciliation = reconcileDailyItems(iss.body || '', diskIo, daily.dailyKey, daily.targetRepository);
      let reconciledBody = itemReconciliation.body;
      if (itemReconciliation.changed) {
        if (DRY_RUN) {
          console.log(`#${iss.number}: ${itemReconciliation.changes.length} item già provati → dry-run, body non riscritto.`);
        } else {
          const latest = parseIssueJson(gh(['issue', 'view', String(iss.number), ...repoArgs, '--json', 'body'], { allowFail: true }));
          if (!latest || String(latest.body || '') !== String(iss.body || '')) {
            console.log(`#${iss.number}: body cambiato/non leggibile durante la riconciliazione → skip, nessun overwrite.`);
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
            const lines = evidenceLines(change.evidence || []);
            gh(['issue', 'comment', String(iss.number), ...repoArgs, '--body',
              `${MARKER}\n✅ Item \`${change.id}\` marcato \`done\` dopo verifica deterministica del matcher.\n\n${lines}`], { allowFail: true });
          }
        }
      }
      const bucketGate = dailyBucketCloseGate(reconciledBody, diskIo, daily.dailyKey, daily.targetRepository);
      if (bucketGate.blocks) {
        console.log(`#${iss.number} daily:${daily.dailyKey}: bucket aperto (${bucketGate.reason}), item non ancora tutti provati.`);
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
      const dailyInfo = dailyBucketInfo(iss.title || '');
      aggGate = dailyBucketCloseGate(iss.body || '', diskIo, dailyInfo?.dailyKey, dailyInfo?.targetRepository);
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
    const comment = `${MARKER}
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

  const summary = `Reconcile follow-ups: scanned ${issues.length}, cache-skipped ${unclassifiableSkipped}, cache-marked ${unclassifiableCandidates.length}, flagged ${flagged.length}, auto-closed ${closed.length}${DRY_RUN ? ' (dry-run)' : ''}${NO_AUTOCLOSE ? ' (no-autoclose)' : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const uc = unclassifiableCandidates.map((c) => `- 🔎 #${c.number} ${c.title} (aggregate non classificabile, resta aperta)`).join('\n');
    const fl = flagged.map((f) => `- 🟡 #${f.number} ${f.title} (flag: ${f.reason}, ${f.evidence.length} match)`).join('\n');
    const cl = closed.map((c) => `- ✅ #${c.number} ${c.title} (auto-closed, ${c.evidence.length} match)`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${[uc, cl, fl].filter(Boolean).join('\n')}\n`);
  }
}

// Run only as a CLI entrypoint — importing for tests (pure decision helpers above) must
// not trigger the gh-driven scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
