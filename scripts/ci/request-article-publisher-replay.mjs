#!/usr/bin/env node

/**
 * Request one bounded rebuild of the corpus publisher after the sync issue has
 * reached its own consecutive-failure threshold.
 *
 * The consumer must never work around articles-sync-pin.mjs: a smaller or
 * unproven corpus remains a skip. The recovery action is deliberately outside
 * that gate. It nudges the upstream publish-api workflow to rebuild its public
 * surface from main; the next attested push dispatch or the scheduled sync then
 * retries the normal fail-closed pull.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const ARTICLE_SYNC_ISSUE_TITLE =
  'Article sync skipped: corpus mirror behind the published API';
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

/** Select exactly one open issue for the stable sync title. */
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

/** Parse the publisher workflow and require an explicit manual trigger. */
export function hasWorkflowDispatch(workflowYaml) {
  if (typeof workflowYaml !== 'string' || workflowYaml.trim() === '') return false;
  let document;
  try {
    document = parseYaml(workflowYaml);
  } catch {
    return false;
  }
  // `yaml` follows YAML 1.2 (`on` is a string), but accept the boolean key as
  // well so this guard remains correct if the parser configuration changes.
  const triggers = document?.on ?? document?.true;
  if (triggers === 'workflow_dispatch') return true;
  if (Array.isArray(triggers)) return triggers.includes('workflow_dispatch');
  return Boolean(
    triggers && typeof triggers === 'object' && !Array.isArray(triggers)
      && Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch'),
  );
}

export function replayComment({ runUrl, reason, requestedAt = new Date().toISOString() } = {}) {
  const compactReason = String(reason ?? 'persistent article sync skip')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 600);
  return [
    REPLAY_MARKER,
    `Requested a bounded \`publish-api.yml\` rebuild on \`${PUBLISHER_REPOSITORY}@${PUBLISHER_REF}\` after the sync skip threshold (${requestedAt}).`,
    runUrl ? `Sync run: ${runUrl}` : '',
    compactReason ? `Reason: ${compactReason}` : '',
    'The consumer remains fail-closed; the next publisher dispatch or scheduled sync must still pass the normal commit and artifact checks.',
  ].filter(Boolean).join('\n');
}

/**
 * Perform the recovery with injectable GitHub transport for deterministic tests.
 * The caller should run this only on automatic, non-preview syncs; the open
 * issue is the evidence that the three-failure gate has already fired.
 */
export function requestPublisherReplay({
  env = process.env,
  now = Date.now(),
  runGh = gh,
} = {}) {
  const currentRepository = String(env.GITHUB_REPOSITORY ?? '').trim();
  if (!REPOSITORY_RE.test(currentRepository)) {
    throw new Error('invalid GITHUB_REPOSITORY');
  }
  const currentToken = env.GH_TOKEN || env.GITHUB_TOKEN;
  const publisherToken = env.PUBLISHER_GH_TOKEN;
  if (!publisherToken) throw new Error('PUBLISHER_GH_TOKEN is empty');

  const listArgs = [
    'issue', 'list', '--repo', currentRepository, '--state', 'open', '--limit', '100',
    '--search', `"${ARTICLE_SYNC_ISSUE_TITLE}" in:title`, '--json', 'number,title',
  ];
  let issues = parseJson(runGh(listArgs, { token: currentToken }), 'open issue listing');
  let issue = findSyncIssue(issues);
  // The search index can lag immediately after github-issue-creator.mjs opens
  // the issue. A plain listing is the fail-closed fallback: no exact issue, no
  // upstream side effect.
  if (!issue) {
    issues = parseJson(runGh([
      'issue', 'list', '--repo', currentRepository, '--state', 'open', '--limit', '100',
      '--json', 'number,title',
    ], { token: currentToken }), 'open issue fallback listing');
    issue = findSyncIssue(issues);
  }
  if (!issue || !Number.isInteger(Number(issue.number)) || Number(issue.number) < 1) {
    console.log('[article-publisher-replay] no unique open sync issue; no replay requested');
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
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    requestPublisherReplay();
  } catch (error) {
    console.error(`[article-publisher-replay] ${error.message}`);
    process.exitCode = 1;
  }
}
