import { describe, it, expect } from 'vitest';
import {
  ARSANTE_KEY,
  ARSANTE_COMPANY_NAME,
  isArsanteJob,
  isTrustedDomain,
  extractDetailBody,
} from '../scripts/lib/arsante-clinique-de-carouge-job-parser.mjs';

describe('Arsanté (Clinique de Carouge) crawler parser', () => {
  it('exports valid company key and name', () => {
    expect(ARSANTE_KEY).toBe('arsante-clinique-de-carouge');
    expect(ARSANTE_COMPANY_NAME).toBe('Arsanté (Clinique de Carouge)');
  });

  describe('isArsanteJob', () => {
    it('matches by companyKey', () => {
      expect(isArsanteJob({ companyKey: 'arsante-clinique-de-carouge' })).toBe(true);
    });

    it('matches by URL domain (both mirrors)', () => {
      expect(isArsanteJob({ url: 'https://arsante.ch/emploi/infirmier-123' })).toBe(true);
      expect(isArsanteJob({ url: 'https://www.cliniquedecarouge.ch/emploi/infirmier-123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isArsanteJob({ companyKey: 'other', url: 'https://other.com/jobs' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts both domains and their subdomains', () => {
      expect(isTrustedDomain('https://arsante.ch/emploi/123')).toBe(true);
      expect(isTrustedDomain('https://www.cliniquedecarouge.ch/emploi/123')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/emploi')).toBe(false);
    });
  });

  describe('extractDetailBody', () => {
    it('does not truncate at the first nested </div></div> (regression: WYSIWYG wrapper div closing early)', () => {
      const html = `
        <div itemscope itemtype="https://schema.org/JobPosting">
          <div itemprop="description">
            <div>
              <div><p>Premier paragraphe avec des détails importants.</p></div>
            </div>
            <div><p>Deuxième paragraphe qui serait tronqué par un regex non-greedy naïf.</p></div>
            <div><p>Troisième paragraphe, le vrai contenu se termine ici.</p></div>
          </div>
        </div>
      `;
      const body = extractDetailBody(html);
      expect(body).toContain('Premier paragraphe');
      expect(body).toContain('Deuxième paragraphe');
      expect(body).toContain('Troisième paragraphe, le vrai contenu se termine ici');
    });

    it('falls back to <main> when no JobPosting microdata is present', () => {
      const html = '<main><p>Contenu de secours.</p></main>';
      expect(extractDetailBody(html)).toContain('Contenu de secours');
    });

    it('returns empty string when neither microdata nor <main> is found', () => {
      expect(extractDetailBody('<div>no structured content</div>')).toBe('');
    });
  });
});
