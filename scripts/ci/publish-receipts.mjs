#!/usr/bin/env node

/**
 * Durable handoff state for the build -> shard/Pages publisher.
 *
 * Artifacts describe what a particular Actions run produced, but they are not
 * an idempotency record for a later retry. These commit statuses are keyed by
 * the immutable source SHA and a source run id, so a retry can prove that a
 * locale shard or the Pages deployment already succeeded without looking at
 * the aggregate conclusion of the old publish run.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import {
  IT_SHARD_GROUP_IDS,
  expectedItGroupDigests,
  itShardGroupPlanDigest,
  validateItShardGroupPlan,
} from './it-shard-group-contract.mjs';

export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const PAGES_RECEIPT_PREFIX = 'frontaliere/pages-deployed';
export const LOCALE_RECEIPT_PREFIX = 'frontaliere/shard-published';
/** The IT CDN payload of one source run is live (written by publish-it-cdn). */
export const IT_CDN_RECEIPT_PREFIX = 'frontaliere/it-cdn-published';
/** One IT section group of one source run is pushed (written by each group job). */
export const IT_GROUP_RECEIPT_PREFIX = 'frontaliere/it-group-published';
/**
 * GitHub keeps at most 1000 statuses per SHA and context. A receipt context is
 * unique per source run (and group), so it only approaches the cap through many
 * retries of the same run; refuse to write near it rather than lose the newest
 * receipt silently. The margin is generous on purpose.
 */
export const MAX_RECEIPT_STATUSES_PER_CONTEXT = 900;
/** GitHub rejects a status description longer than 140 characters. */
const STATUS_DESCRIPTION_MAX = 140;

const SHA_RE = /^[0-9a-f]{40}$/i;
const RUN_ID_RE = /^\d+$/;
const STATUS_SUCCESS = 'success';
const STATUS_READ_MAX_ATTEMPTS = 4;
const STATUS_READ_BACKOFF_MS = Object.freeze([1000, 3000, 7000]);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function validateRunId(sourceRunId) {
  const value = text(sourceRunId);
  return RUN_ID_RE.test(value) ? value : '';
}

function validateSha(sourceSha) {
  const value = text(sourceSha);
  return SHA_RE.test(value) ? value : '';
}

export function pagesReceiptContext(sourceRunId) {
  const runId = validateRunId(sourceRunId);
  return runId ? `${PAGES_RECEIPT_PREFIX}/${runId}` : '';
}

export function localeReceiptContext(sourceRunId, locale) {
  const runId = validateRunId(sourceRunId);
  const normalizedLocale = text(locale).toLowerCase();
  return runId && LOCALES.includes(normalizedLocale)
    ? `${LOCALE_RECEIPT_PREFIX}/${runId}/${normalizedLocale}`
    : '';
}

/** Exact allowlist check: the only IT group names that exist are the planned ones. */
export function assertItGroup(group) {
  if (typeof group !== 'string' || !IT_SHARD_GROUP_IDS.includes(group)) {
    throw new Error(`IT group ${JSON.stringify(group ?? null)} is not in the allowlist (${IT_SHARD_GROUP_IDS.join(', ')})`);
  }
  return group;
}

export function itCdnReceiptContext(sourceRunId) {
  const runId = validateRunId(sourceRunId);
  return runId ? `${IT_CDN_RECEIPT_PREFIX}/${runId}` : '';
}

/** `''` for a malformed run id or a group outside the allowlist. */
export function itGroupReceiptContext(sourceRunId, group) {
  const runId = validateRunId(sourceRunId);
  return runId && typeof group === 'string' && IT_SHARD_GROUP_IDS.includes(group)
    ? `${IT_GROUP_RECEIPT_PREFIX}/${runId}/${group}`
    : '';
}

/** Name of the artifact an IT group job uploads with its ok-markers and tars. */
export function itGroupResultArtifactName(group, sourceRunId) {
  return `it-shard-result-group-${assertItGroup(group)}-${validateRunId(sourceRunId)}`;
}

/**
 * Durable copy of the R2 OG manifest, uploaded by publish-it-cdn BEFORE its
 * receipt (actions/cache saves are best-effort and per-run, an artifact upload
 * really fails). It is what lets a retry skip the CDN job without losing the
 * delta base of deploy-it-pages-prep.sh.
 */
