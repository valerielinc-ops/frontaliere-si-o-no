#!/usr/bin/env node
/**
 * detect-aggregate.mjs — the issue-fix workflow's aggregate detector.
 *
 * The aggregate rule belongs to `isAggregate()`, shared by the issue-fix
 * helpers. Keeping the GitHub read and the output adapter here means the YAML
 * workflow does not grow a fourth, weaker shell implementation.
 *
 * On an unreadable issue the safe direction is `is_aggregate=true`: a false
 * value could let a one-item fixer close a tracker while deferred items are
 * still in its body. A true value costs one conservative follow-up instead.
 *
 * Usage:
 *   REPO=owner/repo ISSUE_NUMBER=123 node scripts/ci/detect-aggregate.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAggregate } from './check-issue-already-resolved.mjs';

export function detectAggregate({ title = '', body = '', readable = true } = {}) {
  if (!readable) return { aggregate: true, fallback: true };
  return { aggregate: isAggregate(title, body), fallback: false };
}

function readIssue(repo, issue) {
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'view', String(issue), '--repo', repo, '--json', 'title,body'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(out);
    return { title: parsed.title || '', body: parsed.body || '', readable: true };
  } catch (err) {
    return { readable: false, error: err?.message || String(err) };
  }
}

function main() {
  const repo = process.env.REPO || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const issue = process.env.ISSUE_NUMBER || '';
  if (!repo || !issue) {
    console.error('detect-aggregate: REPO e ISSUE_NUMBER sono obbligatori');
    process.exit(2);
  }
  const read = readIssue(repo, issue);
  const { aggregate, fallback } = detectAggregate(read);
  if (fallback) {
    console.log(
      `::warning::detect-aggregate: issue #${issue} non leggibile (${read.error}) — `
        + 'is_aggregate=true per prudenza (un falso `false` chiuderebbe il tracker con gli item dentro).',
    );
  }
  console.log(`is_aggregate=${aggregate}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `is_aggregate=${aggregate}\n`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
