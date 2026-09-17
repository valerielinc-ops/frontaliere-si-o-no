/**
 * Native auto-merge guard.
 *
 * GitHub's native auto-merge remains the merger. This helper is only the
 * fail-closed opt-in gate: it must see the latest approving
 * Claude/frontaliere reviewer-bot verdict (or an explicitly marked Codex
 * fallback with structured review-gate evidence) and a completed required
 * Vitest check on the current HEAD before calling `gh pr merge --auto`. The
 * required check is the complete `tests` job. Both the check and the review
 * must name the exact current HEAD; an older verdict is never carried forward.
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
import {
  findTestOnlyApproval,
  TEST_REVIEW_MARKER,
} from './review-test-policy.mjs';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';
import {
  classifyAutomationRisk,
  findSeparateHumanApproval,
} from './lib/automation-risk-policy.mjs';
import { REVIEW_GATE_STEP_NAME } from './lib/vitestCheck.mjs';

const TESTS_WORKFLOW_PATH = '.github/workflows/tests.yml';
const TESTS_WORKFLOW_EVENT = 'pull_request';
const FINDINGS_HEADING_RE = /^\s{0,3}#{1,3}\s+Findings\b[^\n]*$/i;
const LGTM_HEADING_RE = /^\s{0,3}##\s+LGTM\s*$/m;
const TEST_ONLY_REVIEW_BOT_RE = /^(?:github-actions|frontaliere-automation)\[bot\]$/i;
const CODEX_FALLBACK_REVIEWER_RE = /^github-actions\[bot\]$/i;
const CODEX_FALLBACK_REVIEW_MARKER = '<!-- CODEX_FALLBACK_REVIEW -->';
const MAX_TRANSIENT_GH_READ_ATTEMPTS = 3;
const TRANSIENT_GH_READ_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const TRANSIENT_GH_READ_ERROR_RE = /(?:\bHTTP\s+5\d{2}\b|\b5\d{2}\s+(?:bad gateway|service unavailable|gateway timeout)\b|service unavailable|bad gateway|gateway timeout|timed?\s*out|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/iu;

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

function latestReviewMatching(reviews, predicate) {
  if (!Array.isArray(reviews) || typeof predicate !== 'function') return null;
  const candidates = flattenPages(reviews)
    .map((review, index) => ({ review, index, timestamp: reviewTimestamp(review) }))
    .filter(({ review, timestamp }) => predicate(review)
      && timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp
      || (Number(left.review.id || left.index) || left.index)
        - (Number(right.review.id || right.index) || right.index));
  return candidates.at(-1)?.review || null;
}

function latestBotReviewMatching(reviews, predicate) {
  if (typeof predicate !== 'function') return null;
  return latestReviewMatching(reviews, (review) => isReviewerBot(review?.user)
    && predicate(review));
}

/**
 * The Codex fallback is not a raw reviewer. It may enter only the structured
 * review-gate evidence path, with the exact marker emitted by `tests.yml` and
 * an exact current HEAD. Keep this identity narrower than the normal
 * Claude/frontaliere reviewer allowlist.
 */
function isCodexFallbackReviewOnHead(review, head) {
  return typeof head === 'string'
    && /^[0-9a-f]{40}$/iu.test(head)
    && review?.user?.type === 'Bot'
    && CODEX_FALLBACK_REVIEWER_RE.test(review.user.login || '')
    && review.commit_id === head
    && String(review.body || '').includes(CODEX_FALLBACK_REVIEW_MARKER);
}