export function itCdnManifestArtifactName(sourceRunId) {
  return `r2-og-manifest-it-${validateRunId(sourceRunId)}`;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function formatItGroupReceiptDescription({ group, digest }) {
  assertItGroup(group);
  if (!SHA256_HEX_RE.test(text(digest))) throw new Error('IT group receipt digest must be a sha256 hex string');
  return `IT section group ${group} published; digest=${text(digest)}`;
}

export function parseItGroupReceiptDescription(description) {
  const match = /^IT section group ([a-z0-9-]+) published; digest=([0-9a-f]{64})$/.exec(text(description));
  return match ? { group: match[1], digest: match[2] } : null;
}

export function formatItCdnReceiptDescription({ sourceRunId, buildId }) {
  const runId = validateRunId(sourceRunId);
  if (!runId) throw new Error('source run id is missing or malformed');
  const build = text(buildId);
  return build && RUN_ID_RE.test(build)
    ? `IT CDN published for source run ${runId} build ${build}`
    : `IT CDN published for source run ${runId}`;
}

function parseItCdnReceiptBuildId(description) {
  const match = /\bbuild (\d+)$/.exec(text(description));
  return match ? match[1] : '';
}

function statusContext(status) {
  return text(status?.context);
}

function statusSucceeded(status, context) {
  return statusContext(status) === context && text(status?.state).toLowerCase() === STATUS_SUCCESS;
}

/**
 * Resolve the durable state for one source run from the commit status list.
 * Unknown/malformed status entries are ignored; absence is deliberately not
 * treated as success.
 */
export function resolvePublishReceipts({ statuses = [], sourceRunId, locales = LOCALES } = {}) {
  const entries = Array.isArray(statuses) ? statuses : [];
  const pagesContext = pagesReceiptContext(sourceRunId);
  const requestedLocales = [...new Set(
    (Array.isArray(locales) ? locales : [])
      .map((locale) => text(locale).toLowerCase())
      .filter((locale) => LOCALES.includes(locale)),
  )];
  const publishedLocales = requestedLocales.filter((locale) => entries.some((status) => statusSucceeded(
    status,
    localeReceiptContext(sourceRunId, locale),
  )));
  const pendingLocales = requestedLocales.filter((locale) => !publishedLocales.includes(locale));
  const pendingNonItLocales = pendingLocales.filter((locale) => locale !== 'it');
  return {
    pagesDeployed: Boolean(pagesContext && entries.some((status) => statusSucceeded(status, pagesContext))),
    publishedLocales,
    pendingLocales,
    pendingNonItLocales,
    pagesContext,
    localeContexts: Object.fromEntries(requestedLocales.map((locale) => [
      locale,
      localeReceiptContext(sourceRunId, locale),
    ])),
  };
}

function statusTime(status) {
  const stamp = Date.parse(text(status?.updated_at) || text(status?.created_at));
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * The newest status of one context decides. The statuses API already lists the
 * newest first, but the order is not relied on when timestamps are present.
 */
function newestStatusFor(statuses, context) {
  const matching = (Array.isArray(statuses) ? statuses : [])
    .map((status, index) => ({ status, index }))
    .filter(({ status }) => statusContext(status) === context);
  matching.sort((a, b) => (statusTime(b.status) - statusTime(a.status)) || (a.index - b.index));
  return matching[0]?.status ?? null;
}

function publisherRunIdOf(status) {
  const match = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(text(status?.target_url));
  return match ? match[1] : '';
}

/**
 * What a retry of one source run still has to do on the IT side.
 *
 * - `itCdnPublished`: the CDN payload receipt exists (and, when the build id is
 *   known, was written for that build).
 * - `itCdnPublisherRunId`: the publisher run that wrote the CDN receipt, when
 *   the receipt is valid and can safely supply its durable R2 manifest.
 * - `pendingItGroups`: every group that has no valid receipt, in canonical
 *   order. A receipt is valid only when its newest status is a success, its
 *   digest equals the digest the source plan expects, the publisher run that
 *   wrote it is recoverable, and that run's result artifact (ok-markers,
 *   section manifests, tars) is still downloadable. Without a readable plan
 *   (`expectedDigests` null) nothing is skipped: the cost of doubt is more
 *   work, never a group left unpublished.
 */
export function resolveItPublishReceipts({
  statuses = [],
  sourceRunId,
  buildId,
  expectedDigests = null,
  artifactAvailable = () => true,
  cdnManifestRequired = false,
  cdnManifestAvailable = () => true,
} = {}) {
  const entries = Array.isArray(statuses) ? statuses : [];
  const cdnContext = itCdnReceiptContext(sourceRunId);
  const cdnStatus = cdnContext ? newestStatusFor(entries, cdnContext) : null;
  const expectedBuild = text(buildId);
  // The publisher run that wrote the CDN receipt also holds the durable R2 OG
  // manifest artifact the finalizer restores in place of the per-run cache, so a
  // receipt whose run cannot be recovered is not a receipt.
  const cdnPublisherRunId = publisherRunIdOf(cdnStatus);
  const cdnReceiptValid = Boolean(cdnStatus
    && text(cdnStatus.state).toLowerCase() === STATUS_SUCCESS
    && (!expectedBuild || parseItCdnReceiptBuildId(cdnStatus.description) === expectedBuild)
    && cdnPublisherRunId);
  const itCdnPublisherRunId = cdnReceiptValid ? cdnPublisherRunId : '';
  // With an R2 CDN target the receipt is only as good as the manifest behind it:
  // skipping the CDN job is allowed solely when that manifest can be restored,
  // otherwise the finalizer's deploy prep would re-upload the whole og tree.
  const cdnRejectedReason = !cdnReceiptValid ? ''
    : !cdnManifestRequired ? ''
      : !cdnManifestAvailable({ publisherRunId: itCdnPublisherRunId }) ? 'r2-manifest-artifact-unavailable'
        : '';
  const itCdnPublished = cdnReceiptValid && !cdnRejectedReason;

  const publishedItGroups = [];
  const pendingItGroups = [];
  const rejectedItGroups = [];
  for (const group of IT_SHARD_GROUP_IDS) {
    const context = itGroupReceiptContext(sourceRunId, group);
    const status = context ? newestStatusFor(entries, context) : null;
    if (!status || text(status.state).toLowerCase() !== STATUS_SUCCESS) {
      pendingItGroups.push(group);
      continue;
    }
    const expected = expectedDigests && typeof expectedDigests === 'object' ? text(expectedDigests[group]) : '';
    const parsed = parseItGroupReceiptDescription(status.description);
    const publisherRunId = publisherRunIdOf(status);
    let reason = '';
    if (!expected) reason = 'no-expected-digest';
    else if (!parsed || parsed.group !== group || parsed.digest !== expected) reason = 'digest-mismatch';
    else if (!publisherRunId) reason = 'no-publisher-run';
    else if (!artifactAvailable({ group, publisherRunId })) reason = 'result-artifact-unavailable';
    if (reason) {
      pendingItGroups.push(group);
      if (reason !== 'no-expected-digest') rejectedItGroups.push({ group, reason });
      continue;
    }
    publishedItGroups.push({ group, digest: expected, publisherRunId });
  }
  return {
    itCdnPublished,
    itCdnPublisherRunId: itCdnPublished ? itCdnPublisherRunId : '',
    itCdnRejectedReason: cdnRejectedReason,
    pendingItGroups,
    publishedItGroups,
    rejectedItGroups,
    itCdnContext: cdnContext,
    itGroupContexts: Object.fromEntries(IT_SHARD_GROUP_IDS.map((group) => [group, itGroupReceiptContext(sourceRunId, group)])),
  };
}

/**
 * Files an IT group job must have produced for each assigned section before its
 * receipt may be written (relative to the runner temp dir). Empty when complete.
 */
export function missingItGroupResults({ plan, group, resultsDir }) {
  assertItGroup(group);
  const assigned = (Array.isArray(plan?.groups) ? plan.groups : []).find((candidate) => candidate?.id === group)?.sections;
  if (!Array.isArray(assigned) || assigned.length === 0) {
    throw new Error(`IT group ${group} has no assigned sections in the publication plan`);
  }
  const missing = [];
  const present = (relative, minBytes) => {
    try {
      const stat = fs.statSync(path.join(resultsDir, relative));
      return stat.isFile() && stat.size >= minBytes;
    } catch {
      return false;
    }
  };
  for (const section of assigned) {
    if (!present(`shard-ok-${section}-it`, 0)) missing.push(`shard-ok-${section}-it`);
    if (!present(`shard-content-manifests/it/${section}.json`, 1)) missing.push(`shard-content-manifests/it/${section}.json`);
    if (!present(`it-shard-results/${section}-dist-it.tar`, 1)) missing.push(`it-shard-results/${section}-dist-it.tar`);
  }
  return missing;
}

function requireWorkflowContext() {
  const repo = text(process.env.GITHUB_REPOSITORY);
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is missing or malformed');
  const token = text(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return { repo, token };
}

function gh(args, { maxBuffer = 2 * 1024 * 1024 } = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  }).trim();
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter((value) => value != null)
    .map(String)
    .join('\n');
}

/**
 * GitHub's status endpoint occasionally returns a transient gateway or
 * transport error. These failures are safe to retry because the operation is
 * a read and the receipt resolver remains fail-closed if all attempts fail.
 */
export function isRetryableGithubReadError(error) {
  const detail = errorText(error);
  return /\bHTTP\s+(?:408|425|429|500|502|503|504)\b/i.test(detail)
    || /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i.test(detail)
    || /\b(?:bad\s+gateway|gateway\s+timeout|temporarily\s+unavailable|timed?\s*out)\b/i.test(detail);
}

function sleepMs(delayMs) {
  if (delayMs <= 0) return;
  execFileSync('sleep', [String(delayMs / 1000)], { stdio: 'ignore' });
}

/**
 * Run a read with bounded retry/backoff. The injectable sleep and retry hook
 * keep the policy directly testable without waiting in unit tests.
 */
export function withGithubReadRetry(operation, {
  maxAttempts = STATUS_READ_MAX_ATTEMPTS,
  backoffMs = STATUS_READ_BACKOFF_MS,
  sleep = sleepMs,
  onRetry = (attempt, delayMs) => {
    console.warn(`::warning::transient GitHub API read failure on attempt ${attempt}; retrying in ${delayMs}ms`);
  },
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableGithubReadError(error)) throw error;
      const delayMs = Number(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0);
      onRetry(attempt, delayMs);
      sleep(delayMs);
    }
  }
  throw lastError;
}

