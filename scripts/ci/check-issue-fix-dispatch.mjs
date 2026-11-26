#!/usr/bin/env node

/**
 * check-issue-fix-dispatch.mjs — zero-agent admission gate for issue-fix.yml.
 *
 * A label event is only an invitation to inspect an issue.  It is not proof
 * that the daily item which caused the event is still the item that the fixer
 * should receive.  This gate freezes the item from the already verified issue
 * snapshot, then compares that scope with both the original event and a fresh
 * issue read before any App mint, quota lease, mutex claim, or Codex call.
 *
 * `--select` is local-only and emits the frozen scope.  `--verify` is the
 * admission check; it requeues a changed scope without consuming `fu-attempt`
 * and removes routing labels from a terminal bucket.  Any unreadable snapshot,
 * event, or live response fails closed without writing labels.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dailyBucketInfo, dailyBucketScopeDecision } from './followup-resolution-match.mjs';

const MODE = process.argv[2] || '--verify';
const ISSUE = String(process.env.ISSUE_NUMBER || '').trim();
const REPO = String(process.env.GH_REPO || process.env.REPO || process.env.GITHUB_REPOSITORY || '').trim();
const SNAPSHOT_FILE = process.env.ISSUE_FIX_SNAPSHOT_FILE || '';
const EVENT_FILE = process.env.ISSUE_FIX_EVENT_PATH || '';
const EXPECTED_SCOPE_FINGERPRINT = String(process.env.DISPATCH_SCOPE_FINGERPRINT || '').trim();
const EXPECTED_ITEM_ID = String(process.env.DISPATCH_ITEM_ID || '').trim().toUpperCase();
const EXPECTED_IS_DAILY = String(process.env.DISPATCH_IS_DAILY || '').trim() === 'true';
const OUTPUT_FILE = process.env.GITHUB_OUTPUT || '';
const STALE_MARKER = '<!-- ISSUE_FIX_DISPATCH_STALE -->';
const TERMINAL_MARKER = '<!-- ISSUE_FIX_DISPATCH_TERMINAL -->';
const STALE_REQUEUE_MAX = 3;
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  throw new Error(message);
}

function readJson(file, description) {
  if (!file) fail(`${description} path missing`);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`${description} unreadable: ${error?.message || error}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${description} is not valid JSON: ${error?.message || error}`);
  }
}

function normalizeLabels(value, description) {
  if (!Array.isArray(value)) fail(`${description} labels are not an array`);
  const labels = [];
  for (const label of value) {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name !== 'string' || !name) fail(`${description} contains an unreadable label`);
    labels.push(name);
  }
  return [...new Set(labels)];
}

function issueNumber(value, description) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${description} number is not valid`);
  return number;
}

function normalizeIssue(value, description, { requireLabels = false, requireComments = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${description} is not an object`);
  }
  const number = issueNumber(value.number ?? value.target?.issue, description);
  if (number !== Number(ISSUE)) fail(`${description} number does not match ISSUE_NUMBER`);
  if (typeof value.state !== 'string' || !value.state.trim()) fail(`${description} state is not readable`);
  if (typeof value.title !== 'string') fail(`${description} title is not readable`);
  if (value.body !== null && typeof value.body !== 'string') fail(`${description} body is not readable`);
  const labels = requireLabels || value.labels !== undefined
    ? normalizeLabels(value.labels, description)
    : [];
  if (requireComments || value.comments !== undefined) {
    if (!Array.isArray(value.comments)) fail(`${description} comments are not readable`);
    if (value.comments.some((comment) => !comment || typeof comment !== 'object' || Array.isArray(comment))) {
      fail(`${description} contains an unreadable comment`);
    }
  }
  return {
    number,
    state: value.state.toUpperCase(),
    title: value.title,
    body: value.body ?? '',
    labels,
    comments: Array.isArray(value.comments) ? value.comments : [],
  };
}

function readFrozenIssue() {
  const raw = readJson(SNAPSHOT_FILE, 'frozen issue snapshot');
  const issue = normalizeIssue(raw, 'frozen issue snapshot', { requireLabels: true, requireComments: true });
  if (raw.target?.repo && raw.target.repo !== REPO) fail('frozen issue snapshot repository does not match GH_REPO');
  if (issue.state !== 'OPEN') fail('frozen issue snapshot is not OPEN');
  return issue;
}

function readEventIssue() {
  const event = readJson(EVENT_FILE, 'issue event snapshot');
  return normalizeIssue(event.issue, 'issue event snapshot');
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readLiveIssue() {
  if (!REPO) fail('GH_REPO is missing');
  let raw;
  try {
    raw = gh(['issue', 'view', ISSUE, '--repo', REPO, '--json', 'number,state,title,body,labels,comments']);
  } catch (error) {
    fail(`live issue snapshot unreadable: ${error?.message || error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`live issue snapshot is not valid JSON: ${error?.message || error}`);
  }
  return normalizeIssue(parsed, 'live issue snapshot', { requireLabels: true, requireComments: true });
}

function scopeFor(issue) {
  const daily = dailyBucketInfo(issue.title);
  const dailyTitlePrefix = /^follow-up\(daily:/i.test(issue.title.trim());
  const decision = dailyBucketScopeDecision(issue.title, issue.body);
  const malformedDailyTitle = dailyTitlePrefix && !daily;
  const selectedItemId = malformedDailyTitle
    ? ''
    : (decision.item?.id ? String(decision.item.id).toUpperCase() : '');
  const dailyWithoutOpenItem = decision.isDaily && !decision.terminal && !decision.item;
  const material = JSON.stringify({
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    dailyKey: daily?.dailyKey || '',
    selectedItemId,
  });
  return {
    valid: malformedDailyTitle ? false : decision.valid && !dailyWithoutOpenItem,
    reason: malformedDailyTitle
      ? 'malformed-daily-title'
      : (dailyWithoutOpenItem ? (decision.reason || 'no-open-item') : (decision.reason || null)),
    isDaily: decision.isDaily,
    terminal: malformedDailyTitle ? false : (decision.isDaily ? decision.terminal : issue.state !== 'OPEN'),
    dailyKey: daily?.dailyKey || '',
    selectedItemId,
    fingerprint: createHash('sha256').update(material).digest('hex'),
  };
}

function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value ?? ''}`);
  for (const line of lines) console.log(line);
  if (OUTPUT_FILE) fs.appendFileSync(OUTPUT_FILE, `${lines.join('\n')}\n`);
}

function emitSelection(scope) {
  if (!scope.valid) fail(`frozen daily scope is not verifiable: ${scope.reason || 'unknown'}`);
  writeOutputs({
    is_daily_bucket: String(scope.isDaily),
    daily_key: scope.dailyKey,
    selected_item_id: scope.selectedItemId,
    scope_fingerprint: scope.fingerprint,
  });
}

function recentStaleMarkers(issue) {
  const now = Date.now();
  return issue.comments.filter((comment) => {
    if (typeof comment?.body !== 'string' || !comment.body.includes(STALE_MARKER)) return false;
    const created = Date.parse(String(comment.createdAt || ''));
    return Number.isFinite(created) && now - created >= 0 && now - created < STALE_WINDOW_MS;
  }).length;
}

function writeComment(body) {
  const root = process.env.RUNNER_TEMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `issue-fix-dispatch-${process.pid}.md`);
  fs.writeFileSync(file, `${body.trim()}\n`);
  try {
    gh(['issue', 'comment', ISSUE, '--repo', REPO, '--body-file', file]);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function readLiveLabels() {
  const issue = readLiveIssue();
  return issue.labels;
}

function verifyLabelPostcondition({ requireQueued = false, removeQueued = false }) {
  const labels = readLiveLabels();
  const hasFix = labels.includes('agent:fix');
  const hasQueued = labels.includes('agent:fix-queued');
  if (hasFix || (requireQueued && !hasQueued) || (removeQueued && hasQueued)) {
    fail(`routing label postcondition non verificata (agent:fix=${hasFix}, agent:fix-queued=${hasQueued})`);
  }
}

function issueHasFixLabel(issue) {
  return issue.labels.includes('agent:fix');
}

function requeueStale(live, reason, frozen, event) {
  if (!issueHasFixLabel(live)) {
    console.log(`::notice::dispatch stale per #${ISSUE}, ma agent:fix è già assente: nessuna scrittura.`);
    writeOutputs({ proceed: 'false', stale: 'true', terminal: 'false', verified: 'false' });
    return;
  }
  const recent = recentStaleMarkers(live);
  if (recent >= STALE_REQUEUE_MAX) {
    fail(`dispatch stale già ri-accodato ${recent} volte in 24h: deny senza capability`);
  }

  const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID || 'unknown'}`;
  writeComment([
    STALE_MARKER,
    '♻️ **Issue-fix: dispatch stale prima delle capability, ri-accodato** (zero-Claude).',
    '',
    `Lo scope congelato (${frozen.selectedItemId || 'issue-wide'}) non coincide con l’evento o con la issue live (${reason}). Questa run non acquisisce capability, claim, quota o lease e non avvia Codex.`,
    '',
    `Evento: ${event.fingerprint.slice(0, 16)}… · run: ${runUrl}`,
    '',
    '`agent:fix` passa a `agent:fix-queued` senza consumare un `fu-attempt`; il drainer rivaluterà lo scope corrente.',
  ].join('\n'));

  try {
    gh(['issue', 'edit', ISSUE, '--repo', REPO, '--add-label', 'agent:fix-queued', '--remove-label', 'agent:fix']);
  } catch (error) {
    // A concurrent drainer may have completed the same transition. Accept only
    // a freshly proven postcondition; every other edit failure stays red.
    try {
      verifyLabelPostcondition({ requireQueued: true });
    } catch {
      fail(`ri-accodamento stale non verificabile: ${error?.message || error}`);
    }
  }
  verifyLabelPostcondition({ requireQueued: true });
  console.log(`::notice::#${ISSUE} ri-accodata in agent:fix-queued senza tentativo consumato.`);
  writeOutputs({ proceed: 'false', stale: 'true', terminal: 'false', verified: 'false' });
}

function stopTerminal(live, reason) {
  const hasFix = live.labels.includes('agent:fix');
  const hasQueued = live.labels.includes('agent:fix-queued');
  if (!hasFix && !hasQueued) {
    console.log(`::notice::issue-fix terminale per #${ISSUE} (${reason}), routing già assente.`);
    writeOutputs({ proceed: 'false', stale: 'false', terminal: 'true', verified: 'false' });
    return;
  }

  writeComment([
    TERMINAL_MARKER,
    '⏭️ **Issue-fix: dispatch terminale ignorato** (zero-Claude).',
    '',
    `La issue non ha più uno scope aperto per il fixer (${reason}). Rimuovo il routing senza acquisire capability, claim, quota o lease.`,
  ].join('\n'));
  try {
    gh(['issue', 'edit', ISSUE, '--repo', REPO, '--remove-label', 'agent:fix', '--remove-label', 'agent:fix-queued']);
  } catch (error) {
    try {
      verifyLabelPostcondition({ removeQueued: true });
    } catch {
      fail(`uscita terminale non verificabile: ${error?.message || error}`);
    }
  }
  verifyLabelPostcondition({ removeQueued: true });
  console.log(`::notice::#${ISSUE} terminale: routing rimosso senza avviare il fixer.`);
  writeOutputs({ proceed: 'false', stale: 'false', terminal: 'true', verified: 'false' });
}

function select() {
  if (!/^\d+$/.test(ISSUE)) fail('ISSUE_NUMBER missing or invalid');
  if (!REPO) fail('GH_REPO missing');
  emitSelection(scopeFor(readFrozenIssue()));
}

function verify() {
  if (!/^\d+$/.test(ISSUE)) fail('ISSUE_NUMBER missing or invalid');
  if (!REPO) fail('GH_REPO missing');
  if (!/^[0-9a-f]{64}$/.test(EXPECTED_SCOPE_FINGERPRINT)) {
    fail('dispatch scope fingerprint missing or non-canonical');
  }

  const frozen = readFrozenIssue();
  const frozenScope = scopeFor(frozen);
  if (!frozenScope.valid) fail(`frozen daily scope is not verifiable: ${frozenScope.reason || 'unknown'}`);
  if (frozenScope.fingerprint !== EXPECTED_SCOPE_FINGERPRINT
      || frozenScope.isDaily !== EXPECTED_IS_DAILY
      || frozenScope.selectedItemId !== EXPECTED_ITEM_ID) {
    fail('dispatch scope output does not match the frozen issue snapshot');
  }

  const event = readEventIssue();
  const eventScope = scopeFor(event);
  const live = readLiveIssue();
  if (live.state !== 'OPEN') {
    stopTerminal(live, `issue ${live.state.toLowerCase()}`);
    return;
  }
  const liveScope = scopeFor(live);
  if (!liveScope.valid) {
    requeueStale(live, `snapshot live non verificabile: ${liveScope.reason || 'scope-invalid'}`, frozenScope, eventScope);
    return;
  }
  if (!eventScope.valid) {
    requeueStale(live, `evento non più promuovibile: ${eventScope.reason || 'scope-invalid'}`, frozenScope, eventScope);
    return;
  }
  if (liveScope.terminal) {
    stopTerminal(live, liveScope.reason || 'no-open-item');
    return;
  }

  const mismatches = [];
  if (!issueHasFixLabel(live)) mismatches.push('issue live senza routing agent:fix');
  if (eventScope.fingerprint !== frozenScope.fingerprint) mismatches.push('evento diverso dallo scope congelato');
  if (liveScope.fingerprint !== frozenScope.fingerprint) mismatches.push('issue live diversa dallo scope congelato');
  if (frozenScope.isDaily && liveScope.selectedItemId !== frozenScope.selectedItemId) {
    mismatches.push(`item selezionato ${liveScope.selectedItemId || 'nessuno'} diverso da ${frozenScope.selectedItemId}`);
  }
  if (mismatches.length) {
    requeueStale(live, mismatches.join('; '), frozenScope, eventScope);
    return;
  }

  writeOutputs({
    proceed: 'true',
    stale: 'false',
    terminal: 'false',
    verified: 'true',
  });
  console.log(`Dispatch verificato per #${ISSUE}: ${frozenScope.isDaily ? frozenScope.selectedItemId : 'issue-wide'}.`);
}

try {
  if (MODE === '--select') select();
  else if (MODE === '--verify') verify();
  else fail(`unknown mode: ${MODE}`);
} catch (error) {
  console.error(`::error::issue-fix stale-dispatch gate fail-closed: ${error?.message || error}`);
  try {
    writeOutputs({ proceed: 'false', stale: 'false', terminal: 'false', verified: 'false', error: 'true' });
  } catch {
    // A broken output file is itself a hard failure; do not mask the original deny.
  }
  process.exitCode = 1;
}
