#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { expiredArchiveCdnInvariantSha256 } from '../lib/expired-archive-html-invariant.mjs';
import { sectionTreeLayout } from '../../infra/cloudflare-worker/ticino-tree-bucket.js';

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
const DIGEST_CHUNK = Buffer.allocUnsafe(1024 * 1024);

function digestFile(file) {
  // Shard tars can exceed 2 GiB; hash them in bounded reads instead of asking
  // Node to materialize the whole artifact as one Buffer.
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, DIGEST_CHUNK, 0, DIGEST_CHUNK.length, position);
      if (bytesRead === 0) break;
      hash.update(DIGEST_CHUNK.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
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

export function refreshExpiredArchiveEvidence({ root, locale, evidenceManifestPath }) {
  if (!LOCALES.has(locale)) throw new Error(`unsupported locale ${JSON.stringify(locale)}`);
  const manifest = JSON.parse(fs.readFileSync(evidenceManifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1
    || manifest?.kind !== 'expired-archive-publication-evidence'
    || manifest?.validatorVersion !== 'expired-archive-publication-v1'
    || manifest?.locale !== locale
    || !Array.isArray(manifest?.entries)) {
    throw new Error(`invalid expired archive publication evidence for ${locale}`);
  }
  const rootDir = path.resolve(root);
  for (const entry of manifest.entries) {
    if (entry?.locale !== locale) throw new Error(`expired archive evidence locale mismatch for ${entry?.url ?? 'unknown URL'}`);
    const webPath = String(entry.path ?? '');
    const file = path.resolve(rootDir, webPath);
    const relative = path.relative(rootDir, file);
    if (!webPath || !relative || relative.startsWith('..') || path.isAbsolute(relative)
      || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`expired archive evidence page is absent or escapes its root: ${webPath}`);
    }
    entry.cdnInvariantSha256 = expiredArchiveCdnInvariantSha256(fs.readFileSync(file, 'utf8'));
  }
  const temporaryPath = `${evidenceManifestPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporaryPath, evidenceManifestPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return manifest.entries.length;
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
  evidenceManifestPath = '',
  sourcePathLayout = sectionTreeLayout(section),
}) {
  if (!LOCALES.has(locale)) throw new Error(`unsupported locale ${JSON.stringify(locale)}`);
  if (!SHA_RE.test(String(sourceSha ?? '').toLowerCase())) throw new Error('source SHA must be a 40-character commit SHA');
  if (!fs.statSync(root).isDirectory()) throw new Error(`shard root is not a directory: ${root}`);
  const expectedLayout = sectionTreeLayout(section);
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

  if (evidenceManifestPath) {
    const evidence = JSON.parse(fs.readFileSync(evidenceManifestPath, 'utf8'));
    if (evidence?.schemaVersion !== 1
      || evidence?.kind !== 'expired-archive-publication-evidence'
      || evidence?.validatorVersion !== 'expired-archive-publication-v1'
      || evidence?.locale !== locale
      || String(evidence?.sourceRunId) !== String(sourceRunId)
      || String(evidence?.sourceSha).toLowerCase() !== String(sourceSha).toLowerCase()
      || !Array.isArray(evidence?.entries)) {
      throw new Error(`invalid expired archive publication evidence for ${locale}`);
    }
    const byUrl = new Map(pages.map((page) => [page.url, page]));
    for (const entry of evidence.entries.filter((candidate) => candidate.section === section)) {
      const webPath = String(entry.path ?? '');
      const prefixWithSlash = `${normalizedPrefix}/`;
      if (!webPath.startsWith(prefixWithSlash)) throw new Error(`${section} evidence path escapes its shard prefix: ${webPath}`);
      const rel = webPath.slice(prefixWithSlash.length);
      const file = path.resolve(root, rel);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`${section} expired archive canary is absent from its shard source: ${entry.url} (${webPath})`);
      }
      const sourceSha256 = String(entry.sha256 ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/u.test(sourceSha256)) throw new Error(`${section} expired archive canary has no source digest: ${entry.url}`);
      const finalSha256 = digestFile(file);
      if (finalSha256 !== sourceSha256) {
        const sourceInvariant = String(entry.cdnInvariantSha256 ?? '').toLowerCase();
        const finalInvariant = expiredArchiveCdnInvariantSha256(fs.readFileSync(file, 'utf8'));
        if (!/^[0-9a-f]{64}$/u.test(sourceInvariant) || finalInvariant !== sourceInvariant) {
          throw new Error(
            `${section} expired archive canary digest differs from its shard source: ${entry.url} `
            + `(source=${sourceSha256}, final=${finalSha256}, `
            + `sourceInvariant=${sourceInvariant || 'missing'}, finalInvariant=${finalInvariant})`,
          );
        }
      }
      const existing = byUrl.get(String(entry.url));
      if (existing) {
        const existingSourceSha256 = existing.sourceSha256 || existing.sha256;
        if (existing.path !== webPath || existingSourceSha256 !== sourceSha256) {
          throw new Error(`${section} expired archive canary differs from its sitemap page: ${entry.url}`);
        }
        existing.sourceSha256 = sourceSha256;
        existing.evidenceKind = 'expired-archive';
        continue;
      }
      const page = {
        path: webPath,
        url: String(entry.url),
        sourceSha256,
        sha256: finalSha256,
        locale,
        section,
        evidenceKind: 'expired-archive',
      };
      pages.push(page);
      byUrl.set(page.url, page);
    }
    pages.sort((a, b) => a.url.localeCompare(b.url));
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
  if (command === 'refresh-expired-archive-evidence') {
    const count = refreshExpiredArchiveEvidence({
      root: args.root,
      locale: args.locale,
      evidenceManifestPath: args['evidence-manifest'],
    });
    console.log(`[shard-manifest] ${args.locale}: refreshed CDN invariant for ${count} expired archive canary page(s)`);
    return;
  }
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
      evidenceManifestPath: args['evidence-manifest'],
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
  throw new Error('usage: shard-content-manifest.mjs refresh-expired-archive-evidence|create-section|finalize-sections|bind-page ...');
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`[shard-manifest] ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  });
}
