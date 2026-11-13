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
import { validatePublisherFastGate } from '../../scripts/ci/publisher-fast-gate.mjs';

const SOURCE_RUN_ID = '101';
const PUBLISHER_RUN_ID = '202';
const SOURCE_SHA = 'a'.repeat(40);
const roots: string[] = [];

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
  const currentSitemapSnapshot = { version: 3, perSitemap: { 'sitemap-job-market.xml': sitemapUrls } };
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
  const result = validatePublisherFastGate({
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
  return {
    result, pageManifests, sectionPage, sectionManifests, sourceArtifacts, publisherArtifacts,
    sitemapDir, currentSitemapSnapshot, previousSitemapSnapshot,
  };
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
