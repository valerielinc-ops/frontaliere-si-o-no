#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export const SHARD_MANIFEST_VERSION = 2;
export const SHARD_VALIDATOR_VERSION = 'publisher-shard-content-v2';

const SECTION_BATCHES = Object.freeze({
  1: ['appenzello', 'argovia', 'articolifrontaliere', 'articolisvizzera', 'basilea'],
  2: ['berna', 'friburgo', 'ginevra', 'giura', 'glarona'],
  3: ['grigioni', 'lucerna', 'neuchatel', 'nidvaldo', 'obvaldo'],
  4: ['sangallo', 'sciaffusa', 'soletta', 'svitto', 'svizzera'],
  5: ['ticino', 'turgovia', 'uri', 'vallese', 'vaud'],
  6: ['zugo', 'zurigo'],
});

const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const SHA_RE = /^[0-9a-f]{40}$/u;

function digestFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkHtml(root, prefix = '', rows = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkHtml(file, rel, rows);
    else if (entry.isFile() && /\.html?$/iu.test(entry.name)) rows.push({ file, rel });
  }
  return rows;
}

function routeForPath(webPath) {
  const normalized = webPath.split(path.sep).join('/').replace(/^\/+|\/+$/gu, '');
  const route = normalized.replace(/(?:^|\/)index\.html$/iu, '').replace(/\.html?$/iu, '');
  const encoded = route.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/');
  return encoded ? `/${encoded}/` : '/';
}

function requiredText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export function sectionBatch(section) {
  for (const [batch, sections] of Object.entries(SECTION_BATCHES)) {
    if (sections.includes(section)) return Number(batch);
  }
  throw new Error(`unknown section shard ${JSON.stringify(section)}`);
}

export function createSectionManifest({
  root,
  prefix,
  locale,
  section,
  sourceRunId,
  sourceSha,
  artifactRunId,
  tarPath = '',
  pageManifestPath = '',
  sourcePathLayout = section === 'ticino' ? 'ticino-hash-v1' : 'canonical',
}) {
  if (!LOCALES.has(locale)) throw new Error(`unsupported locale ${JSON.stringify(locale)}`);
  if (!SHA_RE.test(String(sourceSha ?? '').toLowerCase())) throw new Error('source SHA must be a 40-character commit SHA');
  if (!fs.statSync(root).isDirectory()) throw new Error(`shard root is not a directory: ${root}`);
  const expectedLayout = section === 'ticino' ? 'ticino-hash-v1' : 'canonical';
  if (sourcePathLayout !== expectedLayout) {
    throw new Error(`${section} sourcePathLayout must be ${expectedLayout}, received ${sourcePathLayout}`);
  }

  const normalizedPrefix = String(prefix ?? '').replace(/^\/+|\/+$/gu, '');
  if (!normalizedPrefix) throw new Error('shard prefix is required');
  let pages;
  if (pageManifestPath) {
    const pageManifest = JSON.parse(fs.readFileSync(pageManifestPath, 'utf8'));
    if (pageManifest?.version !== 2 || pageManifest?.locale !== locale || !Array.isArray(pageManifest?.entries)) {
      throw new Error(`invalid sitemap page manifest for ${locale}`);
    }
    pages = pageManifest.entries.filter((entry) => entry.section === section).map((entry) => {
      const webPath = String(entry.path ?? '');
      const prefixWithSlash = `${normalizedPrefix}/`;
      if (!webPath.startsWith(prefixWithSlash)) throw new Error(`${section} manifest path escapes its shard prefix: ${webPath}`);
      const rel = webPath.slice(prefixWithSlash.length);
      const file = path.resolve(root, rel);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`${section} sitemap page is absent from its shard source: ${entry.url} (${webPath})`);
      }
      return {
        path: webPath,
        url: String(entry.url),
        sourceSha256: String(entry.sha256 ?? '').toLowerCase(),
        sha256: digestFile(file),
        locale,
        section,
      };
    }).sort((a, b) => a.url.localeCompare(b.url));
  } else {
    pages = walkHtml(root).map(({ file, rel }) => {
      const webPath = `${normalizedPrefix}/${rel}`;
      return {
        path: webPath,
        url: `https://frontaliereticino.ch${routeForPath(webPath)}`,
        sha256: digestFile(file),
        locale,
        section,
      };
    }).sort((a, b) => a.url.localeCompare(b.url));
  }

  return {
    schemaVersion: SHARD_MANIFEST_VERSION,
    kind: 'publisher-shard-content',
    validatorVersion: SHARD_VALIDATOR_VERSION,
    sourceRunId: requiredText(sourceRunId, 'sourceRunId'),
    sourceSha: String(sourceSha).toLowerCase(),
    artifactRunId: requiredText(artifactRunId, 'artifactRunId'),
    artifactName: '',
    artifactDigest: '',
    locale,
    section,
    sourcePathLayout,
    prefix: normalizedPrefix,
    tarSha256: tarPath ? digestFile(tarPath) : '',
    population: pages.length,
    pages,
  };
}

