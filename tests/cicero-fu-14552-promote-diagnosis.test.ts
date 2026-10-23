import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SOURCE = execFileSync('git', ['show', 'HEAD:scripts/prospect-promote.mjs'], { encoding: 'utf8' });

describe('FU-2026-10-21-004 — PROMOTE stability-only diagnosis', () => {
  it('reports stability-only blockers separately from other failed predicates', () => {
    expect(SOURCE).toContain('stabilityOnly=${blockedDiagnosis.stabilityOnly}');
    expect(SOURCE).toContain('other=${blockedDiagnosis.other}');
    expect(SOURCE).toContain('candidateFailures');
  });

  it('keeps the distinct-day requirement explicit in the diagnostic path', () => {
    expect(SOURCE).toContain('GATE_DEFAULTS.minDistinctDays');
    expect(SOURCE).toContain("new Set(h.map((v) => String(v.at).slice(0, 10)))");
    expect(SOURCE).toContain('stabilityRequirement');
  });
});
