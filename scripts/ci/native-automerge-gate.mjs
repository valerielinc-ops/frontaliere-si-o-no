/**
 * Native auto-merge guard.
 *
 * GitHub's native auto-merge remains the merger. This helper is only the
 * fail-closed opt-in gate: it must see the latest approving reviewer-bot
 * verdict and a completed required Vitest check on the current HEAD before
 * calling `gh pr merge --auto`. The required check is the complete `tests`
 * job, so its green result is the authority for the review gate's validated
 * LGTM carry-forward when the review commit is older than the current HEAD.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isReviewerBot,
  REDFLAG_IMPORTANT_RE,
  VITEST_CHECK_NAME,
} from './lib/constants.mjs';

const NIT_MARKER_RE = /^[^\n🔴🟢]*(?<!`)🟡\s*\*{0,2}\s*Nit\s*\*{0,2}\s*[:—-]/mu;
const FINDINGS_HEADING_RE = /^\s{0,3}#{1,3}\s+Findings\b[^\n]*$/i;
const LGTM_HEADING_RE = /^\s{0,3}##\s+LGTM\s*$/m;

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function reviewTimestamp(review) {
  const timestamps = [
    review?.edited_at,
    review?.editedAt,
    review?.event_at,
    review?.eventAt,
    review?.updated_at,
    review?.updatedAt,
    review?.submitted_at,
    review?.submittedAt,
    review?.created_at,
    review?.createdAt,
  ]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function latestBotReviewMatching(reviews, predicate) {
  if (!Array.isArray(reviews) || typeof predicate !== 'function') return null;
  const candidates = flattenPages(reviews)
    .map((review, index) => ({ review, index, timestamp: reviewTimestamp(review) }))
    .filter(({ review, timestamp }) => isReviewerBot(review?.user) && predicate(review)
      && timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp
      || (Number(left.review.id || left.index) || left.index)
        - (Number(right.review.id || right.index) || right.index));
  return candidates.at(-1)?.review || null;
}

/** Return the latest reviewer-bot review, regardless of the commit it names. */
export function latestBotReview(reviews) {
  if (!Array.isArray(reviews)) return null;
  return latestBotReviewMatching(reviews, () => true);
}

/** Return the latest reviewer-bot review that is anchored to `head`. */
export function latestBotReviewOnHead(reviews, head) {
  if (typeof head !== 'string' || !head) return null;
  return latestBotReviewMatching(reviews, (review) => review?.commit_id === head);
}

/** Require the explicit reviewer summary, rather than inferring zero findings. */
export function reviewHasZeroFindings(body) {
  if (typeof body !== 'string') return false;
  const findingsHeading = body.split(/\r?\n/).find((line) => FINDINGS_HEADING_RE.test(line));
  if (!findingsHeading) return false;
  return /\bImportant\s*:\s*0\b/i.test(findingsHeading)
    && /\bNit\s*:\s*0\b/i.test(findingsHeading)
    && !REDFLAG_IMPORTANT_RE.test(body)
    && !NIT_MARKER_RE.test(body);
}

export function reviewHasLgtm(body) {
  return typeof body === 'string' && LGTM_HEADING_RE.test(body);
}

export function reviewIsApproved(review) {
  if (!review || !/^[0-9a-f]{40}$/i.test(String(review.commit_id || ''))) return false;
  if (!isReviewerBot(review.user)) return false;
  if (!['APPROVED', 'COMMENTED'].includes(String(review.state || '').toUpperCase())) return false;
  return reviewHasZeroFindings(review.body) && reviewHasLgtm(review.body);
}

export function reviewIsApprovedOnHead(review, head) {
  if (!review || review.commit_id !== head) return false;
  return reviewIsApproved(review);
}