export function finalizeSectionManifestSet({
  manifests,
  locale,
  sourceRunId,
  sourceSha,
  artifactRunId,
  artifactDigests,
  requiredSections = [],
  manifestArtifactName = `section-page-manifest-${locale}-${artifactRunId}`,
}) {
  if (!LOCALES.has(locale)) throw new Error(`unsupported locale ${JSON.stringify(locale)}`);
  if (!SHA_RE.test(String(sourceSha ?? '').toLowerCase())) throw new Error('source SHA must be a 40-character commit SHA');
  const bySection = new Map();
  for (const manifest of manifests) {
    if (manifest?.kind !== 'publisher-shard-content' || manifest.locale !== locale) {
      throw new Error('section manifest kind or locale is invalid');
    }
    if (String(manifest.sourceRunId) !== String(sourceRunId) || manifest.sourceSha !== String(sourceSha).toLowerCase()) {
      throw new Error(`section manifest identity mismatch for ${manifest.section}`);
    }
    if (String(manifest.artifactRunId) !== String(artifactRunId)) {
      throw new Error(`section manifest artifactRunId mismatch for ${manifest.section}`);
    }
    if (bySection.has(manifest.section)) throw new Error(`duplicate section manifest ${manifest.section}`);
    bySection.set(manifest.section, manifest);
  }

  const required = [...new Set(requiredSections.map((value) => String(value).trim()).filter(Boolean))].sort();
  const missing = required.filter((section) => !bySection.has(section));
  if (missing.length) throw new Error(`required section manifests are missing: ${missing.join(', ')}`);

  const shards = [...bySection.values()].map((manifest) => {
    const batch = sectionBatch(manifest.section);
    const artifactName = `shard-batch-${batch}-dist-${locale}-${artifactRunId}`;
    const digest = String(artifactDigests?.[String(batch)] ?? '').replace(/^sha256:/u, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      if (required.includes(manifest.section) || manifest.pages.length > 0) {
        throw new Error(`missing uploaded artifact digest for ${artifactName}`);
      }
    }
    return {
      ...manifest,
      artifactName,
      artifactDigest: digest,
      artifactBatch: batch,
    };
  }).sort((a, b) => a.section.localeCompare(b.section));

  const artifactRefs = [...new Map(shards.map((shard) => [shard.artifactName, {
    runId: String(artifactRunId),
    name: shard.artifactName,
    digest: shard.artifactDigest,
    purpose: 'section-shard-tar-batch',
  }])).values()];

  return {
    schemaVersion: SHARD_MANIFEST_VERSION,
    kind: 'publisher-section-manifest',
    validatorVersion: SHARD_VALIDATOR_VERSION,
    sourceRunId: String(sourceRunId),
    sourceSha: String(sourceSha).toLowerCase(),
    artifactRunId: String(artifactRunId),
    manifestArtifactName,
    locale,
    requiredSections: required,
    artifactRefs,
    shards,
    population: shards.reduce((sum, shard) => sum + shard.population, 0),
  };
}

