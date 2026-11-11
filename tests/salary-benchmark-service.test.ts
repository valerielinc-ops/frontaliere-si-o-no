import { describe, expect, it } from 'vitest';
import {
  formatSalaryInterviewBriefing,
  inferSeniorityTier,
  lookupSalaryBenchmark,
  matchRoleKey,
} from '../functions/src/services/salaryBenchmarkService.js';

describe('salaryBenchmarkService', () => {
  it('infers seniority tier accurately from title and years of experience', () => {
    expect(inferSeniorityTier('Junior Web Developer', 1)).toBe('junior');
    expect(inferSeniorityTier('Software Engineer', 4)).toBe('mid');
    expect(inferSeniorityTier('Senior Data Analyst', 6)).toBe('senior');
    expect(inferSeniorityTier('Lead Architect / Team Manager', 12)).toBe('lead');
  });

  it('matches role key correctly across Italian and English titles', () => {
    expect(matchRoleKey('Sviluppatore React Full-Stack')).toBe('software_engineer');
    expect(matchRoleKey('Senior Cloud & DevOps Specialist')).toBe('devops_cloud_engineer');
    expect(matchRoleKey('Analista Finanziario & Controller')).toBe('financial_analyst');
    expect(matchRoleKey('Tecnico di Laboratorio Controllo Qualità')).toBe('pharma_specialist');
    expect(matchRoleKey('Ingegnere Meccanico Progettista')).toBe('mechanical_engineer');
    expect(matchRoleKey('Infermiera di Reparto')).toBe('nurse_healthcare');
  });

  it('calculates canton-adjusted salary benchmark for Ticino vs Zurich', () => {
    const ticino = lookupSalaryBenchmark({
      roleTitle: 'Senior Software Engineer',
      canton: 'TI',
      seniority: 'senior',
    });

    const zurich = lookupSalaryBenchmark({
      roleTitle: 'Senior Software Engineer',
      canton: 'ZH',
      seniority: 'senior',
    });

    expect(ticino.currency).toBe('CHF');
    expect(ticino.canton).toBe('TI');
    expect(zurich.canton).toBe('ZH');

    // Zurich multiplier (1.15) > Ticino multiplier (0.88)
    expect(zurich.annual.median).toBeGreaterThan(ticino.annual.median);
    expect(ticino.annual.median).toBeGreaterThan(100000);
    expect(ticino.monthly13.median).toBeGreaterThan(8000);
  });

  it('formats interview salary briefing, negotiation script, and HR questions', () => {
    const benchmark = lookupSalaryBenchmark({
      roleTitle: 'Full-Stack Developer',
      canton: 'TI',
      seniority: 'mid',
    });

    const briefing = formatSalaryInterviewBriefing(benchmark, 'Full-Stack Developer');
    expect(briefing.advice).toContain('Canton Ticino');
    expect(briefing.advice).toContain('benchmark di mercato svizzero');
    expect(briefing.deferralScript).toContain('In questa fase iniziale sono concentrato');
    expect(briefing.recruiterQuestions.length).toBeGreaterThanOrEqual(3);
    expect(briefing.recruiterQuestions[0]).toContain('range retributivo previsto');
  });

  it('supports all 26 Swiss cantons with BFS grossregion scaling and names', () => {
    const geneva = lookupSalaryBenchmark({
      roleTitle: 'Responsabile Amministrativo',
      canton: 'GE',
      seniority: 'mid',
    });
    expect(geneva.canton).toBe('GE');
    expect(geneva.cantonName).toBe('Canton Ginevra');
    expect(geneva.cantonMultiplier).toBeGreaterThan(1.2);
    // Geneva has a statutory minimum wage floor of 51,100 CHF
    expect(geneva.annual.p25).toBeGreaterThanOrEqual(51100);

    const basel = lookupSalaryBenchmark({
      roleTitle: 'Ingegnere Meccanico',
      canton: 'BS',
      seniority: 'senior',
    });
    expect(basel.canton).toBe('BS');
    expect(basel.cantonName).toBe('Canton Basilea Città');
    expect(basel.cantonMultiplier).toBeGreaterThan(1.2);
  });
});
