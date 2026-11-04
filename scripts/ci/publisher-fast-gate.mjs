#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isExternallyServedUrl } from '../lib/externally-served-paths.mjs';
import { ownsSitemapUrl, sectionForUrl } from '../validate-sitemap-links.mjs';
import { SHARD_VALIDATOR_VERSION } from './shard-content-manifest.mjs';

export const FAST_GATE_VALIDATOR_VERSION = 'publisher-fast-gate-v1';
export const SITE_ORIGIN = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];
const SHA_RE = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/u;

function normalizeDigest(value) {
  return String(value ?? '').replace(/^sha256:/iu, '').toLowerCase();
}

function listFiles(root, predicate) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(file, predicate));
    else if (entry.isFile() && predicate(file)) out.push(file);
  }
  return out.sort();
}

function jsonFiles(root) {
  return listFiles(root, (file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
}

function artifactList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.artifacts)) return payload.artifacts;
  return [];
}

function assertArtifactRef(ref, expectedRunId, apiArtifacts, errors) {
  const name = String(ref?.name ?? ref?.artifactName ?? '');
  const runId = String(ref?.runId ?? expectedRunId);
  const digest = normalizeDigest(ref?.digest ?? ref?.artifactDigest);
  if (!name) {
    errors.push('artifact reference has no name');
    return;
  }
  if (runId !== String(expectedRunId)) errors.push(`${name}: artifact run ${runId} != ${expectedRunId}`);
  if (!SHA_RE.test(digest)) errors.push(`${name}: expected artifact digest is missing or malformed`);
  const actual = apiArtifacts.get(`${runId}:${name}`);
  if (!actual) {
    errors.push(`${name}: artifact is absent from run ${runId}`);
    return;
  }
  if (actual.expired) errors.push(`${name}: artifact is expired`);
  const actualDigest = normalizeDigest(actual.digest);
  if (!SHA_RE.test(actualDigest)) errors.push(`${name}: GitHub artifact digest is missing or malformed`);
  else if (SHA_RE.test(digest) && actualDigest !== digest) errors.push(`${name}: artifact digest differs from the receipt`);
}

function readArtifactMetadata(sourceRunId, publisherRunId, sourcePayload, publisherPayload) {
  const map = new Map();
  for (const [runId, payload] of [[sourceRunId, sourcePayload], [publisherRunId, publisherPayload]]) {
    for (const artifact of artifactList(payload)) {
      const name = String(artifact?.name ?? '');
      if (!name) continue;
      const key = `${runId}:${name}`;
      map.set(key, { ...artifact, digest: artifact.digest ?? '', expired: Boolean(artifact.expired) });
    }
  }
  return map;
}

function routeCandidates(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return []; }
  if (parsed.origin !== SITE_ORIGIN) return [];
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { return []; }
  if (pathname.includes('\0') || pathname.split('/').includes('..')) return [];
  if (pathname === '/') return ['index.html'];
  const rel = pathname.replace(/^\/+|\/+$/gu, '');
  if (path.posix.extname(rel)) return [rel];
  return [`${rel}/index.html`, `${rel}.html`];
}

function localeForUrl(url) {
  const pathname = new URL(url).pathname;
  for (const locale of ['en', 'de', 'fr']) {
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) return locale;
  }
  return 'it';
}

