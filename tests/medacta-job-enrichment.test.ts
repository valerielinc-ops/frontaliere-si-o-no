import { describe, expect, it } from 'vitest';
import {
  inferMedactaCategory,
  inferMedactaContract,
  buildMedactaLocalizedDescriptions,
} from '../scripts/lib/medacta-job-enrichment.mjs';

describe('medacta-job-enrichment', () => {
  it('maps Medacta categories to canonical job board categories', () => {
    expect(
      inferMedactaCategory({
        category: 'general-services',
        categoryLabel: 'General Services',
        title: 'Manutentore Elettromeccanico',
        jobCategory: 'Altro',
      })
    ).toBe('engineering');

    expect(
      inferMedactaCategory({
        category: 'mkt-communication',
        categoryLabel: 'Marketing & Communications',
        title: 'Group Associate Product Manager',
        jobCategory: 'Marketing',
      })
    ).toBe('sales');
  });

  it('normalizes Medacta contract values to canonical contract types', () => {
    expect(inferMedactaContract({ rawContract: 'permanent', title: 'IT Web Developer' })).toBe('full-time');
    expect(inferMedactaContract({ rawContract: '80%', title: 'HR Specialist' })).toBe('part-time');
    expect(inferMedactaContract({ rawContract: '', title: 'Thesis R&D Orthopedics' })).toBe('internship');
  });

  it('builds rich localized descriptions with markdown sections for all locales', () => {
    const descriptions = buildMedactaLocalizedDescriptions({
      title: 'Manutentore Elettromeccanico',
      location: 'Castel San Pietro/Rancate',
      category: 'engineering',
      departmentLabel: 'General Services',
      isUrgent: false,
      metaDescription: 'Lavora con noi! Medacta International SA sta cercando Manutentore Elettromeccanico su Svizzera',
    });

    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const text = descriptions[locale] || '';
      expect(text.length).toBeGreaterThan(220);
      expect(text).toContain('## ');
      expect(text).toContain('Manutentore Elettromeccanico');
    }

    expect(descriptions.it).not.toBe(descriptions.en);
    expect(descriptions.it).not.toBe(descriptions.de);
    expect(descriptions.it).not.toBe(descriptions.fr);
  });
});
