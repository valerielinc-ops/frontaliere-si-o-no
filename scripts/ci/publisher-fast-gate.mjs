#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { isExternallyServedUrl } from '../lib/externally-served-paths.mjs';
import { readSitemapSnapshot } from '../lib/sitemap-snapshot.mjs';
import { sectionTreeLayout, sectionTreeLayoutAllowed } from '../../infra/cloudflare-worker/ticino-tree-bucket.js';
import {
  diffSitemapFamilyUrls,
  evaluateSitemapFamilyCoverage,
  filterExternallyServedUrlsFromSitemapCoverage,
  isExpiredJobSitemapKey,
  SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
} from '../lib/sitemap-family-coverage.mjs';
import { ownsSitemapUrl, sectionForUrl } from '../validate-sitemap-links.mjs';
import { SHARD_VALIDATOR_VERSION } from './shard-content-manifest.mjs';

export const FAST_GATE_VALIDATOR_VERSION = 'publisher-fast-gate-v8';
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

// Accepted `version` values of a snapshot object. The shared reader hands back
// v4 NDJSON files in the v3 in-memory shape, so 3 is what normally arrives;
// 4 is tolerated for a caller that already normalised differently.
const SUPPORTED_SNAPSHOT_VERSIONS = new Set([3, 4]);

function isSupportedSnapshot(snapshot) {
  return Boolean(snapshot) && SUPPORTED_SNAPSHOT_VERSIONS.has(snapshot.version)
    && Boolean(snapshot.perSitemap) && typeof snapshot.perSitemap === 'object'
    && !Array.isArray(snapshot.perSitemap);
}

// `usable:false` means the current snapshot itself is the problem. The caller
// then skips the URL-by-URL comparison against the page manifests: with no
// snapshot, every page would otherwise be reported as "absent from the source
// sitemap bundle" (200 345 cascading errors on publish 43692928043), burying
// the single root cause reported here.
function parseSitemapSnapshot(root, previousSnapshot, declarations, bridgeEvidence, errors) {
  const urlSet = new Map();
  const familyChurn = [];
  // Expired-archive sitemap URLs (url -> locale), kept ONLY to be counted and
  // tied to the archive canaries; they never enter the page-by-page comparison.
  const archiveUrls = new Map();
  const snapshotPath = path.join(root, 'new-sitemap-urls.json');
  let currentSnapshot;
  try {
    currentSnapshot = readSitemapSnapshot(snapshotPath);
  } catch (error) {
    errors.push(`current sitemap snapshot is missing or invalid (${error.message}); skipping the URL-by-URL comparison against page manifests`);
    return { urlSet, archiveUrls, files: [], usable: false, familyChurn: [] };
  }
  if (!isSupportedSnapshot(currentSnapshot)) {
    errors.push('current sitemap snapshot must use schema version 3 or 4 with perSitemap URL sets; skipping the URL-by-URL comparison against page manifests');
    return { urlSet, archiveUrls, files: [], usable: false, familyChurn: [] };
  }

  const files = Object.keys(currentSnapshot.perSitemap).sort();
  if (!files.length) {
    errors.push(`current sitemap snapshot has no URL sets under ${root}; skipping the URL-by-URL comparison against page manifests`);
    return { urlSet, archiveUrls, files, usable: false, familyChurn: [] };
  }
  for (const [sitemap, urls] of Object.entries(currentSnapshot.perSitemap)) {
    if (!Array.isArray(urls)) {
      errors.push(`${sitemap}: sitemap snapshot URL set is not an array`);
      continue;
    }
    const isExpiredArchiveSitemap = isExpiredJobSitemapKey(sitemap);
    for (const url of urls) {
      let parsed;
      try { parsed = new URL(url); } catch { errors.push(`${sitemap}: malformed URL ${url}`); continue; }
      if (parsed.origin !== SITE_ORIGIN || isExternallyServedUrl(url)) continue;
      const locale = localeForUrl(url);
      if (!ownsSitemapUrl(url, locale)) {
        errors.push(`${sitemap}: URL is not owned by a published locale: ${url}`);
        continue;
      }
      // Expired archive URLs are attested through the bounded
      // expired-archive-evidence canaries, not the active page manifests.
      // Keep the URL/domain/ownership checks above, but do not compare the
      // intentionally larger archive population as active-page coverage.
      if (isExpiredArchiveSitemap) {
        if (!archiveUrls.has(url)) archiveUrls.set(url, locale);
        continue;
      }
      if (!urlSet.has(url)) urlSet.set(url, { locale, sitemap });
    }
  }

  if (!isSupportedSnapshot(previousSnapshot)) {
    errors.push('pre-deploy sitemap snapshot is missing or is not schema version 3 or 4');
  } else {
    const filteredPreviousSnapshot = filterExternallyServedUrlsFromSitemapCoverage(previousSnapshot);
    const filteredCurrentSnapshot = filterExternallyServedUrlsFromSitemapCoverage(currentSnapshot);
    const coverage = evaluateSitemapFamilyCoverage(
      filteredPreviousSnapshot,
      filteredCurrentSnapshot,
      declarations,
      bridgeEvidence,
    );
    for (const entry of coverage.churn) {
      familyChurn.push({
        ...entry,
        ...diffSitemapFamilyUrls(filteredPreviousSnapshot, filteredCurrentSnapshot, entry.family),
      });
    }
    for (const invalid of coverage.invalidDeclarations) {
      errors.push(`sitemap coverage declaration ${invalid.index} is invalid: ${invalid.family}`);
    }
    for (const stale of coverage.staleDeclarations) {
      errors.push(`sitemap coverage declaration is stale for ${stale.family}`);
    }
    errors.push(...coverage.bridgeEvidenceErrors);
    for (const regression of coverage.regressions) {
      errors.push(
        `sitemap family coverage decreased for ${regression.family}: ${regression.previousCount} -> ${regression.currentCount}`,
      );
    }
  }
  return { urlSet, archiveUrls, files, usable: true, familyChurn };
}

