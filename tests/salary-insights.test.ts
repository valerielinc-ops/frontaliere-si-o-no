import { describe, expect, it } from 'vitest';
import {
  calculatePercentile,
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

describe('aggregateRoleInsights', () => {
  it('calcola distribuzione e percentili per ruolo e cantone', () => {
    const jobs = [
      { salaryMin: 85000, salaryMax: 85000, currency: 'CHF', salarySource: 'reported' },
      { salaryMin: 100000, salaryMax: 100000, currency: 'CHF', salarySource: 'reported' },
      { salaryMin: 120000, salaryMax: 120000, currency: 'CHF', salarySource: 'reported' },
    ];

    const insight = aggregateRoleInsights(jobs, { role: 'Software Engineer', canton: 'TI' });
    expect(insight.sampleSize).toBe(3);
    expect(insight.median).toBe(100000);
    expect(insight.min).toBe(85000);
    expect(insight.p10).toBe(88000);
    expect(insight.p25).toBe(92500);
    expect(insight.p75).toBe(110000);
    expect(insight.p90).toBe(116000);
  });

  it('calcola P10 interpolato sui valori normalizzati', () => {
    expect(calculatePercentile([100, 200, 300, 400, 500], 10)).toBe(140);
  });

  it('non inventa percentili dai range né da fonti non dichiarate', () => {
    const insight = aggregateRoleInsights([
      { salaryMin: 80000, salaryMax: 100000, currency: 'CHF', salarySource: 'reported' },
      { salaryMin: 120000, salaryMax: 120000, currency: 'CHF', salarySource: 'estimated' },
    ], { role: 'Analista', canton: 'TI' });

    expect(insight.sampleSize).toBe(0);
    expect(insight.p10).toBeNull();
    expect(insight.p25).toBeNull();
  });
});

describe('generateInsightsStructuredData', () => {
  it('genera Schema.org Dataset e Occupation conformi per Google Rich Results', () => {
    const insight = {
      role: 'Ingegnere Meccanico',
      canton: 'TI',
      sampleSize: 15,
      min: 80000,
      p10: 82000,
      p25: 88000,
      median: 98000,
      p75: 115000,
      p90: 130000,
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
    expect(occupation.estimatedSalary[0].percentile10).toBe(82000);
    expect(occupation.estimatedSalary[0].percentile10).not.toBe(insight.min);
  });

  it('localizza description, ruolo e unità dello Schema.org per EN', () => {
    const schema = generateInsightsStructuredData({
      role: 'Worker in Ticino',
      canton: 'TI',
      sampleSize: 5,
      p10: 140,
      p25: 200,
      median: 300,
      p75: 400,
      p90: 500,
    }, 'en');
    const dataset = schema['@graph'].find((item: any) => item['@type'] === 'Dataset');
    const occupation = schema['@graph'].find((item: any) => item['@type'] === 'Occupation');

    expect(dataset.name).toContain('Observed salary distribution');
    expect(dataset.description).toContain('listings with reported salary ranges');
    expect(dataset.description).not.toContain('offerte');
    expect(occupation.name).toBe('Worker in Ticino');
    expect(occupation.estimatedSalary[0].name).toBe('Observed annual gross salary in CHF');
  });
});
