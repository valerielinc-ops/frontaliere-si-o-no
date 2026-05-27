/**
 * Casale SA — Recruitee API parser tests
 */
import { describe, it, expect } from 'vitest';

import {
  parseApiResponse,
  buildJobFromApi,
  combineDescriptionSections,
  isCasaleSwissOffer,
  isGenericOffer,
  htmlToMarkdown,
  parseListingPage,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/casale-job-parser.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_API_RESPONSE = {
  offers: [
    {
      id: 101,
      slug: 'senior-process-engineer-1',
      title: 'Senior Process Engineer',
      description: '<p>Casale SA is hiring a Senior Process Engineer for our Lugano headquarters. You will work on ammonia and methanol synthesis processes, designing innovative solutions for the fertilizer industry.</p><p><strong>Key responsibilities:</strong></p><ul><li>Process simulation and optimization using Aspen Plus and HYSYS.</li><li>Support project engineering with mass and energy balances.</li><li>Review P&IDs and technical specifications.</li><li>Participate in HAZOP studies and risk assessments.</li></ul>',
      requirements: '<p><strong>Requirements:</strong></p><ul><li>MSc in Chemical Engineering.</li><li>5+ years experience in process design.</li><li>Proficiency in process simulation tools.</li></ul>',
      country_code: 'CH',
      locations: [{ city: 'Lugano', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'fulltime_permanent',
      department: 'Engineering',
      published_at: '2026-03-10T10:00:00Z',
      remote: false,
      hybrid: false,
      careers_apply_url: 'https://recruit.casale.ch/o/senior-process-engineer-1/c/new',
    },
    {
      id: 102,
      slug: 'apprenticeship-laboratory-technician',
      title: 'Apprenticeship - Laboratory Technician in Chemistry AFC',
      description: '<p>Casale SA offers an apprenticeship position for a Laboratory Technician in Chemistry (AFC) at our Lugano site.</p>',
      country_code: 'CH',
      locations: [{ city: 'Lugano', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'internship',
      department: 'R&D',
      published_at: '2026-03-05T08:00:00Z',
      remote: false,
      hybrid: false,
    },
    {
      id: 103,
      slug: 'mechanical-engineer-india',
      title: 'Mechanical Engineer',
      description: '<p>Mechanical Engineer position in Mumbai office.</p>',
      country_code: 'IN',
      locations: [{ city: 'Mumbai', state: 'Maharashtra', country: 'India', country_code: 'IN' }],
      employment_type_code: 'fulltime_permanent',
      department: 'Engineering',
      published_at: '2026-03-08T10:00:00Z',
      remote: false,
      hybrid: false,
    },
    {
      id: 104,
      slug: 'work-with-us',
      title: 'Work with us',
      description: '<p>Join our team at Casale SA.</p>',
      country_code: 'CH',
      locations: [{ city: 'Lugano', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'fulltime_permanent',
      department: '',
      published_at: '2026-01-01T00:00:00Z',
      remote: false,
      hybrid: false,
    },
    {
      id: 105,
      slug: 'candidatura-spontanea',
      title: 'Candidatura spontanea',
      description: '<p>Inviaci la tua candidatura spontanea.</p>',
      country_code: 'CH',
      locations: [{ city: 'Lugano', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'fulltime_permanent',
      department: '',
      published_at: '2026-01-01T00:00:00Z',
      remote: false,
      hybrid: false,
    },
  ],
};

const FIXTURE_LISTING_HTML = `
<!DOCTYPE html>
<html>
<body>
  <div class="job-list">
    <a href="/o/senior-process-engineer-1">Senior Process Engineer</a>
    <a href="/o/apprenticeship-laboratory-technician">Apprenticeship - Laboratory Technician in Chemistry AFC</a>
    <a href="/o/electrical-engineer-2">Electrical Engineer</a>
    <a href="/o/junior-technical-visual-designer">Junior Technical Visual Designer</a>
    <a href="/o/proposal-manager">Proposal Manager</a>
  </div>
</body>
</html>
`;

// ─── parseApiResponse tests ─────────────────────────────────────────────────

describe('parseApiResponse', () => {
  it('filters to Swiss offers only and excludes generic offers', () => {
    const swiss = parseApiResponse(FIXTURE_API_RESPONSE);
    // 5 total: 2 Swiss real jobs, 1 Indian (filtered), 2 Swiss generic (filtered)
    expect(swiss).toHaveLength(2);
    expect(swiss.every(o => o.locations?.[0]?.country_code === 'CH')).toBe(true);
    // Verify generic offers are excluded
    expect(swiss.find(o => o.title === 'Work with us')).toBeUndefined();
    expect(swiss.find(o => o.title === 'Candidatura spontanea')).toBeUndefined();
  });

  it('returns empty for empty input', () => {
    expect(parseApiResponse({})).toHaveLength(0);
  });
});

// ─── isCasaleSwissOffer tests ───────────────────────────────────────────────

describe('isCasaleSwissOffer', () => {
  it('accepts CH country_code', () => {
    expect(isCasaleSwissOffer({ country_code: 'CH' })).toBe(true);
  });

  it('accepts location with Switzerland', () => {
    expect(isCasaleSwissOffer({ location: 'Lugano, Switzerland' })).toBe(true);
  });

  it('rejects Indian offer', () => {
    expect(isCasaleSwissOffer(FIXTURE_API_RESPONSE.offers[2])).toBe(false);
  });
});

// ─── buildJobFromApi tests ──────────────────────────────────────────────────

describe('buildJobFromApi', () => {
  it('builds a job with correct title', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.title).toBe('Senior Process Engineer');
  });

  it('builds correct location', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.city).toBe('Lugano');
    expect(job.location).toContain('Lugano');
  });

  it('builds correct detail URL', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.detailUrl).toContain('recruit.casale.ch');
    expect(job.detailUrl).toContain('senior-process-engineer');
  });

  it('extracts date posted', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.datePosted).toBe('2026-03-10');
  });

  it('sets INTERNSHIP employment type for apprenticeship', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[1]);
    expect(job.employmentType).toBe('INTERNSHIP');
  });
});

