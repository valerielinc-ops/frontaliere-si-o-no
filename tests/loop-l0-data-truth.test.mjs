import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import registry from '../data/loop-fleet/loop-registry.json' with { type: 'json' };
import {
  AUTONOMY_LEVELS,
  LOOP_STATES,
  QUALITY_STATES,
  buildObservation,
  validateLoopRegistry,
} from '../scripts/lib/loop-fleet-contract.mjs';
import {
  runL0,
  validateManifest,
} from '../scripts/ci/loop-l0-data-truth.mjs';

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

test('registry dichiara gli 11 loop originali e il supervisore aggiunto', () => {
  assert.doesNotThrow(() => validateLoopRegistry(registry));
  assert.deepEqual(registry.states, LOOP_STATES);
  assert.deepEqual(registry.qualityStates, QUALITY_STATES);
  assert.deepEqual(Object.keys(registry.autonomyLevels), AUTONOMY_LEVELS);
  assert.equal(registry.loops.length, 12);
  assert.deepEqual(registry.loops.map((loop) => loop.loopId), Array.from({ length: 12 }, (_, i) => `L${i}`));
});

test('manifest completo e fresco è osservato con conteggi verificati', () => {
  const result = validateManifest(GOOD, { now: NOW, url: 'https://example.test/manifest.json' });
  assert.equal(result.ok, true);
  assert.equal(result.quality, 'observed');
  assert.equal(result.manifest.counts.articles, 3857);
  assert.match(result.reason, /complete and/);
});

test('manifest vecchio resta stale, non viene trasformato in dato corrente', () => {
  const result = validateManifest({ ...GOOD, generatedAt: '2026-09-09T00:00:00.000Z' }, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.quality, 'stale');
  assert.match(result.reason, /old/);
});

test('zero esplicito e schema parziale sono stati distinti', () => {
  const zero = validateManifest({ ...GOOD, counts: { ...GOOD.counts, articles: 0 } }, { now: NOW });
  assert.equal(zero.quality, 'zero');
  assert.equal(zero.ok, false);
  const partial = validateManifest({ ...GOOD, counts: { articles: 3857 } }, { now: NOW });
  assert.equal(partial.quality, 'partial');
  assert.equal(partial.ok, false);
});

test('fetch failure è unmeasurable e non inventa un numeratore zero', async () => {
  const result = await runL0({
    now: NOW,
    url: 'https://example.test/manifest.json',
    fetchImpl: async () => { throw new Error('network unavailable'); },
    reportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l0-')),
    logger: { log() {} },
  });
  assert.equal(result.verdict.quality, 'unmeasurable');
  assert.equal(result.observation.numerator, null);
  assert.equal(result.observation.denominator, null);
  assert.equal(result.issued, false);
});

test('apply quarantena solo l’evidenza runner-local e issue è un’azione esterna deduplicabile', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l0-apply-'));
  const issues = [];
  const result = await runL0({
    now: NOW,
    url: 'https://example.test/manifest.json',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ ...GOOD, generatedAt: '2026-09-01T00:00:00.000Z' }) }),
    reportDir,
    apply: true,
    issue: true,
    createIssueImpl: async (payload) => { issues.push(payload); },
    logger: { log() {} },
  });
  assert.equal(result.verdict.quality, 'stale');
  assert.equal(result.quarantined, true);
  assert.equal(result.issued, true);
  assert.equal(issues.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(reportDir, 'l0-quarantine.json'))).previousSurfaceUntouched, true);
});

test('il contratto rifiuta una misura missing con numeratore zero', () => {
  assert.throws(() => buildObservation({
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
  }), /null numerator and denominator/);
});
