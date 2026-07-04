/**
 * error-issue-sync.mjs — shared "top-N recurring error → GitHub backlog
 * issue" sync, used by every user-facing error source (GA4 app_error,
 * PostHog $exception, Cloudflare zone-wide 5xx).
 *
 * Extracted per AGENTS.md #6 (no literal duplication of the same construct
 * across sibling scripts) so scripts/app-error-issue-sync.mjs,
 * scripts/posthog-error-issue-sync.mjs and scripts/cf-5xx-issue-sync.mjs
 * share one create/dedupe loop instead of three copy-pasted ones.
 *
 * Relies on scripts/lib/github-issue-creator.mjs for the actual dedup
 * (stable title prefix match against OPEN issues → comment instead of
 * duplicate).
 */

import { createGithubIssue } from './github-issue-creator.mjs';

/**
 * @param {object} opts
 * @param {Array<object>} opts.entries    Already-sorted (desc by relevance) list of error entries.
 * @param {number} [opts.maxIssues]       Cap on how many issues to open/touch per run (avoids backlog flooding).
 * @param {(entry:object)=>string} opts.titleFor   Stable issue title (first ~60 chars must be a unique discriminator).
 * @param {(entry:object)=>string} opts.bodyFor    Issue body markdown.
 * @param {(entry:object)=>number} [opts.priorityFor]  1-4 scale, 3=medium default.
 * @param {string[]} [opts.labels]        Extra labels beyond the priority label.
 * @param {string} [opts.source]          Human label for the "Workflow:" line in the issue body.
 * @returns {Promise<Array<object|null>>}
 */
export async function syncErrorIssues({
  entries,
  maxIssues = 5,
  titleFor,
  bodyFor,
  priorityFor,
  labels = [],
  source,
}) {
  const results = [];
  for (const entry of entries.slice(0, maxIssues)) {
    const title = titleFor(entry);
    if (!title) continue;
    const priority = priorityFor ? priorityFor(entry) : 3;
    // eslint-disable-next-line no-await-in-loop -- sequential to stay under gh API rate limits
    const res = await createGithubIssue({
      title,
      description: bodyFor(entry),
      priority,
      labels,
      workflow: source,
    });
    results.push(res);
  }
  return results;
}
