/**
 * The self-heal loop of jobsSeoPagesPlugin must yield to the WriteCollector.
 *
 * #10481 turned each of the ~68k historical tracking paths into a full
 * archive page (buildSoftLandingHtml) instead of a tiny bridge. The loop is
 * synchronous, so without an await the collector's background flushes cannot
 * progress and every page's HTML stays queued until the final flush: deploy
 * 30-09 measured the phase at +1.3-1.4 GB (was +171 MB) and the de/en legs
 * died with "Ineffective mark-compacts near heap limit".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');

describe('jobsSeoPagesPlugin self-heal backpressure', () => {
  const start = source.indexOf('the self-healing tombstone is');
  const end = source.indexOf('Preserved ${historicalFallbackCount} historical tracking paths', start);
  const loop = source.slice(start, end);

  it('drains the WriteCollector inside the self-heal loop, before each page is queued', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const drain = loop.indexOf('await collector.awaitDrainSlot(2);');
    expect(drain).toBeGreaterThan(-1);
    // Before both writers of the loop: the relocation bridge and the archive page.
    const firstWrite = loop.indexOf('writeSoftLandingPage(');
    expect(firstWrite).toBeGreaterThan(drain);
    expect(loop.indexOf('buildHistoricalArchiveHtml(slug, relPath, locale, archive)')).toBeGreaterThan(drain);
  });

  it('skips already written paths before waiting, so only emitted pages pay the drain', () => {
    const skip = loop.indexOf('if (_writtenPaths.has(absFile)) continue;');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(loop.indexOf('await collector.awaitDrainSlot(2);'));
  });
});
