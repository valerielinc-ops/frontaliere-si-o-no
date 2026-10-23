import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectCandidatePaths } from '../scripts/discover-404s-via-inspection.mjs';
import {
  gscCoveragePopulationSummary,
  readCanonicalGscCoverage,
} from '../scripts/lib/gsc-coverage-population.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function repositoryWith(snapshot: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'gsc-coverage-population-'));
  roots.push(root);
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'gsc-coverage-404s.json'), `${JSON.stringify(snapshot)}\n`);
  return root;
}

describe('canonical GSC Coverage population', () => {
  it('uses only the supplied source-backed cohort, never an expanded job population', () => {
    expect(collectCandidatePaths({ paths: ['/coverage-backed', '/coverage-backed'], unresolved: [] }))
      .toEqual(['/coverage-backed']);
  });

  it('deduplicates source-backed paths and keeps the unresolved residue out of candidates', () => {
    const population = readCanonicalGscCoverage(repositoryWith({
      source: 'gsc-coverage-drilldown',
      paths: ['/old-route/', '/old-route', '/article'],
      unresolved: [{ kind: 'unknown', path: '/ambiguous', reason: 'ambiguous-routing' }],
      population: { sourceBacked: 2, unresolved: 1, observedRows: 3 },
    }));

    expect(population.paths).toEqual(['/old-route', '/article']);
    expect(population.unresolved).toEqual([{ path: '/ambiguous', reason: 'ambiguous-routing' }]);
    expect(gscCoveragePopulationSummary(population)).toEqual({ sourceBacked: 2, unresolved: 1, observedRows: 3 });
  });

  it('fails closed when the producer writes an unsafe path', () => {
    expect(() => readCanonicalGscCoverage(repositoryWith({ paths: ['/safe', '/../../outside'] })))
      .toThrow(/unsafe GSC Coverage path|invalid GSC Coverage path/);
  });

  it('does not accept a job-orphan ledger as a substitute for the GSC cohort', () => {
    const root = repositoryWith({ paths: ['/coverage-backed'] });
    writeFileSync(join(root, 'data', 'url-inspection-results.json'), JSON.stringify([{ slug: 'job-orphan' }]));

    expect(readCanonicalGscCoverage(root).paths).toEqual(['/coverage-backed']);
  });
});
