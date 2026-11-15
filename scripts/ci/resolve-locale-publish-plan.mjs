#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Resolve the safe per-locale admission plan for a completed deploy run.
 *
 * Matrix legs are independently observable, but a new SEO snapshot is
 * publishable only when every locale has a proven handoff. A locale enters
 * `healthyLocales` only when its job succeeded and its receipt proves the
 * exact build id, CDN ordering, and payload artifact; a source-ready receipt
 * enters `tailLocales` until its post-build shard tail completes. IT's CDN,
 * section, Pages and metadata tail is also owned by deploy-publish.
 * Keeping an old locale shard beside a new IT snapshot breaks the cross-locale
 * hreflang graph, so stale/partial plans are diagnostics and recovery inputs,
 * never publish admission.
 */
import fs from 'node:fs';

import {
  CONTRACT_MISMATCH_VERDICT,
  LOCALES,
  checkPublishContractVersion,
  readLocalePublishProvenanceDirectory,
  validateLocalePublishProvenance,
  validateLocaleSourceProvenance,
} from './locale-publish-provenance.mjs';

/** Reason handed to deploy-rearm-request.mjs when the plan asks for a rebuild. */
export const LEGACY_CONTRACT_RECOVERY_REASON = 'legacy-publish-contract';
export const CONTRACT_MISMATCH_RECOVERY_REASON = CONTRACT_MISMATCH_VERDICT;

const TERMINAL_CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'neutral']);
const ADMISSIBLE_RUN_CONCLUSIONS = new Set(['success']);
const PREREQUISITE_NAMES = Object.freeze([
  'validate production promotion trigger',
  'matrix-setup',
  'prep',
]);
const IT_SHARD_GROUPS = Object.freeze(['zurigo', 'svizzera', 'small-1', 'small-2', 'small-3', 'small-4']);
const PUBLISHER_SOURCE_ARTIFACT_KINDS = Object.freeze([
  'it-publish-root',
  'it-shard-source-plan',
  ...IT_SHARD_GROUPS.map((group) => `it-shard-source-group-${group}`),
  'locale-shard-source-en',
  'locale-shard-source-de',
  'locale-shard-source-fr',
  'sitemap-page-manifest-en',
  'sitemap-page-manifest-de',
  'sitemap-page-manifest-fr',
  'expired-archive-evidence-it',
  'expired-archive-evidence-en',
  'expired-archive-evidence-de',
  'expired-archive-evidence-fr',
  'jobs-master',
]);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeConclusion(value) {
  return text(value).toLowerCase();
}

export function requiredPublisherSourceArtifacts(sourceRunId) {
  const runId = text(sourceRunId);
  return PUBLISHER_SOURCE_ARTIFACT_KINDS.map((kind) => `${kind}-${runId}`);
}

function missingPublisherSourceArtifacts(sourceRunId, payload) {
  const records = Array.isArray(payload) ? payload : payload?.artifacts;
  const artifacts = new Map(
    (Array.isArray(records) ? records : [])
      .map((artifact) => [text(artifact?.name ?? artifact), artifact])
      .filter(([name]) => name),
  );
  return requiredPublisherSourceArtifacts(sourceRunId)
    .filter((name) => !artifacts.has(name) || artifacts.get(name)?.expired === true);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * The non-IT split added both fields to every provenance receipt. A receipt
 * without them was emitted by the pre-split publisher and cannot be handed to
 * the current tail workflow safely: it has no way to prove that the source
 * artifact is the validated handoff rather than the old full-publish payload.
 */
function isLegacyNonItProvenance(manifest) {
  const outcomes = manifest?.outcomes;
  return manifest?.locale !== 'it'
    && outcomes
    && typeof outcomes === 'object'
    && !Array.isArray(outcomes)
    && !hasOwn(outcomes, 'sourceArtifact')
    && !hasOwn(outcomes, 'tailBudget');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unwrapJobs(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.jobs)) return payload.jobs;
  return [];
}

function normalizeJobs(payload) {
  const jobs = unwrapJobs(payload);
  const localeJobs = new Map();
  const prerequisites = new Map();
  const errors = [];
  for (const job of jobs) {
    const name = text(job?.name);
    const conclusion = normalizeConclusion(job?.conclusion);
    const localeMatch = /^build-locale \((it|en|de|fr)\)$/.exec(name);
    if (localeMatch) {
      const locale = localeMatch[1];
      if (localeJobs.has(locale)) errors.push(`duplicate job for ${locale}`);
      else localeJobs.set(locale, { name, conclusion });
      continue;
    }
    if (PREREQUISITE_NAMES.includes(name)) {
      if (prerequisites.has(name)) errors.push(`duplicate prerequisite job ${JSON.stringify(name)}`);
      else prerequisites.set(name, conclusion);
    }
  }
  return { localeJobs, prerequisites, errors };
}