function assertManifestHeader(manifest, expected, errors, label) {
  if (manifest?.kind !== expected.kind) errors.push(`${label}: kind is ${JSON.stringify(manifest?.kind)}, expected ${expected.kind}`);
  if (manifest?.schemaVersion !== expected.schemaVersion) errors.push(`${label}: unsupported schemaVersion ${String(manifest?.schemaVersion)}`);
  if (manifest?.validatorVersion !== expected.validatorVersion) errors.push(`${label}: validatorVersion mismatch`);
  if (String(manifest?.sourceRunId) !== String(expected.sourceRunId)) errors.push(`${label}: sourceRunId mismatch`);
  if (String(manifest?.sourceSha).toLowerCase() !== String(expected.sourceSha).toLowerCase()) errors.push(`${label}: sourceSha mismatch`);
}

// Fail-closed accounting for the expired-archive sitemap family. The family is
// kept out of the page-by-page comparison (its pages are in no page manifest),
// so the only thing vouching for it is the per-locale canary set: a locale whose
// archive sitemaps list URLs must have published at least one canary, whatever
// its overflow counters say, and at least one must be verified in a required
// shard. A URL that is ALSO listed by a page sitemap is compared page-by-page
// and is not counted as excluded.
function summarizeExpiredArchiveCoverage({
  archiveUrls,
  urlSet,
  archiveEvidenceByLocale,
  archiveEvidenceManifests,
  canaryVerifiedByLocale,
  errors,
}) {
  const excludedByLocale = Object.fromEntries(LOCALES.map((locale) => [locale, 0]));
  const canaryEntriesByLocale = Object.fromEntries(LOCALES.map((locale) => [
    locale,
    archiveEvidenceByLocale.get(locale)?.entries?.length ?? 0,
  ]));
  for (const [url, locale] of archiveUrls) {
    if (!urlSet.has(url)) excludedByLocale[locale] += 1;
  }
  const coveredByCanaryByLocale = Object.fromEntries(LOCALES.map((locale) => [locale, 0]));
  let excluded = 0;
  let coveredByCanary = 0;
  for (const locale of LOCALES) {
    const count = excludedByLocale[locale];
    excluded += count;
    if (count === 0) continue;
    if (archiveEvidenceManifests === null) {
      errors.push(`expired archive sitemaps list ${count} ${locale} URL(s) but no archive publication evidence was supplied`);
    } else if (canaryEntriesByLocale[locale] === 0) {
      errors.push(`expired archive sitemaps list ${count} ${locale} URL(s) but the ${locale} archive evidence has no publication canary`);
    } else if (canaryVerifiedByLocale[locale] === 0) {
      // A canary in `entries` only vouches for the archive once it has been
      // bound to the final bytes of a REQUIRED shard; an unbound one proves
      // nothing about what was published.
      errors.push(`expired archive sitemaps list ${count} ${locale} URL(s) but no ${locale} archive canary was verified in a required shard`);
    } else {
      coveredByCanaryByLocale[locale] = count;
      coveredByCanary += count;
    }
  }
  return {
    excluded,
    excludedByLocale,
    coveredByCanary,
    coveredByCanaryByLocale,
    canaryEntriesByLocale,
    canaryVerifiedByLocale,
  };
}