/** Select the newest completed required check; an active run always blocks. */
export function requiredVitestDecision(checkRuns, head) {
  if (!Array.isArray(checkRuns) || typeof head !== 'string' || !head) {
    return { allow: false, reason: 'check-runs non verificabili' };
  }
  const runs = checkRuns.filter((check) => check?.name === VITEST_CHECK_NAME && check.head_sha === head);
  if (runs.length === 0) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} assente sulla HEAD` };
  }
  if (runs.some((check) => check.status !== 'completed')) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} pending sulla HEAD` };
  }
  if (runs.some((check) => !check.conclusion || !Number.isFinite(Date.parse(check.completed_at || '')))) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} senza verdetto completato` };
  }
  const latest = [...runs].sort(
    (left, right) => Date.parse(left.completed_at) - Date.parse(right.completed_at),
  ).at(-1);
  if (latest.conclusion !== 'success') {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} conclusion=${latest.conclusion}` };
  }
  return { allow: true, reason: `${VITEST_CHECK_NAME} success sulla HEAD` };
}

/** Pure decision function used by the workflow and deterministic tests. */
export function evaluateNativeAutoMerge({ pr, reviews, checkRuns } = {}) {
  if (!pr || pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return { allow: false, reason: 'PR non aperta, draft o non basata su main' };
  }
  if (typeof pr.headRefOid !== 'string' || !pr.headRefOid) {
    return { allow: false, reason: 'HEAD SHA mancante' };
  }
  if (!Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, reason: 'stato auto-merge non verificabile' };
  }
  if (pr.autoMergeRequest !== null) {
    return { allow: false, reason: 'native auto-merge già abilitato' };
  }

  // The required check is the complete `tests` job. Its review gate already
  // applies the repository's fingerprint-based carry-forward policy, so the
  // native helper must not reject a valid older LGTM merely because the PR
  // received a data-only or otherwise review-preserving commit afterward.
  const review = latestBotReview(reviews);
  if (!review) {
    return { allow: false, reason: 'nessuna review bot verificabile' };
  }
  if (!reviewIsApproved(review)) {
    return { allow: false, reason: 'ultima review bot non è Important 0/Nit 0 + LGTM' };
  }

  const check = requiredVitestDecision(checkRuns, pr.headRefOid);
  if (!check.allow) return check;
  const reviewScope = review.commit_id === pr.headRefOid
    ? 'review exact-head'
    : 'LGTM carry-forward verificato dal check required';
  return {
    allow: true,
    reason: `${reviewScope} ✔; ${check.reason}`,
    reviewId: review.id,
  };
}

/**
 * Revalidate the current review/check pair even when GitHub already has an
 * auto-merge request. Native auto-merge survives `synchronize`, so the
 * persisted opt-in is not evidence that the new HEAD was reviewed or tested.
 *
 * `action` is deliberately explicit for the side-effecting CLI:
 *   - `enable`: no request exists and the review/check gate passed;
 *   - `retain`: a request exists and the review/check gate passed again;
 *   - `revoke`: a request exists but the fresh gate failed;
 *   - `skip`: no request exists and the gate is not yet satisfied.
 */
export function revalidateNativeAutoMerge({ pr, reviews, checkRuns } = {}) {
  if (!pr || !Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, action: 'skip', reason: 'stato auto-merge non verificabile' };
  }
  const decision = evaluateNativeAutoMerge({
    pr: { ...pr, autoMergeRequest: null },
    reviews,
    checkRuns,
  });
  if (pr.autoMergeRequest !== null) {
    return {
      ...decision,
      action: decision.allow ? 'retain' : 'revoke',
    };
  }
  return {
    ...decision,
    action: decision.allow ? 'enable' : 'skip',
  };
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  }));
}

const REVIEW_METADATA_QUERY = [
  'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){',
  'repository(owner:$owner,name:$name){pullRequest(number:$number){',
  'reviews(first:100,after:$endCursor){nodes{',
  'id databaseId createdAt submittedAt updatedAt',
  '}pageInfo{hasNextPage endCursor}}}}}',
].join('');