export function bindPageManifest({
  manifest,
  sourceRunId,
  sourceSha,
  artifactRunId,
  baseArtifactName,
  baseArtifactDigest,
  sectionArtifactDigests = {},
  requiredSections,
  manifestArtifactName,
  sitemapArtifactName = '',
  sitemapArtifactDigest = '',
}) {
  if (manifest?.kind !== 'publisher-page-manifest' || manifest.version !== 2) {
    throw new Error('page manifest kind/version is invalid');
  }
  if (!LOCALES.has(manifest.locale)) throw new Error(`unsupported locale ${JSON.stringify(manifest.locale)}`);
  if (String(sourceRunId) !== String(manifest.sourceRunId) || String(sourceSha).toLowerCase() !== manifest.sourceSha) {
    throw new Error(`page manifest source identity mismatch for ${manifest.locale}`);
  }
  const baseDigest = String(baseArtifactDigest ?? '').replace(/^sha256:/u, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(baseDigest)) throw new Error(`base artifact digest is missing for ${manifest.locale}`);
  const requiredInput = requiredSections === undefined ? (manifest.requiredSections ?? []) : requiredSections;
  const required = [...new Set(requiredInput.map((value) => String(value).trim()).filter(Boolean))].sort();
  const refs = [{ runId: String(artifactRunId), name: baseArtifactName, digest: baseDigest, purpose: 'locale-base' }];
  const sitemapDigest = String(sitemapArtifactDigest ?? '').replace(/^sha256:/u, '').toLowerCase();
  if (sitemapArtifactName) {
    if (!/^[0-9a-f]{64}$/u.test(sitemapDigest)) throw new Error(`sitemap artifact digest is missing for ${manifest.locale}`);
    refs.push({ runId: String(sourceRunId), name: sitemapArtifactName, digest: sitemapDigest, purpose: 'sitemaps' });
  }
  const batchBySection = new Map();
  for (const section of required) {
    const batch = sectionBatch(section);
    const digest = String(sectionArtifactDigests?.[String(batch)] ?? '').replace(/^sha256:/u, '').toLowerCase();
    if (manifest.locale === 'it') {
      if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error(`missing IT shard batch ${batch} artifact digest for ${section}`);
      const name = `shard-batch-${batch}-dist-it-${artifactRunId}`;
      if (!refs.some((ref) => ref.name === name)) refs.push({ runId: String(artifactRunId), name, digest, purpose: 'section-shard-tar-batch' });
      batchBySection.set(section, { name, digest });
    }
  }

  const pages = manifest.entries.map((entry) => {
    const selected = manifest.locale === 'it' && entry.section && batchBySection.get(entry.section);
    const ref = selected
      ? selected
      : { name: baseArtifactName, digest: baseDigest };
    return { ...entry, artifactName: ref.name, artifactDigest: ref.digest, artifactRunId: String(artifactRunId) };
  });

  return {
    ...manifest,
    sourceRunId: String(sourceRunId),
    sourceSha: String(sourceSha).toLowerCase(),
    artifactRunId: String(artifactRunId),
    artifactName: baseArtifactName,
    artifactDigest: baseDigest,
    manifestArtifactName: manifestArtifactName || `sitemap-page-manifest-${manifest.locale}-${sourceRunId}`,
    requiredSections: required,
    artifactRefs: refs,
    entries: pages,
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const eq = token.indexOf('=');
    if (eq > 0) args[token.slice(2, eq)] = token.slice(eq + 1);
    else args[token.slice(2)] = argv[++i];
  }
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'create-section') {
    const manifest = createSectionManifest({
      root: args.root,
      prefix: args.prefix,
      locale: args.locale,
      section: args.section,
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      artifactRunId: args['artifact-run-id'],
      tarPath: args.tar,
      pageManifestPath: args['page-manifest'],
      sourcePathLayout: args['source-path-layout'] || undefined,
    });
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(manifest)}\n`);
    console.log(`[shard-manifest] ${manifest.locale}/${manifest.section}: ${manifest.population} HTML page(s), ${manifest.sourcePathLayout}`);
    return;
  }
  if (command === 'finalize-sections') {
    const files = fs.readdirSync(args.input, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readJson(path.join(args.input, entry.name)));
    const set = finalizeSectionManifestSet({
      manifests: files,
      locale: args.locale,
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      artifactRunId: args['artifact-run-id'],
      artifactDigests: readJson(args['artifact-digests']),
      requiredSections: String(args['required-sections'] ?? '').split(',').filter(Boolean),
      manifestArtifactName: args['manifest-artifact-name'],
    });
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(set)}\n`);
    console.log(`[shard-manifest] ${set.locale}: ${set.shards.length} shard(s), ${set.population} HTML page(s), ${set.requiredSections.length} required`);
    return;
  }
  if (command === 'bind-page') {
    const manifest = bindPageManifest({
      manifest: readJson(args.input),
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      artifactRunId: args['artifact-run-id'],
      baseArtifactName: args['base-artifact-name'],
      baseArtifactDigest: args['base-artifact-digest'],
      sectionArtifactDigests: args['section-artifact-digests'] ? readJson(args['section-artifact-digests']) : {},
      requiredSections: args['required-sections'] === undefined ? undefined : String(args['required-sections']).split(',').filter(Boolean),
      manifestArtifactName: args['manifest-artifact-name'],
      sitemapArtifactName: args['sitemaps-artifact-name'] || '',
      sitemapArtifactDigest: args['sitemaps-artifact-digest'] || '',
    });
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[page-manifest] ${manifest.locale}: ${manifest.entries.length} sitemap page(s), ${manifest.artifactRefs.length} artifact ref(s)`);
    return;
  }
  throw new Error('usage: shard-content-manifest.mjs create-section|finalize-sections|bind-page ...');
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`[shard-manifest] ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  });
}
