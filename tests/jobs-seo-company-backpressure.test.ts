// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('jobsSeoPages company-landing backpressure', () => {
  it('flushes hub HTML before the generic collector threshold', () => {
    const pluginSource = readSource('build-plugins/jobsSeoPagesPlugin.ts');
    const collectorSource = readSource('build-plugins/batchWrite.ts');
    const phaseStart = pluginSource.indexOf('let companyPagesCount = 0;');
    const phaseEnd = pluginSource.indexOf('/* ── Write known-company-slugs.json', phaseStart);
    const companyPhase = pluginSource.slice(phaseStart, phaseEnd);
    const threshold = Number(
      collectorSource.match(/const DEFAULT_AUTO_FLUSH_THRESHOLD = (\d+);/)?.[1],
    );
    const inFlightLimit = Number(
      companyPhase.match(/await collector\.awaitDrainSlot\((\d+)\);/)?.[1],
    );
    const hubFlushThreshold = Number(
      pluginSource.match(/const HUB_PAGE_WRITE_FLUSH_THRESHOLD = ([\d_]+);/)?.[1]?.replaceAll('_', ''),
    );

    expect(phaseStart).toBeGreaterThan(-1);
    expect(phaseEnd).toBeGreaterThan(phaseStart);
    expect(threshold).toBe(5_000);
    expect(inFlightLimit).toBe(2);
    // A single-locale shard can finish the whole company phase below 1,024
    // writes; 128 forces at least one intermediate drain on that path.
    expect(hubFlushThreshold).toBe(128);
    expect(hubFlushThreshold).toBeLessThan(threshold);
    expect(companyPhase).toContain('await flushHubPageWritesIfNeeded();');
    expect(companyPhase).toContain('await collector.flush();');
    // The active map is drained before the generic 5,000-entry auto-flush can
    // create another large batch; this is the memory bound the old
    // awaitDrainSlot-only guard did not provide.
  });
});
