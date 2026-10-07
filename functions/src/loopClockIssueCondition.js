/**
 * Pure issue-shape helpers shared by the loop-clock dispatcher and watchdog.
 *
 * GitHub's Search API is eventually consistent for label changes. The clock
 * therefore reads the current repository issue listing and applies the
 * `agent:triaged` filter locally; these helpers keep both consumers on the
 * same conservative predicate.
 */

export const LOOP_CLOCK_ISSUES_PAGE_SIZE = 100;
export const LOOP_CLOCK_ISSUES_MAX_PAGES = 100;

function labelName(label) {
  if (typeof label === 'string') return label;
  return typeof label?.name === 'string' ? label.name : '';
}

/**
 * Pull requests are returned by GitHub's `/issues` endpoint too. They are not
 * triage work, while an issue with unreadable labels must remain actionable.
 */
export function isUntriagedIssue(issue) {
  if (!issue || typeof issue !== 'object' || issue.pull_request) return false;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return !labels.some((label) => labelName(label) === 'agent:triaged');
}

/**
 * Summarize the repository listing without trusting Search API counters or
 * result ordering. `created_at` is the REST shape; `createdAt` keeps this
 * helper usable with the equivalent `gh --json` shape in tests/tools.
 */
export function summarizeUntriagedIssues(issues) {
  let count = 0;
  let oldestCreatedAt = null;
  let oldestTimestamp = Infinity;

  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!isUntriagedIssue(issue)) continue;
    count += 1;
    const timestamp = Date.parse(issue.created_at ?? issue.createdAt ?? '');
    if (Number.isFinite(timestamp) && timestamp < oldestTimestamp) {
      oldestTimestamp = timestamp;
      oldestCreatedAt = new Date(timestamp).toISOString();
    }
  }

  return { count, oldestCreatedAt };
}
