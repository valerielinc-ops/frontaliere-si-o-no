#!/usr/bin/env node

/**
 * Observe the downstream lifecycle of loop-fleet candidates.
 *
 * The loop recorder owns candidate/owner_assigned. This script is a separate,
 * read-only observer for the GitHub evidence that can prove pr_opened,
 * tests_passed, review_approved, merged and post_merge_verified. It never
 * infers a lifecycle event from a local decision and never writes GitHub state.
 * A separate reviewed PR step may persist the emitted events.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildLifecycleEvent,
  validateLifecycleEvent,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const DEFAULT_LEDGER_DIR = path.join('data', 'loop-fleet', 'ledger');
const OBSERVED_EVENT_TYPES = Object.freeze([
  'pr_opened',
  'tests_passed',
  'review_approved',
  'merged',
  'post_merge_verified',
]);
const POST_MERGE_WORKFLOWS = Object.freeze(new Set([
  'Loop fleet status',
  'Loop fleet ledger audit',
]));
const SHA_RE = /^[0-9a-f]{40}$/iu;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function iso(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readJson(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function readJsonl(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return [];
  return fs.readFileSync(absolute, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function validPastTimestamp(value, now) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function repositoryName() {
  return process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
}

function ghJson(args) {
  const fullArgs = [...args, ...(repositoryName() ? ['--repo', repositoryName()] : [])];
  let raw;
  try {
    raw = execFileSync('gh', fullArgs, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    throw new Error(`GitHub read failed: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`GitHub returned invalid JSON: ${error.message}`);
  }
}

/** Return only the PRs created by the reviewed loop-fleet ledger bridge. */
export function isFleetLedgerPr(pr) {
  return Boolean(pr
    && text(pr.baseRefName) === 'main'
    && /^chore\(loop-fleet\): persist\b/u.test(text(pr.title) || '')
    && /^chore\/loop-fleet-ledger(?:-|$)/u.test(text(pr.headRefName) || ''));
}

function commitMessages(pr) {
  return (Array.isArray(pr?.commits) ? pr.commits : [])
    .flatMap((commit) => [commit?.messageHeadline, commit?.messageBody])
    .filter((value) => text(value));
}

/**
 * Extract the immutable source runs named by the bridge's commit/body.
 * No source run means no candidate is attributed to the PR.
 */
export function extractSourceRuns(pr) {
  const sources = new Map();
  for (const message of commitMessages(pr)) {
    const match = message.match(/\b(L\d+)\s+(?:durable\s+)?evidence\s+from\s+run\s+(\d+)\b/iu);
    if (match) sources.set(`${match[1].toUpperCase()}:${match[2]}`, { loopId: match[1].toUpperCase(), runId: match[2] });
  }
  const body = text(pr?.body) || '';
  const bodyMatch = body.match(/immutable\s+run\s+\[?(\d+)\]?[^\n]*?\bfor\s+(L\d+)\b/iu);
  if (bodyMatch) {
    sources.set(`${bodyMatch[2].toUpperCase()}:${bodyMatch[1]}`, {
      loopId: bodyMatch[2].toUpperCase(),
      runId: bodyMatch[1],
    });
  }
  return [...sources.values()].sort((left, right) =>
    left.loopId.localeCompare(right.loopId) || left.runId.localeCompare(right.runId));
}

function checkStatus(check) {
  return String(check?.status || '').toUpperCase();
}

function checkConclusion(check) {
  return String(check?.conclusion || '').toUpperCase();
}

function checkUrl(check, fallback) {
  return text(check?.detailsUrl) || text(check?.url) || fallback;
}

/**
 * Require an actual test check on the current PR head and no completed failing
 * check. Skipped auxiliary checks are allowed; an absent/in-progress test is
 * not proof of tests_passed.
 */
export function passedTestsEvidence(pr, now = new Date()) {
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const testChecks = checks.filter((check) =>
    /vitest|\btests?\b/iu.test(`${check?.name || ''} ${check?.workflowName || ''}`));
  const successfulTests = testChecks.filter((check) =>
    checkStatus(check) === 'COMPLETED' && checkConclusion(check) === 'SUCCESS');
  const failed = checks.filter((check) =>
    checkStatus(check) === 'COMPLETED'
      && new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE']).has(checkConclusion(check)));
  if (!successfulTests.length || failed.length) return null;
  const completedAt = successfulTests
    .map((check) => iso(check.completedAt))
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!completedAt || !validPastTimestamp(completedAt, now)) return null;
  return {
    occurredAt: completedAt,
    artifactOrPr: checkUrl(successfulTests.at(-1), text(pr?.url) || null),
  };
}

