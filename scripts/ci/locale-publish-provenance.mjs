#!/usr/bin/env node
/**
 * Build and validate the small provenance receipt emitted by every locale leg.
 *
 * The receipt is deliberately separate from the large Pages/shard payload. It
 * records the exact build id and the steps that made a locale publishable, so
 * the workflow_run publisher can admit healthy locales from a failed matrix
 * without guessing from the aggregate conclusion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const PROVENANCE_SCHEMA_VERSION = 1;
export const PROVENANCE_KIND = 'locale-publish-provenance';

const SUCCESS = 'success';
const BUILD_ID_RE = /^\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

const STATUS_KEYS = Object.freeze([
  'build',
  'validate',
  'sourceArtifact',
  'itPrep',
  'pagesArtifact',
  'offload',
  'sectionPush',
  'cdnGate',
  'localePush',
  'localePack',
  'localeArtifact',
  'tailBudget',
]);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function status(value) {
  const result = text(value).toLowerCase();
  return result || 'unknown';
}

function readBuildId(distDir) {
  const file = path.join(distDir, 'build-id.txt');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function normalizeStatuses(input = {}) {
  return Object.fromEntries(STATUS_KEYS.map((key) => [key, status(input[key])]));
}

function requiredChecks(locale, outcomes) {
  const checks = [
    ['build', outcomes.build],
    ['validate', outcomes.validate],
  ];
  if (locale === 'it') {
    checks.push(['itPrep', outcomes.itPrep], ['pagesArtifact', outcomes.pagesArtifact]);
  } else {
    checks.push(
      ['offload', outcomes.offload],
      ['sectionPush', outcomes.sectionPush],
      ['cdnGate', outcomes.cdnGate],
      ['localePush', outcomes.localePush],
      ['localePack', outcomes.localePack],
      ['localeArtifact', outcomes.localeArtifact],
      ['tailBudget', outcomes.tailBudget],
    );
  }
  return checks;
}

function sourceReadyChecks(locale, outcomes) {
  if (locale === 'it') return [];
  return [
    ['build', outcomes.build],
    ['validate', outcomes.validate],
    ['sourceArtifact', outcomes.sourceArtifact],
  ];
}

function checksPass(checks) {
  return checks.every(([, value]) => value === SUCCESS);
}

/**
 * Create the receipt written by a build-locale leg.
 *
 * A non-IT leg is publishable only when the complete local payload was
 * validated, offloaded, ordered after the IT CDN marker, pushed, and captured
 * in the same-run validation artifact. IT additionally needs the Pages
 * artifact and the full IT/CDN preparation. A failed leg therefore never
 * advertises a partial payload as healthy.
 */
