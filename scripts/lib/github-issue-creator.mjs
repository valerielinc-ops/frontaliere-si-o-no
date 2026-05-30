/**
 * github-issue-creator.mjs — Auto-create GitHub Issues on workflow failure.
 *
 * Drop-in replacement for the legacy github-issue-creator.mjs. Same CLI
 * surface and function signature so existing workflows migrate via a
 * single import path swap.
 *
 * Usage from CLI:
 *   node scripts/lib/github-issue-creator.mjs \
 *     --title "Crawler Failure: Update Coop" \
 *     --description "Stack trace + context" \
 *     --priority 2 \
 *     --label Bug \
 *     --workflow "Update Coop Ticino"
 *
 * Usage as module:
 *   import { createGithubIssue } from './github-issue-creator.mjs';
 *   await createGithubIssue({ title, description, priority, labels, workflow });
 *
 * Auth: requires `gh` CLI authenticated via GITHUB_TOKEN (default in GH
 * Actions) or local `gh auth login`. Repo is auto-detected from the working
 * directory; override with $GH_REPO if needed.
 *
 * Priority → label mapping (kept compatible with the Linear 1-4 scale so
 * call sites don't change):
 *   1 → priority:urgent
 *   2 → priority:high
 *   3 → priority:medium (default)
 *   4 → priority:low
 *
 * De-duplication: searches for OPEN issues whose title shares the first
 * 60 chars of the new title; if found, posts a comment with the new context
 * instead of creating a duplicate. Mirrors the Linear de-dup behavior.
 */

import { execFileSync } from 'node:child_process';

const PRIORITY_LABEL = {
  1: 'priority:urgent',
  2: 'priority:high',
  3: 'priority:medium',
  4: 'priority:low',
};

const DEDUP_TITLE_PREFIX_LEN = 60;
const MAX_BODY_LEN = 60000; // GH issue body cap is 65536; leave margin

/**
 * Run `gh` with explicit args. Returns trimmed stdout, or null on failure.
 * stderr is forwarded for visibility (workflow logs will show the actual error).
 */
function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

function repoFlag() {
  // Honor explicit override; otherwise gh auto-detects from cwd's git remote.
  return process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
}

function ensureLabelsExist(labels) {
  // Best-effort: try to create each label. `gh label create` errors if it
  // exists, which is fine — we proceed.
  for (const name of labels) {
    if (!name) continue;
    gh(['label', 'create', name, ...repoFlag()], { allowFailure: true });
  }
}

function findOpenIssueByTitlePrefix(titlePrefix) {
  // gh issue list --search title:"prefix" --state open
  const out = gh([
    'issue', 'list',
    '--state', 'open',
    '--search', `in:title "${titlePrefix.replace(/"/g, '\\"')}"`,
    '--limit', '5',
    '--json', 'number,title,url',
    ...repoFlag(),
  ], { allowFailure: true });
  if (!out) return null;
  try {
    const issues = JSON.parse(out);
    // `gh issue list --search "in:title ..."` è token-match (fuzzy): titoli che
    // condividono token (es. "...(dist): post-deploy" vs "...(live): post-deploy",
    // o "CI Failure: Refresh Job Popularity" vs "...Refresh BFS Stats") possono
    // entrambi comparire. Filtra al match esatto di prefisso → niente commento
    // sul canonical sbagliato (altrimenti dist commenterebbe su issue live).
    const exact = issues.filter((i) => typeof i.title === 'string' && i.title.startsWith(titlePrefix));
    return exact[0] || null;
  } catch {
    return null;
  }
}

/**
 * Create a GitHub issue, or comment on an existing open duplicate.
 */
