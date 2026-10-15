/**
 * REST operation used when a label removal must be attributable to this run.
 * `gh issue edit --remove-label` is idempotent and exits successfully for a
 * no-op, while the REST DELETE returns 404 when another actor removed the
 * label first.
 */

export function issueLabelDeleteArgs({ issue, label, repo = '' } = {}) {
  const repository = String(repo || '').trim() || '{owner}/{repo}';
  return [
    'api',
    `repos/${repository}/issues/${encodeURIComponent(String(issue))}/labels/${encodeURIComponent(String(label))}`,
    '--method',
    'DELETE',
  ];
}

/**
 * The successful REST response is the remaining label list. Requiring the
 * parsed response (rather than only a zero exit status) keeps the marker
 * fail-closed if the command output is unavailable or malformed.
 */
export function labelDeleteResponseConfirms(raw, label) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const remaining = JSON.parse(raw);
    if (!Array.isArray(remaining)) return false;
    const wanted = String(label).toLowerCase();
    return !remaining.some((entry) => String(entry?.name ?? entry ?? '').toLowerCase() === wanted);
  } catch {
    return false;
  }
}
