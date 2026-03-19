import { describe, expect, it } from 'vitest';
import {
  isMultiLocation,
  normalizeJobCategory,
  normalizeJobContract,
  resolveCompanyLogoUrl,
  resolveCompanyWebsiteHost,
} from '@/services/jobDataNormalization';

describe('jobDataNormalization', () => {
  it('normalizes noisy category labels into canonical categories', () => {
    expect(normalizeJobCategory('General Services', 'Manutentore Elettromeccanico')).toBe('engineering');
    expect(normalizeJobCategory('general-services', '')).toBe('admin');
    expect(normalizeJobCategory('R&D', 'R&D Software Engineer Robotics')).toBe('tech');
  });

  it('normalizes non-canonical contracts into canonical contracts', () => {
    expect(normalizeJobContract('permanent')).toBe('full-time');
    expect(normalizeJobContract('80%')).toBe('part-time');
    expect(normalizeJobContract('', 'Thesis R&D Orthopedics')).toBe('internship');
  });

  it('resolves Medacta website host even when the job URL is hosted on Allibo', () => {
    const host = resolveCompanyWebsiteHost({
      company: 'Medacta International SA',
      companyKey: 'medacta-international',
      companyDomain: 'joblink.allibo.com',
      url: 'https://joblink.allibo.com/ats3/job-offer.aspx?DM=1818&ID=89446&LN=IT&FT=465&SG=2',
    });

    expect(host).toBe('medacta.com');
  });

  it('returns Medacta official SVG logo override instead of low-quality ATS favicon', () => {
    const logo = resolveCompanyLogoUrl({
      company: 'Medacta International SA',
      companyKey: 'medacta-international',
      companyDomain: 'joblink.allibo.com',
      url: 'https://joblink.allibo.com/ats3/job-offer.aspx?DM=1818&ID=89446&LN=IT&FT=465&SG=2',
    });

    expect(logo).toBe('https://www.medacta.com/images/header/Logo_Medacta.svg');
  });

  it('detects non-geographic multi-location strings', () => {
    expect(isMultiLocation('Schweiz und Ausland (abhängig von Funktion und Einsatzort)')).toBe(true);
    expect(isMultiLocation('Schweiz und Ausland')).toBe(true);
    expect(isMultiLocation('im In- und Ausland')).toBe(true);
    expect(isMultiLocation('Suisse et l\'étranger')).toBe(true);
    expect(isMultiLocation('verschiedene Standorte')).toBe(true);
  });

  it('does not flag concrete city/canton locations as multi-location', () => {
    expect(isMultiLocation('Lugano')).toBe(false);
    expect(isMultiLocation('Bellinzona')).toBe(false);
    expect(isMultiLocation('Chiasso, TI')).toBe(false);
    expect(isMultiLocation('Mendrisio (TI)')).toBe(false);
    expect(isMultiLocation('')).toBe(false);
    expect(isMultiLocation(null)).toBe(false);
    expect(isMultiLocation(undefined)).toBe(false);
  });

  it('returns Wikimedia-based EFG logo override instead of low-quality favicon', () => {
    const logo = resolveCompanyLogoUrl({
      company: 'EFG International AG',
      companyKey: 'efg-international',
      companyDomain: 'efginternational.com',
      url: 'https://www.efginternational.com/careers',
    });

    expect(logo).toBe('/images/logos/efg-international.svg');
  });
});
