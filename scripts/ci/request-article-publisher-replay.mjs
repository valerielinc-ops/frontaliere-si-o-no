#!/usr/bin/env node

/**
 * Request one bounded rebuild of the corpus publisher after an automated
 * freshness or sync gate has identified an unusable published surface.
 *
 * The consumer must never work around articles-sync-pin.mjs: a smaller or
 * unproven corpus remains a skip. The recovery action is deliberately outside
 * that gate. It nudges the upstream publish-api workflow to rebuild its public
 * surface from main; the next attested push dispatch or the scheduled sync then
 * retries the normal fail-closed pull.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ARTICLE_SYNC_ISSUE_TITLE =
  'Article sync skipped: corpus mirror behind the published API';
export const ARTICLE_L0_ISSUE_TITLE =
  'L0 Data Truth: corpus manifest is not usable';
export const PUBLISHER_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
export const PUBLISHER_WORKFLOW = 'publish-api.yml';
export const PUBLISHER_REF = 'main';
export const REPLAY_MARKER = '<!-- ARTICLE_PUBLISHER_REPLAY: publish-api.yml -->';
export const REPLAY_COOLDOWN_MS = 36 * 60 * 60 * 1000;
export const GH_TIMEOUT_MS = 60_000;

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function gh(args, { token, input } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('missing GitHub token');
  }
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: token },
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function stripYamlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") {
        if (line[index + 1] === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return trimmed;
}

function splitFlowItems(value) {
  const items = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'") {
        if (value[index + 1] === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ']' || character === '}') {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    if (character === ',' && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) return null;
  items.push(value.slice(start).trim());
  return items;
}

function inlineTriggerHasWorkflowDispatch(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (unquoteYamlScalar(trimmed) === 'workflow_dispatch') return true;

  const opening = trimmed[0];
  const closing = opening === '[' ? ']' : opening === '{' ? '}' : null;
  if (!closing || trimmed.at(-1) !== closing) return false;
  const items = splitFlowItems(trimmed.slice(1, -1));
  if (!items) return false;
  if (opening === '[') {
    return items.some((item) => unquoteYamlScalar(item) === 'workflow_dispatch');
  }
  return items.some((item) => {
    const match = item.match(/^(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_-]+))\s*:/u);
    return Boolean(match && (match[1] ?? match[2] ?? match[3]) === 'workflow_dispatch');
  });
}

function blockTriggerHasWorkflowDispatch(lines, headerIndex) {
  let childIndent = null;
  let sequence = false;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index]);
    if (line.trim() === '') continue;
    const indent = line.match(/^ */u)?.[0].length ?? 0;
    if (indent === 0) break;
    const body = line.trim();
    if (childIndent === null) {
      childIndent = indent;
      sequence = body.startsWith('-');
    }
    if (indent !== childIndent) continue;
    if (sequence) {
      if (!body.startsWith('-')) return false;
      if (unquoteYamlScalar(body.slice(1)) === 'workflow_dispatch') return true;
      continue;
    }
    if (/^(?:workflow_dispatch|['"]workflow_dispatch['"])\s*:/u.test(body)) return true;
  }
  return false;
}

/** Select exactly one open issue for a stable recovery title. */
export function findSyncIssue(issues, title = ARTICLE_SYNC_ISSUE_TITLE) {
  if (!Array.isArray(issues)) return null;
  const matches = issues.filter((issue) => issue?.title === title);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Return the newest replay marker still inside the cooldown window, if any.
 * A malformed/future timestamp never suppresses recovery.
 */
export function findRecentReplayMarker(
  comments,
  { now = Date.now(), cooldownMs = REPLAY_COOLDOWN_MS } = {},
) {
  if (!Array.isArray(comments) || !Number.isFinite(now) || !Number.isFinite(cooldownMs)) {
    return null;
  }
  let newest = null;
  for (const comment of comments) {
    if (typeof comment?.body !== 'string' || !comment.body.includes(REPLAY_MARKER)) continue;
    const createdAt = Date.parse(comment.createdAt ?? comment.created_at ?? '');
    if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > cooldownMs) continue;
    if (!newest || createdAt > newest.createdAt) newest = { comment, createdAt };
  }
  return newest;
}

/**
 * Parse only the top-level `on` trigger from the publisher workflow and require
 * an explicit manual trigger. This intentionally stays dependency-free: L0 is
 * a bare sparse checkout and does not install devDependencies before recovery.
 * Ambiguous or unsupported YAML is rejected closed rather than guessed.
 */
export function hasWorkflowDispatch(workflowYaml) {
  if (typeof workflowYaml !== 'string' || workflowYaml.trim() === '') return false;
  const lines = workflowYaml.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index]);
    if (line.trim() === '' || !/^\S/u.test(line)) continue;
    const match = line.match(/^(?:on|['"]on['"]):(?:[ \t]*(.*))?$/u);
    if (!match) continue;
    const inline = match[1]?.trim() ?? '';
    return inline ? inlineTriggerHasWorkflowDispatch(inline) : blockTriggerHasWorkflowDispatch(lines, index);
  }
  return false;
}

export function replayComment({
  runUrl,
  reason,
  trigger = 'the article sync skip threshold',
  requestedAt = new Date().toISOString(),
} = {}) {
  const compactReason = String(reason ?? 'persistent article sync skip')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 600);
  const compactTrigger = String(trigger)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160) || 'a bounded data-surface recovery trigger';
  return [
    REPLAY_MARKER,
    `Requested a bounded \`publish-api.yml\` rebuild on \`${PUBLISHER_REPOSITORY}@${PUBLISHER_REF}\` after ${compactTrigger} (${requestedAt}).`,
    runUrl ? `Sync run: ${runUrl}` : '',
    compactReason ? `Reason: ${compactReason}` : '',
    'The consumer remains fail-closed; the next publisher dispatch or scheduled sync must still pass the normal commit and artifact checks.',
  ].filter(Boolean).join('\n');
}

