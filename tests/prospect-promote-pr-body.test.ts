import { describe, expect, it } from 'vitest';

import { buildPromotionPrBody } from '../scripts/prospect-promote.mjs';
import { validatePrBody } from '../scripts/ci/pr-body-check-gate.mjs';

const SHIPPED = [{
  spec: {
    companyKey: 'demo-ag',
    companyName: 'Demo AG',
    mode: 'api',
    companyHost: 'jobs.demo.example',
  },
  vacancyCount: 2,
  qualityScore: 0.97,
  validationHistory: [{ verdict: 'good', at: '2026-09-18T08:00:00Z' }],
}];

function build(overrides: Record<string, unknown> = {}) {
  return buildPromotionPrBody({
    shipped: SHIPPED,
    totalVacancies: 2,
    relaxed: false,
    minDays: 2,
    maxPerRun: 10,
    stabilityRequirement: '2 validazioni buone su 2 giorni distinti',
    stabilityClaim: ' — la condizione che una singola run non puo\' soddisfare',
    blocked: [{}, {}],
    blockedSummary: { stabilityOnly: 1, other: 1 },
    groupsRegenerated: false,
    companiesRegenerated: false,
    ...overrides,
  });
}

describe('buildPromotionPrBody — contratto del prospector', () => {
  it('rende specifiche tutte le decisioni e tutti i blocchi', () => {
    const body = build();
    const statusLines = body.split('\n').filter((line) =>
      /(?:by construction|per scelta|blocked:)/i.test(line),
    );

    expect(statusLines.length).toBeGreaterThanOrEqual(5);
    expect(statusLines.every((line) => line.includes('**Motivo:**') && line.includes('**Prossimo passo:**'))).toBe(true);

    const contract = validatePrBody(body);
    expect(contract.ok, JSON.stringify(contract.violations)).toBe(true);
    expect(contract.violations).toEqual([]);
  });

  it('cita i workflow rigenerati così il controllo diff-vs-body non lascia finding', () => {
    const workflowPath = '.github/workflows/crawler-group-1.yml';
    const body = build({
      groupsRegenerated: true,
      companiesRegenerated: true,
      blocked: [],
      workflowPaths: [workflowPath],
    });

    const contract = validatePrBody(body, { diffPaths: [workflowPath] });
    expect(contract.ok, JSON.stringify(contract.violations)).toBe(true);
    expect(contract.warnings).toEqual([]);
    expect(body).toContain(`\`${workflowPath}\``);
  });
});