function byLocale(manifests) {
  const map = new Map();
  const errors = [];
  for (const entry of manifests) {
    const locale = entry?.manifest?.locale;
    if (!LOCALES.includes(locale)) {
      errors.push(`${entry.file}: manifest locale is missing or unsupported`);
      continue;
    }
    if (map.has(locale)) errors.push(`duplicate provenance manifest for ${locale}`);
    else map.set(locale, entry);
  }
  return { map, errors };
}

function blockedPlan({
  runConclusion,
  sourceRunId,
  sourceSha,
  reasons,
  staleReasons = {},
  recoveryRequired = false,
  recoveryReasons = [],
  recoveryKind = '',
  legacySourceLocales = [],
  contractMismatchLocales = [],
}) {
  const recoveryReason = recoveryRequired ? recoveryReasons.join('; ') : '';
  const reason = reasons.join('; ') || 'no locale publish plan was admissible';
  return {
    allowed: false,
    mode: 'blocked',
    sourceConclusion: runConclusion,
    sourceRunId,
    sourceSha,
    buildId: '',
    healthyLocales: [],
    tailLocales: [],
    recoveryRequired,
    recoveryKind: recoveryRequired ? recoveryKind : '',
    legacySourceLocales,
    contractMismatchLocales,
    staleLocales: LOCALES.slice(),
    staleReasons,
    reason: [reason, recoveryReason].filter(Boolean).join('; '),
  };
}

/**
 * Resolve a plan from the Jobs API response and downloaded receipts.
 */
