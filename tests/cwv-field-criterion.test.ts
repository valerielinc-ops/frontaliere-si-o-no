import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guard for scripts/check-cwv-field-criterion.mjs — the FIELD acceptance
 * criterion for issue #5001 (CrUX PHONE p75), which replaced
 * "PageSpeed Insights score > 90 mobile".
 *
 * The point of this file is AGENTS.md Non-Negotiable #1: never loosen a quality
 * threshold to make something pass. A closure criterion is exactly the kind of
 * number that gets quietly relaxed when a deadline slips, and unlike a CI budget
 * nothing else in the repo would notice. These tests pin the thresholds to the
 * measured evidence that justified them (docs/CWV-FIELD-CRITERION.md), so
 * loosening one is a deliberate, reviewable diff rather than a one-character
 * edit.
 *
 * Importing the module is safe: main() is guarded behind the
 * `import.meta.url === pathToFileURL(process.argv[1]).href` CLI check, so no
 * live CrUX request fires here.
 */

const {
  CRITERION,
  RATCHET,
  WATCHLIST,
  WATCHLIST_DRIFT,
  SUSTAINED_WINDOWS,
} = await import('../scripts/check-cwv-field-criterion.mjs');

describe('CWV field criterion for #5001', () => {
  it('gates on INP, CLS and LCP — the three field metrics, nothing lab-derived', () => {
    expect(Object.keys(CRITERION).sort()).toEqual(['cls', 'inp', 'lcp']);
  });

  it('holds INP at Google "good" (200 ms), which this origin has already demonstrated', () => {
    // Measured 158 ms on 2026-04-04 and under 200 through 2026-04-18, so this is
    // a regression to undo, not an aspiration. Relaxing it means claiming the
    // site can no longer reach a number it has already held.
    expect(CRITERION.inp.max).toBe(200);
  });

  it('sets CLS at 0.15 — below the six-week plateau floor of 0.17, above Google 0.10', () => {
    // 0.17 is the best this origin has ever recorded and it sat at 0.17-0.18 for
    // six consecutive windows. 0.15 cannot be reached by noise; 0.10 has never
    // been reached at all and is tracked as the successor target.
    expect(CRITERION.cls.max).toBe(0.15);
    expect(CRITERION.cls.max).toBeLessThan(CRITERION.cls.baseline);
    expect(CRITERION.cls.max).toBeGreaterThan(0.1);
  });

  it('keeps LCP as a hold at the Google-good bound, already satisfied at baseline', () => {
    expect(CRITERION.lcp.max).toBe(2500);
    expect(CRITERION.lcp.baseline).toBeLessThan(CRITERION.lcp.max);
  });

  it('demands every threshold be at least as strict as the 2026-08-07 baseline', () => {
    // A threshold at or above its own baseline would be green on day one and
    // would gate nothing. LCP is the deliberate exception (a hold, see above).
    for (const [key, spec] of Object.entries(CRITERION) as [string, { max: number; baseline: number }][]) {
      if (key === 'lcp') continue;
      expect(spec.max, `${key} threshold must be stricter than its baseline`).toBeLessThan(spec.baseline);
    }
  });

  it('requires two consecutive windows so a single noisy dip cannot close the issue', () => {
    expect(SUSTAINED_WINDOWS).toBe(2);
  });

  it('keeps the interim ratchet strictly between the baseline and the final bar', () => {
    // A ratchet outside that range is either already met (reports nothing) or
    // identical to the closure gate (adds nothing).
    expect(RATCHET.metric).toBe('inp');
    expect(RATCHET.max).toBeLessThan(CRITERION.inp.baseline);
    expect(RATCHET.max).toBeGreaterThan(CRITERION.inp.max);
    expect(RATCHET.by).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('tracks the job-search templates, which carry 56% of mobile organic clicks', () => {
    const paths = WATCHLIST.map((w: { url: string }) => new URL(w.url).pathname);
    expect(paths).toContain('/');
    expect(paths).toContain('/cerca-lavoro-ticino/');
    // The page the lab score calls healthy (PSI mobile 0.94) while its field INP
    // is 4085 ms — the single clearest reason this criterion is not lab-based.
    expect(paths).toContain('/cerca-lavoro-svizzera/');
  });

  it('gives every watchlist entry a full numeric baseline to drift against', () => {
    for (const entry of WATCHLIST as { url: string; inp: number; cls: number; lcp: number }[]) {
      for (const metric of ['inp', 'cls', 'lcp'] as const) {
        expect(typeof entry[metric], `${entry.url} ${metric}`).toBe('number');
        expect(entry[metric], `${entry.url} ${metric}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the drift tolerance tight enough to mean something', () => {
    expect(WATCHLIST_DRIFT).toBeGreaterThan(1);
    expect(WATCHLIST_DRIFT).toBeLessThanOrEqual(1.25);
  });
});

describe('lab configs stay anti-regression guards, not acceptance criteria', () => {
  const read = (f: string) => JSON.parse(readFileSync(resolve(process.cwd(), f), 'utf8'));

  it.each(['lighthouserc.json', 'lighthouserc.desktop.json'])(
    '%s carves the known-bad page out instead of flattening every threshold to it',
    (file) => {
      const cfg = read(file);
      const matrix = cfg.ci.assertMatrix;
      expect(Array.isArray(matrix), `${file} must use assertMatrix`).toBe(true);
      const patterns = matrix.map((m: { matchingUrlPattern: string }) => m.matchingUrlPattern);
      // One group excludes /cerca-lavoro-ticino/, one targets it: that split is
      // what lets the healthy pages be gated meaningfully.
      expect(patterns.some((p: string) => p.includes('(?!cerca-lavoro-ticino/)'))).toBe(true);
      expect(patterns.some((p: string) => /cerca-lavoro-ticino\/\$?$|cerca-lavoro-ticino\//.test(p) && !p.includes('?!'))).toBe(true);
    },
  );

  it('runs the deciding leg on mobile — the form factor Google ranks on', () => {
    const mobile = read('lighthouserc.json');
    expect(mobile.ci.collect.settings.formFactor).toBe('mobile');
    expect(mobile.ci.collect.settings.screenEmulation.mobile).toBe(true);
  });

  it('keeps category-score assertions identical across the two legs so they cannot drift', () => {
    const pick = (cfg: Record<string, any>) =>
      cfg.ci.assertMatrix.find((m: { matchingUrlPattern: string }) => m.matchingUrlPattern === '.*').assertions;
    expect(pick(read('lighthouserc.desktop.json'))).toEqual(pick(read('lighthouserc.json')));
  });
});
