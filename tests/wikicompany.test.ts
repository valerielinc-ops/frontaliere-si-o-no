import { describe, expect, it } from 'vitest';
import {
  buildWikidataCompanySparql,
  parseWikidataCompanyResult,
  queryWikidataCompany,
  POSITIVE_ORG_TYPES,
  NEGATIVE_ORG_TYPES
} from '../scripts/lib/wikicompany.mjs';

describe('buildWikidataCompanySparql', () => {
  it('costruisce la query SPARQL includendo gli anchor positivi e negativi', () => {
    const query = buildWikidataCompanySparql('Rolex SA', 'it');
    expect(query).toContain('Rolex SA');
    expect(query).toContain('wd:Q4830453'); // business enterprise
    expect(query).toContain('wd:Q2221906'); // geographic location (negative anchor)
    expect(query).toContain('FILTER NOT EXISTS');
  });

  it('sanitizza le virgolette nel nome azienda per prevenire SPARQL injection', () => {
    const query = buildWikidataCompanySparql('Acme "Super" Corp', 'it');
    expect(query).toContain('Acme \\"Super\\" Corp');
  });
});

describe('parseWikidataCompanyResult', () => {
  it('estrae i metadati aziendali dalla risposta JSON SPARQL', () => {
    const mockSparqlResponse = {
      results: {
        bindings: [
          {
            company: { value: 'http://www.wikidata.org/entity/Q62288' },
            ceoLabel: { value: 'Jean-Frédéric Dufour' },
            employees: { value: '14000' },
            website: { value: 'https://www.rolex.com' },
            linkedin: { value: 'rolex' },
            description: { value: 'produttore svizzero di orologi di lusso' }
          }
        ]
      }
    };

    const parsed = parseWikidataCompanyResult(mockSparqlResponse);
    expect(parsed).toEqual({
      wikidataId: 'Q62288',
      ceo: 'Jean-Frédéric Dufour',
      employees: 14000,
      website: 'https://www.rolex.com',
      linkedInUrl: 'https://www.linkedin.com/company/rolex',
      description: 'produttore svizzero di orologi di lusso'
    });
  });

  it('restituisce null quando non ci sono risultati', () => {
    const emptyResponse = { results: { bindings: [] } };
    expect(parseWikidataCompanyResult(emptyResponse)).toBeNull();
    expect(parseWikidataCompanyResult(null)).toBeNull();
  });
});

describe('queryWikidataCompany', () => {
  it('esegue la richiesta con fetch e user-agent appropriato', async () => {
    const mockFetch = async (url: string, init: any) => {
      expect(init.headers['User-Agent']).toContain('FrontaliereBot');
      return {
        ok: true,
        json: async () => ({
          results: {
            bindings: [
              {
                company: { value: 'http://www.wikidata.org/entity/Q123' },
                ceoLabel: { value: 'Chief Exec' },
                employees: { value: '500' }
              }
            ]
          }
        })
      };
    };

    const res = await queryWikidataCompany('Test Corp', { fetchFn: mockFetch as any });
    expect(res?.wikidataId).toBe('Q123');
    expect(res?.ceo).toBe('Chief Exec');
    expect(res?.employees).toBe(500);
  });
});
