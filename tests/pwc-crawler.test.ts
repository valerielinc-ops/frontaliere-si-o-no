/**
 * PwC Switzerland crawler parser tests
 *
 * Tests parsePwcJobs(), inferPwcCategory(), mapPwcEmploymentType(),
 * buildPwcDescription(), inferPwcLocation(), and buildPwcLocalizedContent()
 * using mock API response fixtures.
 */
import { describe, it, expect } from 'vitest';

import {
  parsePwcJobs,
  inferPwcCategory,
  mapPwcEmploymentType,
  buildPwcDescription,
  inferPwcLocation,
  inferPwcPostalCode,
  stripHtml,
  buildPwcLocalizedContent,
} from '@/scripts/lib/pwc-job-parser.mjs';

// ─── Fixtures: Mock API response ──────────────────────────────────────────

const MOCK_API_RESPONSE = {
  medium_id: 1000311,
  offset: 0,
  total: 3,
  jobs: [
    {
      id: 101,
      viewkey: 'abc-123-def',
      title: 'Senior Tax Consultant',
      attributes: {
        '10': ['5+ years'],
        '20': ['Lugano'],
        '30': ['Tax & Legal'],
        '40': ['Full-time'],
        '50': ['Tax Consulting'],
      },
      szas: {
        sza_introduction: '<p>Join PwC Switzerland as a Senior Tax Consultant.</p>',
        sza_tasks: '<ul><li>Advise clients on Swiss and international tax matters</li><li>Prepare tax returns and compliance documentation</li></ul>',
        sza_requirements: '<ul><li>University degree in law, economics, or finance</li><li>5+ years of experience in tax consulting</li></ul>',
        sza_apply_link: 'https://www.pwc.ch/apply/101',
        sza_location: { city: 'Lugano', zip: '6900', region: 'Ticino', country: 'CH' },
        sza_employment_type: 'Full-time',
        sza_reference_code: 'PWC-TAX-101',
      },
      links: { directlink: 'https://www.pwc.ch/careers/senior-tax-consultant/abc-123-def' },
      start_date: '2026-03-01',
      end_date: '2026-06-01',
      language: 'en',
    },
    {
      id: 102,
      viewkey: 'ghi-456-jkl',
      title: 'Cloud Engineer',
      attributes: {
        '20': ['Zurich'],
        '30': ['Technology'],
        '40': ['Full-time'],
        '50': ['Cloud & Digital'],
      },
      szas: {
        sza_introduction: '<p>We are looking for a Cloud Engineer to join our Digital team.</p>',
        sza_tasks: '<p>Design and implement cloud solutions on AWS and Azure.</p>',
        sza_requirements: '<p>Experience with cloud platforms (AWS, Azure, GCP). Strong DevOps skills.</p>',
        sza_apply_link: 'https://www.pwc.ch/apply/102',
        sza_location: { city: 'Zurich', zip: '8005', region: 'Zurich', country: 'CH' },
        'sza_pensum.max': '100',
        'sza_pensum.min': '80',
      },
      links: { directlink: 'https://www.pwc.ch/careers/cloud-engineer/ghi-456-jkl' },
      start_date: '2026-02-15',
      language: 'en',
    },
    {
      id: 103,
      viewkey: 'mno-789-pqr',
      title: 'Audit Intern',
      attributes: {
        '20': ['Bern'],
        '30': ['Assurance'],
        '40': ['Part-time'],
        '50': ['Audit'],
      },
      szas: {
        sza_introduction: '',
        sza_tasks: '<p>Support audit teams in the execution of financial audits.</p>',
        sza_requirements: '',
        sza_apply_link: '',
        sza_location: { city: 'Bern', zip: '3001', region: 'Bern', country: 'CH' },
        sza_employment_type: 'Part-time',
        'sza_pensum.max': '60',
        'sza_pensum.min': '40',
      },
      links: { directlink: 'https://www.pwc.ch/careers/audit-intern/mno-789-pqr' },
      language: 'de',
    },
  ],
};

// ─── parsePwcJobs ─────────────────────────────────────────────────────────