function loadReviewMetadata(repo, pr) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error('repository non valido per la metadata review');
  const pages = ghJson([
    'api', 'graphql', '--paginate', '--slurp',
    '-f', `query=${REVIEW_METADATA_QUERY}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${pr}`,
  ]);
  return flattenPages(pages)
    .flatMap((page) => page?.data?.repository?.pullRequest?.reviews?.nodes || []);
}

function loadReviews(repo, pr) {
  const reviews = flattenPages(ghJson([
    'api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp',
  ]));
  const metadataById = new Map();
  for (const metadata of loadReviewMetadata(repo, pr)) {
    if (metadata?.databaseId !== null && metadata?.databaseId !== undefined) {
      metadataById.set(String(metadata.databaseId), metadata);
    }
    if (metadata?.id) metadataById.set(String(metadata.id), metadata);
  }
  return reviews.map((review) => {
    const metadata = metadataById.get(String(review?.id))
      || metadataById.get(String(review?.node_id));
    if (!metadata) {
      throw new Error(`metadata temporale mancante per review ${review?.id || 'sconosciuta'}`);
    }
    return {
      ...review,
      created_at: metadata.createdAt || review.created_at,
      submitted_at: metadata.submittedAt || review.submitted_at,
      updated_at: metadata.updatedAt || review.updated_at,
    };
  });
}

