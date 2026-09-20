/**
 * Native auto-merge guard.
 *
 * GitHub's native auto-merge remains the merger. This helper is only the
 * fail-closed opt-in gate: it must see the first terminal approving
 * Claude/frontaliere reviewer-bot verdict on the current HEAD (or an
 * explicitly marked Codex fallback with structured review-gate evidence) and
 * a completed required Vitest check on that HEAD before calling
 * `gh pr merge --auto`. A later same-HEAD review cannot revoke a clean LGTM.
 * The required check is the complete `tests` job. An older SHA is never
 * carried forward.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isReviewerBot,
  VITEST_CHECK_NAME,
} from './lib/constants.mjs';
import {
  findTestOnlyApproval,
  TEST_REVIEW_MARKER,
} from './review-test-policy.mjs';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';
import {
  classifyAutomationRisk,
} from './lib/automation-risk-policy.mjs';
import { REVIEW_GATE_STEP_NAME } from './lib/vitestCheck.mjs';
import {
  CODEX_FALLBACK_REVIEW_MARKER,
  firstTerminalBotReviewOnHead,
  isTerminalManagedReview,
  parseReviewPages,
  reviewBodyIsApproving,
  reviewHasLgtm,
  reviewHasZeroFindings,
} from './lib/pr-review-admission.mjs';
import {
  reviewHasInputRevision,
  reviewInputRevisionFromBody,
} from './lib/review-input-revision.mjs';

export {
  firstTerminalBotReviewOnHead,
  reviewHasLgtm,
  reviewHasZeroFindings,
} from './lib/pr-review-admission.mjs';

const TESTS_WORKFLOW_PATH = '.github/workflows/tests.yml';
const TESTS_WORKFLOW_EVENT = 'pull_request';
const TEST_ONLY_REVIEW_BOT_RE = /^(?:github-actions|frontaliere-automation)\[bot\]$/i;
const CODEX_FALLBACK_REVIEWER_RE = /^github-actions\[bot\]$/i;
// Explicit, verifiable entry point for the in-job opt-in: the caller declares
// WHICH run it is, never THAT the tests passed. See `inJobRequiredVitestDecision`.
const IN_JOB_RUN_ID_ENV = 'NATIVE_AUTOMERGE_IN_JOB_RUN_ID';
const MAX_TRANSIENT_GH_READ_ATTEMPTS = 3;
const TRANSIENT_GH_READ_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const TRANSIENT_GH_READ_ERROR_RE = /(?:\bHTTP\s+5\d{2}\b|\b5\d{2}\s+(?:bad gateway|service unavailable|gateway timeout)\b|service unavailable|bad gateway|gateway timeout|timed?\s*out|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/iu;
const BODY_RECOVERY_MARKER_PREFIX = '<!-- BODY_REVIEW_RECOVERY_PENDING:';
const BODY_RECOVERY_STATUSES = new Set(['pending', 'queued', 'manual', 'completed']);
const NATIVE_AUTO_MERGE_LEASE_PREFIX = '<!-- NATIVE_AUTO_MERGE_LEASE:';
const NATIVE_AUTO_MERGE_LEASE_STATUSES = new Set(['held', 'released']);
const TRUSTED_AUTOMATION_BOT_RE = /^(?:github-actions|frontaliere-automation)\[bot\]$/iu;
// The scheduled/manual fallback workflows use the repository owner's PAT from
// Remote Config. Keep that user identity explicit; arbitrary human comments
// must never be able to create or release a native auto-merge lease.
const TRUSTED_AUTOMATION_USER_RE = /^valerielinc-ops$/iu;

export function isTrustedNativeAutomationCommentAuthor(user) {
  const login = String(user?.login || '');
  return (user?.type === 'Bot' && TRUSTED_AUTOMATION_BOT_RE.test(login))
    || (user?.type === 'User' && TRUSTED_AUTOMATION_USER_RE.test(login));
}

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
    && isTerminalManagedReview(review)
    && predicate(review));
}

/**
 * The Codex fallback is not a raw reviewer. It may enter only the structured
 * review-gate evidence path, with the exact marker emitted by `tests.yml` and
 * an exact current HEAD. Keep this identity narrower than the normal
 * Claude/frontaliere reviewer allowlist.
 */
function isCodexFallbackReviewOnHead(review, head, reviewRevision) {
  return typeof head === 'string'
    && /^[0-9a-f]{40}$/iu.test(head)
    && typeof reviewRevision === 'string'
    && review?.user?.type === 'Bot'
    && CODEX_FALLBACK_REVIEWER_RE.test(review.user.login || '')
    && isTerminalManagedReview(review)
    && review.commit_id === head
    && reviewHasInputRevision(review.body, reviewRevision)
    && String(review.body || '').includes(CODEX_FALLBACK_REVIEW_MARKER);
}

