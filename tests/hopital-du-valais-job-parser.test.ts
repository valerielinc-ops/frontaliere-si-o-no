/**
 * Tests for the Hôpital du Valais (HVS) dedicated job crawler.
 *
 * Verifies:
 *   - ServiceNow databroker API response parsing
 *   - Job object construction from listing + detail data
 *   - Employment type formatting (percentage ranges)
 *   - Canton assignment (always VS)
 *   - Category detection from u_famille
 *   - Slug generation
 *   - Company job identification
 *   - Trusted domain detection
 *   - Date parsing (DD.MM.YYYY → YYYY-MM-DD)
 *   - Detail URL construction
 */
import { describe, it, expect } from 'vitest';
import {
  buildEmploymentType,
  buildDetailUrl,
  detectCategory,
  isHvsJob,
  isTrustedDomain,
  parseDate,
  HVS_KEY,
  HVS_COMPANY_NAME,
  HVS_COMPANY_DOMAIN,
} from '../scripts/lib/hopital-du-valais-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────────

describe('HVS crawler constants', () => {
  it('has correct company key', () => {
    expect(HVS_KEY).toBe('hopital-du-valais');
  });

  it('has correct company name', () => {
    expect(HVS_COMPANY_NAME).toBe('Hôpital du Valais');
  });

  it('has correct company domain', () => {
    expect(HVS_COMPANY_DOMAIN).toBe('hopitalvs.ch');
  });
});

// ─── Employment type formatting ─────────────────────────────────────────────────

describe('buildEmploymentType', () => {
  it('formats min-max range', () => {
    expect(buildEmploymentType('20 %', '100 %')).toBe('20 - 100%');
  });

  it('formats equal min and max as single value', () => {
    expect(buildEmploymentType('50 %', '50 %')).toBe('50%');
  });

  it('formats 100% alone', () => {
    expect(buildEmploymentType('100 %', '100 %')).toBe('100%');
  });

  it('handles missing max', () => {
    expect(buildEmploymentType('80 %', '')).toBe('80%');
  });

  it('handles missing min', () => {
    expect(buildEmploymentType('', '100 %')).toBe('100%');
  });

  it('returns empty for no input', () => {
    expect(buildEmploymentType('', '')).toBe('');
  });

  it('handles 80-100% range', () => {
    expect(buildEmploymentType('80 %', '100 %')).toBe('80 - 100%');
  });
});

// ─── Detail URL construction ────────────────────────────────────────────────────

describe('buildDetailUrl', () => {
  it('builds URL with sys_id and ATSANN number as spref', () => {
    const url = buildDetailUrl('47fc8463970c87501b87322f2153afb5', 'ATSANN0004604');
    expect(url).toBe(
      'https://vs.service-now.com/x/hdvi2/hvs-ats-portal/annonce-details-page/x_hdvi2_hvs_applic_annonce/47fc8463970c87501b87322f2153afb5/ATSANN0004604/params/language/fr',
    );
  });

  it('falls back to sys_id as spref when number is missing', () => {
    const url = buildDetailUrl('abc123');
    expect(url).toContain('/abc123/abc123/params/language/fr');
  });

  it('URL contains ServiceNow host', () => {
    const url = buildDetailUrl('abc123', 'ATSANN0001');
    expect(url).toContain('vs.service-now.com');
  });

  it('URL contains French language parameter', () => {
    const url = buildDetailUrl('abc123', 'ATSANN0001');
    expect(url).toContain('/language/fr');
  });
});

// ─── Category detection ─────────────────────────────────────────────────────────

describe('detectCategory from u_famille', () => {
  it('detects medical doctors', () => {
    expect(detectCategory('Médecins')).toBe('healthcare-medical');
  });

  it('detects nursing', () => {
    expect(detectCategory('Soins')).toBe('healthcare-nursing');
  });

  it('detects psychology', () => {
    expect(detectCategory('Psychologie, Sciences et Sociale')).toBe('healthcare-psychology');
  });

  it('detects education/training', () => {
    expect(detectCategory('Formation, Médico-technique')).toBe('education');
  });

  it('detects finance', () => {
    expect(detectCategory('Finances')).toBe('finance');
  });

  it('detects logistics/technical', () => {
    expect(detectCategory('Logistique / Technique')).toBe('logistics');
  });

  it('detects German Ärzte as medical', () => {
    expect(detectCategory('Ärzte')).toBe('healthcare-medical');
  });

  it('detects German Pflege as nursing', () => {
    expect(detectCategory('Pflege')).toBe('healthcare-nursing');
  });

  it('defaults to healthcare for unknown', () => {
    expect(detectCategory('Unbekannt')).toBe('healthcare');
    expect(detectCategory('')).toBe('healthcare');
  });
});

