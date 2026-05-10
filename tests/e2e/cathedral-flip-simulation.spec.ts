import { test, expect } from 'playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCantonQuorumGate } from '../../scripts/lib/canton-quorum-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Cathedral Phase 2 — frozen-URL regression guard (E6 + E9).
 * ===========================================================
 *
 * When TARGET_CANTONS expanded from the legacy 3 (TI/GR/VS) to all 26 Swiss
 * cantons, two invariants MUST hold to prevent SEO churn:
 *
 *   1. Legacy-canton jobs (TI/GR/VS) keep their classification — the wider
 *      gate scope MUST NOT reclassify them into a different canton.
 *   2. Existing slug-registry entries published under /cerca-lavoro-ticino/
 *      stay PRESERVED at their original slug even when the canton-quorum
 *      gate now reports a different canton (E9 frozen-URL strategy). New
 *      classifications inform routing of *new* jobs, never rewrite
 *      already-indexed URLs.
 *
 * Decision E6 (Cathedral Phase 1) deferred this regression test until the
 * gate stabilised. This spec is the deferred guard.
 *
 * Implementation note: the spec exercises the pure JS function
 * `applyCantonQuorumGate` (no browser nav needed), but lives under
 * `tests/e2e/` to match the existing E2E framework already used for
 * link-graph and SEO regression guards.
 */

interface FixtureJob {
  id: string;
  expectedCanton: string;
  expectedConfidence: 'high' | 'low' | 'reject';
  title: string;
  description: string;
  addressLocality: string;
  addressRegion: string;
  addressCountry: string;
  postalCode: string;
  canton: string;
  _note?: string;
}

interface SlugRegistryEntry {
  registryKey: string;
  canonicalSlug: string;
  slugByLocale: Record<string, string>;
  createdAt: string;
  publishedUnderCanton?: string;
}

interface FrozenUrlScenario {
  registryKey: string;
  preFlipEntry: SlugRegistryEntry;
  reclassifiedJob: FixtureJob;
  expectedCantonAfterFlip: string;
}

interface Fixture {
  jobs: FixtureJob[];
  preExistingTiSlugs: SlugRegistryEntry[];
  frozenUrlScenario: FrozenUrlScenario;
}

const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  '__fixtures__',
  'cathedral-flip-fixture.json',
);

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

// ─── Pure helpers (immutable) ──────────────────────────────────────────────

interface SlugRegistry {
  readonly entries: Readonly<Record<string, SlugRegistryEntry>>;
}

function buildRegistry(entries: ReadonlyArray<SlugRegistryEntry>): SlugRegistry {
  const map: Record<string, SlugRegistryEntry> = {};
  for (const entry of entries) {
    map[entry.registryKey] = entry;
  }
  return { entries: map };
}

/**
 * Frozen-URL flip simulator. Mirrors the production rule (services/router.ts
 * + scripts/lib/slug-registry.mjs): once a registry key has a canonical slug,
 * subsequent classifications NEVER overwrite it. Returns a NEW registry —
 * never mutates `registry` or `entries`.
 */