describe('parsePwcJobs', () => {
  it('parses the correct number of jobs', () => {
    const { items, total } = parsePwcJobs(MOCK_API_RESPONSE);
    expect(items).toHaveLength(3);
    expect(total).toBe(3);
  });

  it('extracts job titles correctly', () => {
    const { items } = parsePwcJobs(MOCK_API_RESPONSE);
    expect(items[0].title).toBe('Senior Tax Consultant');
    expect(items[1].title).toBe('Cloud Engineer');
    expect(items[2].title).toBe('Audit Intern');
  });

  it('extracts viewkey and id', () => {
    const { items } = parsePwcJobs(MOCK_API_RESPONSE);
    expect(items[0].viewkey).toBe('abc-123-def');
    expect(items[0].id).toBe('101');
  });

  it('extracts direct link URLs', () => {
    const { items } = parsePwcJobs(MOCK_API_RESPONSE);
    expect(items[0].directLink).toBe('https://www.pwc.ch/careers/senior-tax-consultant/abc-123-def');
  });

  it('extracts apply URL from szas', () => {
    const { items } = parsePwcJobs(MOCK_API_RESPONSE);
    expect(items[0].applyUrl).toBe('https://www.pwc.ch/apply/101');
  });

  it('extracts city from sza_location', () => {
    const { items } = parsePwcJobs(MOCK_API_RESPONSE);
    expect(items[0].city).toBe('Lugano');
    expect(items[1].city).toBe('Zurich');
  });

  it('extracts postal code from sza_location', () => {
    const { items } = parsePwcJobs(MOCK_API_RESPONSE);
    expect(items[0].postalCode).toBe('6900');
  });

  it('handles empty/missing API response gracefully', () => {
    const { items, total } = parsePwcJobs({});
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('handles null input gracefully', () => {
    const { items } = parsePwcJobs(null as any);
    expect(items).toHaveLength(0);
  });
});

// ─── inferPwcCategory ─────────────────────────────────────────────────────

describe('inferPwcCategory', () => {
  it('returns "audit" for audit roles', () => {
    expect(inferPwcCategory('Audit Manager', 'financial audit')).toBe('audit');
  });

  it('returns "tax" for tax roles', () => {
    expect(inferPwcCategory('Senior Tax Consultant', 'tax advisory')).toBe('tax');
  });

  it('returns "consulting" for advisory roles', () => {
    expect(inferPwcCategory('Strategy Consultant', 'advisory services')).toBe('consulting');
  });

  it('returns "tech" for technology roles', () => {
    expect(inferPwcCategory('Cloud Engineer', 'cloud and DevOps')).toBe('tech');
    expect(inferPwcCategory('Software Developer', 'Python and Java')).toBe('tech');
    expect(inferPwcCategory('Cyber Security Analyst', '')).toBe('tech');
    expect(inferPwcCategory('Data Scientist', 'machine learning')).toBe('tech');
  });

  it('returns "legal" for legal roles', () => {
    expect(inferPwcCategory('Legal Counsel', 'compliance and regulatory')).toBe('legal');
  });

  it('returns "hr" for human resources roles', () => {
    expect(inferPwcCategory('HR Business Partner', 'talent acquisition')).toBe('hr');
  });

  it('returns "finance" for finance roles', () => {
    expect(inferPwcCategory('Financial Controller', 'accounting')).toBe('finance');
  });

  it('returns "admin" for administrative roles', () => {
    expect(inferPwcCategory('Office Assistant', 'administrative support')).toBe('admin');
  });

  it('returns "apprenticeship" for trainee/intern roles', () => {
    expect(inferPwcCategory('Apprentice', 'apprendistato')).toBe('apprenticeship');
    expect(inferPwcCategory('Trainee Program', '')).toBe('apprenticeship');
  });

  it('defaults to "consulting" for unrecognized roles', () => {
    expect(inferPwcCategory('Generic Role', 'some generic description')).toBe('consulting');
  });
});

// ─── mapPwcEmploymentType ─────────────────────────────────────────────────

describe('mapPwcEmploymentType', () => {
  it('returns "full-time" for full-time employment type', () => {
    expect(mapPwcEmploymentType({ sza_employment_type: 'Full-time' })).toBe('full-time');
  });

  it('returns "part-time" for part-time employment type', () => {
    expect(mapPwcEmploymentType({ sza_employment_type: 'Part-time' })).toBe('part-time');
  });

  it('returns "part-time" when pensum max < 100', () => {
    expect(mapPwcEmploymentType({ 'sza_pensum.max': '60' })).toBe('part-time');
  });

  it('returns "full-time" when pensum max is 100', () => {
    expect(mapPwcEmploymentType({ 'sza_pensum.max': '100' })).toBe('full-time');
  });

  it('returns "part-time" when pensum min < 80', () => {
    expect(mapPwcEmploymentType({ 'sza_pensum.min': '40' })).toBe('part-time');
  });

  it('returns "full-time" for empty/missing szas', () => {
    expect(mapPwcEmploymentType({})).toBe('full-time');
    expect(mapPwcEmploymentType(null as any)).toBe('full-time');
  });
});

// ─── buildPwcDescription ──────────────────────────────────────────────────

describe('buildPwcDescription', () => {
  it('combines introduction + tasks + requirements', () => {
    const szas = {
      sza_introduction: '<p>Join our team.</p>',
      sza_tasks: '<ul><li>Task 1</li><li>Task 2</li></ul>',
      sza_requirements: '<p>3+ years experience.</p>',
    };
    const desc = buildPwcDescription(szas);
    expect(desc).toContain('Join our team.');
    expect(desc).toContain('Task 1');
    expect(desc).toContain('Task 2');
    expect(desc).toContain('3+ years experience.');
  });

  it('strips HTML tags from description', () => {
    const szas = {
      sza_introduction: '<p><strong>Bold intro</strong></p>',
      sza_tasks: '<div class="content"><p>Some <em>task</em></p></div>',
      sza_requirements: '',
    };
    const desc = buildPwcDescription(szas);
    expect(desc).not.toContain('<p>');
    expect(desc).not.toContain('<strong>');
    expect(desc).not.toContain('<em>');
    expect(desc).not.toContain('<div');
    expect(desc).toContain('Bold intro');
    expect(desc).toContain('Some task');
  });

  it('handles missing sections gracefully', () => {
    const desc = buildPwcDescription({ sza_tasks: '<p>Only tasks.</p>' });
    expect(desc).toBe('Only tasks.');
  });

  it('returns empty string for empty szas', () => {
    expect(buildPwcDescription({})).toBe('');
    expect(buildPwcDescription(null as any)).toBe('');
  });
});

// ─── stripHtml ────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes all HTML tags', () => {
    expect(stripHtml('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'');
  });

  it('converts <br> to newlines', () => {
    expect(stripHtml('Line 1<br/>Line 2')).toBe('Line 1\nLine 2');
  });

  it('handles empty/null input', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml(null as any)).toBe('');
  });
});