/**
 * A clean LGTM on HEAD is sticky: a later same-SHA Important cannot revoke it.
 * If the first terminal verdict is not approving, keep the latest HEAD review
 * so structured/stale-fallback evidence still sees the current body.
 */
function firstReviewGateCandidate(reviews, head, reviewRevision) {
  const first = firstTerminalBotReviewOnHead(reviews, head, { reviewRevision });
  if (first && reviewBodyIsApproving(first.body)) return first;
  return latestReviewMatching(reviews, (review) => reviewHasInputRevision(review?.body, reviewRevision)
    && (isCodexFallbackReviewOnHead(review, head, reviewRevision)
      || (isReviewerBot(review?.user)
        && isTerminalManagedReview(review)
        && review?.commit_id === head)));
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
 * Require an H2 LGTM with zero blocking findings.
 *
 * `🟡 Nit` is advisory per REVIEW.md and may therefore coexist with `## LGTM`.
 * A missing `## Findings` heading is still approving when the body has no
 * real `🔴 Important`. Only an actual Important keeps the merge out.
 */
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
function testOnlyReviewIsApproved(review, head, reviewRevision) {
  if (!review || review.commit_id !== head) return false;
  if (review.user?.type !== 'Bot' || !TEST_ONLY_REVIEW_BOT_RE.test(review.user.login || '')) {
    return false;
  }
  if (!String(review.body || '').includes(TEST_REVIEW_MARKER)) return false;
  if (!reviewHasInputRevision(review.body, reviewRevision)) return false;
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

/**
 * In-job opt-in decision.
 *
 * `tests` itself calls this gate as one of the last steps of the required job,
 * so its own required check is necessarily still in flight and
 * `requiredVitestDecision` would deny forever — that permanent fail-closed is
 * exactly why the `workflow_run` trigger existed.
 *
 * The caller does not get to assert «vitest passed»: a boolean flag would be a
 * bypass that any later step — or a PR that edits the workflow it is running
 * from — could set. It passes the id of the run it is executing in, and this
 * function confirms that claim against fields only GitHub can write: the single
 * in-flight required check on this HEAD must belong to that run, the run must be
 * `tests.yml` on a `pull_request` for this HEAD, the job must be the required
 * job on this HEAD, and the approving review-gate step inside that job must
 * already have completed successfully. Any missing or contradicting field denies.
 *
 * Enabling native auto-merge is not merging: GitHub still refuses to merge until
 * the required check on this exact HEAD is green, and the opt-in is bound to that
 * HEAD by `--match-head-commit`. So a job that turns red after this step cannot
 * produce a merge.
 */
export function inJobRequiredVitestDecision({
  checkRuns,
  head,
  runId,
  repo,
  workflow,
  job,
} = {}) {
  const deny = (reason) => ({ allow: false, reason: `opt-in in-job: ${reason}` });
  if (!Array.isArray(checkRuns)) return deny('check-runs non verificabili');
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/iu.test(head)) {
    return deny('HEAD non verificabile');
  }
  if (!validPositiveInteger(runId)) return deny('run id del chiamante mancante o non valido');
  if (typeof repo !== 'string' || !repo) return deny('repository del chiamante mancante');

  const named = checkRuns.filter((check) => check?.name === VITEST_CHECK_NAME
    && check.head_sha === head);
  const own = named.filter((check) => parseActionsJobUrl(check.details_url, repo)?.runId === runId);
  if (own.length !== 1) {
    return deny(`il run ${runId} non possiede esattamente un check required su questa HEAD (${own.length})`);
  }
  const [ownCheck] = own;
  if (ownCheck.status === 'completed') {
    return deny('il check required del chiamante è già completato: il chiamante non è dentro quel run');
  }
  if (named.some((check) => check !== ownCheck && check.status !== 'completed')) {
    return deny('un altro run required è in volo sulla stessa HEAD e supererebbe questo verdetto');
  }
  const location = parseActionsJobUrl(ownCheck.details_url, repo);
  if (!location) return deny('details_url del check required non riconducibile a un job di questo repo');

  if (!workflow
      || workflow.id !== runId
      || workflow.path !== TESTS_WORKFLOW_PATH
      || workflow.event !== TESTS_WORKFLOW_EVENT
      || workflow.head_sha !== head
      || workflow.status === 'completed') {
    return deny('run tests del chiamante non verificabile');
  }

  if (!job
      || job.id !== location.jobId
      || job.run_id !== runId
      || job.name !== VITEST_CHECK_NAME
      || job.head_sha !== head
      || job.status === 'completed'
      || !Array.isArray(job.steps)) {
    return deny('job required del chiamante non verificabile');
  }

  const gateSteps = job.steps.filter((step) => step?.name === REVIEW_GATE_STEP_NAME);
  if (gateSteps.length !== 1) return deny('step review-gate assente o ambiguo nel job del chiamante');
  const [gateStep] = gateSteps;
  if (gateStep.status !== 'completed' || gateStep.conclusion !== 'success') {
    return deny(`step review-gate non approvante (status=${gateStep.status}, conclusion=${gateStep.conclusion})`);
  }

  return {
    allow: true,
    reason: `${VITEST_CHECK_NAME} in volo nel run ${runId} confermato via API; step ${REVIEW_GATE_STEP_NAME} success`,
  };
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
  reviewRevision,
} = {}) {
  const deny = (reason) => ({ allow: false, reason });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return deny('prova review-gate strutturata assente');
  }
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/iu.test(head)) {
    return deny('HEAD non verificabile per la prova review-gate');
  }
  if (!reviewHasInputRevision(review?.body, reviewRevision)) {
    return deny('review input revision assente o diversa dalla body corrente');
  }
  if (!isReviewerBot(review?.user) && !isCodexFallbackReviewOnHead(review, head, reviewRevision)) {
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
  inJobRun = null,
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
  let reviewRevision;
  try {
    reviewRevision = reviewInputRevisionFromBody(pr.body);
  } catch {
    return {
      allow: false,
      reason: 'body revision review non verificabile; deny fail-closed senza approvazione umana',
      humanApprovalRequired: false,
      humanApprovalVerified: false,
    };
  }
  if (!Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, reason: 'stato auto-merge non verificabile' };
  }

  // The production loader validates the API response, but this exported pure
  // entry point is also used by workflow/test callers. Validate that path too:
  // flattening an injected array before parsing would let one malformed
  // historical review sit beside a valid LGTM and still authorize a mutation.
  const parsedReviews = parseReviewPages(reviews);
  if (!parsedReviews) {
    return {
      allow: false,
      reason: 'review history non verificabile: elenco review malformato o assente',
    };
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
  if (pr.autoMergeRequest !== null) {
    return { allow: false, reason: 'native auto-merge già abilitato' };
  }

  // The required check is the complete `tests` job. Its review gate and this
  // native helper both require the exact current HEAD, so a completed check or
  // LGTM from an autorebase predecessor cannot unlock this commit.
  const review = firstReviewGateCandidate(parsedReviews, pr.headRefOid, reviewRevision);
  const testOnlyApproval = !review
    && testOnlyReviewIsApproved(verifiedTestOnlyReview, pr.headRefOid, reviewRevision);
  if (!review && !testOnlyApproval) {
    return { allow: false, reason: 'nessuna review bot verificabile' };
  }
  const reviewGateException = review && !reviewIsApproved(review)
    ? reviewGateEvidenceDecision({
      evidence: reviewGateEvidence,
      repo: repository,
      head: pr.headRefOid,
      review,
      reviewRevision,
    })
    : { allow: false, reason: 'review raw già approvante' };
  if (review && !reviewIsApproved(review) && !reviewGateException.allow) {
    return { allow: false, reason: 'review bot sulla HEAD non è LGTM senza 🔴 Important' };
  }

  // Two independent sources have to agree before the opt-in: the workflow step
  // only runs when `job.status == 'success'` and the review gate published
  // `approved`, and the decision below re-derives both facts from the API.
  // Neither half alone can enable anything.
  const check = inJobRun
    ? inJobRequiredVitestDecision({
      ...inJobRun,
      checkRuns,
      head: pr.headRefOid,
      repo: repository,
    })
    : requiredVitestDecision(checkRuns, pr.headRefOid);
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
  inJobRun = null,
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
    inJobRun,
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

function loadVerifiedTestOnlyReview(repo, pr, head, reviews, reviewRevision) {
  return findTestOnlyApproval(reviews, head, {
    ghFn: ghForTestOnlyReview,
    repo,
    pr,
    reviewRevision,
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
  const reviews = parseReviewPages(ghJson([
    'api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp',
  ]));
  if (!reviews) throw new Error('reviews PR: JSON/pagine/entry malformate');
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

function loadBodyRecoveryBarrier(repo, prNumber, headSha, bodyRevision) {
  const comments = ghJson([
    'api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp',
  ]);
  const decision = bodyRecoveryBarrierDecision({
    comments,
    prNumber: Number(prNumber),
    headSha,
    bodyRevision,
  });
  if (!decision.allow && !Array.isArray(comments)) {
    throw new Error(decision.reason);
  }
  return decision;
}

function loadNativeAutoMergeLease(repo, prNumber, headSha, bodyRevision) {
  const comments = ghJson([
    'api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp',
  ]);
  return nativeAutoMergeLeaseDecision({
    comments,
    prNumber: Number(prNumber),
    headSha,
    bodyRevision,
  });
}

function acquireNativeAutoMergeLease(repo, prNumber, headSha, bodyRevision) {
  const existing = loadNativeAutoMergeLease(repo, prNumber, headSha, bodyRevision);
  // A held lease for another HEAD/body epoch is historical state, not a lock
  // on the new review input. Publishing the new identity makes the latest
  // comment authoritative and prevents a missed body-edited webhook from
  // stranding the PR behind a stale lease forever. A held lease on the exact
  // identity remains shareable between concurrent gate readers.
  if (existing.allow) return { leaseId: existing.leaseId, owned: false };
  const leaseId = `${process.env.GITHUB_RUN_ID || 'local'}:${process.env.GITHUB_RUN_ATTEMPT || '1'}:${process.pid}`;
  ghRaw([
    'pr', 'comment', String(prNumber), '--repo', repo,
    '--body', nativeAutoMergeLeaseBody({
      status: 'held', prNumber: Number(prNumber), headSha, bodyRevision, leaseId,
    }),
  ]);
  const confirmed = loadNativeAutoMergeLease(repo, prNumber, headSha, bodyRevision);
  if (!confirmed.allow || confirmed.leaseId !== leaseId) {
    throw new Error(`lease native auto-merge non confermato dopo la scrittura: ${confirmed.reason}`);
  }
  return { leaseId, owned: true };
}

function loadCheckRuns(repo, head) {
  const pages = ghJson([
    'api', `repos/${repo}/commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp',
  ]);
  return (Array.isArray(pages) ? pages : [pages])
    .flatMap((page) => Array.isArray(page?.check_runs) ? page.check_runs : []);
}

function loadReviewGateEvidence(repo, head, checkRuns, review, reviewRevision) {
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

/**
 * Read the caller's own run id and resolve, from the API, the run and job that
 * id names. Absent env var → `null`, i.e. the ordinary post-hoc behaviour used
 * by `retry-native-automerge.yml` is untouched. Present but unresolvable → a
 * context with null run/job, so the pure decision denies with a reason instead
 * of silently falling back to the completed-check path.
 */
function loadInJobRun(repo, head, checkRuns) {
  const runId = Number(process.env[IN_JOB_RUN_ID_ENV] || '');
  if (!validPositiveInteger(runId)) return null;
  const own = (Array.isArray(checkRuns) ? checkRuns : []).filter(
    (check) => check?.name === VITEST_CHECK_NAME
      && check.head_sha === head
      && parseActionsJobUrl(check.details_url, repo)?.runId === runId,
  );
  if (own.length !== 1) return { runId, workflow: null, job: null };
  const { jobId } = parseActionsJobUrl(own[0].details_url, repo);
  return {
    runId,
    workflow: ghJson(['api', `repos/${repo}/actions/runs/${runId}`]),
    job: ghJson(['api', `repos/${repo}/actions/jobs/${jobId}`]),
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
  const autoMergeEnabled = (value) => value !== null && value !== undefined;
  return left?.number === right?.number
    && left?.id === right?.id
    && left?.state === right?.state
    && left?.isDraft === right?.isDraft
    && left?.baseRefName === right?.baseRefName
    && left?.headRefOid === right?.headRefOid
    && left?.title === right?.title
    && left?.body === right?.body
    && autoMergeEnabled(left?.autoMergeRequest) === autoMergeEnabled(right?.autoMergeRequest)
    && JSON.stringify(normalizedPrLabels(left)) === JSON.stringify(normalizedPrLabels(right));
}

function parseBodyRecoveryMarker(body) {
  const match = String(body || '').match(/<!-- BODY_REVIEW_RECOVERY_PENDING:\s*(\{[\s\S]*?\})\s*-->/u);
  if (!match) return null;
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return { valid: false, reason: 'marker recovery JSON malformato' };
  }
  const status = String(value?.status || '').trim().toLowerCase();
  const headSha = String(value?.headSha || '').trim().toLowerCase();
  const bodyRevision = String(value?.bodyRevision || '').trim().toLowerCase();
  const runId = value?.runId;
  const runAttempt = value?.runAttempt;
  const validRunIdentity = Number.isSafeInteger(runId) && runId > 0
    && Number.isSafeInteger(runAttempt) && runAttempt > 0;
  // A manual checkpoint may predate a run (no-existing-pull-request-run), or
  // retain the exact attempt whose rerun API call was ambiguous. Both shapes
  // are fail-closed until a later workflow_run/scheduled reconciliation marks
  // the marker completed; neither is treated as a clean recovery epoch.
  const runFieldsValid = status === 'manual'
    ? (runId === null && runAttempt === null) || validRunIdentity
    : validRunIdentity;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1
      || !Number.isSafeInteger(value.prNumber) || value.prNumber <= 0
      || !BODY_RECOVERY_STATUSES.has(status)
      || !/^[0-9a-f]{40}$/iu.test(headSha)
      || !/^body:[0-9a-f]{64}$/iu.test(bodyRevision)
      || !Object.hasOwn(value, 'runId')
      || !Object.hasOwn(value, 'runAttempt')
      || !runFieldsValid) {
    return { valid: false, reason: 'marker recovery schema non verificabile' };
  }
  return {
    valid: true,
    status,
    prNumber: value.prNumber,
    headSha,
    bodyRevision,
  };
}

function strictCommentEntries(comments) {
  if (!Array.isArray(comments)) return null;
  const entries = [];
  for (const page of comments) {
    if (Array.isArray(page)) {
      if (page.length === 0 || page.some((comment) => Array.isArray(comment))) return null;
      entries.push(...page);
    } else {
      entries.push(page);
    }
  }
  if (entries.some((comment) => !comment || typeof comment !== 'object'
    || Array.isArray(comment) || typeof comment.body !== 'string')) return null;
  return entries;
}

function parseNativeAutoMergeLease(body) {
  const match = String(body || '').match(/<!-- NATIVE_AUTO_MERGE_LEASE:\s*(\{[\s\S]*?\})\s*-->/u);
  if (!match) return null;
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return { valid: false, reason: 'lease native auto-merge JSON malformato' };
  }
  const status = String(value?.status || '').trim().toLowerCase();
  const headSha = String(value?.headSha || '').trim().toLowerCase();
  const bodyRevision = String(value?.bodyRevision || '').trim().toLowerCase();
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1
      || !NATIVE_AUTO_MERGE_LEASE_STATUSES.has(status)
      || !Number.isSafeInteger(value.prNumber) || value.prNumber <= 0
      || !/^[0-9a-f]{40}$/iu.test(headSha)
      || !/^body:[0-9a-f]{64}$/iu.test(bodyRevision)
      || typeof value.leaseId !== 'string' || value.leaseId.length < 1
      || value.leaseId.length > 200) {
    return { valid: false, reason: 'lease native auto-merge schema non verificabile' };
  }
  return {
    valid: true,
    status,
    prNumber: value.prNumber,
    headSha,
    bodyRevision,
    leaseId: value.leaseId,
  };
}

function nativeAutoMergeLeaseBody({ status, prNumber, headSha, bodyRevision, leaseId, reason = null }) {
  const value = {
    version: 1,
    status,
    prNumber,
    headSha: String(headSha).toLowerCase(),
    bodyRevision: String(bodyRevision).toLowerCase(),
    leaseId,
  };
  if (reason) value.reason = reason;
  return `${NATIVE_AUTO_MERGE_LEASE_PREFIX} ${JSON.stringify(value)} -->\n`
    + `_native auto-merge lease ${status} · head ${String(headSha).slice(0, 12)} · body ${bodyRevision}._`;
}

/**
 * A comment-backed, fail-closed lease shared by the native gate and body
 * recovery. GitHub has no conditional PR-merge mutation keyed to body text;
 * the lease therefore narrows the race to the final API window and leaves a
 * durable released marker for a concurrent body recovery to invalidate. The
 * post-mutation read below is still mandatory because the two GitHub calls are
 * not one atomic transaction.
 */
export function nativeAutoMergeLeaseDecision({ comments, prNumber, headSha, bodyRevision } = {}) {
  const deny = (reason, extra = {}) => ({ allow: false, reason, ...extra });
  const entries = strictCommentEntries(comments);
  if (!entries) return deny('commenti lease native auto-merge non verificabili');
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0
      || !/^[0-9a-f]{40}$/iu.test(String(headSha || ''))
      || !/^body:[0-9a-f]{64}$/iu.test(String(bodyRevision || ''))) {
    return deny('identità lease native auto-merge non verificabile');
  }
  const leases = [];
  for (const comment of entries) {
    if (!comment.body.includes(NATIVE_AUTO_MERGE_LEASE_PREFIX)) continue;
    if (!isTrustedNativeAutomationCommentAuthor(comment.user)) {
      return deny('lease native auto-merge senza autore automation trusted');
    }
    const lease = parseNativeAutoMergeLease(comment.body);
    if (!lease?.valid) return deny(lease?.reason || 'lease native auto-merge non verificabile');
    if (lease.prNumber !== prNumber) return deny('lease native auto-merge associato a una PR diversa');
    leases.push(lease);
  }
  const latest = leases.at(-1);
  if (!latest) return deny('lease native auto-merge assente', { status: null, leaseId: null });
  if (latest.headSha !== String(headSha).toLowerCase()
      || latest.bodyRevision !== String(bodyRevision).toLowerCase()) {
    return deny('lease native auto-merge su HEAD/body revision diversa', {
      status: latest.status,
      leaseId: latest.leaseId,
    });
  }
  if (latest.status !== 'held') {
    return deny('lease native auto-merge rilasciato', {
      status: latest.status,
      leaseId: latest.leaseId,
    });
  }
  return { allow: true, reason: 'lease native auto-merge held su HEAD/body revision correnti', status: latest.status, leaseId: latest.leaseId };
}

/**
 * Durable body-edit epoch barrier shared with retry-code-check-after-body-edit.
 * An active/manual marker or a marker for a different body revision means the
 * revocation/re-review hand-off is incomplete; native auto-merge must not be
 * enabled from a stale review snapshot. Unknown/malformed marker data is also
 * a denial, never an implicit clean state.
 */
export function bodyRecoveryBarrierDecision({
  comments,
  prNumber,
  headSha,
  bodyRevision,
} = {}) {
  const deny = (reason) => ({ allow: false, reason });
  if (!Array.isArray(comments)) return deny('commenti recovery non verificabili');
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0
      || !/^[0-9a-f]{40}$/iu.test(String(headSha || ''))
      || !/^body:[0-9a-f]{64}$/iu.test(String(bodyRevision || ''))) {
    return deny('epoch body recovery non verificabile');
  }
  const markers = [];
  const flattenedComments = [];
  for (const page of comments) {
    if (Array.isArray(page)) {
      // `gh api --paginate --slurp` returns pages, while pure callers/tests may
      // pass one flat comment array. An empty nested page is not an empty
      // history: it is an unverified API shape and must not authorize retain.
      if (page.length === 0 || page.some((comment) => Array.isArray(comment))) {
        return deny('pagine commenti recovery non verificabili');
      }
      flattenedComments.push(...page);
    } else {
      flattenedComments.push(page);
    }
  }
  for (const comment of flattenedComments) {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
      return deny('commento recovery malformato');
    }
    if (typeof comment.body !== 'string') {
      return deny('commento recovery senza body testuale');
    }
    const text = comment.body;
    if (!text.includes(BODY_RECOVERY_MARKER_PREFIX)) continue;
    if (!isTrustedNativeAutomationCommentAuthor(comment.user)) {
      return deny('marker recovery senza autore automation trusted');
    }
    const marker = parseBodyRecoveryMarker(text);
    if (!marker?.valid) return deny(marker?.reason || 'marker recovery non verificabile');
    if (marker.prNumber !== prNumber) return deny('marker recovery associato a una PR diversa');
    markers.push(marker);
  }
  const currentHead = String(headSha).toLowerCase();
  // A recovery marker belongs to the exact HEAD whose body/check run it was
  // created to reconcile.  A later push makes every marker for a predecessor
  // permanently irrelevant: its tests can no longer authorize this HEAD, and
  // waiting for its old workflow_run would strand the new commit behind a
  // dead epoch.  Keep validating every marker above (malformed or untrusted
  // history still fails closed), then select only the current-head epochs.
  // This also protects a current pending marker from an out-of-order stale
  // marker appended by a concurrent recovery writer.
  const currentMarkers = markers.filter((marker) => marker.headSha === currentHead);
  const latest = currentMarkers.at(-1);
  if (!latest) {
    return {
      allow: true,
      reason: markers.length > 0
        ? 'epoch recovery precedenti ignorati: HEAD corrente non ha un recovery attivo'
        : 'nessun epoch recovery attivo',
    };
  }
  if (latest.bodyRevision !== String(bodyRevision).toLowerCase()) {
    return deny('body revision diversa dall’ultimo epoch recovery');
  }
  if (latest.status !== 'completed') {
    return deny(`epoch recovery ${latest.status} non completato`);
  }
  return { allow: true, reason: 'epoch recovery completato sulla body revision e HEAD correnti' };
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

/** Confirm a concurrent opt-in only after the same body/HEAD/barrier read. */
function concurrentOptInSucceeded(repo, prNumber, expectedHead, expectedBodyRevision, expectedLeaseId) {
  return verifyPostMutationState(repo, prNumber, expectedHead, expectedBodyRevision, expectedLeaseId);
}

/**
 * Close the post-mutation TOCTOU window. `--match-head-commit` binds only the
 * commit; a body edit can race the mutation and revoke the review epoch while
 * GitHub is accepting the native request. Re-read the body/barrier and revoke
 * an unsafe open request immediately; a merged request with a changed body is
 * a hard failure because GitHub cannot undo that mutation here.
 */
function verifyPostMutationState(repo, prNumber, expectedHead, expectedBodyRevision, expectedLeaseId) {
  let observed;
  try {
    observed = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,body,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
    const observedRevision = reviewInputRevisionFromBody(observed.body);
    const lease = loadNativeAutoMergeLease(repo, prNumber, observed.headRefOid, observedRevision);
    if (observed.state === 'MERGED') {
      const safe = observed.headRefOid === expectedHead
        && observedRevision === expectedBodyRevision
        && lease.allow
        && lease.leaseId === expectedLeaseId;
      if (!safe) {
        console.error('::error::native auto-merge guard: PR merged ma body/HEAD/lease diversa dal CAS finale');
        process.exitCode = 1;
      }
      return safe;
    }
    const barrier = loadBodyRecoveryBarrier(
      repo,
      prNumber,
      observed.headRefOid,
      observedRevision,
    );
    const safe = observed.state === 'OPEN'
      && observed.isDraft === false
      && observed.baseRefName === 'main'
      && observed.headRefOid === expectedHead
      && observedRevision === expectedBodyRevision
      && observed.autoMergeRequest !== null
      && barrier.allow
      && lease.allow
      && lease.leaseId === expectedLeaseId;
    if (safe) return true;
    if (observed.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, observed, `body/HEAD/barrier/lease cambiati dopo la mutation: ${barrier.reason}; ${lease.reason}`);
    }
    console.error('::error::native auto-merge guard: opt-in post-mutation non più verificabile');
    process.exitCode = 1;
    return false;
  } catch (error) {
    if (observed?.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, observed, 'rilettura body/barrier fallita dopo la mutation');
    }
    console.error(`::error::native auto-merge guard: verifica post-mutation fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
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
  let reviewRevision;
  try {
    reviewRevision = reviewInputRevisionFromBody(pr.body);
  } catch (error) {
    if (hadAutoMerge) {
      revokeExistingAutoMerge(repo, pr, 'body revision review non verificabile');
      return;
    }
    console.error(`::error::native auto-merge guard: body revision review non verificabile: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

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
  let inJobRun;
  try {
    reviews = loadReviews(repo, prNumber);
    checkRuns = loadCheckRuns(repo, pr.headRefOid);
    inJobRun = loadInJobRun(repo, pr.headRefOid, checkRuns);
    verifiedTestOnlyReview = loadVerifiedTestOnlyReview(
      repo,
      prNumber,
      pr.headRefOid,
      reviews,
      reviewRevision,
    );
    reviewGateEvidence = loadReviewGateEvidence(
      repo,
      pr.headRefOid,
      checkRuns,
      firstReviewGateCandidate(reviews, pr.headRefOid, reviewRevision),
      reviewRevision,
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
    inJobRun,
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
  let finalInJobRun;
  try {
    finalChangedFileSnapshot = loadChangedFiles(repo, prNumber);
    finalReviews = loadReviews(repo, prNumber);
    finalCheckRuns = loadCheckRuns(repo, current.headRefOid);
    finalInJobRun = loadInJobRun(repo, current.headRefOid, finalCheckRuns);
    const finalReviewRevision = reviewInputRevisionFromBody(current.body);
    finalVerifiedTestOnlyReview = loadVerifiedTestOnlyReview(
      repo,
      prNumber,
      current.headRefOid,
      finalReviews,
      finalReviewRevision,
    );
    finalReviewGateEvidence = loadReviewGateEvidence(
      repo,
      current.headRefOid,
      finalCheckRuns,
      firstReviewGateCandidate(finalReviews, current.headRefOid, finalReviewRevision),
      finalReviewRevision,
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
    inJobRun: finalInJobRun,
  });
  let freshRecoveryBarrier;
  try {
    const freshRevision = reviewInputRevisionFromBody(fresh.body);
    freshRecoveryBarrier = loadBodyRecoveryBarrier(
      repo,
      prNumber,
      fresh.headRefOid,
      freshRevision,
    );
  } catch (error) {
    if (fresh.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, fresh, 'barrier body recovery non leggibile prima del retain');
      return;
    }
    console.error(`::error::native auto-merge guard: barrier body recovery illeggibile prima del retain: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (!freshRecoveryBarrier.allow) {
    if (fresh.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, fresh, `barrier body recovery non concluso: ${freshRecoveryBarrier.reason}`);
    }
    return skip(`barrier body recovery non concluso prima del retain: ${freshRecoveryBarrier.reason}`);
  }
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

  // Acquire a durable comment-backed lease only after the final recovery
  // barrier/review snapshot is clean. Body recovery publishes a released lease
  // before it revokes native auto-merge; the final checks below then observe
  // that release and fail closed. GitHub exposes no atomic body+merge CAS, so
  // the post-mutation read remains part of the safety protocol.
  let nativeLease;
  try {
    const leaseRevision = reviewInputRevisionFromBody(fresh.body);
    nativeLease = acquireNativeAutoMergeLease(
      repo,
      prNumber,
      fresh.headRefOid,
      leaseRevision,
    );
  } catch (error) {
    console.error(`::error::native auto-merge guard: lease body/HEAD non acquisibile: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  // One last metadata/body read is the narrow CAS-style boundary immediately
  // before the only enabling mutation. If a body edit or another opt-in lands
  // between the final gate and this read, do not hand an old review to GitHub.
  let beforeMutation;
  try {
    beforeMutation = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,title,body,labels,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    if (fresh.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, fresh, 'metadata PR illeggibili al confine della mutation');
      return;
    }
    console.error(`::error::native auto-merge guard: CAS metadata finale illeggibile: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (!samePrMetadata(fresh, beforeMutation)) {
    if (beforeMutation.state === 'OPEN' && beforeMutation.autoMergeRequest !== null) {
      revokeExistingAutoMerge(repo, beforeMutation, 'body/metadata cambiati al confine della mutation');
    }
    return skip('body/metadata cambiati immediatamente prima dell’opt-in; serve una nuova review');
  }
  if (beforeMutation.autoMergeRequest !== null) {
    return skip('native auto-merge abilitato da un writer concorrente durante il CAS finale');
  }

  // The body read above is not enough: review/check API responses may have
  // changed while the metadata CAS was being acquired. Re-read the complete
  // review/check pair and the body-derived revision in the same narrow final
  // window; only this snapshot may feed the enabling mutation.
  let mutationRevision;
  let mutationReviews;
  let mutationCheckRuns;
  let mutationVerifiedTestOnlyReview;
  let mutationReviewGateEvidence;
  let mutationInJobRun;
  let recoveryBarrier;
  let mutationMetadata;
  try {
    mutationRevision = reviewInputRevisionFromBody(beforeMutation.body);
    mutationReviews = loadReviews(repo, prNumber);
    mutationCheckRuns = loadCheckRuns(repo, beforeMutation.headRefOid);
    mutationInJobRun = loadInJobRun(repo, beforeMutation.headRefOid, mutationCheckRuns);
    mutationVerifiedTestOnlyReview = loadVerifiedTestOnlyReview(
      repo,
      prNumber,
      beforeMutation.headRefOid,
      mutationReviews,
      mutationRevision,
    );
    mutationReviewGateEvidence = loadReviewGateEvidence(
      repo,
      beforeMutation.headRefOid,
      mutationCheckRuns,
      firstReviewGateCandidate(mutationReviews, beforeMutation.headRefOid, mutationRevision),
      mutationRevision,
    );
    // Re-acquire PR metadata after the full review/check reads. This binds the
    // body-derived revision and HEAD used below to the exact final API window;
    // a body edit during those reads is a conflict, never a stale merge.
    mutationMetadata = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,id,title,body,labels,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
    if (!samePrMetadata(beforeMutation, mutationMetadata)) {
      return skip('body/metadata cambiati durante lo snapshot finale review/check; serve una nuova valutazione');
    }
    const finalMutationRevision = reviewInputRevisionFromBody(mutationMetadata.body);
    if (finalMutationRevision !== mutationRevision) {
      return skip('body revision cambiata durante lo snapshot finale; serve una nuova review');
    }
    recoveryBarrier = loadBodyRecoveryBarrier(
      repo,
      prNumber,
      mutationMetadata.headRefOid,
      finalMutationRevision,
    );
  } catch (error) {
    console.error(`::error::native auto-merge guard: snapshot finale review/check/body non leggibile: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (!recoveryBarrier.allow) {
    return skip(`body recovery non concluso al confine della mutation: ${recoveryBarrier.reason}`);
  }
  const mutationLease = loadNativeAutoMergeLease(
    repo,
    prNumber,
    mutationMetadata.headRefOid,
    mutationRevision,
  );
  if (!mutationLease.allow || mutationLease.leaseId !== nativeLease.leaseId) {
    return skip(`lease body/HEAD cambiato al confine della mutation: ${mutationLease.reason}`);
  }
  const mutationDecision = revalidateNativeAutoMerge({
    pr: mutationMetadata,
    reviews: mutationReviews,
    checkRuns: mutationCheckRuns,
    verifiedTestOnlyReview: mutationVerifiedTestOnlyReview,
    reviewGateEvidence: mutationReviewGateEvidence,
    repository: repo,
    changedFiles: finalChangedFileSnapshot.files,
    changedFilesComplete: finalChangedFileSnapshot.complete,
    inJobRun: mutationInJobRun,
  });
  console.log(`Native auto-merge guard PR #${prNumber} mutation snapshot: ${mutationDecision.reason}`);
  if (!mutationDecision.allow) {
    return skip('review/check/body revision cambiati al confine della mutation; nessun merge.');
  }
  if (beforeMutation.autoMergeRequest !== null) {
    return skip('native auto-merge abilitato da un writer concorrente al confine della mutation');
  }

  try {
    const output = execFileSync('gh', nativeAutoMergeArgs({ repo, prNumber, headSha: beforeMutation.headRefOid }), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (output) process.stdout.write(output);
    if (!verifyPostMutationState(
      repo,
      prNumber,
      beforeMutation.headRefOid,
      mutationRevision,
      nativeLease.leaseId,
    )) return;
  } catch (error) {
    const details = capturedErrorOutput(error);
    if (isAlreadyInProgressOutput(details)
      && concurrentOptInSucceeded(
        repo,
        prNumber,
        beforeMutation.headRefOid,
        mutationRevision,
        nativeLease.leaseId,
      )) {
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