export function validatePublisherFastGate({
  sourceRunId,
  sourceSha,
  publisherRunId,
  sitemapDir,
  previousSitemapSnapshot,
  sitemapCoverageDeclarations,
  pageManifests,
  sectionManifests,
  archiveEvidenceManifests = null,
  sitemapFamilyBridgeEvidence = null,
  sitemapFamilyBridgeEvidenceFiles = [],
  sourceArtifacts,
  publisherArtifacts,
  manifestArtifactNames = [],
}) {
  const errors = [];
  const pageByUrl = new Map();
  const pageManifestByLocale = new Map();
  const archiveEvidenceByUrl = new Map();
  const expected = { sourceRunId, sourceSha, kind: 'publisher-page-manifest', schemaVersion: 2, validatorVersion: 'publisher-page-index-v2' };
  const artifactMetadata = readArtifactMetadata(sourceRunId, publisherRunId, sourceArtifacts, publisherArtifacts);

  const archiveEvidenceByLocale = new Map();
  for (const manifest of archiveEvidenceManifests ?? []) {
    const locale = String(manifest?.locale ?? '');
    const label = `expired archive evidence ${locale}`;
    assertManifestHeader(manifest, {
      sourceRunId,
      sourceSha,
      kind: 'expired-archive-publication-evidence',
      schemaVersion: 1,
      validatorVersion: 'expired-archive-publication-v1',
    }, errors, label);
    if (!LOCALES.includes(locale)) { errors.push(`${label}: locale is unsupported`); continue; }
    if (archiveEvidenceByLocale.has(locale)) { errors.push(`${label}: duplicate locale evidence`); continue; }
    archiveEvidenceByLocale.set(locale, manifest);
    const artifactName = `expired-archive-evidence-${locale}-${sourceRunId}`;
    const artifact = artifactMetadata.get(`${sourceRunId}:${artifactName}`);
    assertArtifactRef({ name: artifactName, runId: sourceRunId, digest: artifact?.digest }, sourceRunId, artifactMetadata, errors);
    const indexed = Number(manifest.indexedOverflowAliases);
    const rendered = Number(manifest.renderedOverflowPages);
    if (!Number.isSafeInteger(indexed) || indexed < 0) errors.push(`${label}: indexedOverflowAliases is invalid`);
    if (!Number.isSafeInteger(rendered) || rendered < 0) errors.push(`${label}: renderedOverflowPages is invalid`);
    if (!Array.isArray(manifest.entries)) { errors.push(`${label}: entries is not an array`); continue; }
    if (indexed > 0 && rendered > 0 && manifest.entries.length === 0) errors.push(`${label}: overflow pages have no publication canary`);
    if (manifest.sampleSize !== manifest.entries.length) errors.push(`${label}: sampleSize differs from entries`);
    for (const entry of manifest.entries) {
      const url = String(entry?.url ?? '');
      if (!url || archiveEvidenceByUrl.has(url)) { errors.push(`${label}: missing or duplicate URL ${JSON.stringify(url)}`); continue; }
      if (entry.evidenceKind !== 'expired-archive') errors.push(`${label}: evidenceKind is invalid for ${url}`);
      if (entry.locale !== locale) errors.push(`${label}: page locale mismatch for ${url}`);
      if (entry.section !== sectionForUrl(url, locale)) errors.push(`${label}: page section mismatch for ${url}`);
      if (!routeCandidates(url).includes(String(entry.path ?? ''))) errors.push(`${label}: page path does not map to URL ${url}`);
      for (const field of ['sha256', 'payloadSha256', 'descriptionSha256', 'expiredAtSha256', 'ownerSha256']) {
        if (!SHA_RE.test(String(entry[field] ?? ''))) errors.push(`${label}: ${field} is missing or malformed for ${url}`);
      }
      archiveEvidenceByUrl.set(url, entry);
    }
  }
  if (archiveEvidenceManifests !== null) {
    for (const locale of LOCALES) {
      if (!archiveEvidenceByLocale.has(locale)) errors.push(`expired archive evidence missing for locale ${locale}`);
    }
    const indexedPopulations = new Set(
      [...archiveEvidenceByLocale.values()].map((manifest) => Number(manifest.indexedOverflowAliases)),
    );
    if (indexedPopulations.size > 1) errors.push('expired archive indexed overflow population differs between locales');
    const indexedPopulation = Number([...indexedPopulations][0] ?? 0);
    if (indexedPopulation > 0 && archiveEvidenceByUrl.size === 0) {
      errors.push('expired archive overflow has no trusted publication canary');
    }
  }

  for (const manifest of pageManifests) {
    const locale = manifest?.locale;
    const label = `page manifest ${String(locale)}`;
    const expectedArtifactRunId = locale === 'it' ? String(publisherRunId) : String(sourceRunId);
    assertManifestHeader(manifest, expected, errors, label);
    if (!LOCALES.includes(locale)) { errors.push(`${label}: locale is unsupported`); continue; }
    if (pageManifestByLocale.has(locale)) { errors.push(`${label}: duplicate locale manifest`); continue; }
    if (String(manifest.artifactRunId) !== expectedArtifactRunId) errors.push(`${label}: artifactRunId mismatch`);
    pageManifestByLocale.set(locale, manifest);
    if (!Array.isArray(manifest.entries)) { errors.push(`${label}: entries is not an array`); continue; }
    if (!Array.isArray(manifest.artifactRefs) || manifest.artifactRefs.length === 0) errors.push(`${label}: artifactRefs is empty`);
    for (const ref of manifest.artifactRefs ?? []) {
      assertArtifactRef(ref, expectedArtifactRunId, artifactMetadata, errors);
    }
    if (!manifest.manifestArtifactName) errors.push(`${label}: manifest artifact name is missing`);
    else assertArtifactRef({ runId: expectedArtifactRunId, name: manifest.manifestArtifactName, digest: artifactMetadata.get(`${expectedArtifactRunId}:${manifest.manifestArtifactName}`)?.digest }, expectedArtifactRunId, artifactMetadata, errors);
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
    .filter((ref) => ref.purpose === 'sitemaps' && ref.name === `sitemaps-${publisherRunId}`);
  if (sitemapRefs.length !== 1) errors.push(`expected one publisher sitemaps artifact receipt for sitemaps-${publisherRunId}`);

  const sectionByKey = new Map();
  const sectionManifestByLocale = new Map();
  const shardUrlOwners = new Map();
  for (const manifest of sectionManifests) {
    const locale = manifest?.locale;
    const expectedArtifactRunId = String(publisherRunId);
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
      const expectedLayout = sectionTreeLayout(shard.section);
      if (!sectionTreeLayoutAllowed(shard.section, shard.sourcePathLayout)) {
        const allowed = expectedLayout === 'canonical' ? `canonical or ${shard.section}-hash-v1` : expectedLayout;
        errors.push(`${label}: ${shard.section} sourcePathLayout must be ${allowed}`);
      }
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
      const archiveEvidence = archiveEvidenceByUrl.get(url);
      if (!page && !archiveEvidence) {
        errors.push(`${locale}/${section}: shard URL is absent from source page manifests: ${url}`);
        continue;
      }
      const source = page ?? archiveEvidence;
      if (source.locale !== locale) errors.push(`${locale}/${section}: shard URL locale differs from source receipt: ${url}`);
      if (source.section !== section) errors.push(`${locale}/${section}: shard URL section differs from source receipt: ${url}`);
      if (shardPage.path !== source.path) errors.push(`${locale}/${section}: shard path differs from source receipt for ${url}`);
      if (normalizeDigest(shardPage.sourceSha256) !== normalizeDigest(source.sha256)) {
        errors.push(`${locale}/${section}: shard source digest differs from source page manifest for ${url}`);
      }
      if (!SHA_RE.test(String(shardPage.sha256 ?? ''))) errors.push(`${locale}/${section}: final shard page digest is missing or malformed for ${url}`);
    }
  }

  const {
    urlSet,
    archiveUrls,
    files: sitemapFiles,
    usable: sitemapSnapshotUsable,
    familyChurn: sitemapFamilyChurn,
  } = parseSitemapSnapshot(
    sitemapDir,
    previousSitemapSnapshot,
    sitemapCoverageDeclarations,
    sitemapFamilyBridgeEvidence,
    errors,
  );
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
  if (sitemapSnapshotUsable) {
    for (const url of pageByUrl.keys()) {
      if (!urlSet.has(url)) errors.push(`page manifest URL is absent from the source sitemap bundle: ${url}`);
    }
  }
  const canaryVerifiedByLocale = Object.fromEntries(LOCALES.map((locale) => [locale, 0]));
  for (const [url, evidence] of archiveEvidenceByUrl) {
    const pageManifest = pageManifestByLocale.get(evidence.locale);
    if ((pageManifest?.requiredSections ?? []).includes(evidence.section)) {
      const shardPage = sectionByKey.get(`${evidence.locale}:${evidence.section}`)?.get(url);
      if (!shardPage) errors.push(`expired archive canary is absent from required shard ${evidence.locale}/${evidence.section}: ${url}`);
      else if (normalizeDigest(shardPage.sourceSha256) !== normalizeDigest(evidence.sha256)) {
        errors.push(`expired archive canary digest differs in required shard ${evidence.locale}/${evidence.section}: ${url}`);
      } else {
        canaryVerifiedByLocale[evidence.locale] += 1;
      }
    }
  }
  const archive = summarizeExpiredArchiveCoverage({
    archiveUrls,
    urlSet,
    archiveEvidenceByLocale,
    archiveEvidenceManifests,
    canaryVerifiedByLocale,
    errors,
  });
  for (const name of manifestArtifactNames) {
    const runId = name.startsWith('section-page-manifest-') || name.startsWith('sitemap-page-manifest-it-') ? String(publisherRunId)
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
    sitemapUrlPopulation: urlSet.size + archive.excluded,
    pageManifestPopulation: pageByUrl.size,
    sectionManifestPopulation: [...sectionByKey.values()].reduce((sum, pages) => sum + pages.size, 0),
    expiredArchiveEvidencePopulation: archiveEvidenceByUrl.size,
    expiredArchiveSitemapExcluded: archive.excluded,
    expiredArchiveSitemapExcludedByLocale: archive.excludedByLocale,
    expiredArchiveSitemapCoveredByCanary: archive.coveredByCanary,
    expiredArchiveSitemapCoveredByCanaryByLocale: archive.coveredByCanaryByLocale,
    expiredArchiveCanaryEntriesByLocale: archive.canaryEntriesByLocale,
    expiredArchiveCanaryVerifiedByLocale: archive.canaryVerifiedByLocale,
    sitemapFamilyChurn,
    sitemapFamilyBridgeEvidenceFiles,
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

function readOptionalJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return readJson(file); } catch (error) {
    console.error(`[publisher-fast-gate] optional bridge evidence unreadable: ${error.message}`);
    return null;
  }
}