/** Select a normal reviewer or the explicitly marked Codex evidence candidate. */
function latestReviewGateCandidate(reviews, head) {
  return latestReviewMatching(reviews, (review) => isCodexFallbackReviewOnHead(review, head)
    || (isReviewerBot(review?.user) && review?.commit_id === head));
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

/**
 * Require the explicit reviewer summary with zero blocking findings.
 *
 * `🟡 Nit` is advisory per REVIEW.md and may therefore coexist with `## LGTM`.
 * The native gate must agree with the review gate in `tests.yml`: only an
 * actual `🔴 Important` keeps the merge out, not a non-blocking nit.
 */
export function reviewHasZeroFindings(body) {
  if (typeof body !== 'string') return false;
  const findingsHeading = body.split(/\r?\n/).find((line) => FINDINGS_HEADING_RE.test(line));
  if (!findingsHeading) return false;
  return /\bImportant\s*:\s*0\b/i.test(findingsHeading)
    && !REDFLAG_IMPORTANT_RE.test(body);
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

/**
 * Tests-only is a separate, narrower approval class. `github-actions[bot]`
 * must never become a general reviewer identity: this branch is accepted only
 * for the exact marker emitted by `review-test-policy.mjs`, with a clean
 * structured verdict pinned to the current HEAD. The caller still has to pass
 * the result of `findTestOnlyApproval`, which independently re-checks the
 * complete PR file list before this pure decision function is called.
 */
function testOnlyReviewIsApproved(review, head) {
  if (!review || review.commit_id !== head) return false;
  if (review.user?.type !== 'Bot' || !TEST_ONLY_REVIEW_BOT_RE.test(review.user.login || '')) {
    return false;
  }
  if (!String(review.body || '').includes(TEST_REVIEW_MARKER)) return false;
  if (!['COMMENTED', 'APPROVED'].includes(String(review.state || '').toUpperCase())) return false;
  return reviewHasZeroFindings(review.body) && reviewHasLgtm(review.body);
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

function latestRequiredVitestCheck(checkRuns, head) {
  const runs = checkRuns.filter((check) => check?.name === VITEST_CHECK_NAME && check.head_sha === head);
  return [...runs].sort(
    (left, right) => Date.parse(left.completed_at || '') - Date.parse(right.completed_at || ''),
  ).at(-1) || null;
}

function validTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function reviewIdKey(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

/** Parse the only URL shape from which this gate may discover its job. */
export function parseActionsJobUrl(value, repo) {
  if (typeof value !== 'string' || typeof repo !== 'string' || !repo) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  const match = url.pathname.match(
    /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)\/?$/u,
  );
  if (!match || match[1] !== repo) return null;
  const runId = Number(match[2]);
  const jobId = Number(match[3]);
  if (!validPositiveInteger(runId) || !validPositiveInteger(jobId)) return null;
  return { runId, jobId };
}

function parseActionsCheckRunUrl(value, repo) {
  if (typeof value !== 'string' || typeof repo !== 'string' || !repo) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') return null;
  const match = url.pathname.match(
    /^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)\/?$/u,
  );
  if (!match || match[1] !== repo) return null;
  const checkRunId = Number(match[2]);
  return validPositiveInteger(checkRunId) ? checkRunId : null;
}

/**
 * Verify the structured proof used only for the outside-diff exception.
 * Every layer is required: a green check or a green step alone is not proof.
 * The review identity is also checked here so an ordinary Actions review
 * cannot reach this exception without the exact Codex fallback marker.
 */
export function reviewGateEvidenceDecision({
  evidence,
  repo,
  head,
  review,
} = {}) {
  const deny = (reason) => ({ allow: false, reason });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return deny('prova review-gate strutturata assente');
  }
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/iu.test(head)) {
    return deny('HEAD non verificabile per la prova review-gate');
  }
  if (!isReviewerBot(review?.user) && !isCodexFallbackReviewOnHead(review, head)) {
    return deny('identità review non autorizzata per la prova review-gate');
  }
  const reviewId = reviewIdKey(review?.id);
  if (!reviewId || evidence.reviewId !== reviewId) {
    return deny('identità della review non verificabile nella prova review-gate');
  }
  if (!['COMMENTED', 'APPROVED'].includes(String(review.state || '').toUpperCase())) {
    return deny('stato della review non approvabile nella prova review-gate');
  }

  const check = evidence.check;
  const jobLocation = parseActionsJobUrl(check?.details_url, repo);
  if (!jobLocation
      || evidence.workflow?.id !== jobLocation.runId
      || evidence.job?.id !== jobLocation.jobId) {
    return deny('identità run/job del check non verificabile');
  }
  if (!check
      || !validPositiveInteger(check.id)
      || check.name !== VITEST_CHECK_NAME
      || check.head_sha !== head
      || check.status !== 'completed'
      || check.conclusion !== 'success'
      || validTimestamp(check.completed_at) === null) {
    return deny('check vitest della prova review-gate non verificabile');
  }

  const workflow = evidence.workflow;
  if (!workflow
      || !validPositiveInteger(workflow.id)
      || workflow.path !== TESTS_WORKFLOW_PATH
      || workflow.event !== TESTS_WORKFLOW_EVENT
      || workflow.status !== 'completed'
      || workflow.conclusion !== 'success'
      || workflow.head_sha !== head
      || validTimestamp(workflow.run_started_at) === null
      || validTimestamp(workflow.updated_at) === null) {
    return deny('workflow tests della prova review-gate non verificabile');
  }

  const job = evidence.job;
  const checkRunId = parseActionsCheckRunUrl(job?.check_run_url, repo);
  if (!job
      || !validPositiveInteger(job.id)
      || job.run_id !== workflow.id
      || job.name !== VITEST_CHECK_NAME
      || job.status !== 'completed'
      || job.conclusion !== 'success'
      || job.head_sha !== head
      || checkRunId !== check.id
      || validTimestamp(job.started_at) === null
      || validTimestamp(job.completed_at) === null
      || !Array.isArray(job.steps)) {
    return deny('job tests della prova review-gate non verificabile');
  }

  const steps = job.steps.filter((step) => step?.name === REVIEW_GATE_STEP_NAME);
  if (steps.length !== 1) return deny('step review-gate assente o ambiguo');
  const step = steps[0];
  const reviewAt = reviewTimestamp(review);
  const stepStartedAt = validTimestamp(step.started_at);
  const stepCompletedAt = validTimestamp(step.completed_at);
  const checkCompletedAt = validTimestamp(check.completed_at);
  const jobStartedAt = validTimestamp(job.started_at);
  const jobCompletedAt = validTimestamp(job.completed_at);
  const workflowStartedAt = validTimestamp(workflow.run_started_at);
  const workflowUpdatedAt = validTimestamp(workflow.updated_at);
  if (step.status !== 'completed'
      || step.conclusion !== 'success'
      || reviewAt === null
      || stepStartedAt === null
      || stepCompletedAt === null
      || checkCompletedAt === null
      || jobStartedAt === null
      || jobCompletedAt === null
      || workflowStartedAt === null
      || workflowUpdatedAt === null) {
    return deny('step review-gate senza un verdetto temporale completo');
  }
  if (!(reviewAt <= stepStartedAt
      && workflowStartedAt <= jobStartedAt
      && jobStartedAt <= stepStartedAt
      && stepStartedAt <= stepCompletedAt
      && stepCompletedAt <= jobCompletedAt
      && jobCompletedAt <= checkCompletedAt
      && checkCompletedAt <= workflowUpdatedAt)) {
    return deny('ordine temporale review-gate non verificabile');
  }

  return {
    allow: true,
    reason: 'step Require approving Codex review successivo alla review raw sulla stessa HEAD',
    runId: workflow.id,
    jobId: job.id,
    checkId: check.id,
    reviewId,
  };
}