// ─── inferPwcLocation ─────────────────────────────────────────────────────

describe('inferPwcLocation', () => {
  it('extracts city from sza_location object', () => {
    expect(inferPwcLocation({ sza_location: { city: 'Lugano', region: 'Ticino' } })).toBe('Lugano');
  });

  it('falls back to flat sza_location.city key', () => {
    expect(inferPwcLocation({ 'sza_location.city': 'Zurich' })).toBe('Zurich');
  });

  it('falls back to region when city is missing', () => {
    expect(inferPwcLocation({ sza_location: { region: 'Ticino' } })).toBe('Ticino');
  });

  it('falls back to flat sza_location.region key', () => {
    expect(inferPwcLocation({ 'sza_location.region': 'Bern' })).toBe('Bern');
  });

  it('defaults to Switzerland when no location data', () => {
    expect(inferPwcLocation({})).toBe('Switzerland');
    expect(inferPwcLocation(null as any)).toBe('Switzerland');
  });
});

// ─── inferPwcPostalCode ───────────────────────────────────────────────────

describe('inferPwcPostalCode', () => {
  it('extracts zip from sza_location object', () => {
    expect(inferPwcPostalCode({ sza_location: { zip: '6900' } })).toBe('6900');
  });

  it('falls back to flat sza_location.zip key', () => {
    expect(inferPwcPostalCode({ 'sza_location.zip': '8005' })).toBe('8005');
  });

  it('returns empty string when no zip', () => {
    expect(inferPwcPostalCode({})).toBe('');
  });
});

// ─── buildPwcLocalizedContent ─────────────────────────────────────────────

describe('buildPwcLocalizedContent', () => {
  it('creates locale maps for all 4 locales', () => {
    const content = buildPwcLocalizedContent({ title: 'Tax Advisor', city: 'Lugano', description: 'A tax role in Lugano.' });
    expect(Object.keys(content.titleByLocale)).toEqual(['it', 'en', 'de', 'fr']);
    expect(Object.keys(content.descriptionByLocale)).toEqual(['it', 'en', 'de', 'fr']);
    expect(Object.keys(content.slugByLocale)).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('includes company name in slug', () => {
    const content = buildPwcLocalizedContent({ title: 'Tax Advisor', city: 'Lugano' });
    expect(content.slugByLocale.it).toContain('pwc');
    expect(content.slugByLocale.it).toContain('tax-advisor');
    expect(content.slugByLocale.it).toContain('lugano');
  });

  it('uses fallback description when description is empty', () => {
    const content = buildPwcLocalizedContent({ title: 'Analyst', city: 'Bern', description: '' });
    expect(content.descriptionByLocale.it).toContain('PwC Switzerland');
    expect(content.descriptionByLocale.it).toContain('Analyst');
    expect(content.descriptionByLocale.it).toContain('Bern');
  });

  it('uses provided description when available', () => {
    const content = buildPwcLocalizedContent({ title: 'Analyst', city: 'Bern', description: 'A detailed job description for the role.' });
    expect(content.descriptionByLocale.it).toBe('A detailed job description for the role.');
  });
});