export function createLocalePublishProvenance({
  locale,
  sourceRunId,
  sourceSha,
  deployBuildId,
  artifactRunId,
  distDir = 'dist',
  runnerTemp = process.env.RUNNER_TEMP || '',
  outcomes = {},
}) {
  const normalizedLocale = text(locale).toLowerCase();
  const expectedBuildId = text(deployBuildId);
  const outputBuildId = readBuildId(distDir);
  const normalizedOutcomes = normalizeStatuses(outcomes);
  const identityReasons = [];

  if (!LOCALES.includes(normalizedLocale)) identityReasons.push(`unsupported locale ${JSON.stringify(normalizedLocale)}`);
  if (!BUILD_ID_RE.test(expectedBuildId)) identityReasons.push('DEPLOY_BUILD_ID is missing or malformed');
  if (!BUILD_ID_RE.test(outputBuildId)) identityReasons.push('dist/build-id.txt is missing or malformed');
  if (BUILD_ID_RE.test(expectedBuildId) && outputBuildId !== expectedBuildId) {
    identityReasons.push(`dist/build-id.txt=${JSON.stringify(outputBuildId)} differs from DEPLOY_BUILD_ID=${JSON.stringify(expectedBuildId)}`);
  }
  if (!text(sourceRunId)) identityReasons.push('source run id is missing');
  if (!SHA_RE.test(text(sourceSha))) identityReasons.push('source SHA is missing or malformed');

  const fullChecks = requiredChecks(normalizedLocale, normalizedOutcomes);
  const sourceChecks = sourceReadyChecks(normalizedLocale, normalizedOutcomes);
  const fullChecksPass = checksPass(fullChecks);
  const sourceReady = normalizedLocale !== 'it'
    && identityReasons.length === 0
    && checksPass(sourceChecks);
  const shardMarkerPresent = normalizedLocale === 'it'
    || fs.existsSync(path.join(runnerTemp, `shard-ok-${normalizedLocale}`));
  const published = identityReasons.length === 0 && fullChecksPass && shardMarkerPresent;
  const sourceHandoff = sourceReady && !fullChecksPass;
  const reasons = [...identityReasons];

  if (!sourceHandoff) {
    for (const [name, value] of fullChecks) {
      if (value !== SUCCESS) reasons.push(`${name} outcome is ${JSON.stringify(value)}`);
    }
    if (normalizedLocale !== 'it' && fullChecksPass && !shardMarkerPresent) {
      reasons.push('locale shard success marker is missing');
    }
  }

  const sourceRun = text(sourceRunId);
  const artifactRun = text(artifactRunId) || sourceRun;
  const cdnBuildId = published
    ? (normalizedLocale === 'it' ? outputBuildId : outputBuildId)
    : '';
  const cdnStatus = published && cdnBuildId === expectedBuildId
    ? 'coherent'
    : sourceHandoff
      ? 'deferred'
      : 'unknown';
  const artifactName = normalizedLocale === 'it'
    ? 'github-pages'
    : `${sourceHandoff ? 'locale-shard-source' : 'locale-dist'}-${normalizedLocale}-${artifactRun}`;

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    kind: PROVENANCE_KIND,
    locale: normalizedLocale,
    sourceRunId: sourceRun,
    sourceSha: text(sourceSha),
    artifactRunId: artifactRun,
    deployBuildId: expectedBuildId,
    outputBuildId,
    // `buildId` is the stable field consumed by the admission plan. Keeping
    // the two names makes a mismatched source file visible in diagnostics.
    buildId: outputBuildId,
    cdnBuildId,
    cdnStatus,
    artifactName,
    payloadStatus: published ? 'complete' : sourceHandoff ? 'source-ready' : 'incomplete',
    publishStatus: published ? 'published' : sourceHandoff ? 'ready-for-tail' : 'not-published',
    published,
    stale: !published,
    fallback: published ? null : sourceHandoff ? 'post-build-shard-tail' : 'last-known-good',
    crossLocaleSkew: published ? 'verified-none' : sourceHandoff ? 'deferred' : 'not-admitted',
    outcomes: normalizedOutcomes,
    reasons,
  };
}

function pushError(errors, message) {
  errors.push(message);
}

/**
 * Validate one receipt against the immutable identity of the source run.
 * Returns all failures so callers can report a complete fail-closed reason.
 */
