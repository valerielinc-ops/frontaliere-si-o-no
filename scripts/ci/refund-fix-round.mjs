#!/usr/bin/env node
/**
 * Refund a PR-fixer round when Claude stopped before doing any work because of
 * a rate limit. The round marker is removed only after a verified DELETE; the
 * provisional comment keeps the quota beacon visible if that DELETE fails.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { detectClaudeRateLimit, parseExecutionMessages } from './claude-rate-limit.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const PR = process.env.PR;
const MARKER = process.env.MARKER || '';
const ROUND = process.env.ROUND || '';
const EXEC_FILE = process.env.EXEC_FILE;
const RUN_URL = process.env.RUN_URL || '';
const WORKFLOW = process.env.WORKFLOW || 'pr-fixer';
const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

/**
 * Refund only when the structured result proves that Claude stopped before
 * doing work. The site parser deliberately stays fail-closed for plain logs:
 * without a result/metrics record, a 429 alone cannot prove zero-turn.
 */
export function shouldRefundRateLimitedRound(raw) {
  const detected = detectClaudeRateLimit(raw);
  if (!detected.rateLimited) return false;
  const messages = parseExecutionMessages(raw);
  const results = messages.filter((message) => message && message.type === 'result');
  if (!results.length) return false;

  const numericMetric = (value) => typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
  const hasTurns = results.some((message) => numericMetric(message.num_turns) !== null);
  const hasCost = results.some((message) => numericMetric(message.total_cost_usd) !== null);
  if (!hasTurns && !hasCost && messages.some((message) => message && message.type === 'assistant')) {
    return false;
  }
  const turns = results.reduce((max, message) => {
    const value = numericMetric(message.num_turns);
    return value === null ? max : Math.max(max, value);
  }, 0);
  const cost = results.reduce((max, message) => {
    const value = numericMetric(message.total_cost_usd);
    return value === null ? max : Math.max(max, value);
  }, 0);
  return (hasTurns || hasCost) && turns <= 1 && cost <= 0;
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    console.log(`gh fallita (non bloccante): ${error?.message || error}`);
    return '';
  }
}

function ghStatus(args) {
  try {
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return true;
  } catch (error) {
    console.log(`gh fallita (non bloccante): ${error?.message || error}`);
    return false;
  }
}

export function roundMarkerRe(marker, round) {
  const escaped = String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!--\\s*${escaped}:\\s*${Number(round)}\\s*-->`);
}

export function pickRoundCommentId(comments, marker, round) {
  if (!marker || !Number.isFinite(Number(round)) || Number(round) <= 0) return null;
  const re = roundMarkerRe(marker, round);
  const matches = (Array.isArray(comments) ? comments : [])
    .filter((comment) => comment && Number.isFinite(Number(comment.id)) && re.test(String(comment.body || '')))
    .sort((a, b) => {
      const at = Date.parse(a.created_at || a.createdAt || '');
      const bt = Date.parse(b.created_at || b.createdAt || '');
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? 1 : -1;
      return Number(a.id) - Number(b.id);
    });
  return matches.length ? Number(matches.at(-1).id) : null;
}

export function refundMarkerName(marker) {
  return String(marker || '').replace(/_ROUND$/, '') + '_REFUNDED';
}

function resetBeacon(resetsAt) {
  return Number.isFinite(Number(resetsAt)) && Number(resetsAt) > 0
    ? `<!-- QUOTA_RESETS_AT: ${Math.round(Number(resetsAt))} -->`
    : null;
}

export function formatRefundComment({ round, workflow, resetsAt, rateLimitType, runUrl, marker }) {
  const when = Number.isFinite(Number(resetsAt)) && Number(resetsAt) > 0
    ? new Date(Number(resetsAt) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : null;
  return [
    marker ? `<!-- ${refundMarkerName(marker)}: ${round} -->` : null,
    resetBeacon(resetsAt),
    `⏳ **Quota Claude esaurita${rateLimitType ? ` (\`${rateLimitType}\`)` : ''}** — \`${workflow}\` è uscito su HTTP 429:`,
    'Claude **non ha letto questa PR** e non ha speso token (al massimo 1 turno di bootstrap, $0).',
    '',
    `Il round **${round}** è stato **rimborsato** (marker rimosso): non è stato consumato da questa run,`,
    'quindi il cap anti-loop non avvicina la PR a `needs-human` per un muro di quota.',
    when ? `La quota torna disponibile alle **${when}**.` : null,
    runUrl ? `\nRun: ${runUrl}` : null,
  ].filter((line) => line !== null).join('\n');
}