function reviewIsForHead(review, headSha) {
  const reviewSha = text(review?.commit?.oid || review?.commitOid);
  return Boolean(reviewSha && SHA_RE.test(reviewSha) && reviewSha.toLowerCase() === String(headSha || '').toLowerCase());
}

function reviewHasLgtm(review) {
  const body = text(review?.body) || '';
  return /(?:^|\r?\n)##\s*LGTM(?:\s|$)/iu.test(body)
    && !/Findings\s*\(\s*Important\s*:\s*[1-9]\d*/iu.test(body)
    && !/🔴\s*Important/iu.test(body);
}

/** Require the latest review on the current head to carry the repository's LGTM contract. */
export function approvedReviewEvidence(pr, now = new Date()) {
  const headSha = text(pr?.headRefOid);
  if (!headSha || !Array.isArray(pr?.reviews)) return null;
  const reviews = pr.reviews
    .filter((review) => reviewIsForHead(review, headSha) && iso(review?.submittedAt))
    .sort((left, right) => Date.parse(left.submittedAt) - Date.parse(right.submittedAt));
  const latest = reviews.at(-1);
  if (!latest || !validPastTimestamp(latest.submittedAt, now) || !reviewHasLgtm(latest)) return null;
  return {
    occurredAt: new Date(latest.submittedAt).toISOString(),
    artifactOrPr: text(pr?.url) || null,
  };
}

export function mergeEvidence(pr, now = new Date()) {
  const mergeSha = text(pr?.mergeCommit?.oid);
  const mergedAt = iso(pr?.mergedAt);
  if (String(pr?.state || '').toUpperCase() !== 'MERGED' || !mergeSha || !SHA_RE.test(mergeSha)
      || !mergedAt || !validPastTimestamp(mergedAt, now)) return null;
  return {
    occurredAt: mergedAt,
    artifactOrPr: text(pr?.url) || null,
    mergeSha: mergeSha.toLowerCase(),
  };
}

/** Require an independent successful status/audit run on the merge commit. */
export function postMergeEvidence(pr, postMergeRuns, now = new Date()) {
  const merge = mergeEvidence(pr, now);
  if (!merge) return null;
  const runs = (Array.isArray(postMergeRuns) ? postMergeRuns : [])
    .filter((run) => POST_MERGE_WORKFLOWS.has(text(run?.workflowName || run?.name))
      && String(run?.status || '').toUpperCase() === 'COMPLETED'
      && String(run?.conclusion || '').toUpperCase() === 'SUCCESS'
      && String(run?.headSha || '').toLowerCase() === merge.mergeSha
      && iso(run?.updatedAt || run?.completedAt)
      && Date.parse(run.updatedAt || run.completedAt) >= Date.parse(merge.occurredAt))
    .sort((left, right) => Date.parse(left.updatedAt || left.completedAt) - Date.parse(right.updatedAt || right.completedAt));
  const run = runs.at(-1);
  if (!run || !validPastTimestamp(run.updatedAt || run.completedAt, now)) return null;
  return {
    occurredAt: new Date(run.updatedAt || run.completedAt).toISOString(),
    artifactOrPr: text(run.url) || text(pr?.url) || null,
  };
}

function candidateRecords(registry, lifecycleEvents) {
  const candidates = [];
  const seen = new Set();
  for (const event of lifecycleEvents) {
    if (event?.eventType !== 'candidate') continue;
    if (seen.has(event.candidateId)) {
      const previous = candidates.find((candidate) => candidate.candidateId === event.candidateId);
      if (JSON.stringify(previous) !== JSON.stringify(event)) {
        throw new Error(`candidate ${event.candidateId} has conflicting duplicate records`);
      }
      continue;
    }
    validateLifecycleEvent(registry, event.loopId, event);
    if (!object(event.execution)
        || !text(event.execution.runId)
        || !SHA_RE.test(String(event.execution.sha || ''))) {
      throw new Error(`candidate ${event.candidateId} has no durable execution identity`);
    }
    seen.add(event.candidateId);
    candidates.push(event);
  }
  return candidates;
}

function mergeState(pr) {
  return String(pr?.state || '').toUpperCase() === 'MERGED'
    && Boolean(text(pr?.mergeCommit?.oid) && iso(pr?.mergedAt))
    ? 2
    : (String(pr?.state || '').toUpperCase() === 'OPEN' ? 1 : 0);
}

function choosePullRequest(matches) {
  return [...matches].sort((left, right) => {
    const stateDifference = mergeState(right.pr) - mergeState(left.pr);
    if (stateDifference) return stateDifference;
    const rightTime = Date.parse(right.pr.mergedAt || right.pr.updatedAt || right.pr.createdAt || '') || 0;
    const leftTime = Date.parse(left.pr.mergedAt || left.pr.updatedAt || left.pr.createdAt || '') || 0;
    return rightTime - leftTime || Number(right.pr.number || 0) - Number(left.pr.number || 0);
  })[0] || null;
}

function existingEventTypes(lifecycleEvents) {
  const byCandidate = new Map();
  for (const event of lifecycleEvents) {
    if (!event?.candidateId) continue;
    if (!byCandidate.has(event.candidateId)) byCandidate.set(event.candidateId, new Set());
    byCandidate.get(event.candidateId).add(event.eventType);
  }
  return byCandidate;
}

function observerExecution(execution, loopId, now) {
  if (!object(execution) || !text(execution.runId) || !SHA_RE.test(String(execution.sha || ''))) {
    throw new Error('observer execution must include a durable runId and full SHA');
  }
  return {
    ...execution,
    loopId,
    runId: String(execution.runId),
    sha: String(execution.sha).toLowerCase(),
    recordedAt: text(execution.recordedAt) || now.toISOString(),
  };
}

function observedRecordId(eventType, candidateId, pr, evidence) {
  const basis = [
    'loop-fleet-lifecycle-observer-v1',
    eventType,
    candidateId,
    String(pr.number || ''),
    text(pr.headRefOid) || '',
    evidence.artifactOrPr || '',
    evidence.occurredAt,
  ].join('|');
  return `lf-lifecycle-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

function buildObservedEvent({ candidate, eventType, pr, evidence, execution, now }) {
  if (!OBSERVED_EVENT_TYPES.includes(eventType)) throw new Error(`unsupported observed event ${eventType}`);
  if (!text(evidence?.artifactOrPr) || !validPastTimestamp(evidence.occurredAt, now)) return null;
  const event = buildLifecycleEvent({
    eventType,
    loopId: candidate.loopId,
    candidateId: candidate.candidateId,
    owner: candidate.owner,
    sourceRecordId: candidate.sourceRecordId,
    sourceRefs: candidate.sourceRefs,
    lifecycle: candidate.lifecycle,
    occurredAt: new Date(evidence.occurredAt).toISOString(),
    artifactOrPr: evidence.artifactOrPr,
    recordedAt: now.toISOString(),
  });
  return {
    ...event,
    recordId: observedRecordId(eventType, candidate.candidateId, pr, evidence),
    execution: observerExecution(execution, candidate.loopId, now),
  };
}

function prEvidence(pr) {
  const openedAt = iso(pr?.createdAt);
  if (!openedAt || !text(pr?.url)) return null;
  return { occurredAt: openedAt, artifactOrPr: text(pr.url) };
}

/**
 * Reconstruct only independently observable downstream events. The returned
 * `events` contains new records; existing candidate events are never copied or
 * rewritten, and rollback/inconclusive events are never invented here.
 */
export function observeLifecycle({
  registry,
  lifecycleEvents = [],
  pullRequests = [],
  postMergeRuns = [],
  execution,
  now = new Date(),
} = {}) {
  const validatedRegistry = validateLoopRegistry(registry);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  const candidates = candidateRecords(validatedRegistry, lifecycleEvents);
  const existing = existingEventTypes(lifecycleEvents);
  const sourceToCandidate = new Map();
  for (const candidate of candidates) {
    const sourceKey = `${candidate.loopId}:${candidate.execution.runId}`;
    if (sourceToCandidate.has(sourceKey)) {
      throw new Error(`multiple candidates are attributed to source ${sourceKey}`);
    }
    sourceToCandidate.set(sourceKey, candidate);
  }
  const events = [];
  const matches = [];
  const eligiblePullRequests = (Array.isArray(pullRequests) ? pullRequests : []).filter(isFleetLedgerPr);
  const candidateMatches = new Map();
  for (const pr of eligiblePullRequests) {
    const sourceRuns = extractSourceRuns(pr);
    for (const source of sourceRuns) {
      const candidate = sourceToCandidate.get(`${source.loopId}:${source.runId}`);
      if (!candidate) continue;
      if (!candidateMatches.has(candidate.candidateId)) candidateMatches.set(candidate.candidateId, []);
      candidateMatches.get(candidate.candidateId).push({ candidate, pr });
    }
  }
  for (const candidateMatchesForId of candidateMatches.values()) {
    const selected = choosePullRequest(candidateMatchesForId);
    if (!selected) continue;
    const { candidate, pr } = selected;
    const available = [
      ['pr_opened', prEvidence(pr)],
      ['tests_passed', passedTestsEvidence(pr, now)],
      ['review_approved', approvedReviewEvidence(pr, now)],
      ['merged', mergeEvidence(pr, now)],
      ['post_merge_verified', postMergeEvidence(pr, postMergeRuns, now)],
    ];
    const newlyObserved = [];
    for (const [eventType, evidence] of available) {
      if (!evidence || existing.get(candidate.candidateId)?.has(eventType)) continue;
      const event = buildObservedEvent({
        candidate,
        eventType,
        pr,
        evidence,
        execution,
        now,
      });
      if (!event) continue;
      events.push(event);
      newlyObserved.push(eventType);
      if (!existing.has(candidate.candidateId)) existing.set(candidate.candidateId, new Set());
      existing.get(candidate.candidateId).add(eventType);
    }
    matches.push({
      candidateId: candidate.candidateId,
      loopId: candidate.loopId,
      prNumber: pr.number ?? null,
      prUrl: text(pr.url),
      observed: newlyObserved,
    });
  }
  return {
    schemaVersion: 1,
    observer: 'github-pr-actions-lifecycle',
    generatedAt: now.toISOString(),
    candidateCount: candidates.length,
    eligiblePullRequestCount: eligiblePullRequests.length,
    matchCount: matches.length,
    matches,
    events,
  };
}

/** Read PR and post-merge evidence with the read-only GitHub CLI. */
export function collectGitHubEvidence() {
  // Keep the list query scalar-only. Asking GraphQL for commits, reviews and
  // check rollups on 100 PRs makes gh request an unbounded nested connection
  // and can exceed GitHub's node limit. Enrich only the matching ledger PRs
  // one at a time, still bounded by the list limit.
  const listed = ghJson([
    'pr', 'list', '--state', 'all', '--search', 'loop-fleet', '--limit', '100',
    '--json', 'number,url,title,state,baseRefName,headRefName,headRefOid,createdAt,updatedAt,mergedAt,mergeCommit,body',
  ]);
  const pullRequests = (Array.isArray(listed) ? listed : [])
    .filter(isFleetLedgerPr)
    .map((pr) => ghJson([
      'pr', 'view', String(pr.number),
      '--json', 'number,url,title,state,baseRefName,headRefName,headRefOid,createdAt,updatedAt,mergedAt,mergeCommit,body,commits,reviews,statusCheckRollup',
    ]));
  const workflows = ['loop-fleet-status.yml', 'loop-fleet-ledger-audit.yml'];
  const postMergeRuns = workflows.flatMap((workflow) => {
    const value = ghJson([
      'run', 'list', '--workflow', workflow, '--branch', 'main', '--limit', '100',
      '--json', 'databaseId,status,conclusion,headSha,createdAt,updatedAt,url,workflowName,name',
    ]);
    return Array.isArray(value) ? value : [];
  });
  return {
    pullRequests: Array.isArray(pullRequests) ? pullRequests : [],
    postMergeRuns,
  };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const outDir = path.resolve(valueAfter(argv, '--out-dir', process.env.REPORT_DIR || process.env.RUNNER_TEMP || '/tmp'));
  const registryPath = valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH);
  const ledgerDir = valueAfter(argv, '--ledger-dir', DEFAULT_LEDGER_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const registry = readJson(registryPath, 'loop registry');
  const lifecycleEvents = readJsonl(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'durable lifecycle ledger');
  const github = collectGitHubEvidence();
  const now = new Date();
  const result = observeLifecycle({
    registry,
    lifecycleEvents,
    pullRequests: github.pullRequests,
    postMergeRuns: github.postMergeRuns,
    execution: {
      repository: text(process.env.GITHUB_REPOSITORY),
      workflow: text(process.env.GITHUB_WORKFLOW),
      event: text(process.env.GITHUB_EVENT_NAME),
      ref: text(process.env.GITHUB_REF),
      sha: text(process.env.GITHUB_SHA),
      runId: text(process.env.GITHUB_RUN_ID),
      runAttempt: text(process.env.GITHUB_RUN_ATTEMPT) || '1',
    },
    now,
  });
  const eventFile = path.join(outDir, 'lifecycle-events.jsonl');
  fs.writeFileSync(eventFile, result.events.length
    ? `${result.events.map((event) => JSON.stringify(event)).join('\n')}\n`
    : '');
  fs.writeFileSync(path.join(outDir, 'loop-fleet-lifecycle-observer.json'), `${JSON.stringify({
    ...result,
    eventFile: path.basename(eventFile),
  }, null, 2)}\n`);
  logger.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[loop-fleet-lifecycle-observer] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
