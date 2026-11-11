// @vitest-environment node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { jobSectorPagesPlugin } from '../../build-plugins/jobSectorPagesPlugin';
import { validatePublisherFastGate } from '../../scripts/ci/publisher-fast-gate.mjs';
import { collectOwnedLocaleEntries } from '../../scripts/validate-sitemap-links.mjs';

const SOURCE_RUN_ID = '9246001';
const PUBLISHER_RUN_ID = '9246002';
const SOURCE_SHA = '9'.repeat(40);
const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const roots: string[] = [];

const artifact = (name: string, digest: string) => ({
  name,
  digest: `sha256:${digest}`,
  expired: false,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('publisher page-manifest end-to-end union (#9246)', () => {
  it('passes the real sector generator through validate-sitemap-links and publisher-fast-gate for all four locales', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-page-manifest-e2e-'));
    roots.push(root);
    const distDir = path.join(root, 'dist');
    const sitemapDir = path.join(root, 'sitemaps');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(sitemapDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'jobs.json'), '[]');

    const plugin = jobSectorPagesPlugin(root);
    if (typeof plugin.closeBundle !== 'function') throw new Error('Expected closeBundle handler.');
    await (plugin.closeBundle as () => Promise<void>)();

    const sitemapXml = fs.readFileSync(path.join(distDir, 'sitemap-sector.xml'), 'utf8');
    const sitemapUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    const currentSitemapSnapshot = {
      version: 3,
      perSitemap: { 'sitemap-sector.xml': sitemapUrls },
    };
    const previousSitemapSnapshot = structuredClone(currentSitemapSnapshot);
    fs.writeFileSync(
      path.join(sitemapDir, 'new-sitemap-urls.json'),
      JSON.stringify(currentSitemapSnapshot),
    );

    const sourceArtifacts: ReturnType<typeof artifact>[] = [];
    const publisherArtifacts: ReturnType<typeof artifact>[] = [];
    const pageManifests = [];
    const union = new Set<string>();

    for (const locale of LOCALES) {
      // This is the same exported core used by validate-sitemap-links.mjs
      // when each BUILD_LOCALE leg writes its publisher page manifest.
      const collected = collectOwnedLocaleEntries(locale, distDir);
      expect(collected.missing, locale).toEqual([]);
      expect(collected.entries, locale).toHaveLength(sitemapUrls.length / LOCALES.length);

      const baseArtifact = locale === 'it' ? 'github-pages' : `locale-source-${locale}-${SOURCE_RUN_ID}`;
      const baseDigest = crypto.createHash('sha256').update(locale).digest('hex');
      const artifactRunId = locale === 'it' ? PUBLISHER_RUN_ID : SOURCE_RUN_ID;
      const manifestArtifactName = `sitemap-page-manifest-${locale}-${artifactRunId}`;
      const entries = collected.entries.map((entry) => {
        union.add(entry.url);
        return {
          ...entry,
          artifactName: baseArtifact,
          artifactDigest: baseDigest,
        };
      });
      pageManifests.push({
        schemaVersion: 2,
        kind: 'publisher-page-manifest',
        validatorVersion: 'publisher-page-index-v2',
        sourceRunId: SOURCE_RUN_ID,
        sourceSha: SOURCE_SHA,
        artifactRunId,
        artifactName: baseArtifact,
        artifactDigest: baseDigest,
        manifestArtifactName,
        locale,
        requiredSections: [],
        artifactRefs: [
          { runId: artifactRunId, name: baseArtifact, digest: baseDigest, purpose: 'locale-base' },
          ...(locale === 'it' ? [{
            runId: PUBLISHER_RUN_ID,
            name: `sitemaps-${PUBLISHER_RUN_ID}`,
            digest: '8'.repeat(64),
            purpose: 'sitemaps',
          }] : []),
        ],
        entries,
      });
      if (locale === 'it') {
        publisherArtifacts.push(artifact(baseArtifact, baseDigest));
        publisherArtifacts.push(artifact(manifestArtifactName, '7'.repeat(64)));
        publisherArtifacts.push(artifact(`sitemaps-${PUBLISHER_RUN_ID}`, '8'.repeat(64)));
      } else {
        sourceArtifacts.push(artifact(baseArtifact, baseDigest));
        sourceArtifacts.push(artifact(manifestArtifactName, '7'.repeat(64)));
      }
    }

    const sectionManifests = LOCALES.map((locale) => {
      const artifactRunId = PUBLISHER_RUN_ID;
      const manifestArtifactName = `section-page-manifest-${locale}-${PUBLISHER_RUN_ID}`;
      publisherArtifacts.push(
        artifact(manifestArtifactName, '6'.repeat(64)),
      );
      return {
        schemaVersion: 2,
        kind: 'publisher-section-manifest',
        validatorVersion: 'publisher-shard-content-v2',
        sourceRunId: SOURCE_RUN_ID,
        sourceSha: SOURCE_SHA,
        artifactRunId,
        manifestArtifactName,
        locale,
        requiredSections: [],
        artifactRefs: [],
        shards: [],
        population: 0,
      };
    });

    expect(union.size).toBe(sitemapUrls.length);
    expect([...union].sort()).toEqual([...sitemapUrls].sort());

    const validate = () => validatePublisherFastGate({
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

    expect(validate()).toMatchObject({
      passed: true,
      errorCount: 0,
      sitemapUrlPopulation: sitemapUrls.length,
      pageManifestPopulation: sitemapUrls.length,
    });

    const truncated = structuredClone(currentSitemapSnapshot);
    truncated.perSitemap['sitemap-sector.xml'].pop();
    fs.writeFileSync(path.join(sitemapDir, 'new-sitemap-urls.json'), JSON.stringify(truncated));
    const rejected = validate();
    expect(rejected.passed).toBe(false);
    expect(rejected.errors.join('\n')).toContain(
      'page manifest URL is absent from the source sitemap bundle',
    );
  });
});