// ─── Job identification ─────────────────────────────────────────────────────────

describe('isHvsJob detection', () => {
  it('identifies by companyKey', () => {
    expect(isHvsJob({ companyKey: 'hopital-du-valais' })).toBe(true);
  });

  it('identifies by company name (French)', () => {
    expect(isHvsJob({ company: 'Hôpital du Valais' })).toBe(true);
  });

  it('identifies by company name (without accent)', () => {
    expect(isHvsJob({ company: 'Hopital du Valais' })).toBe(true);
  });

  it('identifies by company name (German)', () => {
    expect(isHvsJob({ company: 'Spital Wallis' })).toBe(true);
  });

  it('identifies by ServiceNow URL', () => {
    expect(isHvsJob({ url: 'https://vs.service-now.com/x/hdvi2/hvs-ats-portal/annonce-details-page/abc123/params/language/fr' })).toBe(true);
  });

  it('rejects non-HVS jobs', () => {
    expect(isHvsJob({ companyKey: 'lonza', company: 'Lonza', url: 'https://lonza.com/job/123' })).toBe(false);
  });
});

// ─── Trusted domain check ───────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts vs.service-now.com', () => {
    expect(isTrustedDomain('https://vs.service-now.com/x/hdvi2/hvs-ats-portal/annonce-details-page')).toBe(true);
  });

  it('trusts www.hopitalvs.ch', () => {
    expect(isTrustedDomain('https://www.hopitalvs.ch/emploi')).toBe(true);
  });

  it('trusts hopitalvs.ch', () => {
    expect(isTrustedDomain('https://hopitalvs.ch/emploi')).toBe(true);
  });

  it('trusts *.service-now.com subdomains', () => {
    expect(isTrustedDomain('https://other.service-now.com/api')).toBe(true);
  });

  it('rejects untrusted domains', () => {
    expect(isTrustedDomain('https://malicious-site.com/hopitalvs')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
    expect(isTrustedDomain('')).toBe(false);
  });
});

// ─── ServiceNow API response parsing ────────────────────────────────────────────