function loadCheckRuns(repo, head) {
  const pages = ghJson([
    'api', `repos/${repo}/commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp',
  ]);
  return (Array.isArray(pages) ? pages : [pages])
    .flatMap((page) => Array.isArray(page?.check_runs) ? page.check_runs : []);
}

const DISABLE_AUTO_MERGE_MUTATION =
  'mutation($pullRequestId:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId}){pullRequest{number autoMergeRequest{enabledAt}}}}';

function disableNativeAutoMerge(repo, pr) {
  if (!pr?.id) throw new Error('node ID della PR mancante');
  const response = ghJson([
    'api', 'graphql',
    '-f', `query=${DISABLE_AUTO_MERGE_MUTATION}`,
    '-F', `pullRequestId=${pr.id}`,
  ]);
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error(response.errors.map((error) => error.message || String(error)).join('; '));
  }
  const request = response?.data?.disablePullRequestAutoMerge?.pullRequest;
  if (!request || request.autoMergeRequest !== null) {
    throw new Error('GitHub non ha confermato la revoca dell’auto-merge');
  }
}

function revokeExistingAutoMerge(repo, pr, reason) {
  try {
    disableNativeAutoMerge(repo, pr);
    console.log(`Native auto-merge guard: opt-in revocato per PR #${pr.number} — ${reason}`);
  } catch (error) {
    console.error(`::error::native auto-merge guard: revoca opt-in fallita per PR #${pr.number}: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}

function skip(reason) {
  console.log(`Native auto-merge guard: ${reason} — nessun merge.`);
}

/** Bind the native opt-in to the exact HEAD that passed the gate. */
export function nativeAutoMergeArgs({ repo, prNumber, headSha } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(headSha || '')) {
    throw new Error('HEAD SHA verificato mancante o non valido');
  }
  return [
    'pr', 'merge', prNumber, '--repo', repo, '--auto', '--squash', '--delete-branch',
    '--match-head-commit', headSha,
  ];
}

/** GitHub returns this when a concurrent guard already enabled the request. */
export function isAlreadyInProgressOutput(value) {
  return /merge already in progress/i.test(String(value || ''));
}

function capturedErrorOutput(error) {
  return [error?.stderr, error?.stdout]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''))
    .filter(Boolean)
    .join('\n');
}

/** Confirm that a concurrent opt-in achieved the intended state before going green. */
function concurrentOptInSucceeded(repo, prNumber, expectedHead) {
  try {
    const observed = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'state,headRefOid,autoMergeRequest']);
    if (observed.state === 'MERGED') return true;
    return observed.state === 'OPEN'
      && observed.headRefOid === expectedHead
      && observed.autoMergeRequest !== null;
  } catch {
    return false;
  }
}

function main() {
  const repo = process.argv[2] || process.env.REPOSITORY || process.env.GITHUB_REPOSITORY || '';
  const prNumber = process.argv[3] || process.env.PR_NUMBER || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(prNumber)) {
    return skip('target PR mancante o non valido');
  }

  let pr;
  try {
    pr = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: impossibile leggere PR #${prNumber}: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return skip('PR non aperta, draft o non basata su main');
  }
  const hadAutoMerge = pr.autoMergeRequest !== null;

  let reviews;
  let checkRuns;
  try {
    reviews = loadReviews(repo, prNumber);
    checkRuns = loadCheckRuns(repo, pr.headRefOid);
  } catch (error) {
    if (hadAutoMerge) {
      revokeExistingAutoMerge(repo, pr, 'review/check non leggibili');
      return;
    }
    console.error(`::error::native auto-merge guard: lettura review/check fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  const decision = revalidateNativeAutoMerge({ pr, reviews, checkRuns });
  console.log(`Native auto-merge guard PR #${prNumber} HEAD=${pr.headRefOid}: ${decision.reason}`);
  if (decision.action === 'revoke') {
    revokeExistingAutoMerge(repo, pr, `fresh gate fallito: ${decision.reason}`);
    return;
  }
  if (!decision.allow) return;

  // Close the head race between the reads and the native opt-in. A new HEAD
  // invalidates the review/check snapshot and must be re-evaluated.
  let current;
  try {
    current = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: conferma HEAD fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  const currentStateChanged = current.state !== 'OPEN'
    || current.isDraft !== false
    || current.baseRefName !== 'main'
    || current.headRefOid !== pr.headRefOid;
  if (currentStateChanged) {
    if (current.state === 'OPEN' && current.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, current, 'HEAD o stato cambiato dopo il gate');
    }
    return skip('HEAD/stato cambiato dopo i gate; serve una nuova valutazione review/check');
  }

  // Review and checks can change without a HEAD change. Re-read them after
  // confirming the HEAD and immediately before the native opt-in; the first
  // snapshot is not enough to authorize the opt-in.
  let finalReviews;
  let finalCheckRuns;
  try {
    finalReviews = loadReviews(repo, prNumber);
    finalCheckRuns = loadCheckRuns(repo, current.headRefOid);
  } catch (error) {
    if (current.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, current, 'review/check non leggibili prima dell’opt-in');
      return;
    }
    console.error(`::error::native auto-merge guard: rilettura review/check fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  const finalDecision = revalidateNativeAutoMerge({
    pr: current,
    reviews: finalReviews,
    checkRuns: finalCheckRuns,
  });
  console.log(`Native auto-merge guard PR #${prNumber} final gate: ${finalDecision.reason}`);
  if (finalDecision.action === 'revoke') {
    revokeExistingAutoMerge(repo, current, `fresh gate finale fallito: ${finalDecision.reason}`);
    return;
  }
  if (!finalDecision.allow) {
    return skip('review/check cambiati o non più validi prima dell’opt-in; nessun merge.');
  }
  if (current.autoMergeRequest !== null) {
    return skip('native auto-merge già abilitato e rivalidato sulla HEAD corrente');
  }

  try {
    const output = execFileSync('gh', nativeAutoMergeArgs({ repo, prNumber, headSha: pr.headRefOid }), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (output) process.stdout.write(output);
  } catch (error) {
    const details = capturedErrorOutput(error);
    if (isAlreadyInProgressOutput(details)
      && concurrentOptInSucceeded(repo, prNumber, pr.headRefOid)) {
      console.log(`Native auto-merge guard: opt-in concorrente confermato per PR #${prNumber} sulla HEAD corrente`);
      return;
    }
    console.error(`::error::native auto-merge opt-in fallito: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) main();
