import { describe, expect, it } from 'vitest';
import {
  calculatePercentile,
  estimateMonthlyNetFrontaliereChf,
  aggregateRoleInsights,
  generateInsightsStructuredData
} from '../scripts/lib/salary-insights.mjs';

describe('calculatePercentile', () => {
  it('calcola correttamente mediana e percentili', () => {
    const values = [50000, 60000, 70000, 80000, 90000, 100000];
    expect(calculatePercentile(values, 50)).toBe(75000); // mediana tra 70000 e 80000
    expect(calculatePercentile(values, 0)).toBe(50000);
    expect(calculatePercentile(values, 100)).toBe(100000);
  });
});

describe('estimateMonthlyNetFrontaliereChf', () => {
  it('calcola il netto mensile stimato dedotti contributi e imposta alla fonte', () => {
    // 100'000 CHF lordi annui in Ticino
    // Contributi sociali (15%) = 15'000 -> 85'000
    // Imposta fonte TI (8%) = 8'000
    // Netto = 77'000 / 12 = ~6417 CHF/mese
    const net = estimateMonthlyNetFrontaliereChf(100000, 'TI');
    expect(net).toBeGreaterThan(6000);
    expect(net).toBeLessThan(7000);
  });
});

describe('aggregateRoleInsights', () => {
  it('calcola distribuzione e percentili per ruolo e cantone', () => {
    const jobs = [
      { salaryMin: 80000, salaryMax: 90000 }, // mid 85000
      { salaryMin: 90000, salaryMax: 110000 }, // mid 100000
      { salaryMin: 110000, salaryMax: 130000 }, // mid 120000
    ];

    const insight = aggregateRoleInsights(jobs, { role: 'Software Engineer', canton: 'TI' });
    expect(insight.sampleSize).toBe(3);
    expect(insight.median).toBe(100000);
    expect(insight.min).toBe(85000);
    expect(insight.monthlyNetChf).toBeGreaterThan(6000);
  });
});

describe('generateInsightsStructuredData', () => {
  it('genera Schema.org Dataset e Occupation conformi per Google Rich Results', () => {
    const insight = {
      role: 'Ingegnere Meccanico',
      canton: 'TI',
      sampleSize: 15,
      min: 80000,
      p25: 88000,
      median: 98000,
      p75: 115000,
      p90: 130000,
      monthlyNetChf: 6300,
      calculatedAt: '2026-11-01T00:00:00Z'
    };

    const schema = generateInsightsStructuredData(insight);
    expect(schema['@context']).toBe('https://schema.org');
    expect(schema['@graph']).toHaveLength(2);

    const dataset = schema['@graph'].find((item: any) => item['@type'] === 'Dataset');
    expect(dataset).toBeDefined();
    expect(dataset.name).toContain('Ingegnere Meccanico');
    expect(dataset.variableMeasured[0].value).toBe('98000');

    const occupation = schema['@graph'].find((item: any) => item['@type'] === 'Occupation');
    expect(occupation).toBeDefined();
    expect(occupation.estimatedSalary[0].currency).toBe('CHF');
    expect(occupation.estimatedSalary[0].median).toBe(98000);
  });
});
