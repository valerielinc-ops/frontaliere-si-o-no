import { describe, expect, it } from 'vitest';
import {
  pickSpreadSample,
  sampleConverged,
  extractBundleUrls,
  waitForDeepSample,
} from '../scripts/wait-for-pages-propagation.mjs';

// Regression context (2026-07-14): the propagation gate verified ONLY
// build-id.txt (1 request, converged in 1s) and the caller then purged the
// whole Cloudflare edge — while GitHub Pages was still propagating the
// ~650k-file artifact and ~2.5k canonical job URLs 404'd at origin for ~2h.
// The 04:38Z send-job-alerts run's live-link preflight filtered 15-30% of
// every CH-wide alert as dead links. The deep-sample phase-2 gate below is
// what prevents that: the purge is now held until a spread sample of THIS
// build's own sitemap URLs actually serves.

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example.com/p/${String(i).padStart(5, '0')}/`);

describe('pickSpreadSample — deterministic whole-artifact coverage', () => {
  it('returns all URLs when the list is smaller than the sample size', () => {
    expect(pickSpreadSample(urls(10), 60)).toHaveLength(10);
  });

  it('caps at the sample size and spreads across the full range', () => {
    const sample = pickSpreadSample(urls(6000), 60);
    expect(sample.length).toBeLessThanOrEqual(60);
    expect(sample.length).toBeGreaterThan(50);
    // Spread: both the head and the tail of the sorted list are represented —
    // the tail is exactly where the post-activation propagation holes live.
    expect(sample[0]).toBe('https://example.com/p/00000/');
    const last = sample[sample.length - 1];
    expect(Number(last.match(/(\d+)\/$/)![1])).toBeGreaterThan(5000);
  });

  it('is deterministic (same input → same sample, no flapping between rounds)', () => {
    const a = pickSpreadSample(urls(5000), 60);
    const b = pickSpreadSample(urls(5000), 60);
    expect(a).toEqual(b);
  });

  it('drops non-URL junk and duplicates', () => {
    const dirty = [...urls(5), '', 'not-a-url', urls(5)[0], null as unknown as string];
    expect(pickSpreadSample(dirty, 60)).toHaveLength(5);
  });
});

describe('sampleConverged — threshold math', () => {
  it('60 URLs at 0.97 tolerates exactly 1 failure', () => {
    expect(sampleConverged(60, 60, 0.97)).toBe(true);
    expect(sampleConverged(59, 60, 0.97)).toBe(true);
    expect(sampleConverged(58, 60, 0.97)).toBe(false);
  });

  it('an empty sample converges trivially (fail-open)', () => {
    expect(sampleConverged(0, 0, 0.97)).toBe(true);
  });

  it('1.0 min-ok tolerates zero failures', () => {
    expect(sampleConverged(9, 10, 1.0)).toBe(false);
    expect(sampleConverged(10, 10, 1.0)).toBe(true);
  });
});

describe('extractBundleUrls — new-sitemap-urls.json shape', () => {
  it('reads the version-2 _allUrls array', () => {
    expect(extractBundleUrls({ version: 2, _allUrls: ['https://a/', 'https://b/'] })).toHaveLength(2);
  });

  it('returns [] on missing/malformed shapes so the caller fails open', () => {
    expect(extractBundleUrls(null)).toEqual([]);
    expect(extractBundleUrls({})).toEqual([]);
    expect(extractBundleUrls({ _allUrls: 'nope' })).toEqual([]);
    expect(extractBundleUrls({ _allUrls: [1, 2] as unknown as string[] })).toEqual([]);
  });
});

describe('waitForDeepSample — polling loop (injected probe, no network)', () => {
  it('converges immediately when everything is live', async () => {
    const sample = urls(20);
    const ok = await waitForDeepSample({
      sample, minOk: 0.97, timeoutMs: 5_000,
      probe: async () => true,
    });
    expect(ok).toBe(true);
  });

  it('re-probes ONLY the still-failing URLs and converges once holes heal', async () => {
    const sample = urls(10);
    const probed: string[] = [];
    let round = 0;
    const holey = new Set([sample[3], sample[7]]);
    const ok = await waitForDeepSample({
      sample, minOk: 1.0, timeoutMs: 120_000, pollGapMs: 10,
      probe: async (u: string) => {
        probed.push(u);
        if (probed.length === 10) round = 1; // after first full pass
        if (round === 0) return !holey.has(u);
        return true; // holes healed on the second round
      },
    });
    expect(ok).toBe(true);
    // First round: all 10. Second round: only the 2 previously-failing.
    expect(probed.length).toBe(12);
  });

  it('times out (returns false) when the holes never heal', async () => {
    const sample = urls(5);
    const ok = await waitForDeepSample({
      sample, minOk: 1.0, timeoutMs: 1_000,
      probe: async (u: string) => u !== sample[2],
    });
    expect(ok).toBe(false);
  });
});
