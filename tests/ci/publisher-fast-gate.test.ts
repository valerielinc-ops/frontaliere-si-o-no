// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindPageManifest,
  createSectionManifest,
  finalizeSectionManifestSet,
  sectionBatch,
} from '../../scripts/ci/shard-content-manifest.mjs';
import {
  readSitemapFamilyBridgeEvidence,
  validatePublisherFastGate,
} from '../../scripts/ci/publisher-fast-gate.mjs';
import { writeSnapshotFile } from '../../scripts/lib/sitemap-snapshot.mjs';
import { EXPIRED_JOB_SITEMAP_FILE_RX, isExpiredJobSitemapKey } from '../../scripts/lib/sitemap-family-coverage.mjs';

const SOURCE_RUN_ID = '101';
const PUBLISHER_RUN_ID = '202';
const SOURCE_SHA = 'a'.repeat(40);
const roots: string[] = [];

function coverageUrls(family: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    `https://coverage-fixture.invalid/${family}/${String(index).padStart(4, '0')}/`);
}

function bridgeEvidenceForSnapshots(
  previous: { perSitemap: Record<string, string[]> },
  current: { perSitemap: Record<string, string[]> },
  family: string,
) {
  const previousUrls = new Set(Object.values(previous.perSitemap).flat());
  const currentUrls = new Set(Object.values(current.perSitemap).flat());
  return {
    schemaVersion: 1,
    kind: 'sitemap-family-bridge-evidence',
    complete: true,
    entries: [...previousUrls]
      .filter((url) => !currentUrls.has(url))
      .map((url) => ({
        family,
        url,
        path: `${new URL(url).pathname.replace(/^\/+|\/+$/gu, '')}/index.html`,
        sha256: 'a'.repeat(64),
        robots: 'noindex,follow',
      })),
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-fast-gate-'));
  roots.push(root);
  return root;
}

function artifact(name: string, digest: string) {
  return { name, digest: `sha256:${digest}`, expired: false };
}

function fixture() {
  const root = tempRoot();
  const sitemapDir = path.join(root, 'sitemaps');
  fs.mkdirSync(sitemapDir);
  const routes = [
    ['it', 'cerca-lavoro-ticino/sector/'],
    ['en', 'en/good/'],
    ['de', 'de/gut/'],
    ['fr', 'fr/bon/'],
  ] as const;
  const pageManifests = [];
  const sourceArtifacts = [];
  const publisherArtifacts = [];
  const sitemapUrls = routes.map(([locale, route]) => `https://frontaliereticino.ch/${route}`);
  const currentSitemapSnapshot: { version: number; perSitemap: Record<string, string[]> } = {
    version: 3,
    perSitemap: { 'sitemap-job-market.xml': sitemapUrls },
  };
  const previousSitemapSnapshot = structuredClone(currentSitemapSnapshot);
  fs.writeFileSync(path.join(sitemapDir, 'new-sitemap-urls.json'), JSON.stringify(currentSitemapSnapshot));
  fs.writeFileSync(path.join(sitemapDir, 'pre-deploy-sitemap-urls.json'), JSON.stringify(previousSitemapSnapshot));

  for (const [locale, route] of routes) {
    const baseArtifact = locale === 'it' ? 'github-pages' : `locale-shard-source-${locale}-${SOURCE_RUN_ID}`;
    const baseDigest = locale === 'it'
      ? '0'.repeat(64)
      : `${locale.charCodeAt(0).toString(16).padStart(2, '0')}`.repeat(32);
    const section = locale === 'it' ? 'ticino' : null;
    const batchName = `shard-batch-5-dist-it-${SOURCE_RUN_ID}`;
    const batchDigest = 'b'.repeat(64);
    const pageArtifactName = section ? batchName.replace(SOURCE_RUN_ID, PUBLISHER_RUN_ID) : baseArtifact;
    const pageArtifactDigest = section ? batchDigest : baseDigest;
    const url = `https://frontaliereticino.ch/${route}`;
    const pagePath = `${route.replace(/\/$/u, '')}/index.html`;
    const pageDigest = 'c'.repeat(64);

    pageManifests.push({
      schemaVersion: 2,
      kind: 'publisher-page-manifest',
      validatorVersion: 'publisher-page-index-v2',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: locale === 'it' ? PUBLISHER_RUN_ID : SOURCE_RUN_ID,
      artifactName: baseArtifact,
      artifactDigest: baseDigest,
      manifestArtifactName: `sitemap-page-manifest-${locale}-${locale === 'it' ? PUBLISHER_RUN_ID : SOURCE_RUN_ID}`,
      locale,
      requiredSections: section ? ['ticino'] : [],
      artifactRefs: [
        { runId: locale === 'it' ? PUBLISHER_RUN_ID : SOURCE_RUN_ID, name: baseArtifact, digest: baseDigest, purpose: 'locale-base' },
        ...(locale === 'it' ? [{ runId: PUBLISHER_RUN_ID, name: `sitemaps-${PUBLISHER_RUN_ID}`, digest: '9'.repeat(64), purpose: 'sitemaps' }] : []),
        ...(section ? [{ runId: PUBLISHER_RUN_ID, name: batchName.replace(SOURCE_RUN_ID, PUBLISHER_RUN_ID), digest: batchDigest, purpose: 'section-shard-tar-batch' }] : []),
      ],
      entries: [{ url, path: pagePath, sha256: pageDigest, locale, section, artifactName: pageArtifactName, artifactDigest: pageArtifactDigest }],
    });
    if (locale !== 'it') {
      sourceArtifacts.push(artifact(baseArtifact, baseDigest));
      sourceArtifacts.push(artifact(`sitemap-page-manifest-${locale}-${SOURCE_RUN_ID}`, 'd'.repeat(64)));
    } else {
      publisherArtifacts.push(artifact(baseArtifact, baseDigest));
      publisherArtifacts.push(artifact(`sitemaps-${PUBLISHER_RUN_ID}`, '9'.repeat(64)));
      publisherArtifacts.push(artifact(`sitemap-page-manifest-it-${PUBLISHER_RUN_ID}`, 'd'.repeat(64)));
      publisherArtifacts.push(artifact(`shard-batch-5-dist-it-${PUBLISHER_RUN_ID}`, batchDigest));
    }
  }
  sourceArtifacts.push(artifact(`it-publish-root-${SOURCE_RUN_ID}`, 'a'.repeat(64)));
  for (const locale of ['it', 'en', 'de', 'fr']) {
    sourceArtifacts.push(artifact(`expired-archive-evidence-${locale}-${SOURCE_RUN_ID}`, '5'.repeat(64)));
  }
  sourceArtifacts.push(artifact(`jobs-master-${SOURCE_RUN_ID}`, '6'.repeat(64)));

  const ticinoPage = pageManifests[0].entries[0];
  const sectionPage = {
    schemaVersion: 2,
    kind: 'publisher-section-manifest',
    validatorVersion: 'publisher-shard-content-v2',
    sourceRunId: SOURCE_RUN_ID,
    sourceSha: SOURCE_SHA,
    artifactRunId: PUBLISHER_RUN_ID,
    manifestArtifactName: `section-page-manifest-it-${PUBLISHER_RUN_ID}`,
    locale: 'it',
    requiredSections: ['ticino'],
    artifactRefs: [{ runId: PUBLISHER_RUN_ID, name: `shard-batch-5-dist-it-${PUBLISHER_RUN_ID}`, digest: 'b'.repeat(64), purpose: 'section-shard-tar-batch' }],
    shards: [{
      schemaVersion: 2,
      kind: 'publisher-shard-content',
      validatorVersion: 'publisher-shard-content-v2',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: PUBLISHER_RUN_ID,
      artifactName: `shard-batch-5-dist-it-${PUBLISHER_RUN_ID}`,
      artifactDigest: 'b'.repeat(64),
      locale: 'it',
      section: 'ticino',
      sourcePathLayout: 'ticino-hash-v1',
      prefix: 'cerca-lavoro-ticino',
      tarSha256: 'e'.repeat(64),
      population: 1,
      pages: [{ url: ticinoPage.url, path: ticinoPage.path, sourceSha256: ticinoPage.sha256, sha256: '1'.repeat(64), locale: 'it', section: 'ticino' }],
    }],
    population: 1,
  };
  publisherArtifacts.push(artifact(`section-page-manifest-it-${PUBLISHER_RUN_ID}`, 'f'.repeat(64)));
  publisherArtifacts.push(artifact('github-pages', '0'.repeat(64)));
  const sectionManifests = [sectionPage];
  for (const locale of ['en', 'de', 'fr']) {
    const name = `section-page-manifest-${locale}-${PUBLISHER_RUN_ID}`;
    const digest = `${locale.charCodeAt(0).toString(16).padStart(2, '0')}`.repeat(32);
    sectionManifests.push({
      schemaVersion: 2,
      kind: 'publisher-section-manifest',
      validatorVersion: 'publisher-shard-content-v2',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: PUBLISHER_RUN_ID,
      manifestArtifactName: name,
      locale,
      requiredSections: [],
      artifactRefs: [],
      shards: [],
      population: 0,
    });
    publisherArtifacts.push(artifact(name, digest));
  }
  const validate = (options: Record<string, unknown> = {}) => validatePublisherFastGate({
    sourceRunId: SOURCE_RUN_ID,
    sourceSha: SOURCE_SHA,
    publisherRunId: PUBLISHER_RUN_ID,
    sitemapDir,
    previousSitemapSnapshot,
    sitemapCoverageDeclarations: { version: 1, decreases: [] },
    pageManifests,
    sectionManifests,
    sourceArtifacts: { artifacts: sourceArtifacts },
    publisherArtifacts: { artifacts: publisherArtifacts },
    manifestArtifactNames: [
      ...pageManifests.map((manifest) => manifest.manifestArtifactName),
      ...sectionManifests.map((manifest) => manifest.manifestArtifactName),
    ],
    ...options,
  });
  const result = validate();
  return {
    result, pageManifests, sectionPage, sectionManifests, sourceArtifacts, publisherArtifacts,
    sitemapDir, currentSitemapSnapshot, previousSitemapSnapshot, validate,
  };
}

function addOrphanFamilyDecrease(base: ReturnType<typeof fixture>, removedUrls: string[]): string[] {
  const retainedUrls = Array.from({ length: 18 }, (_, index) =>
    `https://coverage-fixture.invalid/orphan-retained/${String(index).padStart(2, '0')}/`);
  base.previousSitemapSnapshot.perSitemap['sitemap-orphan-landings.xml'] = [...retainedUrls, ...removedUrls];
  base.currentSitemapSnapshot.perSitemap['sitemap-orphan-landings.xml'] = retainedUrls;
  fs.writeFileSync(
    path.join(base.sitemapDir, 'pre-deploy-sitemap-urls.json'),
    JSON.stringify(base.previousSitemapSnapshot),
  );
  fs.writeFileSync(
    path.join(base.sitemapDir, 'new-sitemap-urls.json'),
    JSON.stringify(base.currentSitemapSnapshot),
  );
  return retainedUrls;
}

function evidenceEntry(url: string) {
  return {
    family: 'orphan-landings',
    url,
    path: `${new URL(url).pathname.replace(/^\/+|\/+$/gu, '')}/index.html`,
    sha256: 'a'.repeat(64),
    robots: 'noindex,follow',
  };
}

function validateWithBridgeEvidenceFiles(base: ReturnType<typeof fixture>) {
  const bridgeEvidence = readSitemapFamilyBridgeEvidence(base.sitemapDir);
  return {
    ...bridgeEvidence,
    result: base.validate({
      sitemapFamilyBridgeEvidence: bridgeEvidence.evidence,
      sitemapFamilyBridgeEvidenceFiles: bridgeEvidence.files,
    }),
  };
}

const ARCHIVE_URLS = {
  it: 'https://frontaliereticino.ch/cerca-lavoro-ticino/late-overflow-alias/',
  en: 'https://frontaliereticino.ch/en/find-jobs-ticino/late-overflow-alias/',
  de: 'https://frontaliereticino.ch/de/jobs-im-tessin/late-overflow-alias/',
  fr: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin/late-overflow-alias/',
} as const;
const ARCHIVE_DIGEST = '7'.repeat(64);

// Adds the expired-archive family to a base fixture: `archiveLocales` get a
// URL in `sitemap-jobs-expired-001.xml`, `canaryLocales` get one published
// canary. The IT canary is bound to the required Ticino shard receipt, as the
// real evidence is. Evidence manifests are only built when `withEvidence`.
// `unboundLocales` keep their canary in the evidence but get NO required Ticino
// shard, so the canary can never be verified against published bytes.
function archiveFixture({ archiveLocales, canaryLocales, withEvidence = true, unboundLocales = [] }: {
  archiveLocales: Array<keyof typeof ARCHIVE_URLS>;
  canaryLocales: Array<keyof typeof ARCHIVE_URLS>;
  withEvidence?: boolean;
  unboundLocales?: Array<keyof typeof ARCHIVE_URLS>;
}) {
  const base = fixture();
  base.currentSitemapSnapshot.perSitemap['sitemap-jobs-expired-001.xml'] = archiveLocales.map((l) => ARCHIVE_URLS[l]);
  fs.writeFileSync(path.join(base.sitemapDir, 'new-sitemap-urls.json'), JSON.stringify(base.currentSitemapSnapshot));
  const archiveEvidenceManifests = ['it', 'en', 'de', 'fr'].map((locale) => {
    const l = locale as keyof typeof ARCHIVE_URLS;
    const url = ARCHIVE_URLS[l];
    const entries = canaryLocales.includes(l) ? [{
      evidenceKind: 'expired-archive', locale, section: 'ticino', url,
      path: `${new URL(url).pathname.replace(/^\/|\/$/gu, '')}/index.html`,
      sha256: ARCHIVE_DIGEST, payloadSha256: '1'.repeat(64),
      descriptionSha256: '2'.repeat(64), expiredAtSha256: '3'.repeat(64), ownerSha256: '4'.repeat(64),
    }] : [];
    if (entries.length && !unboundLocales.includes(l)) {
      const page = {
        evidenceKind: 'expired-archive', locale, section: 'ticino', url, path: entries[0].path,
        sourceSha256: ARCHIVE_DIGEST, sha256: '8'.repeat(64),
      };
      if (l === 'it') {
        base.sectionPage.shards[0].pages.push(page);
      } else {
        // bind the canary to the final bytes of a required Ticino shard of that locale
        const shardArtifact = `shard-batch-5-dist-${locale}-${PUBLISHER_RUN_ID}`;
        base.pageManifests.find((manifest) => manifest.locale === locale)!.requiredSections = ['ticino'];
        const sectionManifest = base.sectionManifests.find((manifest) => manifest.locale === locale)!;
        sectionManifest.requiredSections = ['ticino'];
        sectionManifest.artifactRefs = [{ runId: PUBLISHER_RUN_ID, name: shardArtifact, digest: 'b'.repeat(64), purpose: 'section-shard-tar-batch' }];
        sectionManifest.shards = [{
          schemaVersion: 2,
          kind: 'publisher-shard-content',
          validatorVersion: 'publisher-shard-content-v2',
          sourceRunId: SOURCE_RUN_ID,
          sourceSha: SOURCE_SHA,
          artifactRunId: PUBLISHER_RUN_ID,
          artifactName: shardArtifact,
          artifactDigest: 'b'.repeat(64),
          locale,
          section: 'ticino',
          sourcePathLayout: 'ticino-hash-v1',
          prefix: entries[0].path.split('/').slice(0, 2).join('/'),
          tarSha256: 'e'.repeat(64),
          population: 1,
          pages: [page],
        }];
        base.publisherArtifacts.push(artifact(shardArtifact, 'b'.repeat(64)));
      }
    }
    return {
      schemaVersion: 1,
      kind: 'expired-archive-publication-evidence',
      validatorVersion: 'expired-archive-publication-v1',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      locale,
      indexedOverflowAliases: 1000,
      // a locale without a canary renders no overflow page: the pre-existing per-locale
      // check (indexed>0 && rendered>0) stays silent, which is the hole the new check closes
      renderedOverflowPages: entries.length ? 1000 : 0,
      sampleSize: entries.length,
      entries,
    };
  });
  const validate = () => validatePublisherFastGate({
    sourceRunId: SOURCE_RUN_ID,
    sourceSha: SOURCE_SHA,
    publisherRunId: PUBLISHER_RUN_ID,
    sitemapDir: base.sitemapDir,
    previousSitemapSnapshot: base.previousSitemapSnapshot,
    sitemapCoverageDeclarations: { version: 1, decreases: [] },
    pageManifests: base.pageManifests,
    sectionManifests: base.sectionManifests,
    ...(withEvidence ? { archiveEvidenceManifests } : {}),
    sourceArtifacts: { artifacts: base.sourceArtifacts },
    publisherArtifacts: { artifacts: base.publisherArtifacts },
    manifestArtifactNames: [
      ...base.pageManifests.map((manifest) => manifest.manifestArtifactName),
      ...base.sectionManifests.map((manifest) => manifest.manifestArtifactName),
    ],
  });
  return { ...base, validate };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('publisher fast provenance gate', () => {
  it('hashes section tar files in bounded chunks without whole-file reads', () => {
    const root = tempRoot();
    const tarPath = path.join(root, 'section.tar');
    const tarBytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
    fs.writeFileSync(tarPath, tarBytes);
    const expectedTarDigest = crypto.createHash('sha256').update(tarBytes).digest('hex');
    const readFileSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('whole-file reads are not supported for shard artifacts');
    });

    try {
      const manifest = createSectionManifest({
        root,
        prefix: 'cerca-lavoro-ticino',
        locale: 'it',
        section: 'ticino',
        sourceRunId: SOURCE_RUN_ID,
        sourceSha: SOURCE_SHA,
        artifactRunId: SOURCE_RUN_ID,
        tarPath,
      });

      expect(manifest.tarSha256).toBe(expectedTarDigest);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it('adds non-sitemap archive evidence to the section receipt with source and final digests', () => {
    const root = tempRoot();
    const pageRoot = path.join(root, 'cerca-lavoro-ticino');
    const pagePath = path.join(pageRoot, 'late-alias', 'index.html');
    const html = '<html><main data-expired-static-body="true">archive</main></html>';
    fs.mkdirSync(path.dirname(pagePath), { recursive: true });
    fs.writeFileSync(pagePath, html);
    const sourceDigest = crypto.createHash('sha256').update(html).digest('hex');
    const evidencePath = path.join(root, 'evidence.json');
    fs.writeFileSync(evidencePath, JSON.stringify({
      schemaVersion: 1,
      kind: 'expired-archive-publication-evidence',
      validatorVersion: 'expired-archive-publication-v1',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      locale: 'it',
      entries: [{
        evidenceKind: 'expired-archive', locale: 'it', section: 'ticino',
        url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/late-alias/',
        path: 'cerca-lavoro-ticino/late-alias/index.html', sha256: sourceDigest,
      }],
    }));

    const manifest = createSectionManifest({
      root: pageRoot,
      prefix: 'cerca-lavoro-ticino',
      locale: 'it',
      section: 'ticino',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
      evidenceManifestPath: evidencePath,
    });

    expect(manifest.pages).toEqual([expect.objectContaining({
      evidenceKind: 'expired-archive', sourceSha256: sourceDigest, sha256: sourceDigest,
    })]);
  });

  it('rejects archive evidence whose digest differs from the shard source bytes', () => {
    const root = tempRoot();
    const pageRoot = path.join(root, 'cerca-lavoro-ticino');
    const pagePath = path.join(pageRoot, 'late-alias', 'index.html');
    fs.mkdirSync(path.dirname(pagePath), { recursive: true });
    fs.writeFileSync(pagePath, '<html>final archive bytes</html>');
    const pageManifestPath = path.join(root, 'page-manifest.json');
    fs.writeFileSync(pageManifestPath, JSON.stringify({ version: 2, locale: 'it', entries: [] }));
    const evidencePath = path.join(root, 'evidence.json');
    fs.writeFileSync(evidencePath, JSON.stringify({
      schemaVersion: 1,
      kind: 'expired-archive-publication-evidence',
      validatorVersion: 'expired-archive-publication-v1',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      locale: 'it',
      entries: [{
        evidenceKind: 'expired-archive', locale: 'it', section: 'ticino',
        url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/late-alias/',
        path: 'cerca-lavoro-ticino/late-alias/index.html', sha256: 'f'.repeat(64),
      }],
    }));

    expect(() => createSectionManifest({
      root: pageRoot,
      prefix: 'cerca-lavoro-ticino',
      locale: 'it',
      section: 'ticino',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
      pageManifestPath,
      evidenceManifestPath: evidencePath,
    })).toThrow('digest differs from its shard source');
  });

  it('accepts complete sitemap, path, digest, and Ticino shard evidence', () => {
    expect(fixture().result).toMatchObject({ passed: true, errorCount: 0, sampleRate: 1 });
  });

  it('reports ONE root-cause error, not one per page, when the current sitemap snapshot is missing', () => {
    const f = fixture();
    fs.rmSync(path.join(f.sitemapDir, 'new-sitemap-urls.json'));
    const result = f.validate();
    expect(result.passed).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toContain('current sitemap snapshot is missing or invalid');
    expect(result.errors[0]).toContain('ENOENT');
    expect(result.errors.join('\n')).not.toContain('absent from the source sitemap bundle');
    expect(result.sitemapFamilyChurn).toEqual([]);
  });

  it('reports ONE root-cause error when the current snapshot file is truncated', () => {
    const f = fixture();
    const file = path.join(f.sitemapDir, 'new-sitemap-urls.json');
    fs.writeFileSync(file, '{"version":4,"sitemapFiles":["a.xml","b.xml"]}\n{"sitemap":"a.xml","urls":["https://frontaliereticino.ch/x/"],"digest":"d","lastmod":{}}\n');
    const result = f.validate();
    expect(result.passed).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toMatch(/current sitemap snapshot is missing or invalid .*incomplete/);
  });

  it('accepts a v4 NDJSON current snapshot written by the streaming writer', async () => {
    const f = fixture();
    const file = path.join(f.sitemapDir, 'new-sitemap-urls.json');
    await writeSnapshotFile(file, f.currentSitemapSnapshot);
    expect(fs.readFileSync(file, 'utf8').split('\n')[0]).toContain('"version":4');
    expect(f.validate()).toMatchObject({ passed: true, errorCount: 0 });
  });

  describe('expired archive sitemap family', () => {
    it('counts the archive URLs kept out of the page comparison and ties them to the locale canaries', () => {
      const f = archiveFixture({ archiveLocales: ['it', 'en', 'de'], canaryLocales: ['it', 'en', 'de', 'fr'] });
      const result = f.validate();
      expect(result.errors).toEqual([]);
      expect(result).toMatchObject({
        passed: true,
        sitemapUrlPopulation: f.pageManifests.length + 3,
        pageManifestPopulation: f.pageManifests.length,
        expiredArchiveSitemapExcluded: 3,
        expiredArchiveSitemapExcludedByLocale: { it: 1, en: 1, de: 1, fr: 0 },
        expiredArchiveSitemapCoveredByCanary: 3,
        expiredArchiveSitemapCoveredByCanaryByLocale: { it: 1, en: 1, de: 1, fr: 0 },
        expiredArchiveCanaryEntriesByLocale: { it: 1, en: 1, de: 1, fr: 1 },
        expiredArchiveCanaryVerifiedByLocale: { it: 1, en: 1, de: 1, fr: 1 },
      });
    });

    it('fails a locale whose archive sitemaps list URLs but whose evidence has no canary', () => {
      const f = archiveFixture({ archiveLocales: ['en', 'de'], canaryLocales: ['it', 'en', 'fr'] });
      const result = f.validate();
      expect(result.passed).toBe(false);
      expect(result.errors).toEqual([
        'expired archive sitemaps list 1 de URL(s) but the de archive evidence has no publication canary',
      ]);
      expect(result).toMatchObject({
        expiredArchiveSitemapExcluded: 2,
        expiredArchiveSitemapCoveredByCanary: 1,
        expiredArchiveSitemapCoveredByCanaryByLocale: { it: 0, en: 1, de: 0, fr: 0 },
      });
    });

    it('does not count a canary as coverage when its section is not a required shard (never verified)', () => {
      const f = archiveFixture({
        archiveLocales: ['en'], canaryLocales: ['it', 'en', 'de', 'fr'], unboundLocales: ['en'],
      });
      const result = f.validate();
      expect(result.passed).toBe(false);
      expect(result.errors).toEqual([
        'expired archive sitemaps list 1 en URL(s) but no en archive canary was verified in a required shard',
      ]);
      expect(result).toMatchObject({
        expiredArchiveSitemapExcluded: 1,
        expiredArchiveCanaryEntriesByLocale: { it: 1, en: 1, de: 1, fr: 1 },
        expiredArchiveCanaryVerifiedByLocale: { it: 1, en: 0, de: 1, fr: 1 },
        expiredArchiveSitemapCoveredByCanary: 0,
        expiredArchiveSitemapCoveredByCanaryByLocale: { it: 0, en: 0, de: 0, fr: 0 },
      });
    });

    it('fails when archive sitemap URLs exist and no archive evidence was supplied at all', () => {
      const f = archiveFixture({ archiveLocales: ['it'], canaryLocales: ['it'], withEvidence: false });
      const result = f.validate();
      expect(result.passed).toBe(false);
      expect(result.errors).toContain('expired archive sitemaps list 1 it URL(s) but no archive publication evidence was supplied');
    });

    it('does not let the archive family mask a non-archive sitemap URL without a page manifest entry', () => {
      const f = archiveFixture({ archiveLocales: ['en'], canaryLocales: ['it', 'en', 'de', 'fr'] });
      f.currentSitemapSnapshot.perSitemap['sitemap-jobs.xml'] = [
        'https://frontaliereticino.ch/de/jobs-im-tessin/landing-without-manifest/',
      ];
      fs.writeFileSync(path.join(f.sitemapDir, 'new-sitemap-urls.json'), JSON.stringify(f.currentSitemapSnapshot));
      const result = f.validate();
      expect(result.passed).toBe(false);
      expect(result.errors).toEqual([
        '[sitemap-jobs.xml] sitemap URL has no page manifest entry: https://frontaliereticino.ch/de/jobs-im-tessin/landing-without-manifest/',
      ]);
    });

    it('still compares page-by-page a URL that an archive sitemap ALSO shares with a page sitemap', () => {
      const f = archiveFixture({ archiveLocales: ['en'], canaryLocales: ['it', 'en', 'de', 'fr'] });
      f.currentSitemapSnapshot.perSitemap['sitemap-jobs.xml'] = [ARCHIVE_URLS.en];
      fs.writeFileSync(path.join(f.sitemapDir, 'new-sitemap-urls.json'), JSON.stringify(f.currentSitemapSnapshot));
      const result = f.validate();
      expect(result.errors).toEqual([`[sitemap-jobs.xml] sitemap URL has no page manifest entry: ${ARCHIVE_URLS.en}`]);
      expect(result.expiredArchiveSitemapExcluded).toBe(0);
    });

    it('keeps the archive file-name predicate identical to every other copy of the pattern', () => {
      const root = path.resolve(__dirname, '..', '..');
      const rx = EXPIRED_JOB_SITEMAP_FILE_RX.source;
      const copies = [
        ['build-plugins/jobsSeoPagesPlugin.ts', /expiredSitemapFilePattern\s*=\s*\/(.+?)\/u;/u],
        ['build-plugins/shared/sitemapDerivedLastmod.ts', /EXPIRED_JOB_SITEMAP_RX\s*=\s*\/(.+?)\/;/u],
        ['scripts/lib/indexing-jobs-planner.mjs', /!\/(sitemap-jobs-expired.+?)\/\.test/u],
      ] as const;
      for (const [file, extract] of copies) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const match = source.match(extract);
        expect(match, `${file} no longer carries the expired-archive sitemap pattern`).not.toBeNull();
        // the shared constant anchors with ^...$; the planner copy is unanchored
        expect(rx).toContain((match as RegExpMatchArray)[1].replace(/^\^|\$$/gu, ''));
      }
      expect(isExpiredJobSitemapKey('sitemap-jobs-expired.xml')).toBe(true);
      expect(isExpiredJobSitemapKey('sitemap-jobs-expired-044.xml')).toBe(true);
      expect(isExpiredJobSitemapKey('x/sitemap-jobs-expired-1.xml')).toBe(true);
      expect(isExpiredJobSitemapKey('sitemap-jobs-expired-ticino.xml')).toBe(false);
      expect(isExpiredJobSitemapKey('sitemap-jobs.xml')).toBe(false);
    });
  });

  it('keeps comparing URL-by-URL when a readable snapshot is merely incomplete', async () => {
    const f = fixture();
    const file = path.join(f.sitemapDir, 'new-sitemap-urls.json');
    const incomplete = structuredClone(f.currentSitemapSnapshot);
    incomplete.perSitemap['sitemap-job-market.xml'].pop();
    await writeSnapshotFile(file, incomplete);
    const result = f.validate();
    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toContain('page manifest URL is absent from the source sitemap bundle');
  });

  it('unions URLs across the legacy IT sitemap and per-locale canton shards', () => {
    const f = fixture();
    const urls = f.pageManifests.flatMap((manifest) => manifest.entries.map((entry) => entry.url));
    f.currentSitemapSnapshot.perSitemap = {
      'sitemap-jobs.xml': [urls[0]],
      'sitemap-jobs-argovia-en.xml': [urls[1]],
      'sitemap-jobs-argovia-de.xml': [urls[2]],
      'sitemap-jobs-argovia-fr.xml': [urls[3]],
    };
    f.previousSitemapSnapshot.perSitemap = structuredClone(f.currentSitemapSnapshot.perSitemap);
    fs.writeFileSync(
      path.join(f.sitemapDir, 'new-sitemap-urls.json'),
      JSON.stringify(f.currentSitemapSnapshot),
    );

    const result = f.validate();
    expect(result).toMatchObject({
      passed: true,
      errorCount: 0,
      sitemapUrlPopulation: urls.length,
      pageManifestPopulation: urls.length,
    });
  });

  it('accepts the IT page manifest as bound by the publisher (sitemaps ref on the publisher run)', () => {
    // Publish 43314110480: the hand-written fixture above put the sitemaps ref
    // on the publisher run, but bind-page wrote it on the source run, so the
    // real receipt failed `sitemaps-<id>: artifact run <source> != <publisher>`.
    const f = fixture();
    const [handIt, ...others] = f.pageManifests;
    const { artifactRefs: _refs, artifactRunId: _run, artifactName: _name, artifactDigest: _digest, ...unbound } = handIt;
    const bound = bindPageManifest({
      manifest: {
        ...unbound,
        version: 2,
        entries: handIt.entries.map(({ artifactName: _a, artifactDigest: _d, ...entry }) => entry),
      },
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: PUBLISHER_RUN_ID,
      baseArtifactName: 'github-pages',
      baseArtifactDigest: `sha256:${'0'.repeat(64)}`,
      sectionArtifactDigests: { [String(sectionBatch('ticino'))]: 'b'.repeat(64) },
      requiredSections: ['ticino'],
      manifestArtifactName: `sitemap-page-manifest-it-${PUBLISHER_RUN_ID}`,
      sitemapArtifactName: `sitemaps-${PUBLISHER_RUN_ID}`,
      sitemapArtifactDigest: '9'.repeat(64),
    });
    expect(bound.artifactRefs.filter((ref: { purpose: string }) => ref.purpose === 'sitemaps')).toEqual([
      { runId: PUBLISHER_RUN_ID, name: `sitemaps-${PUBLISHER_RUN_ID}`, digest: '9'.repeat(64), purpose: 'sitemaps' },
    ]);

    const pageManifests = [bound, ...others];
    const result = validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir: f.sitemapDir,
      previousSitemapSnapshot: f.previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] },
      pageManifests,
      sectionManifests: f.sectionManifests,
      sourceArtifacts: { artifacts: f.sourceArtifacts },
      publisherArtifacts: { artifacts: f.publisherArtifacts },
      manifestArtifactNames: [
        ...pageManifests.map((manifest) => manifest.manifestArtifactName),
        ...f.sectionManifests.map((manifest) => manifest.manifestArtifactName),
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ passed: true, errorCount: 0 });
  });

  it('binds a non-sitemap expired archive canary to its final shard bytes', () => {
    const base = fixture();
    const archiveUrl = 'https://frontaliereticino.ch/cerca-lavoro-ticino/late-overflow-alias/';
    const archivePath = 'cerca-lavoro-ticino/late-overflow-alias/index.html';
    const archiveDigest = '7'.repeat(64);
    const archiveEvidenceManifests = ['it', 'en', 'de', 'fr'].map((locale) => {
      const entries = locale === 'it' ? [{
        evidenceKind: 'expired-archive', locale, section: 'ticino', url: archiveUrl,
        path: archivePath, sha256: archiveDigest, payloadSha256: '1'.repeat(64),
        descriptionSha256: '2'.repeat(64), expiredAtSha256: '3'.repeat(64), ownerSha256: '4'.repeat(64),
      }] : [];
      base.sourceArtifacts.push(artifact(`expired-archive-evidence-${locale}-${SOURCE_RUN_ID}`, '5'.repeat(64)));
      return {
        schemaVersion: 1,
        kind: 'expired-archive-publication-evidence',
        validatorVersion: 'expired-archive-publication-v1',
        sourceRunId: SOURCE_RUN_ID,
        sourceSha: SOURCE_SHA,
        locale,
        indexedOverflowAliases: 201_656,
        renderedOverflowPages: locale === 'it' ? 1 : 0,
        sampleSize: entries.length,
        entries,
      };
    });
    base.sectionPage.shards[0].pages.push({
      evidenceKind: 'expired-archive', locale: 'it', section: 'ticino', url: archiveUrl,
      path: archivePath, sourceSha256: archiveDigest, sha256: '8'.repeat(64),
    });

    const result = validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir: base.sitemapDir,
      previousSitemapSnapshot: base.previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] },
      pageManifests: base.pageManifests,
      sectionManifests: base.sectionManifests,
      archiveEvidenceManifests,
      sourceArtifacts: { artifacts: base.sourceArtifacts },
      publisherArtifacts: { artifacts: base.publisherArtifacts },
      manifestArtifactNames: [
        ...base.pageManifests.map((manifest) => manifest.manifestArtifactName),
        ...base.sectionManifests.map((manifest) => manifest.manifestArtifactName),
      ],
    });

    expect(result).toMatchObject({ passed: true, expiredArchiveEvidencePopulation: 1 });

    archiveEvidenceManifests.pop();
    const missingLocale = validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID, sourceSha: SOURCE_SHA, publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir: base.sitemapDir, previousSitemapSnapshot: base.previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] }, pageManifests: base.pageManifests,
      sectionManifests: base.sectionManifests, archiveEvidenceManifests,
      sourceArtifacts: { artifacts: base.sourceArtifacts }, publisherArtifacts: { artifacts: base.publisherArtifacts },
    });
    expect(missingLocale.errors.join('\n')).toContain('expired archive evidence missing for locale fr');
  });

  it('fails closed when a sitemap URL is absent from its required shard manifest', () => {
    const {
      sectionManifests, pageManifests, sourceArtifacts, publisherArtifacts, sitemapDir,
      previousSitemapSnapshot,
    } = fixture();
    const sectionPage = sectionManifests[0];
    sectionPage.shards[0].pages = [];
    const rerun = validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir,
      previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] },
      pageManifests,
      sectionManifests,
      sourceArtifacts: { artifacts: sourceArtifacts },
      publisherArtifacts: { artifacts: publisherArtifacts },
      manifestArtifactNames: [
        ...pageManifests.map((manifest) => manifest.manifestArtifactName),
        ...sectionManifests.map((manifest) => manifest.manifestArtifactName),
      ],
    });
    expect(rerun.passed).toBe(false);
    expect(rerun.errors.join('\n')).toContain('absent from required shard it/ticino');
  });

  it('fails closed when the prior live snapshot shows an undeclared family decrease', () => {
    const base = fixture();
    base.currentSitemapSnapshot.perSitemap['sitemap-job-market.xml'].pop();
    fs.writeFileSync(
      path.join(base.sitemapDir, 'new-sitemap-urls.json'),
      JSON.stringify(base.currentSitemapSnapshot),
    );
    const result = validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir: base.sitemapDir,
      previousSitemapSnapshot: base.previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] },
      pageManifests: base.pageManifests,
      sectionManifests: base.sectionManifests,
      sourceArtifacts: { artifacts: base.sourceArtifacts },
      publisherArtifacts: { artifacts: base.publisherArtifacts },
      manifestArtifactNames: [
        ...base.pageManifests.map((manifest) => manifest.manifestArtifactName),
        ...base.sectionManifests.map((manifest) => manifest.manifestArtifactName),
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toContain('sitemap family coverage decreased for job-market: 4 -> 3');
  });

  it('passes a data-driven family decrease within the collapse bound and returns its URL diff', () => {
    const base = fixture();
    base.previousSitemapSnapshot.perSitemap['sitemap-orphan-landings.xml'] = coverageUrls('orphan-landings', 100);
    base.currentSitemapSnapshot.perSitemap['sitemap-orphan-landings.xml'] = coverageUrls('orphan-landings', 93);
    fs.writeFileSync(
      path.join(base.sitemapDir, 'new-sitemap-urls.json'),
      JSON.stringify(base.currentSitemapSnapshot),
    );

    const result = base.validate({
      sitemapFamilyBridgeEvidence: bridgeEvidenceForSnapshots(
        base.previousSitemapSnapshot,
        base.currentSitemapSnapshot,
        'orphan-landings',
      ),
    });

    expect(result.passed).toBe(true);
    expect(result.validatorVersion).toBe('publisher-fast-gate-v8');
    expect(result.errors.join('\n')).not.toContain('sitemap family coverage decreased for orphan-landings');
    expect(result.sitemapFamilyChurn).toEqual([{
      family: 'orphan-landings',
      previousCount: 100,
      currentCount: 93,
      delta: -7,
      tolerance: 0.1,
      removed: 7,
      added: 0,
      removedSample: coverageUrls('orphan-landings', 100).slice(93).sort().slice(0, 5),
      addedSample: [],
    }]);
  });

  it('fails a structural family decrease and keeps it out of the churn report', () => {
    const base = fixture();
    base.previousSitemapSnapshot.perSitemap['sitemap-eventi.xml'] = coverageUrls('events', 100);
    base.currentSitemapSnapshot.perSitemap['sitemap-eventi.xml'] = coverageUrls('events', 99);
    fs.writeFileSync(
      path.join(base.sitemapDir, 'new-sitemap-urls.json'),
      JSON.stringify(base.currentSitemapSnapshot),
    );

    const result = base.validate();

    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toContain('sitemap family coverage decreased for events: 100 -> 99');
    expect(result.sitemapFamilyChurn).toEqual([]);
  });

  describe('sitemap family bridge evidence artifacts', () => {
    const itUrl = 'https://frontaliereticino.ch/ricerca/bridge-it/';
    const deUrl = 'https://frontaliereticino.ch/de/suche/bridge-de/';

    it('unions IT and DE evidence files before checking removed URLs', () => {
      const base = fixture();
      addOrphanFamilyDecrease(base, [itUrl, deUrl]);
      fs.writeFileSync(path.join(base.sitemapDir, 'sitemap-family-bridge-evidence.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'sitemap-family-bridge-evidence',
        complete: true,
        entries: [evidenceEntry(itUrl)],
        missing: [],
      }));
      fs.writeFileSync(path.join(base.sitemapDir, 'sitemap-family-bridge-evidence-de.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'sitemap-family-bridge-evidence',
        complete: true,
        locale: 'de',
        entries: [evidenceEntry(deUrl)],
        missing: [],
      }));

      const execution = validateWithBridgeEvidenceFiles(base);

      expect(execution.result.passed).toBe(true);
      expect(execution.files).toEqual([
        'sitemap-family-bridge-evidence.json',
        'sitemap-family-bridge-evidence-de.json',
      ]);
      expect(execution.result.sitemapFamilyBridgeEvidenceFiles).toEqual(execution.files);
      expect(execution.result.sitemapFamilyChurn).toMatchObject([{
        family: 'orphan-landings', previousCount: 20, currentCount: 18, delta: -2,
      }]);
    });

    it('fails closed when a removed DE URL has no evidence in any file', () => {
      const base = fixture();
      addOrphanFamilyDecrease(base, [itUrl, deUrl]);
      fs.writeFileSync(path.join(base.sitemapDir, 'sitemap-family-bridge-evidence.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'sitemap-family-bridge-evidence',
        complete: true,
        entries: [evidenceEntry(itUrl)],
        missing: [],
      }));

      const execution = validateWithBridgeEvidenceFiles(base);

      expect(execution.result.passed).toBe(false);
      expect(execution.result.errors.join('\n')).toContain(`missing bridge evidence for removed URL ${deUrl}`);
      expect(execution.result.errors.join('\n')).toContain('sitemap family coverage decreased for orphan-landings: 20 -> 18');
    });

    it('keeps the existing fail-closed behavior when no evidence files are present', () => {
      const base = fixture();
      addOrphanFamilyDecrease(base, [itUrl, deUrl]);

      const execution = validateWithBridgeEvidenceFiles(base);

      expect(execution.result.sitemapFamilyBridgeEvidenceFiles).toEqual([]);
      expect(execution.result.errors.join('\n')).toContain('sitemap family coverage decreased for orphan-landings: 20 -> 18');
    });

    it('rejects a present evidence file whose complete flag is false', () => {
      const base = fixture();
      addOrphanFamilyDecrease(base, [itUrl, deUrl]);
      fs.writeFileSync(path.join(base.sitemapDir, 'sitemap-family-bridge-evidence.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'sitemap-family-bridge-evidence',
        complete: false,
        entries: [evidenceEntry(itUrl)],
        missing: [],
      }));

      const execution = validateWithBridgeEvidenceFiles(base);

      expect(execution.result.errors.join('\n')).toContain('orphan-landings: bridge evidence is missing or has an unsupported schema');
      expect(execution.result.errors.join('\n')).toContain('sitemap family coverage decreased for orphan-landings: 20 -> 18');
    });
  });

  it('does not compare corpus-owned article sitemap coverage against this site deploy', () => {
    const base = fixture();
    base.previousSitemapSnapshot.perSitemap['sitemap-topics-frontaliere.xml'] = [
      'https://frontaliereticino.ch/articoli-frontaliere/argomenti/assicurazioni/',
      'https://frontaliereticino.ch/articoli-frontaliere/argomenti/lavoro/',
    ];
    base.currentSitemapSnapshot.perSitemap['sitemap-topics-frontaliere.xml'] = [
      'https://frontaliereticino.ch/articoli-frontaliere/argomenti/lavoro/',
    ];
    fs.writeFileSync(
      path.join(base.sitemapDir, 'new-sitemap-urls.json'),
      JSON.stringify(base.currentSitemapSnapshot),
    );

    const result = validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir: base.sitemapDir,
      previousSitemapSnapshot: base.previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] },
      pageManifests: base.pageManifests,
      sectionManifests: base.sectionManifests,
      sourceArtifacts: { artifacts: base.sourceArtifacts },
      publisherArtifacts: { artifacts: base.publisherArtifacts },
      manifestArtifactNames: [
        ...base.pageManifests.map((manifest) => manifest.manifestArtifactName),
        ...base.sectionManifests.map((manifest) => manifest.manifestArtifactName),
      ],
    });

    expect(result).toMatchObject({ passed: true, errorCount: 0 });
  });

  it('fails closed when a shard manifest contains a page absent from every source manifest', () => {
    const base = fixture();
    base.sectionManifests[0].shards[0].pages.push({
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/extra/',
      path: 'cerca-lavoro-ticino/extra/index.html',
      sourceSha256: 'c'.repeat(64),
      sha256: '1'.repeat(64),
      locale: 'it',
      section: 'ticino',
    });
    const rerun = validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir: base.sitemapDir,
      previousSitemapSnapshot: base.previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] },
      pageManifests: base.pageManifests,
      sectionManifests: base.sectionManifests,
      sourceArtifacts: { artifacts: base.sourceArtifacts },
      publisherArtifacts: { artifacts: base.publisherArtifacts },
      manifestArtifactNames: [
        ...base.pageManifests.map((manifest) => manifest.manifestArtifactName),
        ...base.sectionManifests.map((manifest) => manifest.manifestArtifactName),
      ],
    });
    expect(rerun.passed).toBe(false);
    expect(rerun.errors.join('\n')).toContain('shard URL is absent from source page manifests');
  });

  it('requires the Ticino hash layout and binds each shard to the uploaded batch digest', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'cerca-lavoro-ticino'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cerca-lavoro-ticino', 'index.html'), '<html></html>');
    expect(() => createSectionManifest({
      root: path.join(root, 'cerca-lavoro-ticino'),
      prefix: 'cerca-lavoro-ticino',
      locale: 'it',
      section: 'ticino',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
      sourcePathLayout: 'canonical',
    })).toThrow('must be ticino-hash-v1');

    const manifest = createSectionManifest({
      root: path.join(root, 'cerca-lavoro-ticino'),
      prefix: 'cerca-lavoro-ticino',
      locale: 'it',
      section: 'ticino',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
    });
    const bound = finalizeSectionManifestSet({
      manifests: [manifest],
      locale: 'it',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
      artifactDigests: { '5': 'b'.repeat(64) },
      requiredSections: ['ticino'],
    });
    expect(bound.shards[0]).toMatchObject({ sourcePathLayout: 'ticino-hash-v1', artifactDigest: 'b'.repeat(64) });
    expect(() => finalizeSectionManifestSet({
      manifests: [manifest], locale: 'it', sourceRunId: SOURCE_RUN_ID, sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID, artifactDigests: {}, requiredSections: ['ticino'],
    })).toThrow('missing uploaded artifact digest');
  });

  it('requires the Zurich hash layout in section receipts', () => {
    const root = tempRoot();
    const pageRoot = path.join(root, 'de', 'jobs-in-zurich');
    fs.mkdirSync(pageRoot, { recursive: true });
    fs.writeFileSync(path.join(pageRoot, 'index.html'), '<html></html>');

    expect(() => createSectionManifest({
      root: pageRoot,
      prefix: 'de/jobs-in-zurich',
      locale: 'de',
      section: 'zurigo',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
      sourcePathLayout: 'canonical',
    })).toThrow('zurigo sourcePathLayout must be zurigo-hash-v1');

    const manifest = createSectionManifest({
      root: pageRoot,
      prefix: 'de/jobs-in-zurich',
      locale: 'de',
      section: 'zurigo',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
    });
    expect(manifest.sourcePathLayout).toBe('zurigo-hash-v1');
  });

  it('records a registry-selected hash layout for a dynamic section receipt', () => {
    const root = tempRoot();
    const pageRoot = path.join(root, 'de', 'jobs-in-lucerne');
    fs.mkdirSync(pageRoot, { recursive: true });
    fs.writeFileSync(path.join(pageRoot, 'index.html'), '<html></html>');
    const input = {
      root: pageRoot,
      prefix: 'de/jobs-in-lucerne',
      locale: 'de' as const,
      section: 'lucerna',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
    };

    expect(createSectionManifest({ ...input, sourcePathLayout: 'lucerna-hash-v1' }).sourcePathLayout)
      .toBe('lucerna-hash-v1');
    expect(createSectionManifest({ ...input, sourcePathLayout: 'canonical' }).sourcePathLayout)
      .toBe('canonical');
    expect(() => createSectionManifest({ ...input, sourcePathLayout: 'ticino-hash-v1' }))
      .toThrow('lucerna sourcePathLayout must be canonical or lucerna-hash-v1');
  });

  it('binds the EN Ticino shard receipt to the source SHA and published artifact digest', () => {
    const base = fixture();
    const pageManifest = base.pageManifests[1];
    const page = pageManifest.entries[0];
    const oldUrl = page.url;
    page.url = 'https://frontaliereticino.ch/en/find-jobs-ticino/good/';
    page.path = 'en/find-jobs-ticino/good/index.html';
    page.section = 'ticino';
    pageManifest.requiredSections = ['ticino'];
    base.currentSitemapSnapshot.perSitemap['sitemap-job-market.xml'] =
      base.currentSitemapSnapshot.perSitemap['sitemap-job-market.xml'].map((url: string) => url === oldUrl ? page.url : url);
    fs.writeFileSync(
      path.join(base.sitemapDir, 'new-sitemap-urls.json'),
      JSON.stringify(base.currentSitemapSnapshot),
    );

    const artifactName = `shard-batch-5-dist-en-${PUBLISHER_RUN_ID}`;
    const artifactDigest = '8'.repeat(64);
    base.publisherArtifacts.push(artifact(artifactName, artifactDigest));
    const enManifest = base.sectionManifests[1];
    enManifest.requiredSections = ['ticino'];
    enManifest.artifactRefs = [{ runId: PUBLISHER_RUN_ID, name: artifactName, digest: artifactDigest, purpose: 'section-shard-tar-batch' }];
    enManifest.shards = [{
      schemaVersion: 2,
      kind: 'publisher-shard-content',
      validatorVersion: 'publisher-shard-content-v2',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: PUBLISHER_RUN_ID,
      artifactName,
      artifactDigest,
      locale: 'en',
      section: 'ticino',
      sourcePathLayout: 'ticino-hash-v1',
      prefix: 'en/find-jobs-ticino',
      tarSha256: '5'.repeat(64),
      population: 1,
      pages: [{ url: page.url, path: page.path, sourceSha256: page.sha256, sha256: '6'.repeat(64), locale: 'en', section: 'ticino' }],
    }];
    enManifest.population = 1;

    const runGate = () => validatePublisherFastGate({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      publisherRunId: PUBLISHER_RUN_ID,
      sitemapDir: base.sitemapDir,
      previousSitemapSnapshot: base.previousSitemapSnapshot,
      sitemapCoverageDeclarations: { version: 1, decreases: [] },
      pageManifests: base.pageManifests,
      sectionManifests: base.sectionManifests,
      sourceArtifacts: { artifacts: base.sourceArtifacts },
      publisherArtifacts: { artifacts: base.publisherArtifacts },
      manifestArtifactNames: [
        ...base.pageManifests.map((manifest) => manifest.manifestArtifactName),
        ...base.sectionManifests.map((manifest) => manifest.manifestArtifactName),
      ],
    });

    expect(runGate()).toMatchObject({ passed: true, errorCount: 0 });
    enManifest.sourceSha = 'f'.repeat(40);
    enManifest.shards[0].sourcePathLayout = 'canonical';
    const invalid = runGate();
    expect(invalid.passed).toBe(false);
    expect(invalid.errors.join('\n')).toContain('sourceSha mismatch');
    expect(invalid.errors.join('\n')).toContain('ticino sourcePathLayout must be ticino-hash-v1');
  });
});