/** Pure decision function used by the workflow and deterministic tests. */
export function evaluateNativeAutoMerge({
  pr,
  reviews,
  checkRuns,
  verifiedTestOnlyReview = null,
  reviewGateEvidence = null,
  repository = null,
  changedFiles,
  changedFilesComplete,
} = {}) {
  if (!pr || pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return { allow: false, reason: 'PR non aperta, draft o non basata su main' };
  }
  if (typeof pr.headRefOid !== 'string' || !pr.headRefOid) {
    return { allow: false, reason: 'HEAD SHA mancante' };
  }
  if (typeof pr.title !== 'string' || typeof pr.body !== 'string' || !Array.isArray(pr.labels)) {
    return {
      allow: false,
      reason: 'metadata PR (title/body/labels) non verificabili; deny fail-closed senza approvazione umana',
      humanApprovalRequired: false,
      humanApprovalVerified: false,
    };
  }
  if (!Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, reason: 'stato auto-merge non verificabile' };
  }

  const files = changedFiles !== undefined ? changedFiles : pr.changedFiles;
  const filesComplete = changedFilesComplete !== undefined
    ? changedFilesComplete
    : pr.changedFilesComplete;
  const risk = classifyAutomationRisk({
    title: pr.title,
    body: pr.body,
    labels: pr.labels,
    paths: files,
    pathsComplete: filesComplete,
    surface: 'pull-request',
  });
  if (!risk.verifiable) {
    return {
      allow: false,
      reason: `policy PR non verificabile: ${risk.reason}; deny fail-closed senza approvazione umana`,
      riskDomains: risk.domains,
      humanApprovalRequired: false,
      humanApprovalVerified: false,
    };
  }
  if (risk.needsHumanVeto) {
    const humanApproval = findSeparateHumanApproval(reviews, pr.headRefOid);
    return {
      allow: false,
      reason: `\`needs-human\` è un veto persistente: solo un umano può rimuoverlo dopo approvazione sulla HEAD${humanApproval ? ' e review umana verificata sulla HEAD' : ''}`,
      riskDomains: risk.domains,
      humanApprovalRequired: true,
      humanApprovalVerified: humanApproval !== null,
      humanApprovalReviewId: humanApproval?.id || null,
      needsHumanVeto: Boolean(risk.needsHumanVeto),
      riskDenyCode: risk.denyCode,
    };
  }
  if (pr.autoMergeRequest !== null) {
    return { allow: false, reason: 'native auto-merge già abilitato' };
  }

  // The required check is the complete `tests` job. Its review gate and this
  // native helper both require the exact current HEAD, so a completed check or
  // LGTM from an autorebase predecessor cannot unlock this commit.
  const review = latestReviewGateCandidate(reviews, pr.headRefOid);
  const testOnlyApproval = !review
    && testOnlyReviewIsApproved(verifiedTestOnlyReview, pr.headRefOid);
  if (!review && !testOnlyApproval) {
    return { allow: false, reason: 'nessuna review bot verificabile' };
  }
  const reviewGateException = review && !reviewIsApproved(review)
    ? reviewGateEvidenceDecision({
      evidence: reviewGateEvidence,
      repo: repository,
      head: pr.headRefOid,
      review,
    })
    : { allow: false, reason: 'review raw già approvante' };
  if (review && !reviewIsApproved(review) && !reviewGateException.allow) {
    return { allow: false, reason: 'ultima review bot non è Important 0 + LGTM senza 🔴 Important' };
  }

  const check = requiredVitestDecision(checkRuns, pr.headRefOid);
  if (!check.allow) return check;
  if (reviewGateException.allow) {
    const latestCheck = latestRequiredVitestCheck(checkRuns, pr.headRefOid);
    if (!latestCheck || latestCheck.id !== reviewGateException.checkId) {
      return { allow: false, reason: 'prova review-gate non legata al check vitest più recente' };
    }
  }
  const approval = review || verifiedTestOnlyReview;
  const reviewScope = testOnlyApproval
    ? 'tests-only review verificata sul current HEAD'
    : reviewGateException.allow
    ? 'review-gate outside-diff verificato sulla stessa HEAD'
    : 'review exact-head';
  return {
    allow: true,
    reason: `${reviewScope} ✔; ${check.reason}`,
    reviewId: approval.id,
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
export function revalidateNativeAutoMerge({
  pr,
  reviews,
  checkRuns,
  verifiedTestOnlyReview = null,
  reviewGateEvidence = null,
  repository = null,
  changedFiles,
  changedFilesComplete,
} = {}) {
  if (!pr || !Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, action: 'skip', reason: 'stato auto-merge non verificabile' };
  }
  const decision = evaluateNativeAutoMerge({
    pr: { ...pr, autoMergeRequest: null },
    reviews,
    checkRuns,
    verifiedTestOnlyReview,
    reviewGateEvidence,
    repository,
    changedFiles,
    changedFilesComplete,
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
  return JSON.parse(withTransientGithubReadRetry(() => ghRaw(args)));
}

function ghRaw(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
}

function sleepForTransientReadRetry(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, delayMs);
}

function transientGithubErrorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .map((value) => String(value || ''))
    .filter(Boolean)
    .join('\n');
}