function mergeSitemapFamilyBridgeEvidence(evidenceFiles) {
  if (evidenceFiles.length === 0) return null;

  const entries = new Map();
  const missing = new Map();
  for (const { evidence } of evidenceFiles) {
    for (const entry of Array.isArray(evidence?.entries) ? evidence.entries : []) {
      const family = String(entry?.family ?? '');
      const url = String(entry?.url ?? '');
      const key = family && url ? `${family}\0${url}` : `invalid:${JSON.stringify(entry)}`;
      if (!entries.has(key)) entries.set(key, entry);
    }
    for (const item of Array.isArray(evidence?.missing) ? evidence.missing : []) {
      const key = JSON.stringify(item);
      if (!missing.has(key)) missing.set(key, item);
    }
  }

  return {
    schemaVersion: SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
    kind: 'sitemap-family-bridge-evidence',
    complete: evidenceFiles.every(({ evidence }) =>
      evidence?.schemaVersion === SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION
      && evidence?.kind === 'sitemap-family-bridge-evidence'
      && evidence?.complete === true),
    entries: [...entries.values()].sort((a, b) =>
      `${a?.family ?? ''}\0${a?.url ?? ''}`.localeCompare(`${b?.family ?? ''}\0${b?.url ?? ''}`)),
    missing: [...missing.values()].sort((a, b) =>
      `${a?.family ?? ''}\0${a?.url ?? ''}\0${a?.reason ?? ''}`
        .localeCompare(`${b?.family ?? ''}\0${b?.url ?? ''}\0${b?.reason ?? ''}`)),
  };
}

