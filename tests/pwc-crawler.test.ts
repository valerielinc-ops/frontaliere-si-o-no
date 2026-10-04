/**
 * PwC Switzerland crawler parser tests
 *
 * Tests parsePwcJobs(), inferPwcCategory(), mapPwcEmploymentType(),
 * buildPwcDescription(), inferPwcLocation(), and buildPwcLocalizedContent()
 * using mock API response fixtures.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildPwcJob, fetchAllListings, fetchAllPwcJobs, jobMatchKey } from '../scripts/update-pwc-jobs.mjs';

import {
  parsePwcJobs,
  inferPwcCategory,
  mapPwcEmploymentType,
  buildPwcDescription,
  inferPwcLocation,
  inferPwcPostalCode,
  inferPwcStreetAddress,
  inferPwcCountry,
  stripHtml,
  buildPwcLocalizedContent,
} from '@/scripts/lib/pwc-job-parser.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(total).toBeNull();
  });

  it('handles null input gracefully', () => {
    const { items } = parsePwcJobs(null as any);
    expect(items).toHaveLength(0);
  });
});

describe('PwC source pagination', () => {
  it('fails when a repeated page adds no unique stable records', async () => {
    const listing = {
      id: 101,
      viewkey: 'abc-123-def',
      title: 'Senior Tax Consultant',
      attributes: { '20': ['Lugano'] },
      szas: { sza_location: { city: 'Lugano', country: 'CH' } },
      links: { directlink: 'https://www.pwc.ch/careers/senior-tax-consultant/abc-123-def' },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      total: 2,
      jobs: [listing],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAllListings()).rejects.toThrow(/did not advance/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('PwC source locality filtering', () => {
  const baseRow = {
    id: 201,
    viewkey: 'border-location-201',
    title: 'Consultant',
    description: 'Consulting role in Switzerland',
    city: 'Como',
    directLink: 'https://www.pwc.ch/careers/consultant/border-location-201',
  };

  it('rejects a border-near foreign city when country is absent', () => {
    expect(buildPwcJob(baseRow)).toBeNull();
  });

  it('keeps a known Swiss city when country is absent', () => {
    expect(buildPwcJob({ ...baseRow, city: 'Lugano', directLink: 'https://www.pwc.ch/careers/consultant/lugano-201' })).toMatchObject({
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      addressCountry: 'CH',
    });
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

  it('does not publish a region as a city when the source city is missing', () => {
    expect(inferPwcLocation({ sza_location: { region: 'Ticino' } })).toBe('');
    expect(inferPwcLocation({ 'sza_location.region': 'Bern' })).toBe('');
  });

  it('returns an empty locality when the source has no location data', () => {
    expect(inferPwcLocation({})).toBe('');
    expect(inferPwcLocation(null as any)).toBe('');
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

describe('source address fields', () => {
  it('extracts street and country without inventing an HQ', () => {
    const szas = {
      sza_location: { city: 'Lugano', street: 'Via della Posta 7', zip: '6900', country: 'Switzerland' },
    };
    expect(inferPwcStreetAddress(szas)).toBe('Via della Posta 7');
    expect(inferPwcCountry(szas)).toBe('Switzerland');
  });
});

// ─── buildPwcLocalizedContent ─────────────────────────────────────────────

describe('buildPwcLocalizedContent', () => {
  it('keeps the body in the source-language slot only; titles and slugs stay in all 4 locales (#5253)', () => {
    const content = buildPwcLocalizedContent({ title: 'Tax Advisor', city: 'Lugano', description: 'A tax role in Lugano for an experienced advisor who works with our clients.' });
    expect(content.sourceLang).toBe('en');
    expect(Object.keys(content.titleByLocale)).toEqual(['it', 'en', 'de', 'fr']);
    expect(Object.keys(content.descriptionByLocale)).toEqual(['en']);
    expect(Object.keys(content.slugByLocale)).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('includes company name in slug', () => {
    const content = buildPwcLocalizedContent({ title: 'Tax Advisor', city: 'Lugano' });
    expect(content.slugByLocale.it).toContain('pwc');
    expect(content.slugByLocale.it).toContain('tax-advisor');
    expect(content.slugByLocale.it).toContain('lugano');
  });

  it('uses fallback description when description is empty (Italian text, under it)', () => {
    const content = buildPwcLocalizedContent({ title: 'Analyst', city: 'Bern', description: '' });
    expect(content.sourceLang).toBe('it');
    expect(content.descriptionByLocale.it).toContain('PwC Switzerland');
    expect(content.descriptionByLocale.it).toContain('Analyst');
    expect(content.descriptionByLocale.it).toContain('Bern');
  });

  it('uses provided description when available', () => {
    const content = buildPwcLocalizedContent({ title: 'Analyst', city: 'Bern', description: 'A detailed job description for the role.' });
    expect(content.descriptionByLocale.en).toBe('A detailed job description for the role.');
    expect(content.descriptionByLocale.it).toBeUndefined();
  });
});

// ─── Re-posts per city (bucket 10677, item FU-2026-10-01-019) ─────────────
//
// One PwC vacancy can be tagged with several offices (attribute 20): the run
// publishes one record per city. A vacancy the source re-posts under a new id
// and URL, with the same rendered page at the same office, is one vacancy for
// a seeker: the run drops the copy (`dropRepostedListings`). Across runs the
// merge key `jobMatchKey()` is the UUID of the vacancy URL plus the city, so
// a renamed URL slug updates the stored record instead of adding a new one,
// and the per-city records of one vacancy never merge into each other.

const daysAgoDate = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const PWC_UUID = '3e3dc2f3-629d-4764-a803-82d199746aba';
const PWC_REPOST_UUID = 'f196cf47-50ab-4981-9717-2d5aadfe62ff';
const PWC_URL = `https://jobs.pwc.ch/job-vacancies/senior-tax-consultant/${PWC_UUID}`;
const PWC_REPOST_URL = `https://jobs.pwc.ch/job-vacancies/senior-tax-consultant-1/${PWC_REPOST_UUID}`;

const PWC_INTRO = 'Join our Tax and Legal team in Lugano and advise private and corporate clients on Swiss and international tax matters.';
const PWC_TASKS = ['Advise clients on cross-border tax structures and compliance questions', 'Prepare tax returns, rulings and documentation for our clients'];
const PWC_REQUIREMENTS = ['University degree in law, economics or finance with a focus on taxation', 'Several years of experience in tax consulting and excellent English'];

function pwcListingRow(id: number, viewkey: string, directlink: string, offices: string[]) {
  return {
    id,
    viewkey,
    title: 'Senior Tax Consultant',
    attributes: { '20': offices, '30': ['Tax & Legal'], '40': ['Full-time'] },
    szas: {
      sza_introduction: `<p>${PWC_INTRO}</p>`,
      sza_tasks: `<ul>${PWC_TASKS.map((task) => `<li>${task}</li>`).join('')}</ul>`,
      sza_requirements: `<ul>${PWC_REQUIREMENTS.map((req) => `<li>${req}</li>`).join('')}</ul>`,
      sza_location: { city: 'Lugano', zip: '6900', street: 'Via della Posta 7', country: 'CH' },
    },
    links: { directlink },
    start_date: daysAgoDate(3),
    language: 'en',
  };
}

// The vacancy page the tenant renders: the listing text plus the sections the
// API omits. Both listing ids render the same page.
const PWC_PAGE = `<!doctype html><html><body><main>
  <h1>Senior Tax Consultant</h1>
  <p>${PWC_INTRO}</p>
  <h2>Your tasks</h2><ul>${PWC_TASKS.map((task) => `<li>${task}</li>`).join('')}</ul>
  <h2>Your profile</h2><ul>${PWC_REQUIREMENTS.map((req) => `<li>${req}</li>`).join('')}</ul>
  <h2>Your Team</h2><p>You join a team of twelve tax specialists who work closely with our offices in Zurich and Geneva.</p>
  <h2>Your Benefits</h2><ul><li>Flexible working hours and hybrid work arrangements</li><li>Paid study leave for professional tax qualifications</li></ul>
</main></body></html>`;

describe('PwC re-posts per city (FU-2026-10-01-019)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps one record per office of a multi-city vacancy and drops a re-post of it at the same office', async () => {
    const listing = {
      total: 2,
      jobs: [
        pwcListingRow(101, 'tax-101', PWC_URL, ['Lugano', 'Zürich']),
        pwcListingRow(102, 'tax-102', PWC_REPOST_URL, ['Lugano']),
      ],
    };
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.startsWith('https://ohws.prospective.ch/public/v1/medium/')) {
        return new Response(JSON.stringify(listing), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (href === PWC_URL || href === PWC_REPOST_URL) {
        return new Response(PWC_PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const jobs: any[] = (await fetchAllPwcJobs())!;

    // The re-post (another id and URL, same page, same office) is gone; the
    // Zürich record of the original vacancy stays.
    expect(jobs.map((job) => [job.addressLocality, job.url])).toEqual([
      ['Lugano', PWC_URL],
      ['Zürich', PWC_URL],
    ]);
    // Both records were described by the rendered page, so the drop compared
    // full vacancy texts, not listing text.
    for (const job of jobs) expect(job.description).toContain('twelve tax specialists');
    // The two offices of one vacancy keep two distinct merge keys.
    expect(new Set(jobs.map((job) => jobMatchKey(job))).size).toBe(jobs.length);
    // The shared page is read once per URL.
    expect(fetchMock.mock.calls.filter(([url]) => url === PWC_URL)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === PWC_REPOST_URL)).toHaveLength(1);
  }, 20_000);
});

describe('jobMatchKey (FU-2026-10-01-019)', () => {
  const row = (directLink: string, city: string) => ({
    id: 101,
    viewkey: 'tax-101',
    title: 'Senior Tax Consultant',
    description: `${PWC_INTRO}\n\n${PWC_TASKS.join('\n')}`,
    city: 'Lugano',
    _explodedCity: city,
    postalCode: '6900',
    country: 'CH',
    directLink,
    startDate: daysAgoDate(3),
    language: 'en',
  });

  it('matches the stored record when PwC rewrites the slug of the vacancy URL', () => {
    const stored = buildPwcJob(row(`https://jobs.pwc.ch/job-vacancies/stage-de-audit/${PWC_UUID}`, 'Lugano'))!;
    const renamed = buildPwcJob(row(`https://jobs.pwc.ch/job-vacancies/fy27-asr-audit/${PWC_UUID}`, 'Lugano'))!;

    expect(renamed.url).not.toBe(stored.url);
    expect(jobMatchKey(renamed)).toBe(jobMatchKey(stored));
  });

  it('keeps the per-city records of one vacancy apart', () => {
    const lugano = buildPwcJob(row(PWC_URL, 'Lugano'))!;
    const zurich = buildPwcJob(row(PWC_URL, 'Zürich'))!;

    expect(jobMatchKey(lugano)).not.toBe(jobMatchKey(zurich));
  });

  // Records what jobMatchKey does today, not a requirement: a same-run re-post
  // is dropped by dropRepostedListings; a re-post seen only in a later run is
  // not caught here, and a future fix for that may change this expectation.
  it('does not merge a re-post under a new UUID: the run-level re-post drop handles it', () => {
    const original = buildPwcJob(row(PWC_URL, 'Lugano'))!;
    const repost = buildPwcJob(row(PWC_REPOST_URL, 'Lugano'))!;

    expect(jobMatchKey(repost)).not.toBe(jobMatchKey(original));
  });

  it('falls back to the slug when the URL carries no stable id', () => {
    expect(jobMatchKey({ slug: 'Senior-Tax-Consultant-PwC-Lugano' })).toBe('senior-tax-consultant-pwc-lugano');
  });
});

describe('PwC publication provenance', () => {
  for (const kind of ['unverified-start', 'missing', 'invalid', 'future']) {
    it(`keeps ${kind} startDate separate from publication`, () => {
      const year = new Date().getUTCFullYear() - 1;
      const startDate = kind === 'unverified-start' ? `${year}-06-15T12:00:00+02:00` : kind === 'invalid' ? `${year}-02-30` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : '';
      const job = buildPwcJob({ id: 201, title: 'Consultant', city: 'Lugano', description: 'Consulting responsibilities in Switzerland.', directLink: 'https://www.pwc.ch/careers/consultant/lugano-201', startDate });
      expect(job).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown', addressLocality: 'Lugano' });
      expect(job?.crawledAt).toBeTruthy();
    });
  }
});