export function validateLocalePublishProvenance(manifest, {
  locale,
  sourceRunId,
  sourceSha,
  expectedBuildId,
  expectedArtifactRunId,
  requirePublished = true,
  requireSourceReady = false,
} = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest is not an object'] };
  }
  if (manifest.schemaVersion !== PROVENANCE_SCHEMA_VERSION) pushError(errors, 'schemaVersion is unsupported');
  if (manifest.kind !== PROVENANCE_KIND) pushError(errors, 'kind is not locale-publish-provenance');
  if (!LOCALES.includes(manifest.locale)) pushError(errors, `locale ${JSON.stringify(manifest.locale)} is unsupported`);
  if (locale && manifest.locale !== locale) pushError(errors, `locale is ${JSON.stringify(manifest.locale)}, expected ${JSON.stringify(locale)}`);
  if (sourceRunId != null && text(manifest.sourceRunId) !== text(sourceRunId)) {
    pushError(errors, `sourceRunId ${JSON.stringify(manifest.sourceRunId)} does not match ${JSON.stringify(text(sourceRunId))}`);
  }
  if (sourceSha != null && text(manifest.sourceSha) !== text(sourceSha)) {
    pushError(errors, `sourceSha ${JSON.stringify(manifest.sourceSha)} does not match the workflow_run head SHA`);
  }
  if (!BUILD_ID_RE.test(text(manifest.buildId))) pushError(errors, 'buildId is missing or malformed');
  if (!BUILD_ID_RE.test(text(manifest.deployBuildId))) pushError(errors, 'deployBuildId is missing or malformed');
  if (BUILD_ID_RE.test(text(manifest.buildId)) && manifest.deployBuildId !== manifest.buildId) {
    pushError(errors, 'deployBuildId differs from buildId');
  }
  if (expectedBuildId != null) {
    const expected = text(expectedBuildId);
    if (manifest.buildId !== expected) pushError(errors, `buildId ${JSON.stringify(manifest.buildId)} does not match the expected build id ${JSON.stringify(expected)}`);
    if (manifest.deployBuildId !== expected) pushError(errors, `deployBuildId ${JSON.stringify(manifest.deployBuildId)} does not match the expected build id ${JSON.stringify(expected)}`);
  }
  const artifactRun = text(manifest.artifactRunId) || text(manifest.sourceRunId);
  if (expectedArtifactRunId != null) {
    if (!text(manifest.artifactRunId)) pushError(errors, 'artifactRunId is missing');
    else if (artifactRun !== text(expectedArtifactRunId)) {
      pushError(errors, `artifactRunId ${JSON.stringify(artifactRun)} does not match ${JSON.stringify(text(expectedArtifactRunId))}`);
    }
  }
  const expectedArtifact = manifest.locale === 'it'
    ? 'github-pages'
    : `${manifest.payloadStatus === 'source-ready' ? 'locale-shard-source' : 'locale-dist'}-${manifest.locale}-${artifactRun}`;
  if (manifest.artifactName !== expectedArtifact) {
    pushError(errors, `artifactName ${JSON.stringify(manifest.artifactName)} does not match ${JSON.stringify(expectedArtifact)}`);
  }
  if (requireSourceReady) {
    if (manifest.locale === 'it') pushError(errors, 'IT cannot use a deferred non-IT source receipt');
    if (manifest.payloadStatus !== 'source-ready') pushError(errors, `payloadStatus is ${JSON.stringify(manifest.payloadStatus)}`);
    if (manifest.publishStatus !== 'ready-for-tail') pushError(errors, `publishStatus is ${JSON.stringify(manifest.publishStatus)}`);
    if (manifest.published !== false) pushError(errors, 'source receipt is marked published');
    if (manifest.stale !== true) pushError(errors, 'source receipt is not marked stale');
    if (manifest.cdnStatus !== 'deferred') pushError(errors, `cdnStatus is ${JSON.stringify(manifest.cdnStatus)}`);
    if (manifest.cdnBuildId !== '') pushError(errors, 'source receipt has a CDN build id before the tail');
    for (const [name, value] of sourceReadyChecks(manifest.locale, manifest.outcomes)) {
      if (status(value) !== SUCCESS) pushError(errors, `${name} outcome is ${JSON.stringify(status(value))}`);
    }
  } else {
    if (manifest.cdnStatus !== 'coherent') pushError(errors, `cdnStatus is ${JSON.stringify(manifest.cdnStatus)}`);
    if (manifest.cdnBuildId !== manifest.buildId) pushError(errors, 'cdnBuildId differs from buildId');
    if (manifest.payloadStatus !== 'complete') pushError(errors, `payloadStatus is ${JSON.stringify(manifest.payloadStatus)}`);
    if (requirePublished && (manifest.published !== true || manifest.publishStatus !== 'published')) {
      pushError(errors, 'manifest is not marked published');
    }
    if (requirePublished && manifest.stale !== false) pushError(errors, 'published manifest is marked stale');
    if (requirePublished && manifest.crossLocaleSkew !== 'verified-none') {
      pushError(errors, `crossLocaleSkew is ${JSON.stringify(manifest.crossLocaleSkew)}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateLocaleSourceProvenance(manifest, options = {}) {
  return validateLocalePublishProvenance(manifest, {
    ...options,
    requirePublished: false,
    requireSourceReady: true,
  });
}

function collectJsonFiles(root) {
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    }
  }
  return files.sort();
}

/** Read all downloaded provenance artifacts, preserving malformed-file errors. */
export function readLocalePublishProvenanceDirectory(root) {
  const manifests = [];
  const errors = [];
  for (const file of collectJsonFiles(root)) {
    try {
      manifests.push({ file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch (error) {
      errors.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { manifests, errors };
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['validate-dir']) {
    const loaded = readLocalePublishProvenanceDirectory(args['validate-dir']);
    const expectedLocale = args.locale || undefined;
    const entry = loaded.manifests.find(({ manifest }) => !expectedLocale || manifest?.locale === expectedLocale);
    const verdict = entry
      ? validateLocalePublishProvenance(entry.manifest, {
        locale: expectedLocale,
        sourceRunId: args['source-run-id'],
        sourceSha: args['source-sha'],
        expectedBuildId: args['expected-build-id'],
        expectedArtifactRunId: args['artifact-run-id'],
        requirePublished: true,
      })
      : { valid: false, errors: ['expected provenance manifest is missing'] };
    const errors = [...loaded.errors, ...verdict.errors];
    console.log(JSON.stringify({ valid: errors.length === 0, errors }));
    if (errors.length) process.exitCode = 1;
    return;
  }
  const output = args.output;
  if (!output) {
    console.error('Usage: locale-publish-provenance.mjs --output <file> [--dist-dir <dir>] | --validate-dir <dir> --locale <locale> --source-run-id <id> --source-sha <sha> --expected-build-id <id>');
    process.exitCode = 2;
    return;
  }
  const manifest = createLocalePublishProvenance({
    locale: process.env.BUILD_LOCALE,
    sourceRunId: process.env.PROVENANCE_SOURCE_RUN_ID || process.env.GITHUB_RUN_ID,
    sourceSha: process.env.PROVENANCE_SOURCE_SHA || process.env.GITHUB_SHA,
    deployBuildId: process.env.DEPLOY_BUILD_ID,
    artifactRunId: process.env.PROVENANCE_ARTIFACT_RUN_ID || process.env.GITHUB_RUN_ID,
    distDir: args['dist-dir'] || 'dist',
    runnerTemp: process.env.RUNNER_TEMP || '',
    outcomes: {
      build: process.env.PROVENANCE_BUILD_OUTCOME,
      validate: process.env.PROVENANCE_VALIDATE_OUTCOME,
      sourceArtifact: process.env.PROVENANCE_SOURCE_ARTIFACT_OUTCOME,
      itPrep: process.env.PROVENANCE_IT_PREP_OUTCOME,
      pagesArtifact: process.env.PROVENANCE_PAGES_ARTIFACT_OUTCOME,
      offload: process.env.PROVENANCE_OFFLOAD_OUTCOME,
      sectionPush: process.env.PROVENANCE_SECTION_PUSH_OUTCOME,
      cdnGate: process.env.PROVENANCE_CDN_GATE_OUTCOME,
      localePush: process.env.PROVENANCE_LOCALE_PUSH_OUTCOME,
      localePack: process.env.PROVENANCE_LOCALE_PACK_OUTCOME,
      localeArtifact: process.env.PROVENANCE_LOCALE_ARTIFACT_OUTCOME,
    },
  });
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
  if (!manifest.published) process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
