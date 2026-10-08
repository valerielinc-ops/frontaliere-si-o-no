#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Admit the complete non-IT shard tail completed by deploy-publish.yml.
 *
 * The source build plan leaves en/de/fr source-ready while their validated
 * artifacts cross the workflow boundary. This resolver promotes a locale only
 * after the post-build receipt proves the full tail and the receipt artifact
 * belongs to this publish run. A locale whose tail is incomplete is reported
 * as stale and keeps serving its previous shard; it does not stop the IT
 * snapshot from being published (see the comment above `allowed`).
 */
import fs from 'node:fs';

import {
  LOCALES,
  readLocalePublishProvenanceDirectory,
  validateLocalePublishProvenance,
} from './locale-publish-provenance.mjs';

const NON_IT_LOCALES = Object.freeze(['en', 'de', 'fr']);

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
  const staleReasons = {};
  const readyLocales = [];
  const failures = [...provenanceErrors, ...manifestErrors];
  const requestedTail = uniqueLocales(tailLocales).filter((locale) => NON_IT_LOCALES.includes(locale));

  for (const locale of requestedTail) {
    const entry = map.get(locale);
    if (!entry) {
      const reason = 'post-build non-IT provenance receipt is missing';
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
  // A non-IT locale whose tail did not complete stays on its last-known-good
  // shard and is REPORTED as stale; it no longer vetoes the IT Pages snapshot.
  // Owner rule (2026-10-07): no gate blocks publication. Requiring every locale
  // froze production twice in one night — run 37671196544 (three section shards
  // rejected with 403) and run 37728960699, where GitHub refused the ticino-de
  // push because one git tree had grown past 50 MiB ("non-blob object size
  // limit exceeded"): that condition does not clear by itself, so every later
  // publish would have skipped Pages as well. validate-live already receives
  // stale_locales and checks those locales against their declared fallback.
  // Still blocking: an IT snapshot that was not admitted, and unreadable or
  // contradictory receipts (`failures`) — those are "state unknown", not stale.
  const allowed = failures.length === 0 && healthy.has('it');
  const staleNonIt = incompleteLocales.filter((locale) => locale !== 'it');
  const admittedReason = readyLocales.length > 0
    ? `admitted post-build tail for ${readyLocales.join(', ')}`
    : 'admitted the IT snapshot with no completed post-build tail';
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
