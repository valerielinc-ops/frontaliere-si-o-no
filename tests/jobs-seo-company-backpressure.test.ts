// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('jobsSeoPages company-landing backpressure', () => {
  it('caps retained company HTML at 15,000 entries (down from 35,000)', () => {
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

    expect(phaseStart).toBeGreaterThan(-1);
    expect(phaseEnd).toBeGreaterThan(phaseStart);
    expect(threshold).toBe(5_000);
    expect(inFlightLimit).toBe(2);
    // One active collector map plus at most two flush batches. This metric is
    // deterministic and does not require the unsafe full local SEO build.
    expect((inFlightLimit + 1) * threshold).toBe(15_000);
  });
});