function listStatuses(repo, sourceSha) {
  const sha = validateSha(sourceSha);
  if (!sha) throw new Error('source SHA is missing or malformed');
  // A long-lived commit can accumulate more than one page of statuses after
  // the receipt was written. `--paginate --slurp` keeps the durable marker
  // readable instead of silently losing it behind the newest 100 entries.
  const raw = withGithubReadRetry(() => gh([
    'api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/statuses?per_page=100`,
  ]));
  const pages = JSON.parse(raw || '[]');
  if (!Array.isArray(pages)) throw new Error('commit status response is malformed');
  const statuses = pages.flatMap((page) => {
    if (!Array.isArray(page)) throw new Error('commit status page is malformed');
    return page;
  });
  return statuses;
}

function writeGithubOutputs(file, state, itState = null) {
  if (!file) return;
  const itLines = itState
    ? [
      `it_cdn_published=${itState.itCdnPublished}`,
      `it_cdn_publisher_run_id=${itState.itCdnPublisherRunId}`,
      `pending_it_groups=${JSON.stringify(itState.pendingItGroups)}`,
      `receipt_it_groups=${JSON.stringify(itState.publishedItGroups.map((entry) => ({ group: entry.group, runId: entry.publisherRunId })))}`,
    ]
    : [];
  const lines = [
    ...itLines,
    `pages_deployed=${state.pagesDeployed}`,
    `published_locales=${JSON.stringify(state.publishedLocales)}`,
    `published_locales_csv=${state.publishedLocales.join(',')}`,
    `pending_locales=${JSON.stringify(state.pendingLocales)}`,
    `pending_locales_csv=${state.pendingLocales.join(',')}`,
    `pending_nonit_locales=${JSON.stringify(state.pendingNonItLocales)}`,
    `pending_nonit_locales_csv=${state.pendingNonItLocales.join(',')}`,
    `pages_context=${state.pagesContext}`,
  ];
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

function writeReceipt({ kind, sourceRunId, sourceSha, locale }) {
  const { repo } = requireWorkflowContext();
  const runId = validateRunId(sourceRunId);
  const sha = validateSha(sourceSha);
  if (!runId) throw new Error('source run id is missing or malformed');
  if (!sha) throw new Error('source SHA is missing or malformed');
  const context = kind === 'pages'
    ? pagesReceiptContext(runId)
    : localeReceiptContext(runId, locale);
  if (!context) throw new Error(`unsupported receipt kind/locale: ${kind}/${locale || ''}`);
  const normalizedLocale = text(locale).toLowerCase();
  const description = kind === 'pages'
    ? `Pages deploy succeeded for source run ${runId}`
    : `Shard push succeeded for ${normalizedLocale} source run ${runId}`;
  const targetUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  gh([
    'api',
    '--method', 'POST',
    `repos/${repo}/statuses/${sha}`,
    '--field', `state=${STATUS_SUCCESS}`,
    '--field', `context=${context}`,
    '--field', `description=${description}`,
    '--field', `target_url=${targetUrl}`,
  ]);
  console.log(JSON.stringify({ kind, sourceRunId: runId, sourceSha: sha, locale: normalizedLocale || null, context }));
}

function postSuccessStatus({ repo, sha, context, description, targetUrl }) {
  if (description.length > STATUS_DESCRIPTION_MAX) {
    throw new Error(`status description is ${description.length} characters, GitHub accepts at most ${STATUS_DESCRIPTION_MAX}`);
  }
  gh([
    'api',
    '--method', 'POST',
    `repos/${repo}/statuses/${sha}`,
    '--field', `state=${STATUS_SUCCESS}`,
    '--field', `context=${context}`,
    '--field', `description=${description}`,
    '--field', `target_url=${targetUrl}`,
  ]);
}

function assertBelowStatusCap(statuses, context) {
  const count = statuses.filter((status) => statusContext(status) === context).length;
  if (count >= MAX_RECEIPT_STATUSES_PER_CONTEXT) {
    throw new Error(`${context} already has ${count} statuses on this SHA (GitHub keeps at most 1000); refusing to write another`);
  }
}

function writeItCdnReceipt({ sourceRunId, sourceSha, buildId, publisherRunId }) {
  const { repo } = requireWorkflowContext();
  const runId = validateRunId(sourceRunId);
  const sha = validateSha(sourceSha);
  if (!runId) throw new Error('source run id is missing or malformed');
  if (!sha) throw new Error('source SHA is missing or malformed');
  const context = itCdnReceiptContext(runId);
  const statuses = listStatuses(repo, sha);
  assertBelowStatusCap(statuses, context);
  postSuccessStatus({
    repo,
    sha,
    context,
    description: formatItCdnReceiptDescription({ sourceRunId: runId, buildId }),
    targetUrl: `https://github.com/${repo}/actions/runs/${validateRunId(publisherRunId) || runId}`,
  });
  console.log(JSON.stringify({ kind: 'it-cdn', sourceRunId: runId, sourceSha: sha, context }));
}

function writeItGroupReceipt({ sourceRunId, sourceSha, group, planFile, resultsDir, publisherRunId }) {
  const { repo } = requireWorkflowContext();
  const runId = validateRunId(sourceRunId);
  const sha = validateSha(sourceSha);
  assertItGroup(group);
  if (!runId) throw new Error('source run id is missing or malformed');
  if (!sha) throw new Error('source SHA is missing or malformed');
  const publisherRun = validateRunId(publisherRunId);
  if (!publisherRun) throw new Error('publisher run id is missing or malformed');
  if (!planFile) throw new Error('--plan is required to write an IT group receipt');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const verdict = validateItShardGroupPlan(plan, { sourceRunId: runId, sourceSha: sha });
  if (!verdict.valid) throw new Error(`IT publication plan is invalid: ${verdict.errors.join('; ')}`);
  const missing = missingItGroupResults({ plan, group, resultsDir });
  if (missing.length) throw new Error(`IT group ${group} has no proof of its push yet, missing: ${missing.join(', ')}`);
  const digest = itShardGroupPlanDigest(plan, group);
  const context = itGroupReceiptContext(runId, group);
  const statuses = listStatuses(repo, sha);
  const newest = newestStatusFor(statuses, context);
  const targetUrl = `https://github.com/${repo}/actions/runs/${publisherRun}`;
  if (newest
    && text(newest.state).toLowerCase() === STATUS_SUCCESS
    && parseItGroupReceiptDescription(newest.description)?.digest === digest
    && publisherRunIdOf(newest) === publisherRun) {
    console.log(JSON.stringify({ kind: 'it-group', group, sourceRunId: runId, context, written: false, reason: 'identical receipt already present' }));
    return;
  }
  assertBelowStatusCap(statuses, context);
  postSuccessStatus({ repo, sha, context, description: formatItGroupReceiptDescription({ group, digest }), targetUrl });
  console.log(JSON.stringify({ kind: 'it-group', group, sourceRunId: runId, sourceSha: sha, context, digest, written: true }));
}

/** `true` when `name` is listed, unexpired, among the artifacts of `runId`. */
/** `(publisherRunId, name) => boolean`: listed and unexpired among that run's artifacts. */
function artifactLister(repo) {
  const cache = new Map();
  return (publisherRunId, wanted) => {
    if (!cache.has(publisherRunId)) {
      let names = new Set();
      try {
        const raw = withGithubReadRetry(() => gh([
          'api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${publisherRunId}/artifacts?per_page=100`,
        ]));
        const pages = JSON.parse(raw || '[]');
        names = new Set((Array.isArray(pages) ? pages : [])
          .flatMap((page) => (Array.isArray(page?.artifacts) ? page.artifacts : []))
          .filter((artifact) => artifact?.expired !== true)
          .map((artifact) => text(artifact?.name)));
      } catch {
        // Unreadable listing: treat every artifact of that run as unavailable.
        names = new Set();
      }
      cache.set(publisherRunId, names);
    }
    return cache.get(publisherRunId).has(wanted);
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    args[key] = argv[index + 1]?.startsWith('--') ? true : (argv[index + 1] ?? true);
    if (args[key] !== true) index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.resolve) {
    const { repo } = requireWorkflowContext();
    const sourceRunId = validateRunId(args['source-run-id']);
    if (!sourceRunId) throw new Error('source run id is missing or malformed');
    const statuses = listStatuses(repo, args['source-sha']);
    const state = resolvePublishReceipts({
      statuses,
      sourceRunId,
      locales: args.locales === undefined || args.locales === true
        ? LOCALES
        : String(args.locales).split(','),
    });
    let itState = null;
    if (args['it-plan'] !== undefined) {
      // Only the publisher resolver (resolve-publish-receipts) asks for the IT
      // side. A plan that is missing, unreadable or for another source leaves
      // `expectedDigests` null, so no group is skipped.
      let expectedDigests = null;
      try {
        const plan = JSON.parse(fs.readFileSync(String(args['it-plan']), 'utf8'));
        const verdict = validateItShardGroupPlan(plan, { sourceRunId, sourceSha: args['source-sha'] });
        if (verdict.valid) expectedDigests = expectedItGroupDigests(plan);
        else console.warn(`::warning::IT publication plan is not usable for receipts (${verdict.errors.join('; ')}); every IT group stays pending`);
      } catch (error) {
        console.warn(`::warning::IT publication plan is unreadable (${error?.message || error}); every IT group stays pending`);
      }
      const hasArtifact = artifactLister(repo);
      itState = resolveItPublishReceipts({
        statuses,
        sourceRunId,
        buildId: text(args['build-id']) || undefined,
        expectedDigests,
        artifactAvailable: ({ group, publisherRunId }) => hasArtifact(publisherRunId, itGroupResultArtifactName(group, sourceRunId)),
        cdnManifestRequired: text(args['cdn-manifest-required']) === 'true',
        cdnManifestAvailable: ({ publisherRunId }) => hasArtifact(publisherRunId, itCdnManifestArtifactName(sourceRunId)),
      });
    }
    writeGithubOutputs(args['github-output'], state, itState);
    console.log(JSON.stringify(itState ? { ...state, it: itState } : state));
    return;
  }
  if (args.write === 'it-cdn') {
    writeItCdnReceipt({
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      buildId: args['build-id'],
      publisherRunId: args['publisher-run-id'] || process.env.GITHUB_RUN_ID,
    });
    return;
  }
  if (args.write === 'it-group') {
    writeItGroupReceipt({
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      group: args.group,
      planFile: args.plan,
      resultsDir: args['results-dir'],
      publisherRunId: args['publisher-run-id'] || process.env.GITHUB_RUN_ID,
    });
    return;
  }
  if (args.write) {
    writeReceipt({
      kind: text(args.write),
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      locale: args.locale,
    });
    return;
  }
  console.error('Usage: publish-receipts.mjs --resolve --source-run-id <id> --source-sha <sha> [--github-output <file>] [--it-plan <file> --build-id <id> [--cdn-manifest-required true]] | --write pages|locale --source-run-id <id> --source-sha <sha> [--locale <locale>] | --write it-cdn --source-run-id <id> --source-sha <sha> --build-id <id> | --write it-group --source-run-id <id> --source-sha <sha> --group <group> --plan <file> --results-dir <dir>');
  process.exitCode = 2;
}

if (process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})()) {
  try {
    main();
  } catch (error) {
    console.error(`::error::publish receipt failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
