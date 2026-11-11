import { describe, expect, it } from 'vitest';
import {
  formatCompanyPromptContext,
  getCompanyResearch,
  normalizeCompanyKey,
  resolveCompanyResearch,
  saveCompanyResearch,
  SWISS_EMPLOYER_BASELINES,
} from '../functions/src/services/companyResearchService.js';

describe('companyResearchService', () => {
  it('normalizes Swiss company names removing legal suffixes and accents', () => {
    expect(normalizeCompanyKey('UBS Switzerland AG')).toBe('ubs');
    expect(normalizeCompanyKey('Novartis Pharma Schweiz AG')).toBe('novartis');
    expect(normalizeCompanyKey('Bally Schuhfabriken SA')).toBe('bally');
    expect(normalizeCompanyKey('Clinica Luganese Moncucco Sagl')).toBe('clinica-luganese-moncucco');
    expect(normalizeCompanyKey('Société Générale de Surveillance SA')).toBe('societe-generale-de-surveillance');
  });

  it('retrieves curated baseline for known Swiss employers when db has no record', async () => {
    const fakeDb = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: false }),
        }),
      }),
    };

    const res = await getCompanyResearch(fakeDb as any, 'UBS Switzerland AG');
    expect(res).not.toBeNull();
    expect(res?.companyKey).toBe('ubs');
    expect(res?.industry).toContain('Banking');
    expect(res?.cantons).toContain('TI');
    expect(res?.cultureKeywords).toContain('eccellenza operativa');
  });

  it('saves and formats company intelligence context for AI prompts', async () => {
    let savedData: any = null;
    const fakeDb = {
      collection: () => ({
        doc: (key: string) => ({
          get: async () => ({ exists: Boolean(savedData), data: () => savedData }),
          set: async (val: any) => { savedData = val; },
        }),
      }),
    };

    const record = await saveCompanyResearch(fakeDb as any, 'Ticino Software House Sagl', {
      industry: 'Software & Cloud',
      mission: 'Creare soluzioni ERP avanzate per il mercato elvetico.',
      cultureKeywords: ['qualità del codice', 'affidabilità svizzera'],
      strategicPriorities: ['migrazione al cloud Azure Svizzera'],
    });

    expect(record.companyKey).toBe('ticino-software-house');
    expect(record.mission).toContain('ERP');

    const formatted = formatCompanyPromptContext(record);
    expect(formatted).toContain('Company Intelligence');
    expect(formatted).toContain('Settore: Software & Cloud');
    expect(formatted).toContain('Missione: Creare soluzioni ERP');
    expect(formatted).toContain('qualità del codice, affidabilità svizzera');
  });

  it('respects cache expiration TTL', async () => {
    const now = Date.now();
    const expiredData = {
      companyKey: 'test-co',
      companyName: 'Test Co',
      expiresAt: now - 1000, // Expired 1 second ago
    };

    const fakeDb = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => expiredData }),
        }),
      }),
    };

    const res = await getCompanyResearch(fakeDb as any, 'Test Co', { nowMs: now });
    expect(res).toBeNull();
  });
});
