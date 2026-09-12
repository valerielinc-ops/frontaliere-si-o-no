import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the CI loop is a plain .mjs script with its own runtime contract.
import { runL0, validateManifest } from '../scripts/ci/loop-l0-data-truth.mjs';
// @ts-expect-error — the shared loop contract is intentionally dependency-free .mjs.
import { buildObservation, validateLoopRegistry } from '../scripts/lib/loop-fleet-contract.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));
const NOW = new Date('2026-09-12T12:00:00.000Z');
const GOOD = {
  commit: 'b'.repeat(40),
  generatedAt: '2026-09-11T17:16:13.000Z',
  counts: {
    articles: 3857,
    swissArticles: 2089,
    sitemapBlogUrls: 3850,
    sitemapBlogChUrls: 2086,
  },
};

describe('L0 Data Truth & Freshness', () => {
  it('registry dichiara gli 11 loop originali e il supervisore aggiunto', () => {
    expect(() => validateLoopRegistry(registry)).not.toThrow();
    expect(registry.loops).toHaveLength(12);
    expect(registry.loops.map((loop: { loopId: string }) => loop.loopId))
      .toEqual(Array.from({ length: 12 }, (_, i) => `L${i}`));
  });

  it('manifest completo e fresco è osservato con conteggi verificati', () => {
    const result = validateManifest(GOOD, { now: NOW, url: 'https://example.test/manifest.json' });
    expect(result).toMatchObject({ ok: true, quality: 'observed' });
    expect(result.manifest.counts.articles).toBe(3857);
  });

  it('manifest vecchio resta stale, non viene trasformato in dato corrente', () => {
    const result = validateManifest({ ...GOOD, generatedAt: '2026-09-09T00:00:00.000Z' }, { now: NOW });
    expect(result).toMatchObject({ ok: false, quality: 'stale' });
    expect(result.reason).toMatch(/old/);
  });

  it('keeps a future timestamp from inverting the decision window', async () => {
    const result = await runL0({
      now: NOW,
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({
          ...GOOD,
          generatedAt: '2026-09-12T18:00:00.000Z',
        }),
      }),
      logger: { log: () => {} },
    });
    expect(result.verdict.ok).toBe(false);
    expect(result.decision.startedAt).toBe(NOW.toISOString());
    expect(Date.parse(result.decision.expiresAt)).toBeGreaterThan(Date.parse(result.decision.startedAt));
  });

  it('zero esplicito e schema parziale sono stati distinti', () => {
    const zero = validateManifest({ ...GOOD, counts: { ...GOOD.counts, articles: 0 } }, { now: NOW });
    expect(zero).toMatchObject({ ok: false, quality: 'zero' });
    const partial = validateManifest({ ...GOOD, counts: { articles: 3857 } }, { now: NOW });
    expect(partial).toMatchObject({ ok: false, quality: 'partial' });
  });

  it('fetch failure è unmeasurable e non inventa un numeratore zero', async () => {
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l0-'));
    const result = await runL0({
      now: NOW,
      url: 'https://example.test/manifest.json',
      fetchImpl: async () => { throw new Error('network unavailable'); },
      reportDir,
      logger: { log: () => {} },
    });
    expect(result.verdict.quality).toBe('unmeasurable');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
    expect(result.issued).toBe(false);
  });

  it('apply quarantena solo l’evidenza runner-local e issue è un’azione esterna', async () => {
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l0-apply-'));
    const issues: unknown[] = [];
    const result = await runL0({
      now: NOW,
      url: 'https://example.test/manifest.json',
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({ ...GOOD, generatedAt: '2026-09-01T00:00:00.000Z' }),
      }),
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload: unknown) => { issues.push(payload); },
      logger: { log: () => {} },
    });
    expect(result).toMatchObject({ issued: true, quarantined: true, verdict: { quality: 'stale' } });
    expect(issues).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l0-quarantine.json'), 'utf8')))
      .toMatchObject({ previousSurfaceUntouched: true });
  });

  it('il contratto rifiuta una misura unmeasurable con numeratore zero', () => {
    expect(() => buildObservation({
      loopId: 'L0',
      goal: 'Data Truth & Freshness',
      owner: 'CDO',
      oracle: 'independent',
      hypothesis: 'test',
      sourceSnapshot: { source: 'test' },
      observationWindow: { start: NOW.toISOString(), end: NOW.toISOString() },
      cohort: 'test',
      numerator: 0,
      denominator: 1,
      primaryMetric: 'test',
      guardrails: ['missing is not zero'],
      minimumSample: 1,
      quality: 'unmeasurable',
    })).toThrow(/null numerator and denominator/);
  });
});