function parseSitemapBundle(root, errors) {
  const urlSet = new Map();
  const files = listFiles(root, (file) => path.basename(file).startsWith('sitemap') && file.endsWith('.xml'));
  if (!files.length) errors.push(`no sitemap XML files found under ${root}`);
  for (const file of files) {
    const xml = fs.readFileSync(file, 'utf8');
    const valid = spawnSync('python3', ['-c', 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])', file], { encoding: 'utf8' });
    if (valid.error || valid.status !== 0) {
      const detail = valid.error?.message ?? valid.stderr?.trim() ?? 'XML parser failed';
      errors.push(`${path.relative(root, file)}: invalid XML (${detail})`);
      continue;
    }
    if (/<sitemapindex\b/iu.test(xml)) continue;
    const blocks = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/giu)];
    if (!blocks.length && /<urlset\b/iu.test(xml)) errors.push(`${path.relative(root, file)}: urlset has no url entries`);
    for (const block of blocks) {
      const body = block[1];
      const locs = [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/giu)].map((match) => match[1].trim());
      if (locs.length !== 1) {
        errors.push(`${path.relative(root, file)}: each url must contain exactly one loc (found ${locs.length})`);
        continue;
      }
      const urls = [locs[0], ...[...body.matchAll(/<xhtml:link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/giu)].map((match) => match[1])];
      for (const url of urls) {
        let parsed;
        try { parsed = new URL(url); } catch { errors.push(`${path.relative(root, file)}: malformed URL ${url}`); continue; }
        if (parsed.origin !== SITE_ORIGIN || isExternallyServedUrl(url)) continue;
        const locale = localeForUrl(url);
        if (!ownsSitemapUrl(url, locale)) {
          errors.push(`${path.relative(root, file)}: URL is not owned by a published locale: ${url}`);
          continue;
        }
        if (!urlSet.has(url)) urlSet.set(url, { locale, sitemap: path.relative(root, file) });
      }
    }
  }
  return { urlSet, files };
}

function assertManifestHeader(manifest, expected, errors, label) {
  if (manifest?.kind !== expected.kind) errors.push(`${label}: kind is ${JSON.stringify(manifest?.kind)}, expected ${expected.kind}`);
  if (manifest?.schemaVersion !== expected.schemaVersion) errors.push(`${label}: unsupported schemaVersion ${String(manifest?.schemaVersion)}`);
  if (manifest?.validatorVersion !== expected.validatorVersion) errors.push(`${label}: validatorVersion mismatch`);
  if (String(manifest?.sourceRunId) !== String(expected.sourceRunId)) errors.push(`${label}: sourceRunId mismatch`);
  if (String(manifest?.sourceSha).toLowerCase() !== String(expected.sourceSha).toLowerCase()) errors.push(`${label}: sourceSha mismatch`);
}