// ─── combineDescriptionSections tests ───────────────────────────────────────

describe('combineDescriptionSections', () => {
  it('combines description and requirements', () => {
    const combined = combineDescriptionSections(FIXTURE_API_RESPONSE.offers[0]);
    expect(combined).toContain('Senior Process Engineer');
    expect(combined).toContain('MSc in Chemical Engineering');
  });

  it('returns empty for empty offer', () => {
    expect(combineDescriptionSections({})).toBe('');
  });
});

// ─── parseListingPage tests ─────────────────────────────────────────────────

describe('parseListingPage', () => {
  it('finds five jobs from HTML listing', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_HTML);
    expect(jobs).toHaveLength(5);
  });

  it('extracts correct slugs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_HTML);
    expect(jobs[0].slug).toBe('senior-process-engineer-1');
  });

  it('returns empty for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
  });
});

// ─── isGenericOffer tests ────────────────────────────────────────────────────

describe('isGenericOffer', () => {
  it('detects "Work with us" as generic', () => {
    expect(isGenericOffer({ title: 'Work with us' })).toBe(true);
  });

  it('detects "WORK WITH US" (case-insensitive) as generic', () => {
    expect(isGenericOffer({ title: 'WORK WITH US' })).toBe(true);
  });

  it('detects "Spontaneous application" as generic', () => {
    expect(isGenericOffer({ title: 'Spontaneous application' })).toBe(true);
  });

  it('detects "Open application" as generic', () => {
    expect(isGenericOffer({ title: 'Open application' })).toBe(true);
  });

  it('detects "Candidatura spontanea" as generic', () => {
    expect(isGenericOffer({ title: 'Candidatura spontanea' })).toBe(true);
  });

  it('detects "Candidature spontanee" as generic', () => {
    expect(isGenericOffer({ title: 'Candidature spontanee' })).toBe(true);
  });

  it('detects "Postuler spontanément" as generic', () => {
    expect(isGenericOffer({ title: 'Postuler spontanément' })).toBe(true);
  });

  it('detects "Initiativbewerbung" as generic', () => {
    expect(isGenericOffer({ title: 'Initiativbewerbung' })).toBe(true);
  });

  it('detects "Offene Bewerbung" as generic', () => {
    expect(isGenericOffer({ title: 'Offene Bewerbung' })).toBe(true);
  });

  it('rejects titles shorter than 5 chars', () => {
    expect(isGenericOffer({ title: 'Job' })).toBe(true);
    expect(isGenericOffer({ title: '' })).toBe(true);
  });

  it('accepts real job titles', () => {
    expect(isGenericOffer({ title: 'Senior Process Engineer' })).toBe(false);
    expect(isGenericOffer({ title: 'Mechanical Engineer' })).toBe(false);
    expect(isGenericOffer({ title: 'Apprenticeship - Laboratory Technician in Chemistry AFC' })).toBe(false);
  });

  it('detects "Work with us!" with trailing punctuation', () => {
    expect(isGenericOffer({ title: 'Work with us!' })).toBe(true);
    expect(isGenericOffer({ title: 'Work With Us.' })).toBe(true);
  });

  it('detects suffixed placeholders like "Candidatura Spontanea - Neolaureati"', () => {
    expect(isGenericOffer({ title: 'Candidatura Spontanea - Neolaureati' })).toBe(true);
    expect(isGenericOffer({ title: 'Spontaneous Application - New Graduates' })).toBe(true);
  });

  it('falls back to slug for pipeline postings without matching title', () => {
    expect(isGenericOffer({ title: 'Neolaureati 2026', slug: 'candidatura-spontanea-neolaureati' })).toBe(true);
    expect(isGenericOffer({ title: 'Talent Pool', slug: 'talent-pool-engineering' })).toBe(true);
  });

  it('does not flag real jobs by slug', () => {
    expect(isGenericOffer({ title: 'Senior Process Engineer', slug: 'senior-process-engineer-1' })).toBe(false);
  });
});

