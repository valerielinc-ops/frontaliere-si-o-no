#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Admit the post-build shard tails completed by deploy-publish.yml.
 *
 * The source build plan leaves en/de/fr source-ready while their validated
 * artifacts cross the workflow boundary. This resolver promotes a locale only
 * after the post-build receipt proves the full tail and the receipt artifact
 * belongs to this publish run. An incomplete IT tail blocks Pages; incomplete
 * non-IT tails keep serving their previous shards.
 */
import fs from 'node:fs';

import {
  LOCALES,
  readLocalePublishProvenanceDirectory,
  validateLocalePublishProvenance,
} from './locale-publish-provenance.mjs';


function text(value) {
  return value == null ? '' : String(value).trim();
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  try {
    const parsed = JSON.parse(text(value) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueLocales(values) {
  return [...new Set(values.filter((locale) => LOCALES.includes(locale)))];
}

function manifestMap(entries) {
  const map = new Map();
  const errors = [];
  for (const entry of entries) {
    const locale = entry?.manifest?.locale;
    if (!LOCALES.includes(locale)) {
      errors.push(`${entry.file}: manifest locale is missing or unsupported`);
    } else if (map.has(locale)) {
      errors.push(`duplicate provenance manifest for ${locale}`);
    } else {
      map.set(locale, entry);
    }
  }
  return { map, errors };
}

export function resolveNonItPublishPlan({
  sourceHealthyLocales = [],
  sourceStaleLocales = [],
  durablePublishedLocales = [],
  tailLocales = [],
  sourceRunId,
  sourceSha,
  expectedBuildId,
  artifactRunId,
  provenance = [],
  provenanceErrors = [],
}) {
  const { map, errors: manifestErrors } = manifestMap(provenance);
  const healthy = new Set(uniqueLocales(sourceHealthyLocales));
  const stale = new Set(uniqueLocales(sourceStaleLocales));
  // A durable commit-status receipt proves that this locale's shard push
  // already succeeded for this source run. A retry may therefore omit the
  // force-push and still keep the last successful locale in the plan; the
  // current run only has to recreate validation artifacts if it needs them.
  const durable = new Set(uniqueLocales(durablePublishedLocales));
  for (const locale of durable) {
    healthy.add(locale);
    stale.delete(locale);
  }
  const staleReasons = {};
  const readyLocales = [];
  const failures = [...provenanceErrors, ...manifestErrors];
  const requestedTail = uniqueLocales(tailLocales);

  for (const locale of requestedTail) {
    if (durable.has(locale)) continue;
    const entry = map.get(locale);
    if (!entry) {
      const reason = 'post-build provenance receipt is missing';
      stale.add(locale);
      staleReasons[locale] = reason;
      continue;
    }
    const verdict = validateLocalePublishProvenance(entry.manifest, {
      locale,
      sourceRunId,
      sourceSha,
      expectedBuildId,
      expectedArtifactRunId: artifactRunId,
      requirePublished: true,
    });
    if (!verdict.valid) {
      const reason = `post-build provenance rejected: ${verdict.errors.join('; ')}`;
      stale.add(locale);
      staleReasons[locale] = reason;
      continue;
    }
    healthy.add(locale);
    stale.delete(locale);
    readyLocales.push(locale);
  }

  for (const locale of LOCALES) {
    if (!healthy.has(locale) && !stale.has(locale)) {
      stale.add(locale);
      staleReasons[locale] = 'not admitted; keep the last-known-good locale shard';
    }
  }
  for (const locale of stale) {
    if (!staleReasons[locale]) staleReasons[locale] = 'not admitted; keep the last-known-good locale shard';
  }

  const incompleteLocales = LOCALES.filter((locale) => !healthy.has(locale));
  // IT owns the Pages artifact and CDN ordering, so its tail remains
  // mandatory. A non-IT tail failure keeps that locale on its last-known-good
  // shard; an incomplete IT tail or contradictory receipt blocks Pages.
  const itTailComplete = healthy.has('it') || readyLocales.includes('it');
  const allowed = failures.length === 0 && itTailComplete;
  const staleNonIt = incompleteLocales.filter((locale) => locale !== 'it');
  const admittedReason = readyLocales.length > 0
    ? `admitted post-build tail for ${readyLocales.join(', ')}`
    : 'admitted the durable IT snapshot';
  if (allowed) {
    return {
      allowed,
      healthyLocales: LOCALES.filter((locale) => healthy.has(locale)),
      staleLocales: LOCALES.filter((locale) => stale.has(locale)),
      staleReasons,
      readyLocales,
      requestedTail,
      failures,
      reason: staleNonIt.length > 0
        ? `${admittedReason}; stale fallback for ${staleNonIt.join(', ')}`
        : admittedReason,
    };
  }
  return {
    allowed,
    healthyLocales: LOCALES.filter((locale) => healthy.has(locale)),
    staleLocales: LOCALES.filter((locale) => stale.has(locale)),
    staleReasons,
    readyLocales,
    requestedTail,
    failures,
    reason: allowed
      ? `admitted post-build tail for ${readyLocales.join(', ')}`
      : `post-build locale handoff is incomplete for ${incompleteLocales.join(', ') || 'the recorded provenance'}`,
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
    healthy_locales: JSON.stringify(plan.healthyLocales),
    stale_locales: JSON.stringify(plan.staleLocales),
    stale_reasons: JSON.stringify(plan.staleReasons),
    ready_locales: JSON.stringify(plan.readyLocales),
    reason: plan.reason,
  };
  fs.appendFileSync(file, `${Object.entries(lines).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['manifests-dir'] || !args['source-run-id'] || !args['source-sha'] || !args['artifact-run-id']) {
    console.error('Usage: resolve-nonit-publish-plan.mjs --manifests-dir <dir> --source-run-id <id> --source-sha <sha> --artifact-run-id <id>');
    process.exitCode = 2;
    return;
  }
  const loaded = readLocalePublishProvenanceDirectory(args['manifests-dir']);
  const plan = resolveNonItPublishPlan({
    sourceHealthyLocales: parseJsonList(args['source-healthy-locales']),
    sourceStaleLocales: parseJsonList(args['source-stale-locales']),
    tailLocales: parseJsonList(args['tail-locales']),
    durablePublishedLocales: parseJsonList(args['durable-published-locales']),
    sourceRunId: args['source-run-id'],
    sourceSha: args['source-sha'],
    expectedBuildId: args['expected-build-id'],
    artifactRunId: args['artifact-run-id'],
    provenance: loaded.manifests,
    provenanceErrors: loaded.errors,
  });
  writeGithubOutputs(args['github-output'], plan);
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) main();
