import { describe, expect, it } from 'vitest';

import { summarise } from '@/build-plugins/writeRegistryLifecyclePlugin';
import type { CollisionRecord } from '@/build-plugins/sharedWriteRegistry';

function record(firstPlugin: string, attemptedPlugin: string, path = '/dist/foo/index.html'): CollisionRecord {
  return {
    path,
    first: { plugin: firstPlugin, callSite: `<lazy:${firstPlugin}>`, contentHash: 'aaa' },
    attempted: { plugin: attemptedPlugin, callSite: `<lazy:${attemptedPlugin}>`, contentHash: 'bbb' },
  };
}

describe('writeRegistryLifecyclePlugin summarise', () => {
  it('classifies a same-plugin collision as samePluginCollisions, not crossPluginCollisions', () => {
    // Regression: this used to be derived as `totalCollisions - intraPluginOverwrites`,
    // where intraPluginOverwrites only reflects overwrites still held in a
    // WriteCollector's in-memory Map at claim time. Once that Map auto-flushed and
    // reset between the two same-plugin writes (batchWrite.ts, every 5000 adds), the
    // subtraction silently relabelled a same-plugin collision as cross-plugin even
    // though both sides name the same plugin.
    const summary = summarise([record('jobsSeoPagesPlugin', 'jobsSeoPagesPlugin')]);
    expect(summary.samePluginCollisions).toBe(1);
    expect(summary.crossPluginCollisions).toBe(0);
  });

  it('classifies a genuine cross-plugin collision as crossPluginCollisions', () => {
    const summary = summarise([record('jobsSeoPagesPlugin', 'relatedSearchClustersPlugin')]);
    expect(summary.samePluginCollisions).toBe(0);
    expect(summary.crossPluginCollisions).toBe(1);
  });

  it('classification is independent of intraPluginOverwrites (the stale Map-transient counter)', () => {
    // Even if the Map-transient counter under-reports (e.g. 0, because the two
    // writes straddled an auto-flush reset), the same-plugin collision above must
    // still be counted correctly since it's derived directly from the records.
    const summary = summarise([record('jobsSeoPagesPlugin', 'jobsSeoPagesPlugin')]);
    expect(summary.totalCollisions).toBe(1);
    expect(summary.samePluginCollisions + summary.crossPluginCollisions).toBe(summary.totalCollisions);
  });

  it('groups mixed records into the correct plugin-pair buckets', () => {
    const records = [
      record('jobsSeoPagesPlugin', 'jobsSeoPagesPlugin', '/dist/a/'),
      record('jobsSeoPagesPlugin', 'jobsSeoPagesPlugin', '/dist/b/'),
      record('jobsSeoPagesPlugin', 'relatedSearchClustersPlugin', '/dist/c/'),
    ];
    const summary = summarise(records);
    expect(summary.totalCollisions).toBe(3);
    expect(summary.uniquePaths).toBe(3);
    expect(summary.samePluginCollisions).toBe(2);
    expect(summary.crossPluginCollisions).toBe(1);
    const pairs = Object.fromEntries(summary.byPluginPair.map((p) => [p.pair, p.count]));
    expect(pairs['jobsSeoPagesPlugin ↔ jobsSeoPagesPlugin']).toBe(2);
    expect(pairs['jobsSeoPagesPlugin ↔ relatedSearchClustersPlugin']).toBe(1);
  });
});