export async function createGithubIssue({
  title,
  description = '',
  priority = 3,
  labels = [],
  workflow,
  // When set (hours), a recently-closed issue with the same stable title prefix
  // is REOPENED + commented instead of opening a fresh duplicate. Use for
  // transient per-run reporters (post-deploy validation) where the issue may
  // have been auto-closed on a green run and then flaps red again. CLI:
  // --reopen-within-hours N. Default 0 = disabled (legacy behaviour preserved).
  reopenWithinHours = 0,
  // `project` accepted for backward compatibility but not used (GH issues
  // don't have a free-form project field comparable to Linear's; the
  // workflow name is preserved in the body for grouping).
} = {}) {
  if (process.env.ENABLE_FAILURE_REPORT === 'false') {
    console.log('[github-issue-creator] ENABLE_FAILURE_REPORT=false, skipping');
    return null;
  }
  if (!title) {
    console.error('[github-issue-creator] --title is required');
    return null;
  }

  const titlePrefix = title.slice(0, DEDUP_TITLE_PREFIX_LEN);
  const existing = findOpenIssueByTitlePrefix(titlePrefix);

  // Build label set: priority label + caller-supplied labels.
  const priorityLabel = PRIORITY_LABEL[Number(priority)] || PRIORITY_LABEL[3];
  const labelSet = Array.from(new Set([priorityLabel, ...labels].filter(Boolean)));

  // Body: workflow name + description, truncated to GH limit.
  const bodyLines = [];
  if (workflow) bodyLines.push(`**Workflow:** ${workflow}`);
  if (bodyLines.length > 0) bodyLines.push('');
  bodyLines.push(description || '_no details provided_');
  let body = bodyLines.join('\n');
  if (body.length > MAX_BODY_LEN) body = body.slice(0, MAX_BODY_LEN - 30) + '\n\n...(truncated)';

  if (existing) {
    // Post a comment instead of opening a duplicate.
    try {
      gh([
        'issue', 'comment', String(existing.number),
        '--body', `🔁 Recurrence on workflow run.\n\n${body}`,
        ...repoFlag(),
      ]);
      console.log(`[github-issue-creator] Commented on existing #${existing.number} — ${existing.title}`);
      return { number: existing.number, title: existing.title, url: existing.url };
    } catch (err) {
      console.error(`[github-issue-creator] Failed to comment on #${existing.number}: ${err.message}`);
      return existing;
    }
  }

  // No OPEN duplicate. For transient reporters, check whether the SAME canonical
  // issue was recently closed (e.g. auto-closed on a green deploy) and is now
  // flapping red again. Reopen + comment instead of minting a new issue — this
  // is what stops the per-deploy-run churn (#928/#931/#937/#941) from recurring.
  if (reopenWithinHours > 0) {
    const recentlyClosed = findRecentlyClosedIssueByTitlePrefix(titlePrefix, reopenWithinHours);
    if (recentlyClosed) {
      const reopened = gh(
        ['issue', 'reopen', String(recentlyClosed.number), ...repoFlag()],
        { allowFailure: true },
      );
      if (reopened !== null) {
        gh([
          'issue', 'comment', String(recentlyClosed.number),
          '--body', `🔁 Reopened — same failure recurred within ${reopenWithinHours}h of being closed.\n\n${body}`,
          ...repoFlag(),
        ], { allowFailure: true });
        console.log(`[github-issue-creator] Reopened #${recentlyClosed.number} — ${recentlyClosed.title}`);
        return { number: recentlyClosed.number, title: recentlyClosed.title, url: recentlyClosed.url };
      }
      // Reopen failed (e.g. closed-as-duplicate locked) → fall through to create.
      console.error(`[github-issue-creator] Could not reopen #${recentlyClosed.number}; creating fresh issue.`);
    }
  }

  // Create labels if missing, then open the issue.
  ensureLabelsExist(labelSet);
  const args = [
    'issue', 'create',
    '--title', title.slice(0, 200),
    '--body', body,
    ...labelSet.flatMap((l) => ['--label', l]),
    ...repoFlag(),
  ];
  try {
    const url = gh(args).split('\n').pop().trim();
    console.log(`[github-issue-creator] Created: ${url}`);
    // Parse issue number from URL for return value
    const m = url.match(/\/issues\/(\d+)/);
    return { number: m ? Number(m[1]) : null, title, url };
  } catch (err) {
    // Why: this helper runs in `if: failure()` reporter steps. If posting to
    // GH fails (missing GH_TOKEN, API outage, perms), we must NOT lose the
    // diagnostics — dump them so the workflow log preserves the upstream
    // error context. Callers should still treat this as best-effort (CLI
    // mode exits 0 below).
    console.error(`[github-issue-creator] Failed to create issue: ${err.message}`);
    console.error('[github-issue-creator] --- begin issue body fallback ---');
    console.error(`Title: ${title}`);
    if (workflow) console.error(`Workflow: ${workflow}`);
    console.error(body);
    console.error('[github-issue-creator] --- end issue body fallback ---');
    return null;
  }
}

// CLI mode — mirrors github-issue-creator.mjs flag set so workflow scripts
// only need to swap the .mjs filename in the path.
if (process.argv[1]?.endsWith('github-issue-creator.mjs')) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const collect = (flag) => {
    const values = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) values.push(args[i + 1]);
    }
    return values;
  };

  const title = get('--title');
  if (!title) {
    console.error('Usage: node github-issue-creator.mjs --title "..." [--description "..."] [--priority N] [--label Bug] [--workflow "Update Coop"] [--reopen-within-hours N]');
    process.exit(1);
  }

  createGithubIssue({
    title,
    description: get('--description') || '',
    priority: Number(get('--priority') || 3),
    labels: (() => {
      const single = get('--label');
      const many = collect('--label');
      return many.length > 0 ? many : (single ? [single] : ['bug']);
    })(),
    workflow: get('--workflow'),
    reopenWithinHours: Number(get('--reopen-within-hours') || 0),
  }).then(() => {
    // Why: this CLI is a best-effort reporter invoked from `if: failure()`
    // steps after the real failure has already been recorded. Exiting non-zero
    // here would add a second red step and risk hiding the upstream cause —
    // the body fallback above keeps the diagnostics in the workflow log.
    process.exit(0);
  }).catch((err) => {
    console.error(`[github-issue-creator] Error: ${err.message}`);
    process.exit(0);
  });
}

