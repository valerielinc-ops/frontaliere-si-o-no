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

  it('releases only behind the post-walk sequential barrier, after every parallel reader', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../..', rel), 'utf8');
    const readers = [
      'build-plugins/jobsSeoPagesPlugin.ts',
      'build-plugins/eventsSeoPagesPlugin.ts',
      'build-plugins/plateAuctionsPagesPlugin.ts',
      'build-plugins/relatedSearchClustersPlugin.ts',
    ];
    // Readers run as plain (parallel) closeBundle hooks: none may release the
    // singleton itself, or a sibling still reading it would see emptied data.
    for (const reader of readers) {
      const source = read(reader);
      expect(source, reader).toContain('getTrafficEvidenceFilter(');
      expect(source, reader).not.toContain('releaseTrafficEvidenceFilter');
    }

    const postWalk = read('build-plugins/postWalkCoordinatorPlugin.ts');
    const hook = postWalk.slice(postWalk.indexOf('closeBundle: {'));
    expect(hook).toMatch(/^closeBundle: \{\s*order: 'post',\s*sequential: true,\s*handler: async \(\) => \{/u);
    expect(postWalk.match(/releaseTrafficEvidenceFilter\(rootDir\);/gu)).toHaveLength(1);
    expect(hook.indexOf('releaseTrafficEvidenceFilter(rootDir);'))
      .toBeLessThan(hook.indexOf('const distDir'));

    const config = read('vite.config.ts');
    const barrier = config.indexOf('postWalkCoordinatorPlugin(__dirname');
    expect(barrier).toBeGreaterThan(0);
    for (const name of ['jobsSeoPagesPlugin', 'eventsSeoPagesPlugin', 'plateAuctionsPagesPlugin', 'relatedSearchClustersPlugin']) {
      const at = config.indexOf(`${name}(__dirname`);
      expect(at, name).toBeGreaterThan(0);
      expect(at, name).toBeLessThan(barrier);
    }

    const allReaders = fs.readdirSync(path.resolve(import.meta.dirname, '../../build-plugins'))
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => read(`build-plugins/${file}`).includes('getTrafficEvidenceFilter('))
      .map((file) => `build-plugins/${file}`)
      .sort();
    expect(allReaders).toEqual([...readers].sort());
  });
});
