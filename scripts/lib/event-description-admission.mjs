export const EVENT_DESCRIPTION_REWRITE_BRANCH = 'chore/event-description-rewrite';

function sameBranchPullRequest(pr) {
  return pr?.state === undefined || String(pr.state).toLowerCase() === 'open';
}

export function assessEventDescriptionRewriteAdmission({
  currentRunId = '',
  runs = [],
  dataPullRequests = [],
  branch = EVENT_DESCRIPTION_REWRITE_BRANCH,
} = {}) {
  const active = (Array.isArray(runs) ? runs : []).find((run) => (
    String(run?.databaseId ?? run?.id ?? '') !== String(currentRunId)
      && ['queued', 'in_progress', 'requested', 'waiting'].includes(String(run?.status || '').toLowerCase())
  ));
  if (active) {
    return {
      admitted: false,
      reason: 'run-in-flight',
      detail: String(active.databaseId ?? active.id ?? 'unknown'),
    };
  }

  const dataPr = (Array.isArray(dataPullRequests) ? dataPullRequests : []).find((pr) => (
    sameBranchPullRequest(pr)
      && String(pr?.headRefName || pr?.head?.ref || '') === branch
      && String(pr?.baseRefName || pr?.base?.ref || 'main') === 'main'
  ));
  if (dataPr) {
    return {
      admitted: false,
      reason: 'data-pr-open',
      detail: String(dataPr.number ?? dataPr.id ?? 'unknown'),
    };
  }

  return { admitted: true, reason: 'admitted', detail: '' };
}