export function isTransientGithubReadError(error) {
  return TRANSIENT_GH_READ_ERROR_RE.test(transientGithubErrorText(error));
}

/** Retry only idempotent GitHub reads; mutations remain single-attempt and fail closed. */
export function withTransientGithubReadRetry(operation, {
  attemptLimit = MAX_TRANSIENT_GH_READ_ATTEMPTS,
  delaysMs = TRANSIENT_GH_READ_RETRY_DELAYS_MS,
  sleep = sleepForTransientReadRetry,
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('read retry operation must be a function');
  const attempts = Number.isSafeInteger(attemptLimit) && attemptLimit > 0
    ? attemptLimit
    : MAX_TRANSIENT_GH_READ_ATTEMPTS;
  const delays = Array.isArray(delaysMs) ? delaysMs : TRANSIENT_GH_READ_RETRY_DELAYS_MS;
  const wait = typeof sleep === 'function' ? sleep : sleepForTransientReadRetry;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (attempt + 1 >= attempts || !isTransientGithubReadError(error)) throw error;
      const delayMs = Number(delays[attempt]);
      if (Number.isFinite(delayMs) && delayMs > 0) wait(delayMs);
    }
  }
  throw new Error('read retry exhausted without an attempt');
}

function ghJsonOnce(args) {
  return JSON.parse(ghRaw(args));
}

