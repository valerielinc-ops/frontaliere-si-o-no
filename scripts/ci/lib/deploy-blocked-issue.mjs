/**
 * One open "blocked" issue per failure key for the deploy control plane.
 *
 * Shared by the build re-arm (`Deploy build blocked:`) and the publish
 * reconciler (`Deploy publish blocked:`). The prefix is the only thing that
 * differs; each caller names its own opt-in environment flag, and nothing is
 * written unless that flag is exactly `1` (the re-arm uses
 * `REARM_ISSUE_UPDATE`, the publish reconciler `PUBLISH_ISSUE_UPDATE`).
 *
 * Writes go through `scripts/lib/github-issue-creator.mjs`, which de-duplicates
 * on the stable title and comments on the open canonical issue instead of
 * opening a second one. Both helpers never throw: visibility must not cost a
 * deploy.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gh } from './deploy-run-evidence.mjs';

export const BUILD_BLOCKED_ISSUE_PREFIX = 'Deploy build blocked:';
export const PUBLISH_BLOCKED_ISSUE_PREFIX = 'Deploy publish blocked:';

/** True only when `process.env[flag]` is exactly `'1'`. */
export function issueUpdatesEnabled(flag, env = process.env) {
  return Boolean(flag) && env?.[flag] === '1';
}

export function blockedIssueTitle(prefix, failure) {
  const short = `${failure.job || 'deploy'} / ${failure.step || 'unknown step'}`.replace(/\s+/g, ' ').slice(0, 100);
  return `${prefix} ${short}`;
}

/** True when an open issue already carries exactly this title. A failed lookup is `false`. */
function hasOpenBlockedIssue(title) {
  try {
    const listed = JSON.parse(gh([
      'issue', 'list', '--state', 'open', '--search', `in:title "${title}"`,
      '--json', 'number,title', '--limit', '30',
    ]));
    return (Array.isArray(listed) ? listed : []).some((issue) => String(issue?.title || '') === title);
  } catch {
    return false;
  }
}

/**
 * @param {object} input
 * @param {string} input.prefix        title prefix, e.g. BUILD_BLOCKED_ISSUE_PREFIX
 * @param {string} input.flag          opt-in env flag name
 * @param {string} input.workflowName  workflow named in the issue
 * @param {{job?: string, step?: string}} input.failure
 * @param {string} input.body          markdown body (the caller owns the wording)
 * @param {string} [input.runUrl]
 * @param {boolean} [input.createOnly] write only when no open issue has this exact
 *        title (a reconciler that ticks every 10 minutes must not comment each time)
 */
export function upsertBlockedIssue({ prefix, flag, workflowName, failure, body, runUrl, createOnly = false }) {
  if (!issueUpdatesEnabled(flag)) return false;
  try {
    if (createOnly && hasOpenBlockedIssue(blockedIssueTitle(prefix, failure))) return false;
    const dir = mkdtempSync(join(tmpdir(), 'deploy-blocked-'));
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    execFileSync('node', [
      'scripts/lib/github-issue-creator.mjs',
      '--title', blockedIssueTitle(prefix, failure),
      '--description-file', file,
      '--workflow', workflowName,
      ...(runUrl ? ['--run-url', runUrl] : []),
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    return true;
  } catch (err) {
    console.warn(`::warning::could not update the blocked issue (${prefix}): ${String(err?.message || err).split('\n')[0]}`);
    return false;
  }
}

/** Close every open issue whose title starts with `prefix`. */
export function resolveBlockedIssues({ prefix, flag, workflowName, runUrl }) {
  if (!issueUpdatesEnabled(flag)) return false;
  try {
    const listed = JSON.parse(gh([
      'issue', 'list', '--state', 'open', '--search', `in:title "${prefix}"`,
      '--json', 'number,title', '--limit', '30',
    ]));
    for (const issue of Array.isArray(listed) ? listed : []) {
      if (!String(issue?.title || '').startsWith(prefix)) continue;
      execFileSync('node', [
        'scripts/lib/github-issue-creator.mjs', '--resolve',
        '--title', issue.title, '--workflow', workflowName,
        ...(runUrl ? ['--run-url', runUrl] : []),
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    }
    return true;
  } catch (err) {
    console.warn(`::warning::could not resolve blocked issues (${prefix}): ${String(err?.message || err).split('\n')[0]}`);
    return false;
  }
}