// ─── htmlToMarkdown tests ───────────────────────────────────────────────────

describe('htmlToMarkdown', () => {
  it('converts headings to ## markdown', () => {
    const md = htmlToMarkdown('<h2>Requirements</h2>');
    expect(md).toContain('## Requirements');
  });

  it('converts h1 and h3 to ## markdown', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toContain('## Title');
    expect(htmlToMarkdown('<h3>Section</h3>')).toContain('## Section');
  });

  it('converts list items to - bullets', () => {
    const md = htmlToMarkdown('<ul><li>First item</li><li>Second item</li></ul>');
    expect(md).toContain('- First item');
    expect(md).toContain('- Second item');
  });

  it('converts bold/strong to **text**', () => {
    const md = htmlToMarkdown('<p><strong>Key responsibilities:</strong></p>');
    expect(md).toContain('**Key responsibilities:**');
  });

  it('converts <b> to **text**', () => {
    const md = htmlToMarkdown('<p><b>Important</b> note</p>');
    expect(md).toContain('**Important**');
  });

  it('preserves paragraphs as double newlines', () => {
    const md = htmlToMarkdown('<p>First paragraph.</p><p>Second paragraph.</p>');
    expect(md).toContain('First paragraph.');
    expect(md).toContain('Second paragraph.');
    // There should be separation between paragraphs
    expect(md).toMatch(/First paragraph\.\n\n.*Second paragraph\./s);
  });

  it('converts <br> to newline', () => {
    const md = htmlToMarkdown('Line one<br/>Line two');
    expect(md).toContain('Line one\nLine two');
  });

  it('decodes HTML entities', () => {
    const md = htmlToMarkdown('<p>Tom &amp; Jerry &lt;3&gt; &quot;friends&quot; &#39;forever&#39;</p>');
    expect(md).toContain('Tom & Jerry');
    expect(md).toContain('<3>');
    expect(md).toContain('"friends"');
    expect(md).toContain("'forever'");
  });

  it('handles &nbsp; entity', () => {
    const md = htmlToMarkdown('<p>word&nbsp;word</p>');
    expect(md).toContain('word word');
  });

  it('returns empty string for empty/null input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown(null as any)).toBe('');
    expect(htmlToMarkdown(undefined as any)).toBe('');
  });

  it('removes script and style tags', () => {
    const md = htmlToMarkdown('<p>Real content</p><script>alert("x")</script><style>.x{}</style>');
    expect(md).toContain('Real content');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('.x{}');
  });

  it('normalizes excessive whitespace', () => {
    const md = htmlToMarkdown('<p>Text</p>\n\n\n\n\n<p>More text</p>');
    // Should not have more than 2 consecutive newlines
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('produces structured output from realistic Recruitee HTML', () => {
    const html = FIXTURE_API_RESPONSE.offers[0].description +
      '\n' + FIXTURE_API_RESPONSE.offers[0].requirements;
    const md = htmlToMarkdown(html);
    // Should have bullet points
    expect(md).toContain('- Process simulation');
    expect(md).toContain('- MSc in Chemical Engineering.');
    // Should have bold text
    expect(md).toContain('**Key responsibilities:**');
    expect(md).toContain('**Requirements:**');
    // Should have real content
    expect(md.length).toBeGreaterThan(200);
  });
});

// ─── buildJobFromApi description quality tests ──────────────────────────────

describe('buildJobFromApi description quality', () => {
  it('produces markdown description with structure preserved', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    // Should contain markdown bullets
    expect(job.description).toContain('- Process simulation');
    // Should contain bold text
    expect(job.description).toContain('**Key responsibilities:**');
  });

  it('preserves list items from requirements section', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.description).toContain('- MSc in Chemical Engineering.');
    expect(job.description).toContain('- 5+ years experience');
  });
});

// ─── Utility tests ──────────────────────────────────────────────────────────

describe('detectCategory', () => {
  it('detects engineering for Process Engineer', () => {
    expect(detectCategory('Senior Process Engineer')).toBe('engineering');
  });

  it('detects internship for Apprenticeship', () => {
    expect(detectCategory('Apprenticeship - Laboratory Technician')).toBe('internship');
  });

  it('detects sales for Proposal Manager', () => {
    expect(detectCategory('Proposal Manager')).toBe('sales');
  });
});

describe('detectExperienceLevel', () => {
  it('detects SENIOR for Senior Process Engineer', () => {
    expect(detectExperienceLevel('Senior Process Engineer')).toBe('SENIOR');
  });

  it('detects ENTRY for Apprenticeship', () => {
    expect(detectExperienceLevel('Apprenticeship - Laboratory Technician')).toBe('ENTRY');
  });

  it('detects MID for Electrical Engineer', () => {
    expect(detectExperienceLevel('Electrical Engineer')).toBe('MID');
  });
});