export function readSitemapFamilyBridgeEvidence(sitemapsDir) {
  const names = [
    'sitemap-family-bridge-evidence.json',
    'sitemap-family-bridge-evidence-en.json',
    'sitemap-family-bridge-evidence-de.json',
    'sitemap-family-bridge-evidence-fr.json',
  ];
  const files = names
    .map((name) => ({ name, file: path.join(sitemapsDir, name) }))
    .filter(({ file }) => fs.existsSync(file))
    .map(({ name, file }) => ({ name, evidence: readOptionalJson(file) }));
  return {
    evidence: mergeSitemapFamilyBridgeEvidence(files),
    files: files.map(({ name }) => name),
  };
}

function formatByLocale(byLocale) {
  return LOCALES.map((locale) => `${locale}=${byLocale?.[locale] ?? 0}`).join(' ');
}

// Absent or unreadable baseline -> null, so the gate reports it as an error
// (fail-closed) instead of crashing before it can write its result file.
function readPreviousSitemapSnapshot(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return readSitemapSnapshot(file);
  } catch (error) {
    console.error(`[publisher-fast-gate] pre-deploy sitemap snapshot unreadable: ${error.message}`);
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pageManifests = jsonFiles(args['page-manifests-dir']);
  const sectionManifests = jsonFiles(args['section-manifests-dir']);
  const archiveEvidenceManifests = jsonFiles(args['archive-evidence-dir']);
  const bridgeEvidence = readSitemapFamilyBridgeEvidence(args['sitemaps-dir']);
  const manifestArtifactNames = [
    ...pageManifests.map((manifest) => manifest.manifestArtifactName),
    ...sectionManifests.map((manifest) => manifest.manifestArtifactName),
  ].filter(Boolean);
  const result = validatePublisherFastGate({
    sourceRunId: args['source-run-id'],
    sourceSha: args['source-sha'],
    publisherRunId: args['publisher-run-id'],
    sitemapDir: args['sitemaps-dir'],
    previousSitemapSnapshot: readPreviousSitemapSnapshot(path.join(args['sitemaps-dir'], 'pre-deploy-sitemap-urls.json')),
    sitemapCoverageDeclarations: readJson('data/sitemap-family-coverage-declarations.json'),
    sitemapFamilyBridgeEvidence: bridgeEvidence.evidence,
    sitemapFamilyBridgeEvidenceFiles: bridgeEvidence.files,
    pageManifests,
    sectionManifests,
    archiveEvidenceManifests,
    sourceArtifacts: readJson(args['source-artifacts']),
    publisherArtifacts: readJson(args['publisher-artifacts']),
    manifestArtifactNames,
  });
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`[publisher-fast-gate] ${result.passed ? 'PASS' : 'FAIL'} source=${result.sourceRunId}@${result.sourceSha.slice(0, 12)} URLs=${result.sitemapUrlPopulation} pages=${result.pageManifestPopulation} shardPages=${result.sectionManifestPopulation} errors=${result.errorCount} sitemapFamilyBridgeEvidenceFiles=${result.sitemapFamilyBridgeEvidenceFiles.join(',') || 'none'}`);
  console.log(
    `[publisher-fast-gate] expired-archive family: ${result.expiredArchiveSitemapExcluded} sitemap URL(s) excluded from the page-by-page comparison (${formatByLocale(result.expiredArchiveSitemapExcludedByLocale)}); `
    + `${result.expiredArchiveSitemapCoveredByCanary} covered by a locale canary set (${formatByLocale(result.expiredArchiveSitemapCoveredByCanaryByLocale)}); `
    + `canary entries ${formatByLocale(result.expiredArchiveCanaryEntriesByLocale)}, verified in a required shard ${formatByLocale(result.expiredArchiveCanaryVerifiedByLocale)}`,
  );
  for (const entry of result.sitemapFamilyChurn) {
    const pct = ((entry.previousCount - entry.currentCount) / entry.previousCount * 100).toFixed(1);
    console.log(
      `[publisher-fast-gate] sitemap family churn (data-driven, within collapse bound): ${entry.family} `
      + `${entry.previousCount} -> ${entry.currentCount} (${entry.delta}, -${pct}% of ${entry.tolerance * 100}% bound; `
      + `removed=${entry.removed} added=${entry.added})`,
    );
  }
  for (const error of result.errors.slice(0, 100)) console.error(`  - ${error}`);
  if (result.errors.length > 100) console.error(`  - … ${result.errors.length - 100} additional errors`);
  if (!result.passed) process.exitCode = 1;
}

if (isInvokedDirectly(import.meta.url)) main();
