// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSectionManifest,
  finalizeSectionManifestSet,
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
    const baseDigest = `${locale.charCodeAt(0).toString(16).padStart(2, '0')}`.repeat(32);
    const section = locale === 'it' ? 'ticino' : null;
    const batchName = `shard-batch-5-dist-it-${SOURCE_RUN_ID}`;
    const batchDigest = 'b'.repeat(64);
    const pageArtifactName = section ? batchName : baseArtifact;
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
      artifactRunId: SOURCE_RUN_ID,
      artifactName: baseArtifact,
      artifactDigest: baseDigest,
      manifestArtifactName: `sitemap-page-manifest-${locale}-${SOURCE_RUN_ID}`,
      locale,
      requiredSections: section ? ['ticino'] : [],
      artifactRefs: [
        { runId: SOURCE_RUN_ID, name: baseArtifact, digest: baseDigest, purpose: 'locale-base' },
        ...(locale === 'it' ? [{ runId: SOURCE_RUN_ID, name: `sitemaps-${SOURCE_RUN_ID}`, digest: '9'.repeat(64), purpose: 'sitemaps' }] : []),
        ...(section ? [{ runId: SOURCE_RUN_ID, name: batchName, digest: batchDigest, purpose: 'section-shard-tar-batch' }] : []),
      ],
      entries: [{ url, path: pagePath, sha256: pageDigest, locale, section, artifactName: pageArtifactName, artifactDigest: pageArtifactDigest }],
    });
    sourceArtifacts.push(artifact(baseArtifact, baseDigest));
    if (locale === 'it') sourceArtifacts.push(artifact(`sitemaps-${SOURCE_RUN_ID}`, '9'.repeat(64)));
    sourceArtifacts.push(artifact(`sitemap-page-manifest-${locale}-${SOURCE_RUN_ID}`, 'd'.repeat(64)));
    if (section) sourceArtifacts.push(artifact(batchName, batchDigest));
  }

  const ticinoPage = pageManifests[0].entries[0];
  const sectionPage = {
    schemaVersion: 2,
    kind: 'publisher-section-manifest',
    validatorVersion: 'publisher-shard-content-v2',
    sourceRunId: SOURCE_RUN_ID,
    sourceSha: SOURCE_SHA,
    artifactRunId: SOURCE_RUN_ID,
    manifestArtifactName: `section-page-manifest-it-${SOURCE_RUN_ID}`,
    locale: 'it',
    requiredSections: ['ticino'],
    artifactRefs: [{ runId: SOURCE_RUN_ID, name: `shard-batch-5-dist-it-${SOURCE_RUN_ID}`, digest: 'b'.repeat(64), purpose: 'section-shard-tar-batch' }],
    shards: [{
      schemaVersion: 2,
      kind: 'publisher-shard-content',
      validatorVersion: 'publisher-shard-content-v2',
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId: SOURCE_RUN_ID,
      artifactName: `shard-batch-5-dist-it-${SOURCE_RUN_ID}`,
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
  sourceArtifacts.push(artifact(`section-page-manifest-it-${SOURCE_RUN_ID}`, 'f'.repeat(64)));
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
  it('accepts complete sitemap, path, digest, and Ticino shard evidence', () => {
    expect(fixture().result).toMatchObject({ passed: true, errorCount: 0, sampleRate: 1 });
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
