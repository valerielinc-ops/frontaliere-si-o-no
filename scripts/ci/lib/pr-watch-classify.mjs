/**
 * pr-watch-classify.mjs — pure verdict for one watched PR: has it reached a
 * state where a session may stop, or must the watch stay open?
 *
 * The review that matters is the one submitted against the CURRENT head
 * commit, never just "the latest review" — a stale review from before a fix
 * commit must not read as today's verdict (that exact confusion is why
 * #6318's real 🔴 Important finding went unnoticed for two hours on
 * 2026-08-24: the session checked once, saw green CI, and never looked at
 * the review that had already landed).
 */

/**
 * @param {object} args
 * @param {string} args.state PR state from `gh pr view --json state`: OPEN/MERGED/CLOSED
 * @param {string} args.headSha current HEAD commit of the PR
 * @param {Array<{commit_id:string, user:{login:string}, body:string}>} args.reviews
 *   from `gh api repos/<owner>/<repo>/pulls/<n>/reviews`
 * @returns {{status:'merged'|'closed'|'lgtm'|'not-lgtm'|'awaiting-review', detail:string}}
 */
export function classifyPr({ state, headSha, reviews }) {
  if (state === 'MERGED') return { status: 'merged', detail: 'PR mergiata' };
  if (state === 'CLOSED') return { status: 'closed', detail: 'PR chiusa senza merge' };

  const onHead = (reviews || []).filter(
    (r) => r.commit_id === headSha && r.user?.login === 'claude[bot]',
  );
  const latest = onHead[onHead.length - 1];

  if (!latest) {
    return {
      status: 'awaiting-review',
      detail: `nessuna review di claude[bot] sull'ultimo commit (${String(headSha).slice(0, 8)})`,
    };
  }
  if (/##\s*LGTM/.test(latest.body || '')) {
    return { status: 'lgtm', detail: 'review LGTM sull\'ultimo commit — pronta per l\'auto-merge' };
  }
  return {
    status: 'not-lgtm',
    detail: 'la review sull\'ultimo commit non e\' LGTM (verosimilmente un finding non affrontato)',
  };
}

/** Statuses that mean the watch entry can be dropped and the session may stop for it. */
export const RESOLVED_STATUSES = new Set(['merged', 'closed', 'lgtm']);