export function resolveLocalePublishPlan({
  runConclusion,
  sourceRunId,
  sourceSha,
  jobs,
  provenance = [],
  provenanceErrors = [],
  sourceArtifacts,
}) {
  const conclusion = normalizeConclusion(runConclusion);
  const runId = text(sourceRunId);
  const sha = text(sourceSha);
  const { localeJobs, prerequisites, errors: jobErrors } = normalizeJobs(jobs);
  const { map: manifestMap, errors: manifestErrors } = byLocale(provenance);
  const reasons = [];
  const staleReasons = {};

  if (!ADMISSIBLE_RUN_CONCLUSIONS.has(conclusion)) {
    reasons.push(`workflow_run conclusion ${JSON.stringify(conclusion || '<missing>')} is not terminal/admissible`);
  }
  for (const name of PREREQUISITE_NAMES) {
    const result = prerequisites.get(name);
    if (result !== 'success') reasons.push(`${name} conclusion is ${JSON.stringify(result || '<missing>')}`);
  }
  reasons.push(...jobErrors);
  if (provenanceErrors.length) reasons.push(...provenanceErrors);

  for (const locale of LOCALES) {
    const job = localeJobs.get(locale);
    if (!job) {
      staleReasons[locale] = 'build-locale job is missing from the source run';
      continue;
    }
    if (!TERMINAL_CONCLUSIONS.has(job.conclusion)) {
      reasons.push(`${job.name} conclusion ${JSON.stringify(job.conclusion || '<missing>')} is not terminal`);
    }
    if (job.conclusion !== 'success') staleReasons[locale] = `source job concluded ${job.conclusion || '<missing>'}`;
  }

  const itJob = localeJobs.get('it');
  if (!itJob || itJob.conclusion !== 'success') {
    reasons.push('IT locale is not a successful source job; Pages/CDN ownership cannot be proven');
  }

  // A receipt for a successful source leg is required. A failed/cancelled leg
  // is deliberately allowed to have no receipt because cancellation can stop
  // the final `always()` upload before GitHub persists an artifact.
  const healthyLocales = [];
  const tailLocales = [];
  const legacySourceLocales = [];
  const contractMismatchLocales = [];
  const manifestFailures = {};
  let buildId = '';
  for (const locale of LOCALES) {
    const job = localeJobs.get(locale);
    if (!job || job.conclusion !== 'success') continue;
    const entry = manifestMap.get(locale);
    if (!entry) {
      const reason = 'successful source job has no provenance receipt';
      manifestFailures[locale] = reason;
      staleReasons[locale] = reason;
      continue;
    }
    // The publisher toolchain is pinned to its own SHA, not to the build's.
    // A receipt stamped with a contract this toolchain cannot read is not
    // transient: the verdict is `contract-mismatch` and the remedy a rebuild.
    const contract = checkPublishContractVersion(entry.manifest);
    if (!contract.ok) {
      contractMismatchLocales.push(locale);
      manifestFailures[locale] = `${contract.verdict}: ${contract.reason}`;
      staleReasons[locale] = `${contract.verdict}: ${contract.reason}`;
      continue;
    }
    const expected = buildId || undefined;
    const verdict = validateLocalePublishProvenance(entry.manifest, {
      locale,
      sourceRunId: runId,
      sourceSha: sha,
      expectedBuildId: expected,
      requirePublished: true,
    });
    if (verdict.valid) {
      if (!buildId) buildId = entry.manifest.buildId;
      healthyLocales.push(locale);
      continue;
    }

    // Every locale now hands off a validated immutable source artifact to
    // deploy-publish.yml. IT's larger CDN/section/Pages tail joins the same
    // cross-run workflow, so source readiness alone never proves publication.
    const sourceVerdict = validateLocaleSourceProvenance(entry.manifest, {
      locale,
      sourceRunId: runId,
      sourceSha: sha,
      expectedBuildId: expected,
      expectedArtifactRunId: runId,
    });
    if (sourceVerdict.valid) {
      if (!buildId) buildId = entry.manifest.buildId;
      tailLocales.push(locale);
      staleReasons[locale] = locale === 'it'
        ? 'validated IT source artifacts awaiting the post-build CDN, section, and Pages tail'
        : 'validated source artifact awaiting the post-build non-IT shard tail';
      continue;
    }
    if (isLegacyNonItProvenance(entry.manifest)) legacySourceLocales.push(locale);
    const reason = `${verdict.errors.join('; ')}; source handoff rejected: ${sourceVerdict.errors.join('; ')}`;
    manifestFailures[locale] = reason;
    staleReasons[locale] = `provenance rejected: ${reason}`;
    continue;
  }

  if (healthyLocales.includes('it')) {
    // Re-check every admitted receipt against IT's build id. This is the
    // cross-locale skew gate: one source run cannot announce mixed snapshots.
    for (const locale of healthyLocales.slice()) {
      const entry = manifestMap.get(locale);
      if (entry.manifest.buildId !== buildId || entry.manifest.cdnBuildId !== buildId) {
        const reason = `build-id skew: buildId=${JSON.stringify(entry.manifest.buildId)} cdnBuildId=${JSON.stringify(entry.manifest.cdnBuildId)} expected=${JSON.stringify(buildId)}`;
        manifestFailures[locale] = reason;
        staleReasons[locale] = `provenance rejected: ${reason}`;
        healthyLocales.splice(healthyLocales.indexOf(locale), 1);
      }
    }
  }

  for (const [locale, reason] of Object.entries(manifestFailures)) {
    if (!staleReasons[locale]) staleReasons[locale] = reason;
  }
  const staleLocales = LOCALES.filter((locale) => !healthyLocales.includes(locale));
  for (const locale of staleLocales) {
    if (!staleReasons[locale]) staleReasons[locale] = 'not admitted; keep the last-known-good locale shard';
  }

  const missingPublisherArtifacts = sourceArtifacts === undefined
    ? []
    : missingPublisherSourceArtifacts(runId, sourceArtifacts);
  if (missingPublisherArtifacts.length > 0) {
    reasons.push(
      `source build is missing publisher fast-gate artifacts: ${missingPublisherArtifacts.join(', ')}`,
    );
  }

  // IT is the one non-negotiable common payload. No amount of healthy
  // per-locale evidence can publish around a missing/invalid IT receipt.
  if (!healthyLocales.includes('it') && !tailLocales.includes('it')) {
    reasons.push('IT provenance is missing, invalid, or skewed; refusing all publish side effects');
  }

  // A source-ready receipt is not live yet, but is a complete input for the
  // deferred tail. Anything outside the union of healthy + tail
  // locales means the new snapshot cannot produce a complete hreflang graph.
  const sourceReadyLocales = new Set([...healthyLocales, ...tailLocales]);
  const sourceIncompleteLocales = LOCALES.filter((locale) => !sourceReadyLocales.has(locale));
  if (sourceIncompleteLocales.length) {
    reasons.push(`source locale handoff is incomplete for ${sourceIncompleteLocales.join(', ')}; refusing publish`);
  }

  const recoveryReasons = [];
  if (contractMismatchLocales.length > 0) {
    reasons.push(
      `${CONTRACT_MISMATCH_VERDICT} for ${contractMismatchLocales.join(', ')}: the source build speaks a publish contract this toolchain does not accept`,
    );
    recoveryReasons.push(
      `${CONTRACT_MISMATCH_VERDICT} for ${contractMismatchLocales.join(', ')}; enqueue one current build request, retrying this publish cannot succeed`,
    );
  }
  if (legacySourceLocales.length > 0) {
    recoveryReasons.push(
      `legacy non-IT provenance contract detected for ${legacySourceLocales.join(', ')}; enqueue one current build request to replay the split handoff`,
    );
  }
  if (missingPublisherArtifacts.length > 0) {
    recoveryReasons.push(
      'source build predates or did not emit the publisher fast-gate receipt contract; enqueue one current build request before validation',
    );
  }
  const recoveryRequired = recoveryReasons.length > 0;
  const recoveryKind = !recoveryRequired
    ? ''
    : contractMismatchLocales.length > 0
      ? CONTRACT_MISMATCH_RECOVERY_REASON
      : LEGACY_CONTRACT_RECOVERY_REASON;

  if (reasons.length) {
    return blockedPlan({
      runConclusion: conclusion,
      sourceRunId: runId,
      sourceSha: sha,
      reasons,
      staleReasons,
      recoveryRequired,
      recoveryReasons,
      recoveryKind,
      legacySourceLocales,
      contractMismatchLocales,
    });
  }

  const recoveryReason = recoveryReasons.join('; ');

  return {
    allowed: true,
    mode: staleLocales.length ? 'partial' : 'full',
    sourceConclusion: conclusion,
    sourceRunId: runId,
    sourceSha: sha,
    buildId,
    healthyLocales,
    tailLocales,
    recoveryRequired,
    recoveryKind,
    legacySourceLocales,
    contractMismatchLocales,
    staleLocales,
    staleReasons,
    reason: recoveryRequired
      ? `${recoveryReason}; stale fallback for ${staleLocales.join(', ')}`
      : staleLocales.length
        ? `admitted ${healthyLocales.join(', ')}; stale fallback for ${staleLocales.join(', ')}`
        : `admitted all locales at build id ${buildId}`,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    args[key] = argv[i + 1]?.startsWith('--') ? true : (argv[i + 1] ?? true);
    if (args[key] !== true) i += 1;
  }
  return args;
}

