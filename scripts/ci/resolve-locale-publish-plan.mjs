#!/usr/bin/env node
/**
 * Resolve the safe per-locale admission plan for a completed deploy run.
 *
 * The aggregate workflow_run conclusion is intentionally not the admission
 * signal: matrix legs are independently observable. A locale enters
 * `healthyLocales` only when its job succeeded and its receipt proves the
 * exact build id, CDN ordering, and payload artifact. Every other locale is
 * explicitly classified as stale/last-known-good. IT remains mandatory
 * because it owns the Pages artifact and the shared CDN payload.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCALES,
  readLocalePublishProvenanceDirectory,
  validateLocalePublishProvenance,
} from './locale-publish-provenance.mjs';

const TERMINAL_CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'neutral']);
const ADMISSIBLE_RUN_CONCLUSIONS = new Set(['success', 'failure', 'cancelled']);
const PREREQUISITE_NAMES = Object.freeze([
  'validate production promotion trigger',
  'matrix-setup',
  'prep',
]);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeConclusion(value) {
  return text(value).toLowerCase();
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

function blockedPlan({ runConclusion, sourceRunId, sourceSha, reasons, staleReasons = {} }) {
  return {
    allowed: false,
    mode: 'blocked',
    sourceConclusion: runConclusion,
    sourceRunId,
    sourceSha,
    buildId: '',
    healthyLocales: [],
    staleLocales: LOCALES.slice(),
    staleReasons,
    reason: reasons.join('; ') || 'no locale publish plan was admissible',
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
    const expected = buildId || undefined;
    const verdict = validateLocalePublishProvenance(entry.manifest, {
      locale,
      sourceRunId: runId,
      sourceSha: sha,
      expectedBuildId: expected,
      requirePublished: true,
    });
    if (!verdict.valid) {
      const reason = verdict.errors.join('; ');
      manifestFailures[locale] = reason;
      staleReasons[locale] = `provenance rejected: ${reason}`;
      continue;
    }
    if (!buildId) buildId = entry.manifest.buildId;
    healthyLocales.push(locale);
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

  // IT is the one non-negotiable common payload. No amount of healthy
  // per-locale evidence can publish around a missing/invalid IT receipt.
  if (!healthyLocales.includes('it')) {
    reasons.push('IT provenance is missing, invalid, or skewed; refusing all publish side effects');
  }

  if (reasons.length) {
    return blockedPlan({ runConclusion: conclusion, sourceRunId: runId, sourceSha: sha, reasons, staleReasons });
  }

  return {
    allowed: true,
    mode: staleLocales.length ? 'partial' : 'full',
    sourceConclusion: conclusion,
    sourceRunId: runId,
    sourceSha: sha,
    buildId,
    healthyLocales,
    staleLocales,
    staleReasons,
    reason: staleLocales.length
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
    mode: plan.mode,
    build_id: plan.buildId,
    healthy_locales: JSON.stringify(plan.healthyLocales),
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
  const plan = resolveLocalePublishPlan({
    runConclusion: args['run-conclusion'],
    sourceRunId: args['source-run-id'] || '',
    sourceSha: args['source-sha'] || '',
    jobs,
    provenance: loaded.manifests,
    provenanceErrors: loaded.errors,
  });
  writeGithubOutputs(args['github-output'], plan);
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