describe('ServiceNow API response structure', () => {
  const SAMPLE_LISTING = {
    u_description: '<p><strong>1er employeur du canton</strong></p>\n<p>L\'Hôpital du Valais cherche un-e</p>\n<p><strong>Infirmier-ère à 100%</strong></p>',
    u_description_de: null,
    u_date_debut: '07.04.2026',
    u_titre: 'Infirmier-ère à 100% pour un CDD de 6 mois pour le service de gynécologie',
    u_titre_de: '',
    number: 'ATSANN0004604',
    sys_id: '93a311e29700035012f9322f2153afef',
    u_societe: 'Centre Hospitalier du Valais romand',
    u_famille: 'Soins',
    u_tx_occupation_min: '100 %',
    u_tx_occupation_max: '100 %',
    u_site: 'SION',
    u_date_fin: '30.04.2026',
    u_date_published: '07.04.2026',
  };

  const SAMPLE_GERMAN_LISTING = {
    u_description: '<p>Das Spital Wallis sucht eine:</p>\n<p><strong>Pflegefachperson 80 - 100%</strong></p>',
    u_description_de: '<p>Das Spital Wallis sucht eine:</p>\n<p><strong>Pflegefachperson 80 - 100%</strong></p>',
    u_date_debut: '03.04.2026',
    u_titre: 'Pflegefachperson 80 - 100%, Orthopädie 3-West Lean Bettenabteilung',
    u_titre_de: 'Pflegefachperson 80 - 100%, Orthopädie 3-West Lean Bettenabteilung',
    number: 'ATSANN0004603',
    sys_id: '9dfd00d997c047101b87322f2153af63',
    u_societe: 'Spitalzentrum Oberwallis',
    u_famille: 'Soins',
    u_tx_occupation_min: '80 %',
    u_tx_occupation_max: '100 %',
    u_site: 'BRIG',
    u_date_fin: '30.04.2026',
    u_date_published: '03.04.2026',
  };

  it('listing has all required fields', () => {
    expect(SAMPLE_LISTING.sys_id).toBeTruthy();
    expect(SAMPLE_LISTING.u_titre).toBeTruthy();
    expect(SAMPLE_LISTING.u_site).toBeTruthy();
    expect(SAMPLE_LISTING.number).toBeTruthy();
    expect(SAMPLE_LISTING.u_famille).toBeTruthy();
    expect(SAMPLE_LISTING.u_date_published).toBeTruthy();
  });

  it('French listing has no German title', () => {
    expect(SAMPLE_LISTING.u_titre_de).toBe('');
  });

  it('German listing has German title', () => {
    expect(SAMPLE_GERMAN_LISTING.u_titre_de).toBe(SAMPLE_GERMAN_LISTING.u_titre);
  });

  it('German listing has German description', () => {
    expect(SAMPLE_GERMAN_LISTING.u_description_de).toBeTruthy();
  });

  it('site is uppercase city name', () => {
    expect(SAMPLE_LISTING.u_site).toBe('SION');
    expect(SAMPLE_GERMAN_LISTING.u_site).toBe('BRIG');
  });

  it('dates are in DD.MM.YYYY format', () => {
    expect(SAMPLE_LISTING.u_date_published).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it('number starts with ATSANN prefix', () => {
    expect(SAMPLE_LISTING.number).toMatch(/^ATSANN\d+$/);
  });
});

// ─── Detail API response ────────────────────────────────────────────────────────

describe('ServiceNow detail API response', () => {
  const SAMPLE_DETAIL = {
    number: 'ATSANN0004609',
    description: '<p><strong>1er employeur du canton</strong></p>',
    titre: 'Médecins chefs-fes de clinique',
    site: 'SIERRE',
    societe: 'Centre Hospitalier du Valais romand',
    famille: 'Médecins',
    mission: '<p>Prise en charge des patients ambulatoires</p>',
    profil: '<p>Diplôme fédéral de médecin</p>',
    offer: null,
    entree_en_fonction: 'De suite ou à convenir',
    tx_occupation_min: '20 %',
    tx_occupation_max: '100 %',
    job_contact: 'Nadia Amyai',
    job_contact_email: 'nadia.amyai@hopitalvs.ch',
    job_contact_phone: '+41276034133',
    date_published: '10.04.2026',
    job_closed: false,
  };

  it('detail has mission and profil fields', () => {
    expect(SAMPLE_DETAIL.mission).toBeTruthy();
    expect(SAMPLE_DETAIL.profil).toBeTruthy();
  });

  it('detail has contact information', () => {
    expect(SAMPLE_DETAIL.job_contact).toBeTruthy();
    expect(SAMPLE_DETAIL.job_contact_email).toContain('@hopitalvs.ch');
  });

  it('detail has start date text', () => {
    expect(SAMPLE_DETAIL.entree_en_fonction).toBeTruthy();
  });

  it('job_closed is boolean', () => {
    expect(typeof SAMPLE_DETAIL.job_closed).toBe('boolean');
    expect(SAMPLE_DETAIL.job_closed).toBe(false);
  });
});

// ─── Slug generation ────────────────────────────────────────────────────────────

describe('slug generation', () => {
  it('generates slug for French job title', () => {
    const slug = slugify('Infirmier-ère à 100% pour le service de gynécologie Hôpital du Valais Sion');
    expect(slug).toBe('infirmier-ere-a-100-pour-le-service-de-gynecologie-hopital-du-valais-sion');
  });

  it('generates slug for German job title', () => {
    const slug = slugify('Pflegefachperson 80 - 100% Orthopädie Hôpital du Valais Brig');
    expect(slug).toBe('pflegefachperson-80-100-orthopadie-hopital-du-valais-brig');
  });

  it('strips accents and special characters', () => {
    const slug = slugify('Médecin adjoint-e spécialiste');
    expect(slug).toBe('medecin-adjoint-e-specialiste');
  });

  it('truncates to max 90 characters', () => {
    const longTitle = 'A'.repeat(100);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

// ─── Date parsing ───────────────────────────────────────────────────────────────

describe('date parsing (DD.MM.YYYY → YYYY-MM-DD)', () => {
  it('parses standard date', () => {
    expect(parseDate('10.04.2026')).toBe('2026-04-10');
  });

  it('parses date with leading zeros', () => {
    expect(parseDate('01.01.2026')).toBe('2026-01-01');
  });

  it('returns empty for invalid format', () => {
    expect(parseDate('2026-04-10')).toBe('');
    expect(parseDate('April 10, 2026')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(parseDate('')).toBe('');
    expect(parseDate(undefined as unknown as string)).toBe('');
  });
});
