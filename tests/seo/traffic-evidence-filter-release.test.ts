// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getTrafficEvidenceFilter,
  releaseTrafficEvidenceFilter,
  _resetForTests,
} from '../../build-plugins/shared/trafficEvidenceFilter';

let roots: string[] = [];

afterEach(() => {
  _resetForTests();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function writeEvidence(root: string, pages: Record<string, number>): void {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'evidence-index.json'),
    JSON.stringify({ ga4: { pages } }),
  );
}

describe('traffic evidence filter release', () => {
  it('clears held indexes and reloads updated evidence on the next reader', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-evidence-release-'));
    roots.push(root);
    writeEvidence(root, { '/old-path/': 3 });

    const firstReader = getTrafficEvidenceFilter(root);
    expect(firstReader.hasTraffic('/old-path/')).toBe(true);
    expect(firstReader.memoryStats().trafficSet).toBe(1);

    writeEvidence(root, { '/new-path/': 4 });
    expect(getTrafficEvidenceFilter(root)).toBe(firstReader);
    expect(firstReader.hasTraffic('/new-path/')).toBe(false);

    expect(releaseTrafficEvidenceFilter(root)).toBe(true);
    expect(firstReader.memoryStats()).toEqual({ trafficSet: 0, firstSeen: 0 });
    expect(firstReader.hasTraffic('/old-path/')).toBe(false);

    const reloadedReader = getTrafficEvidenceFilter(root);
    expect(reloadedReader).not.toBe(firstReader);
    expect(reloadedReader.hasTraffic('/new-path/')).toBe(true);
    expect(reloadedReader.hasTraffic('/old-path/')).toBe(false);
  });

  it('does not release evidence owned by another root and is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-evidence-release-'));
    const otherRoot = path.resolve(root, 'other');
    roots.push(root);
    fs.mkdirSync(otherRoot);
    writeEvidence(root, { '/owned-here/': 1 });
    writeEvidence(otherRoot, { '/owned-there/': 1 });
    const filter = getTrafficEvidenceFilter(root);

    expect(releaseTrafficEvidenceFilter(otherRoot)).toBe(false);
    expect(filter.hasTraffic('/owned-here/')).toBe(true);
    expect(releaseTrafficEvidenceFilter(root)).toBe(true);
    expect(releaseTrafficEvidenceFilter(root)).toBe(false);
  });

  it('runs after related search has consumed the shared filter for the last time', () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../build-plugins/relatedSearchClustersPlugin.ts'),
      'utf8',
    );
    const finalUse = source.lastIndexOf('trafficFilter.');
    const release = source.lastIndexOf('releaseTrafficEvidenceFilter(rootDir);');
    expect(finalUse).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(finalUse);
    expect(source.match(/releaseTrafficEvidenceFilter\(rootDir\);/gu)).toHaveLength(5);
  });
});