function writeGithubOutputs(file, plan) {
  if (!file) return;
  const lines = {
    allowed: String(plan.allowed),
    it_admitted: String(plan.healthyLocales.includes('it') || plan.tailLocales.includes('it')),
    mode: plan.mode,
    build_id: plan.buildId,
    healthy_locales: JSON.stringify(plan.healthyLocales),
    tail_locales: JSON.stringify(plan.tailLocales || []),
    recovery_required: String(plan.recoveryRequired === true),
    recovery_reason: plan.recoveryKind || '',
    stale_locales: JSON.stringify(plan.staleLocales),
    stale_reasons: JSON.stringify(plan.staleReasons),
    reason: plan.reason,
  };
  fs.appendFileSync(file, `${Object.entries(lines).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['jobs-file'] || !args['run-conclusion']) {
    console.error('Usage: resolve-locale-publish-plan.mjs --jobs-file <file> --provenance-dir <dir> --run-conclusion <conclusion> --source-run-id <id> --source-sha <sha>');
    process.exitCode = 2;
    return;
  }
  const jobs = readJson(args['jobs-file']);
  const loaded = readLocalePublishProvenanceDirectory(args['provenance-dir']);
  const sourceArtifacts = args['source-artifacts-file']
    ? readJson(args['source-artifacts-file'])
    : undefined;
  const plan = resolveLocalePublishPlan({
    runConclusion: args['run-conclusion'],
    sourceRunId: args['source-run-id'] || '',
    sourceSha: args['source-sha'] || '',
    jobs,
    provenance: loaded.manifests,
    provenanceErrors: loaded.errors,
    sourceArtifacts,
  });
  writeGithubOutputs(args['github-output'], plan);
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) main();
