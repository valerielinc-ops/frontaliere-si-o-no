import { describe, expect, it } from 'vitest';
import {
  CRAWLED_COMPANY_LOGOS,
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

  it('returns Boggi official logo override instead of the ATS favicon', () => {
    const logo = resolveCompanyLogoUrl({
      company: 'Boggi Milano',
      companyKey: 'boggi-milano',
      companyDomain: 'recruitee.com',
      url: 'https://boggimilano1.recruitee.com/l/it/o/retail-hr-specialist-2',
    });

    expect(logo).toBe('https://www.boggi.com/on/demandware.static/Sites-Boggi-Site/-/default/dwc9d6c35e/images/global/boggi-logo.svg');
  });

  it('returns Boggi official logo even when the crawler record has no companyKey', () => {
    const logo = resolveCompanyLogoUrl({
      company: 'Boggi Milano',
      companyDomain: 'recruitee.com',
      url: 'https://boggimilano1.recruitee.com/l/it/o/retail-hr-specialist-2',
    });

    expect(logo).toBe('https://www.boggi.com/on/demandware.static/Sites-Boggi-Site/-/default/dwc9d6c35e/images/global/boggi-logo.svg');
  });

  it('returns Convit official logo for Convit jobs instead of careers-page favicon', () => {
    const logo = resolveCompanyLogoUrl({
      company: 'Convit Holding GmbH',
      companyKey: 'convit-holding',
      companyDomain: 'careers-page.com',
      url: 'https://www.careers-page.com/convit-holding-gmbh/job/RY658X6X',
    });

    expect(logo).toBe('https://convit.ch/images/convit-logo.png');
  });

  it('returns Convit official logo even when the crawler record has no companyKey', () => {
    const logo = resolveCompanyLogoUrl({
      company: 'Convit Holding GmbH',
      companyDomain: 'careers-page.com',
      url: 'https://www.careers-page.com/convit-holding-gmbh/job/RY658X6X',
    });

    expect(logo).toBe('https://convit.ch/images/convit-logo.png');
  });

  it('no CRAWLED_COMPANY_LOGOS entry uses gFavicon on a known ATS domain', () => {
    const atsDomains = [
      'myworkdayjobs.com', 'umantis.com', 'zohorecruit.com', 'ncoreplat.com',
      'successfactors.com', 'recruitee.com', 'careers-page.com', 'joblink.allibo.com',
      'service-now.com', 'greenhouse.io', 'lever.co', 'smartrecruiters.com',
      'icims.com', 'jobs.sbb.ch',
    ];
    const gFaviconPrefix = 'https://www.google.com/s2/favicons?domain=';

    for (const [key, url] of Object.entries(CRAWLED_COMPANY_LOGOS)) {
      if (!url.startsWith(gFaviconPrefix)) continue;
      const domain = decodeURIComponent(url.replace(gFaviconPrefix, '').replace('&sz=128', ''));
      for (const ats of atsDomains) {
        expect(domain, `${key} uses gFavicon on ATS domain ${ats}`).not.toContain(ats);
      }
    }
  });

  it('every CRAWLED_COMPANY_LOGOS entry has a non-empty URL', () => {
    for (const [key, url] of Object.entries(CRAWLED_COMPANY_LOGOS)) {
      expect(url, `${key} has empty logo URL`).toBeTruthy();
      expect(typeof url, `${key} logo URL is not a string`).toBe('string');
    }
  });

  it('returns Hôpital du Valais direct logo instead of grey globe', () => {
    const logo = resolveCompanyLogoUrl({
      company: 'Hôpital du Valais',
      companyKey: 'hopital-du-valais',
      companyDomain: 'hopitalvs.ch',
      url: 'https://vs.service-now.com/x/hdvi2/hvs-ats-portal/annonce-details-page',
    });

    expect(logo).not.toContain('google.com/s2/favicons');
    expect(logo).toBeTruthy();
  });
});