// `review-test-policy` needs both parsed GitHub responses and raw newline
// output for the paginated REST file list. Keep this adapter local so the
// native gate remains fail-closed without changing the shared gh helper.
function ghForTestOnlyReviewOnce(args, options = {}) {
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  return options.json === false ? output : JSON.parse(output);
}

function ghForTestOnlyReview(args, options = {}) {
  return withTransientGithubReadRetry(() => ghForTestOnlyReviewOnce(args, options));
}

function loadVerifiedTestOnlyReview(repo, pr, head, reviews) {
  return findTestOnlyApproval(reviews, head, {
    ghFn: ghForTestOnlyReview,
    repo,
    pr,
  });
}

function loadChangedFiles(repo, pr) {
  const snapshot = fetchPrFiles(pr, ghForTestOnlyReview, repo);
  if (!snapshot.complete) {
    throw new Error(`elenco file PR non completo (${snapshot.reason})`);
  }
  return snapshot;
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

function loadReviewGateEvidence(repo, head, checkRuns, review) {
  if (!review || reviewIsApproved(review)) return null;
  const checkDecision = requiredVitestDecision(checkRuns, head);
  if (!checkDecision.allow) return null;
  const check = latestRequiredVitestCheck(checkRuns, head);
  const location = parseActionsJobUrl(check?.details_url, repo);
  if (!check || !location || !reviewIdKey(review.id)) return null;
  const workflow = ghJson([
    'api', `repos/${repo}/actions/runs/${location.runId}`,
  ]);
  const job = ghJson([
    'api', `repos/${repo}/actions/jobs/${location.jobId}`,
  ]);
  return {
    reviewId: reviewIdKey(review.id),
    check,
    workflow,
    job,
  };
}

const DISABLE_AUTO_MERGE_MUTATION =
  'mutation($pullRequestId:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId}){pullRequest{number autoMergeRequest{enabledAt}}}}';

function disableNativeAutoMerge(repo, pr) {
  if (!pr?.id) throw new Error('node ID della PR mancante');
  const response = ghJsonOnce([
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

function normalizedPrLabels(pr) {
  return (Array.isArray(pr?.labels) ? pr.labels : [])
    .map((label) => String(label?.name || '').toLowerCase())
    .sort();
}

/** Metadata that must remain stable between the first and final reads. */
function samePrMetadata(left, right) {
  return left?.number === right?.number
    && left?.id === right?.id
    && left?.state === right?.state
    && left?.isDraft === right?.isDraft
    && left?.baseRefName === right?.baseRefName
    && left?.headRefOid === right?.headRefOid
    && left?.title === right?.title
    && left?.body === right?.body
    && JSON.stringify(normalizedPrLabels(left)) === JSON.stringify(normalizedPrLabels(right));
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
      'number,id,title,body,labels,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: impossibile leggere PR #${prNumber}: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return skip('PR non aperta, draft o non basata su main');
  }
  const hadAutoMerge = pr.autoMergeRequest !== null;

  let changedFileSnapshot;
  try {
    changedFileSnapshot = loadChangedFiles(repo, prNumber);
  } catch (error) {
    if (hadAutoMerge) {
      revokeExistingAutoMerge(repo, pr, 'elenco file PR non verificabile');
      return;
    }
    console.error(`::error::native auto-merge guard: lettura file PR fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  let reviews;
  let checkRuns;
  let verifiedTestOnlyReview;
  let reviewGateEvidence;
  try {
    reviews = loadReviews(repo, prNumber);
    checkRuns = loadCheckRuns(repo, pr.headRefOid);
    verifiedTestOnlyReview = loadVerifiedTestOnlyReview(repo, prNumber, pr.headRefOid, reviews);
    reviewGateEvidence = loadReviewGateEvidence(
      repo,
      pr.headRefOid,
      checkRuns,
      latestReviewGateCandidate(reviews, pr.headRefOid),
    );
  } catch (error) {
    if (hadAutoMerge) {
      revokeExistingAutoMerge(repo, pr, 'review/check non leggibili');
      return;
    }
    console.error(`::error::native auto-merge guard: lettura review/check fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  const decision = revalidateNativeAutoMerge({
    pr,
    reviews,
    checkRuns,
    verifiedTestOnlyReview,
    reviewGateEvidence,
    repository: repo,
    changedFiles: changedFileSnapshot.files,
    changedFilesComplete: changedFileSnapshot.complete,
  });
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
      'number,id,title,body,labels,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: conferma HEAD fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  const currentStateChanged = !samePrMetadata(pr, current);
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
  let finalVerifiedTestOnlyReview;
  let finalReviewGateEvidence;
  let finalChangedFileSnapshot;
  try {
    finalChangedFileSnapshot = loadChangedFiles(repo, prNumber);
    finalReviews = loadReviews(repo, prNumber);
    finalCheckRuns = loadCheckRuns(repo, current.headRefOid);
    finalVerifiedTestOnlyReview = loadVerifiedTestOnlyReview(
      repo,
      prNumber,
      current.headRefOid,
      finalReviews,
    );
    finalReviewGateEvidence = loadReviewGateEvidence(
      repo,
      current.headRefOid,
      finalCheckRuns,
      latestReviewGateCandidate(finalReviews, current.headRefOid),
    );
  } catch (error) {
    if (current.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, current, 'review/check non leggibili prima dell’opt-in');
      return;
    }
    console.error(`::error::native auto-merge guard: rilettura review/check fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  // The final file/review/check reads are still not enough: title, body,
  // labels and HEAD may change while they are being fetched. Re-acquire the
  // complete PR metadata immediately before the only enabling mutation.
  let fresh;
  try {
    fresh = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,title,body,labels,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    if (current.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, current, 'metadata PR non leggibili prima dell’opt-in');
      return;
    }
    console.error(`::error::native auto-merge guard: metadata finale PR illeggibile: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (!samePrMetadata(current, fresh)) {
    if (fresh.state === 'OPEN' && fresh.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, fresh, 'metadata/file-list non più stabile prima dell’opt-in');
    }
    return skip('metadata PR o HEAD cambiati dopo la rilettura finale; serve una nuova valutazione');
  }

  const finalDecision = revalidateNativeAutoMerge({
    pr: fresh,
    reviews: finalReviews,
    checkRuns: finalCheckRuns,
    verifiedTestOnlyReview: finalVerifiedTestOnlyReview,
    reviewGateEvidence: finalReviewGateEvidence,
    repository: repo,
    changedFiles: finalChangedFileSnapshot.files,
    changedFilesComplete: finalChangedFileSnapshot.complete,
  });
  console.log(`Native auto-merge guard PR #${prNumber} final gate: ${finalDecision.reason}`);
  if (finalDecision.action === 'revoke') {
    revokeExistingAutoMerge(repo, current, `fresh gate finale fallito: ${finalDecision.reason}`);
    return;
  }
  if (!finalDecision.allow) {
    return skip('review/check cambiati o non più validi prima dell’opt-in; nessun merge.');
  }
  if (fresh.autoMergeRequest !== null) {
    return skip('native auto-merge già abilitato e rivalidato sulla HEAD corrente');
  }

  try {
    const output = execFileSync('gh', nativeAutoMergeArgs({ repo, prNumber, headSha: fresh.headRefOid }), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (output) process.stdout.write(output);
  } catch (error) {
    const details = capturedErrorOutput(error);
    if (isAlreadyInProgressOutput(details)
      && concurrentOptInSucceeded(repo, prNumber, fresh.headRefOid)) {
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