function simulateRegistryFlip(
  registry: SlugRegistry,
  reclassifiedJobs: ReadonlyArray<{ registryKey: string; newCanonicalSlug: string }>,
): SlugRegistry {
  const next: Record<string, SlugRegistryEntry> = { ...registry.entries };
  for (const { registryKey, newCanonicalSlug } of reclassifiedJobs) {
    if (next[registryKey]) {
      // Frozen — do nothing (E9 invariant).
      continue;
    }
    next[registryKey] = {
      registryKey,
      canonicalSlug: newCanonicalSlug,
      slugByLocale: { it: newCanonicalSlug },
      createdAt: '2026-05-10',
    };
  }
  return { entries: next };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test.describe('Cathedral Phase 2 — frozen-URL flip regression', () => {
  test('fixture is the expected mix for full coverage', () => {
    const byCanton = (code: string) =>
      fixture.jobs.filter((j) => j.expectedCanton === code).length;
    expect(byCanton('TI'), 'TI fixture jobs').toBe(5);
    expect(byCanton('GR'), 'GR fixture jobs').toBe(3);
    expect(byCanton('VS'), 'VS fixture jobs').toBe(4); // 3 mainline + 1 ambiguous Saint-Maurice
    expect(byCanton('ZH'), 'ZH fixture jobs').toBe(4);
    expect(byCanton('BE'), 'BE fixture jobs').toBe(3);
    expect(byCanton('GE'), 'GE fixture jobs').toBe(2);
    expect(
      fixture.jobs.filter((j) => j.expectedConfidence === 'reject').length,
      'rejected (Liechtenstein) fixture jobs',
    ).toBe(1);
  });

  test('every TI-tagged legacy job keeps canton=TI after the gate (no churn)', () => {
    const tiJobs = fixture.jobs.filter((j) => j.expectedCanton === 'TI');
    expect(tiJobs.length, 'TI fixture cohort').toBeGreaterThan(0);
    for (const job of tiJobs) {
      const result = applyCantonQuorumGate(job);
      expect(
        result.canton,
        `TI job ${job.id} (${job.addressLocality}) reclassified to ${result.canton}`,
      ).toBe('TI');
      expect(result.confidence, `TI job ${job.id} confidence`).toBe('high');
    }
  });

  test('every GR-tagged legacy job keeps canton=GR after the gate (no churn)', () => {
    const grJobs = fixture.jobs.filter((j) => j.expectedCanton === 'GR');
    expect(grJobs.length, 'GR fixture cohort').toBeGreaterThan(0);
    for (const job of grJobs) {
      const result = applyCantonQuorumGate(job);
      expect(
        result.canton,
        `GR job ${job.id} (${job.addressLocality}) reclassified to ${result.canton}`,
      ).toBe('GR');
      expect(result.confidence, `GR job ${job.id} confidence`).toBe('high');
    }
  });

  test('every VS-tagged legacy job keeps canton=VS after the gate (no churn)', () => {
    const vsJobs = fixture.jobs.filter((j) => j.expectedCanton === 'VS');
    expect(vsJobs.length, 'VS fixture cohort').toBeGreaterThan(0);
    for (const job of vsJobs) {
      const result = applyCantonQuorumGate(job);
      expect(
        result.canton,
        `VS job ${job.id} (${job.addressLocality}) reclassified to ${result.canton}`,
      ).toBe('VS');
      expect(result.confidence, `VS job ${job.id} confidence`).toBe('high');
    }
  });

  test('newly-in-scope ZH and BE jobs classify with confidence=high (acceptance)', () => {
    const newCantons = ['ZH', 'BE'] as const;
    for (const code of newCantons) {
      const cohort = fixture.jobs.filter((j) => j.expectedCanton === code);
      expect(cohort.length, `${code} fixture cohort`).toBeGreaterThan(0);
      for (const job of cohort) {
        const result = applyCantonQuorumGate(job);
        expect(
          result.canton,
          `${code} job ${job.id} (${job.addressLocality}) classified as ${result.canton}`,
        ).toBe(code);
        expect(
          result.confidence,
          `${code} job ${job.id} confidence`,
        ).toBe('high');
      }
    }
  });

  test('newly-in-scope GE jobs classify with confidence=high', () => {
    const cohort = fixture.jobs.filter((j) => j.expectedCanton === 'GE');
    expect(cohort.length, 'GE fixture cohort').toBeGreaterThan(0);
    for (const job of cohort) {
      const result = applyCantonQuorumGate(job);
      expect(result.canton, `GE job ${job.id}`).toBe('GE');
      expect(result.confidence, `GE job ${job.id} confidence`).toBe('high');
    }
  });

  test('Liechtenstein-tagged job is rejected (postal 9494 / Schaan)', () => {
    const fl = fixture.jobs.find((j) => j.id === 'fl-1');
    expect(fl, 'Liechtenstein fixture present').toBeTruthy();
    const result = applyCantonQuorumGate(fl!);
    expect(result.confidence, 'FL job confidence').toBe('reject');
    expect(result.canton, 'FL job canton').toBe('');
  });

  test('slug-registry mock with 5 existing TI slugs is preserved after the simulated flip (zero churn)', () => {
    // Snapshot the registry state BEFORE the flip.
    const before = buildRegistry(fixture.preExistingTiSlugs);
    const beforeKeys = Object.keys(before.entries).sort();
    const beforeSnapshot = JSON.stringify(before.entries);

    // Simulate the cathedral flip: re-run the gate over the 5 TI fixture jobs
    // and feed each result into the frozen-URL simulator. Because the registry
    // already has each key, NONE should be added or modified.
    const tiJobs = fixture.jobs.filter((j) => j.expectedCanton === 'TI');
    const reclassified = tiJobs.map((job, idx) => {
      const result = applyCantonQuorumGate(job);
      // Build a candidate slug from the fresh classification — the simulator
      // MUST refuse to overwrite any of these.
      return {
        registryKey: fixture.preExistingTiSlugs[idx].registryKey,
        newCanonicalSlug: `${job.title.toLowerCase().replace(/\s+/g, '-')}-${result.canton.toLowerCase()}`,
      };
    });

    const after = simulateRegistryFlip(before, reclassified);
    const afterKeys = Object.keys(after.entries).sort();
    const afterSnapshot = JSON.stringify(after.entries);

    expect(afterKeys, 'registry key set unchanged').toEqual(beforeKeys);
    expect(afterSnapshot, 'every registry entry byte-identical').toBe(beforeSnapshot);
    expect(afterKeys.length, 'no new entries added').toBe(5);
  });

  test('E9 frozen-URL invariant: a pre-existing TI-published slug is NOT updated when canton flips to ZH', () => {
    // Setup: registry already contains the UBS Zurigo job under its original
    // TI-era canonical slug.
    const { registryKey, preFlipEntry, reclassifiedJob, expectedCantonAfterFlip } =
      fixture.frozenUrlScenario;
    const registryBefore = buildRegistry([preFlipEntry]);

    // Sanity: verify the pre-flip entry is what we expect.
    expect(registryBefore.entries[registryKey].canonicalSlug).toBe(
      'responsabile-vendite-ubs-zurigo',
    );
    expect(registryBefore.entries[registryKey].publishedUnderCanton).toBe('TI');

    // Run the gate on the reclassified job (now classified as ZH).
    const result = applyCantonQuorumGate(reclassifiedJob);
    expect(
      result.canton,
      'gate now classifies UBS Zurigo as ZH',
    ).toBe(expectedCantonAfterFlip);
    expect(result.confidence, 'high-confidence ZH classification').toBe('high');

    // Simulate the flip: caller WOULD propose a new ZH-flavoured slug, but
    // the registry MUST refuse to overwrite the TI-era canonical entry.
    const proposedNewSlug = 'responsabile-vendite-ubs-zurigo-zh';
    const registryAfter = simulateRegistryFlip(registryBefore, [
      { registryKey, newCanonicalSlug: proposedNewSlug },
    ]);

    expect(
      registryAfter.entries[registryKey].canonicalSlug,
      'frozen canonical slug unchanged after canton flip',
    ).toBe('responsabile-vendite-ubs-zurigo');
    expect(
      registryAfter.entries[registryKey].slugByLocale.it,
      'IT slug unchanged',
    ).toBe('responsabile-vendite-ubs-zurigo');
    expect(
      registryAfter.entries[registryKey].slugByLocale.de,
      'DE slug unchanged',
    ).toBe('verkaufsleiter-ubs-zuerich');
    expect(
      Object.keys(registryAfter.entries),
      'no extra registry keys created',
    ).toHaveLength(1);
  });

  test('canton quorum gate is total — never throws on malformed input', () => {
    const malformed: unknown[] = [
      undefined,
      null,
      {},
      { addressCountry: '' },
      { title: 42, description: undefined, addressLocality: null },
    ];
    for (const job of malformed) {
      expect(
        () => applyCantonQuorumGate(job as Parameters<typeof applyCantonQuorumGate>[0]),
        `gate should not throw on input ${JSON.stringify(job)}`,
      ).not.toThrow();
    }
  });
});