export function validatePublisherFastGate({
  sourceRunId,
  sourceSha,
  publisherRunId,
  sitemapDir,
  pageManifests,
  sectionManifests,
  sourceArtifacts,
  publisherArtifacts,
  manifestArtifactNames = [],
}) {
  const errors = [];
  const pageByUrl = new Map();
  const pageManifestByLocale = new Map();
  const expected = { sourceRunId, sourceSha, kind: 'publisher-page-manifest', schemaVersion: 2, validatorVersion: 'publisher-page-index-v2' };
  const artifactMetadata = readArtifactMetadata(sourceRunId, publisherRunId, sourceArtifacts, publisherArtifacts);

  for (const manifest of pageManifests) {
    const locale = manifest?.locale;
    const label = `page manifest ${String(locale)}`;
    assertManifestHeader(manifest, expected, errors, label);
    if (!LOCALES.includes(locale)) { errors.push(`${label}: locale is unsupported`); continue; }
    if (pageManifestByLocale.has(locale)) { errors.push(`${label}: duplicate locale manifest`); continue; }
    if (String(manifest.artifactRunId) !== String(sourceRunId)) errors.push(`${label}: artifactRunId mismatch`);
    pageManifestByLocale.set(locale, manifest);
    if (!Array.isArray(manifest.entries)) { errors.push(`${label}: entries is not an array`); continue; }
    if (!Array.isArray(manifest.artifactRefs) || manifest.artifactRefs.length === 0) errors.push(`${label}: artifactRefs is empty`);
    for (const ref of manifest.artifactRefs ?? []) {
      assertArtifactRef(ref, sourceRunId, artifactMetadata, errors);
    }
    if (!manifest.manifestArtifactName) errors.push(`${label}: manifest artifact name is missing`);
    else assertArtifactRef({ runId: sourceRunId, name: manifest.manifestArtifactName, digest: artifactMetadata.get(`${sourceRunId}:${manifest.manifestArtifactName}`)?.digest }, sourceRunId, artifactMetadata, errors);
    for (const entry of manifest.entries) {
      const url = String(entry?.url ?? '');
      if (!url || pageByUrl.has(url)) { errors.push(`${label}: missing or duplicate URL ${JSON.stringify(url)}`); continue; }
      if (entry.locale !== locale) errors.push(`${label}: page locale mismatch for ${url}`);
      if (entry.section !== sectionForUrl(url, locale)) errors.push(`${label}: page section mismatch for ${url}`);
      if (!SHA_RE.test(String(entry.sha256 ?? ''))) errors.push(`${label}: page digest missing or malformed for ${url}`);
      if (!routeCandidates(url).includes(String(entry.path ?? ''))) errors.push(`${label}: page path does not map to URL ${url} (${String(entry.path ?? '')})`);
      const ref = (manifest.artifactRefs ?? []).find((candidate) => candidate.name === entry.artifactName);
      if (!ref) errors.push(`${label}: page artifact reference is missing for ${url}`);
      else if (normalizeDigest(ref.digest) !== normalizeDigest(entry.artifactDigest)) errors.push(`${label}: page artifact digest differs from manifest ref for ${url}`);
      pageByUrl.set(url, { ...entry, locale, requiredSections: manifest.requiredSections ?? [] });
    }
  }
  for (const locale of LOCALES) if (!pageManifestByLocale.has(locale)) errors.push(`page manifest missing for locale ${locale}`);
  const sitemapRefs = pageManifests.flatMap((manifest) => manifest.artifactRefs ?? [])
    .filter((ref) => ref.purpose === 'sitemaps' && ref.name === `sitemaps-${sourceRunId}`);
  if (sitemapRefs.length !== 1) errors.push(`expected one source sitemaps artifact receipt for sitemaps-${sourceRunId}`);

  const sectionByKey = new Map();
  const sectionManifestByLocale = new Map();
  const shardUrlOwners = new Map();
  for (const manifest of sectionManifests) {
    const locale = manifest?.locale;
    const expectedArtifactRunId = locale === 'it' ? String(sourceRunId) : String(publisherRunId);
    const label = `section manifest ${String(locale)}`;
    assertManifestHeader(manifest, {
      sourceRunId,
      sourceSha,
      kind: 'publisher-section-manifest',
      schemaVersion: 2,
      validatorVersion: SHARD_VALIDATOR_VERSION,
    }, errors, label);
    if (!LOCALES.includes(locale)) { errors.push(`${label}: locale is unsupported`); continue; }
    if (sectionManifestByLocale.has(locale)) {
      errors.push(`${label}: duplicate locale manifest`);
      continue;
    }
    sectionManifestByLocale.set(locale, manifest);
    if (String(manifest.artifactRunId) !== expectedArtifactRunId) errors.push(`${label}: artifactRunId mismatch`);
    if (!manifest.manifestArtifactName) errors.push(`${label}: manifest artifact name is missing`);
    else assertArtifactRef({ runId: expectedArtifactRunId, name: manifest.manifestArtifactName, digest: artifactMetadata.get(`${expectedArtifactRunId}:${manifest.manifestArtifactName}`)?.digest }, expectedArtifactRunId, artifactMetadata, errors);
    for (const ref of manifest.artifactRefs ?? []) assertArtifactRef(ref, expectedArtifactRunId, artifactMetadata, errors);
    for (const shard of manifest.shards ?? []) {
      const key = `${locale}:${shard.section}`;
      if (sectionByKey.has(key)) errors.push(`${label}: duplicate section ${shard.section}`);
      const expectedLayout = shard.section === 'ticino' ? 'ticino-hash-v1' : 'canonical';
      if (shard.sourcePathLayout !== expectedLayout) errors.push(`${label}: ${shard.section} sourcePathLayout must be ${expectedLayout}`);
      if (!Array.isArray(shard.pages)) errors.push(`${label}: ${shard.section} pages is not an array`);
      if (String(shard.artifactRunId) !== expectedArtifactRunId) errors.push(`${label}: ${shard.section} artifactRunId mismatch`);
      const artifactRef = (manifest.artifactRefs ?? []).find((ref) => ref.name === shard.artifactName);
      if (!artifactRef) errors.push(`${label}: ${shard.section} artifact reference is missing`);
      else if (normalizeDigest(artifactRef.digest) !== normalizeDigest(shard.artifactDigest)) {
        errors.push(`${label}: ${shard.section} artifact digest differs from its reference`);
      }
      const shardPages = new Map();
      for (const page of shard.pages ?? []) {
        const url = String(page?.url ?? '');
        if (!url || shardPages.has(url)) {
          errors.push(`${label}: ${shard.section} has a missing or duplicate page URL ${JSON.stringify(url)}`);
          continue;
        }
        const priorOwner = shardUrlOwners.get(url);
        if (priorOwner) errors.push(`${url}: appears in multiple shard receipts (${priorOwner} and ${key})`);
        else shardUrlOwners.set(url, key);
        if (page.locale !== locale) errors.push(`${label}: ${shard.section} page locale mismatch for ${url}`);
        if (page.section !== shard.section) errors.push(`${label}: page section mismatch for ${url}`);
        if (sectionForUrl(url, locale) !== shard.section) errors.push(`${label}: page URL does not map to ${shard.section}: ${url}`);
        if (!routeCandidates(url).includes(String(page.path ?? ''))) errors.push(`${label}: page path does not map to URL ${url} (${String(page.path ?? '')})`);
        if (!SHA_RE.test(String(page.sha256 ?? ''))) errors.push(`${label}: final page digest is missing or malformed for ${url}`);
        if (!SHA_RE.test(String(page.sourceSha256 ?? ''))) errors.push(`${label}: source page digest is missing or malformed for ${url}`);
        shardPages.set(url, page);
      }
      sectionByKey.set(key, shardPages);
    }
    for (const section of manifest.requiredSections ?? []) {
      if (!sectionByKey.has(`${locale}:${section}`)) errors.push(`${label}: required shard ${section} is missing`);
    }
  }

  for (const locale of LOCALES) {
    if (!sectionManifestByLocale.has(locale)) errors.push(`section manifest missing for locale ${locale}`);
  }

  for (const [locale, manifest] of pageManifestByLocale) {
    const expectedSections = [...new Set((manifest.requiredSections ?? []).map(String))].sort();
    const actualSectionManifest = sectionManifestByLocale.get(locale);
    const actualSections = [...new Set((actualSectionManifest?.requiredSections ?? []).map(String))].sort();
    if (JSON.stringify(actualSections) !== JSON.stringify(expectedSections)) {
      errors.push(`${locale}: required section set differs between page and shard manifests`);
    }
    for (const section of manifest.requiredSections ?? []) {
      if (!sectionByKey.has(`${locale}:${section}`)) {
        errors.push(`section manifest missing required shard ${locale}/${section}`);
      }
    }
  }

  // The set comparison is bidirectional: a sitemap URL must exist in its
  // declared shard (checked below), and a shard receipt may not smuggle in a
  // URL or path that the source sitemap/page index did not produce.
  for (const [key, shardPages] of sectionByKey) {
    const [locale, section] = key.split(':', 2);
    for (const [url, shardPage] of shardPages) {
      const page = pageByUrl.get(url);
      if (!page) {
        errors.push(`${locale}/${section}: shard URL is absent from source page manifests: ${url}`);
        continue;
      }
      if (page.locale !== locale) errors.push(`${locale}/${section}: shard URL locale differs from source page manifest: ${url}`);
      if (page.section !== section) errors.push(`${locale}/${section}: shard URL section differs from source page manifest: ${url}`);
      if (shardPage.path !== page.path) errors.push(`${locale}/${section}: shard path differs from source page manifest for ${url}`);
      if (normalizeDigest(shardPage.sourceSha256) !== normalizeDigest(page.sha256)) {
        errors.push(`${locale}/${section}: shard source digest differs from source page manifest for ${url}`);
      }
      if (!SHA_RE.test(String(shardPage.sha256 ?? ''))) errors.push(`${locale}/${section}: final shard page digest is missing or malformed for ${url}`);
    }
  }

  const { urlSet, files: sitemapFiles } = parseSitemapBundle(sitemapDir, errors);
  for (const [url, source] of urlSet) {
    const page = pageByUrl.get(url);
    if (!page) { errors.push(`[${source.sitemap}] sitemap URL has no page manifest entry: ${url}`); continue; }
    if (page.locale !== source.locale) errors.push(`[${source.sitemap}] sitemap URL locale differs from its manifest: ${url}`);
    if (page.section && page.requiredSections.includes(page.section)) {
      const shardPages = sectionByKey.get(`${page.locale}:${page.section}`);
      const shardPage = shardPages?.get(url);
      if (!shardPage) errors.push(`[${source.sitemap}] sitemap URL is absent from required shard ${page.locale}/${page.section}: ${url}`);
      else {
        if (shardPage.path !== page.path) errors.push(`${page.locale}/${page.section}: path differs from sitemap manifest for ${url}`);
        if (!SHA_RE.test(String(shardPage.sha256 ?? ''))) errors.push(`${page.locale}/${page.section}: page digest missing for ${url}`);
        if (normalizeDigest(shardPage.sourceSha256) !== normalizeDigest(page.sha256)) {
          errors.push(`${page.locale}/${page.section}: source page digest differs from source sitemap manifest for ${url}`);
        }
      }
    }
  }
  for (const url of pageByUrl.keys()) {
    if (!urlSet.has(url)) errors.push(`page manifest URL is absent from the source sitemap bundle: ${url}`);
  }
  for (const name of manifestArtifactNames) {
    const runId = name.startsWith('section-page-manifest-it-') ? String(sourceRunId)
      : name.startsWith('section-page-manifest-') ? String(publisherRunId)
        : String(sourceRunId);
    assertArtifactRef({ runId, name, digest: artifactMetadata.get(`${runId}:${name}`)?.digest }, runId, artifactMetadata, errors);
  }

  return {
    audit: 'publisher-fast-gate',
    passed: errors.length === 0,
    validatorVersion: FAST_GATE_VALIDATOR_VERSION,
    sourceRunId: String(sourceRunId),
    sourceSha: String(sourceSha).toLowerCase(),
    publisherRunId: String(publisherRunId),
    sitemapFiles: sitemapFiles.length,
    sitemapUrlPopulation: urlSet.size,
    pageManifestPopulation: pageByUrl.size,
    sectionManifestPopulation: [...sectionByKey.values()].reduce((sum, pages) => sum + pages.size, 0),
    sampleRate: 1,
    sampledPages: urlSet.size,
    offendersTotal: errors.length,
    offendersTotalExtrapolated: errors.length,
    topOffenders: errors.slice(0, 20).map((error) => ({ path: error, feature: 'publisher-fast-gate' })),
    threshold: { metric: 'count', value: 0, comparator: '<=' },
    errorCount: errors.length,
    errors,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=', 2);
    args[rawKey] = inline ?? argv[++i];
  }
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pageManifests = jsonFiles(args['page-manifests-dir']);
  const sectionManifests = jsonFiles(args['section-manifests-dir']);
  const manifestArtifactNames = [
    ...pageManifests.map((manifest) => manifest.manifestArtifactName),
    ...sectionManifests.map((manifest) => manifest.manifestArtifactName),
  ].filter(Boolean);
  const result = validatePublisherFastGate({
    sourceRunId: args['source-run-id'],
    sourceSha: args['source-sha'],
    publisherRunId: args['publisher-run-id'],
    sitemapDir: args['sitemaps-dir'],
    pageManifests,
    sectionManifests,
    sourceArtifacts: readJson(args['source-artifacts']),
    publisherArtifacts: readJson(args['publisher-artifacts']),
    manifestArtifactNames,
  });
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`[publisher-fast-gate] ${result.passed ? 'PASS' : 'FAIL'} source=${result.sourceRunId}@${result.sourceSha.slice(0, 12)} URLs=${result.sitemapUrlPopulation} pages=${result.pageManifestPopulation} shardPages=${result.sectionManifestPopulation} errors=${result.errorCount}`);
  for (const error of result.errors.slice(0, 100)) console.error(`  - ${error}`);
  if (result.errors.length > 100) console.error(`  - … ${result.errors.length - 100} additional errors`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
