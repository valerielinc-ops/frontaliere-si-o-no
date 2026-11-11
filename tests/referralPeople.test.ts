import { describe, expect, it } from 'vitest';
import { getLinkedInPeopleSearchUrl, referralPeopleUrl } from '../services/referralPeople';

describe('getLinkedInPeopleSearchUrl', () => {
  it('genera il link diretto al tab people pulendo i parametri di tracciamento', () => {
    const input = 'https://www.linkedin.com/company/rolex/?trk=public_jobs';
    const result = getLinkedInPeopleSearchUrl('Rolex SA', input);
    expect(result).toBe('https://www.linkedin.com/company/rolex/people/');
  });

  it('gestisce correttamente le entità accademiche / scuole (/school/)', () => {
    const input = 'http://ch.linkedin.com/school/eth-zurich/people/';
    const result = getLinkedInPeopleSearchUrl('ETH Zurich', input);
    expect(result).toBe('https://www.linkedin.com/school/eth-zurich/people/');
  });

  it('esegue il fallback a keyword search se il link aziendale è assente', () => {
    const result = getLinkedInPeopleSearchUrl('Banca Stato Ticino');
    expect(result).toBe('https://www.linkedin.com/search/results/people/?keywords=Banca+Stato+Ticino');
  });

  it('esegue il fallback a keyword search su tentativi di phishing o domini non validi', () => {
    const phishingUrl = 'https://linkedin.com.attacker.com/company/rolex';
    const result = getLinkedInPeopleSearchUrl('Rolex', phishingUrl);
    expect(result).toBe('https://www.linkedin.com/search/results/people/?keywords=Rolex');
  });

  it('protegge da injection malevole javascript:', () => {
    const xss = 'javascript:alert(document.cookie)';
    const result = getLinkedInPeopleSearchUrl('Acme Corp', xss);
    expect(result).toBe('https://www.linkedin.com/search/results/people/?keywords=Acme+Corp');
  });

  it('restituisce null quando il nome azienda è vuoto o composto solo da spazi', () => {
    expect(getLinkedInPeopleSearchUrl('')).toBeNull();
    expect(getLinkedInPeopleSearchUrl('   ')).toBeNull();
    expect(getLinkedInPeopleSearchUrl('   ', 'https://www.linkedin.com/company/foo')).toBeNull();
  });

  it('mantiene la parità con referralPeopleUrl (Freehire alias)', () => {
    expect(referralPeopleUrl('Rolex', 'https://www.linkedin.com/company/rolex/')).toBe(
      'https://www.linkedin.com/company/rolex/people/'
    );
  });

  it('JobDetailLinkedInPeopleButton restituisce null per company vuota', async () => {
    const { JobDetailLinkedInPeopleButton } = await import('../components/community/JobDetailPresentation');
    const element = JobDetailLinkedInPeopleButton({ companyName: '' });
    expect(element).toBeNull();
  });
});