/**
 * Perform the recovery with injectable GitHub transport for deterministic tests.
 * The caller should run this only on automatic, non-preview recovery paths;
 * the open issue is the durable evidence that the corresponding health gate
 * has already fired.
 */
export function requestPublisherReplay({
  env = process.env,
  now = Date.now(),
  runGh = gh,
  issueTitle,
} = {}) {
  const currentRepository = String(env.GITHUB_REPOSITORY ?? '').trim();
  if (!REPOSITORY_RE.test(currentRepository)) {
    throw new Error('invalid GITHUB_REPOSITORY');
  }
  const currentToken = env.GH_TOKEN || env.GITHUB_TOKEN;
  const publisherToken = env.PUBLISHER_GH_TOKEN;
  if (!publisherToken) throw new Error('PUBLISHER_GH_TOKEN is empty');
  const recoveryIssueTitle = String(
    issueTitle
      ?? env.ARTICLE_PUBLISHER_REPLAY_ISSUE_TITLE
      ?? (env.ARTICLE_PUBLISHER_REPLAY_ISSUE_KIND === 'l0' ? ARTICLE_L0_ISSUE_TITLE : ARTICLE_SYNC_ISSUE_TITLE),
  ).trim();
  if (!recoveryIssueTitle) throw new Error('recovery issue title is empty');
  const searchTitle = recoveryIssueTitle.replaceAll('"', '\\"');
  const recoveryTrigger = env.ARTICLE_PUBLISHER_REPLAY_TRIGGER
    || (env.ARTICLE_PUBLISHER_REPLAY_ISSUE_KIND === 'l0'
      ? 'the stale L0 manifest verdict'
      : 'the article sync skip threshold');

  const listArgs = [
    'issue', 'list', '--repo', currentRepository, '--state', 'open', '--limit', '100',
    '--search', `"${searchTitle}" in:title`, '--json', 'number,title',
  ];
  let issues = parseJson(runGh(listArgs, { token: currentToken }), 'open issue listing');
  let issue = findSyncIssue(issues, recoveryIssueTitle);
  // The search index can lag immediately after github-issue-creator.mjs opens
  // the issue. A plain listing is the fail-closed fallback: no exact issue, no
  // upstream side effect.
  if (!issue) {
    issues = parseJson(runGh([
      'issue', 'list', '--repo', currentRepository, '--state', 'open', '--limit', '100',
      '--json', 'number,title',
    ], { token: currentToken }), 'open issue fallback listing');
    issue = findSyncIssue(issues, recoveryIssueTitle);
  }
  if (!issue || !Number.isInteger(Number(issue.number)) || Number(issue.number) < 1) {
    console.log('[article-publisher-replay] no unique open recovery issue; no replay requested');
    return { requested: false, reason: 'no-unique-open-issue' };
  }

  const comments = parseJson(runGh([
    'issue', 'view', String(issue.number), '--repo', currentRepository, '--json', 'comments',
  ], { token: currentToken }), 'issue comments').comments;
  const recent = findRecentReplayMarker(comments, { now });
  if (recent) {
    console.log(
      `[article-publisher-replay] replay already requested at ${new Date(recent.createdAt).toISOString()}; `
      + 'cooldown is active',
    );
    return { requested: false, reason: 'cooldown', issueNumber: Number(issue.number) };
  }

  const workflowYaml = runGh([
    'workflow', 'view', PUBLISHER_WORKFLOW, '--repo', PUBLISHER_REPOSITORY, '--yaml',
  ], { token: publisherToken });
  if (!hasWorkflowDispatch(workflowYaml)) {
    throw new Error(`${PUBLISHER_REPOSITORY}/${PUBLISHER_WORKFLOW} has no workflow_dispatch trigger`);
  }

  // Claim the cooldown before dispatching. If the workflow is accepted but its
  // response is lost, the durable issue comment still prevents the next sync
  // from dispatching the same recovery again within the bounded window.
  const body = replayComment({
    runUrl: env.RUN_URL,
    reason: env.GATE_REASON,
    trigger: recoveryTrigger,
    requestedAt: new Date(now).toISOString(),
  });
  runGh([
    'issue', 'comment', String(issue.number), '--repo', currentRepository, '--body-file', '-',
  ], { token: currentToken, input: body });

  runGh([
    'workflow', 'run', PUBLISHER_WORKFLOW,
    '--repo', PUBLISHER_REPOSITORY,
    '--ref', PUBLISHER_REF,
  ], { token: publisherToken });

  console.log(`[article-publisher-replay] requested ${PUBLISHER_REPOSITORY}/${PUBLISHER_WORKFLOW}`);
  return { requested: true, issueNumber: Number(issue.number) };
}

const isMain = process.argv[1]
  && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();

if (isMain) {
  try {
    requestPublisherReplay();
  } catch (error) {
    console.error(`[article-publisher-replay] ${error.message}`);
    process.exitCode = 1;
  }
}