export function formatRefundAttemptComment({ round, workflow, resetsAt, rateLimitType, runUrl }) {
  const when = Number.isFinite(Number(resetsAt)) && Number(resetsAt) > 0
    ? new Date(Number(resetsAt) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : null;
  return [
    resetBeacon(resetsAt),
    `⏳ **Quota Claude esaurita${rateLimitType ? ` (\`${rateLimitType}\`)` : ''}** — \`${workflow}\` ha rilevato HTTP 429:`,
    'Questa è la traccia della procedura di rimborso; il marker viene rimosso solo dopo una DELETE verificata.',
    when ? `La quota torna disponibile alle **${when}**.` : null,
    runUrl ? `\nRun: ${runUrl}` : null,
  ].filter((line) => line !== null).join('\n');
}

function executionRaw() {
  if (EXEC_FILE && fs.existsSync(EXEC_FILE)) return fs.readFileSync(EXEC_FILE, 'utf8');
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID;
  if (!runId) return '';
  const log = gh(['run', 'view', String(runId), ...repoArgs, '--log-failed']);
  if (log) console.log('execution_file assente → verifico il log della run per un 429 esplicito.');
  return log;
}

function main() {
  if (!PR || !MARKER || !ROUND) {
    console.log('PR/MARKER/ROUND non impostati → niente da rimborsare.');
    return;
  }
  const raw = executionRaw();
  if (!raw) {
    console.log('Nessun execution file né log verificabile → nessun rimborso.');
    return;
  }
  const { rateLimited, resetsAt, rateLimitType } = detectClaudeRateLimit(raw);
  if (!rateLimited) {
    console.log('La run non è morta di quota → il round resta consumato.');
    return;
  }
  if (!shouldRefundRateLimitedRound(raw)) {
    console.log('429 rilevato dopo consumo Claude → nessun rimborso del round.');
    return;
  }

  const repo = process.env.GH_REPO || '{owner}/{repo}';
  const commentsRaw = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${PR}/comments?per_page=100`]);
  let comments = [];
  try {
    const parsed = JSON.parse(commentsRaw || '[]');
    comments = Array.isArray(parsed) ? parsed.flatMap((page) => Array.isArray(page) ? page : []) : [];
  } catch {
    comments = [];
  }
  const id = pickRoundCommentId(comments, MARKER, ROUND);
  if (!id) {
    console.log(`Marker \`${MARKER}: ${ROUND}\` non trovato sulla PR #${PR} → niente da cancellare.`);
    return;
  }

  const attempt = formatRefundAttemptComment({ round: ROUND, workflow: WORKFLOW, resetsAt, rateLimitType, runUrl: RUN_URL });
  const refund = formatRefundComment({ round: ROUND, workflow: WORKFLOW, resetsAt, rateLimitType, runUrl: RUN_URL, marker: MARKER });
  if (DRY_RUN) {
    console.log(refund);
    return;
  }
  // Prima la traccia provvisoria, poi DELETE, poi il commento conclusivo: se la
  // DELETE fallisce il beacon resta leggibile senza dichiarare un rimborso.
  if (!ghStatus(['pr', 'comment', String(PR), ...repoArgs, '--body', attempt])) return;
  if (!ghStatus(['api', '-X', 'DELETE', `repos/${repo}/issues/comments/${id}`])) {
    console.log('DELETE del marker fallita → round ancora consumato.');
    return;
  }
  if (!ghStatus(['pr', 'comment', String(PR), ...repoArgs, '--body', refund])) {
    console.log('Commento finale non postato dopo DELETE riuscita → marker già rimborsato.');
  }
}

if (process.argv[1]?.endsWith('refund-fix-round.mjs')) main();
