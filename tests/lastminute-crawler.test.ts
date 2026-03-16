/**
 * Tests for the lastminute.com SmartRecruiters parser.
 *
 * Validates HTML-to-markdown conversion, section combination,
 * quality guards, and SR ID extraction.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSmartRecruitersDetail,
  validateLastminuteDescription,
  extractSrIdFromUrl,
} from '@/scripts/lib/lastminute-job-parser.mjs';

/* ── Fixtures: SmartRecruiters API responses ── */

const HEAD_OF_DATA_PLATFORM_API = {
  name: 'Head of Data Platform Engineering ',
  location: {
    city: 'Chiasso',
    region: 'TI',
    country: 'ch',
    remote: false,
    hybrid: true,
  },
  applyUrl: 'https://jobs.smartrecruiters.com/oneclick-ui/company/lastminutecom/publication/1e2bd16f',
  releasedDate: '2026-01-15T10:00:00.000Z',
  jobAd: {
    sections: {
      jobDescription: {
        text: '<p>We are looking for a <strong>Head of Data Platform Engineering</strong> to join our company of around 1,700 people worldwide.</p><p><strong>The job in brief:</strong></p><ul><li>Job Title - Head of Data Platform Engineering</li><li>Working model - hybrid from Switzerland</li><li>Team - you will join the Data Warehouse team within the Data Platform Engineering area inside the Data department.</li><li>Level - Managerial and Tech leading</li><li>Location - Chiasso</li><li>Contract - Permanent full-time (EUR 36 h/week)</li></ul>',
      },
      qualifications: {
        text: '<p><strong>What your impact will be:</strong></p><ul><li>Build and evolve our data platform</li><li>Design and implement our enterprise data infrastructure across cloud and hybrid environments</li><li>Define reference architectures for modern data stacks</li><li>Lead a team of data engineers</li></ul><p><strong>What we are looking for:</strong></p><ul><li>10+ years in data engineering and platform roles</li><li>Strong experience with Spark, Hadoop, Kafka, Airflow</li><li>Deep knowledge of cloud platforms (AWS, GCP, Azure)</li><li>Proven leadership and team management skills</li></ul>',
      },
      companyDescription: {
        text: '<p>At lastminute.com, we live for the holidays. We are the European Travel-Tech leader in Dynamic Holiday Packages.</p>',
      },
      additionalInformation: {
        text: '<p><strong>Perks of working with us:</strong></p><ul><li>An inclusive, friendly, and international environment</li><li>Shorter working week (36h)</li><li>Flexible hybrid working model</li><li>Company share purchase plan</li><li>Learning and development opportunities</li></ul><p>We value diversity and inclusion.</p>',
      },
    },
  },
};

const SOFTWARE_ENGINEER_API = {
  name: 'Software Engineer – ETLs & Microservices',
  location: {
    city: 'Chiasso',
    region: 'TI',
    country: 'ch',
    remote: false,
    hybrid: true,
  },
  applyUrl: 'https://jobs.smartrecruiters.com/oneclick-ui/company/lastminutecom/publication/abc123',
  releasedDate: '2026-02-01T10:00:00.000Z',
  jobAd: {
    sections: {
      jobDescription: {
        text: '<p>We are looking for a <strong>Software Engineer – Microservices &amp; ETLs</strong> to join our team of around 1,700 people worldwide.</p><p>If you are passionate about building robust backend systems, keep reading.</p>',
      },
      qualifications: {
        text: '<p><strong>Your expertise:</strong></p><ul><li>1+ years of experience in software development</li><li>Hands-on experience using an OO/FP language — preferably Java or Kotlin</li><li>Understanding of microservices architecture, REST API design</li><li>Experience with SQL databases and NoSQL stores</li><li>Familiarity with message brokers (Kafka, RabbitMQ)</li></ul>',
      },
      additionalInformation: {
        text: '<p><strong>Perks of working with us:</strong></p><p><strong>How we work together:</strong></p><ul><li>An inclusive, friendly, and international environment</li><li>Shorter working week (36h per week instead of 40h)</li><li>Flexible hybrid working model up to 25% remote</li></ul><p><strong>How we learn together:</strong></p><ul><li>Free access to LinkedIn Learning</li><li>Company-wide learning days</li></ul>',
      },
    },
  },
};

const THIN_API = {
  name: 'Intern',
  location: { city: 'Chiasso', region: 'TI', country: 'ch' },
  jobAd: {
    sections: {
      jobDescription: {
        text: '<p>Short description only.</p>',
      },
    },
  },
};

/* ── Tests ── */

describe('lastminute parser — parseSmartRecruitersDetail', () => {
  describe('Head of Data Platform Engineering', () => {
    const detail = parseSmartRecruitersDetail(HEAD_OF_DATA_PLATFORM_API);

    it('extracts correct title', () => {
      expect(detail.title).toBe('Head of Data Platform Engineering');
    });

    it('extracts location from API', () => {
      expect(detail.location).toBe('Chiasso');
    });

    it('extracts canton', () => {
      expect(detail.canton).toBe('TI');
    });

    it('has description >= 500 chars', () => {
      expect(detail.description.length).toBeGreaterThanOrEqual(500);
    });

    it('combines all 4 sections', () => {
      expect(detail.sectionCount).toBe(4);
    });

    it('preserves responsibility bullet points', () => {
      expect(detail.description).toContain('- Build and evolve our data platform');
      expect(detail.description).toContain('- Design and implement our enterprise data infrastructure');
    });

    it('preserves requirement bullet points', () => {
      expect(detail.description).toContain('- 10+ years in data engineering');
      expect(detail.description).toContain('- Strong experience with Spark');
    });

    it('preserves perks bullet points', () => {
      expect(detail.description).toContain('- Shorter working week');
      expect(detail.description).toContain('- Flexible hybrid working model');
    });

    it('preserves section headings', () => {
      expect(detail.description).toContain('What your impact will be');
      expect(detail.description).toContain('What we are looking for');
    });

    it('includes company description section', () => {
      expect(detail.description).toContain('lastminute.com');
      expect(detail.description).toContain('Travel-Tech');
    });

    it('extracts apply URL', () => {
      expect(detail.applyUrl).toContain('smartrecruiters.com');
    });

    it('extracts posted date in ISO format', () => {
      expect(detail.postedDate).toBe('2026-01-15');
    });

    it('tracks source text length', () => {
      expect(detail.sourceTextLength).toBeGreaterThan(500);
    });
  });

  describe('Software Engineer – ETLs & Microservices', () => {
    const detail = parseSmartRecruitersDetail(SOFTWARE_ENGINEER_API);

    it('extracts title with special chars', () => {
      expect(detail.title).toContain('Software Engineer');
      expect(detail.title).toContain('ETLs');
    });

    it('has description >= 500 chars', () => {
      expect(detail.description.length).toBeGreaterThanOrEqual(500);
    });

    it('has at least 3 sections', () => {
      expect(detail.sectionCount).toBeGreaterThanOrEqual(3);
    });

    it('preserves technical requirements', () => {
      expect(detail.description).toContain('Java or Kotlin');
      expect(detail.description).toContain('microservices architecture');
    });

    it('preserves perks', () => {
      expect(detail.description).toContain('36h per week');
    });
  });
});

describe('lastminute parser — validateLastminuteDescription', () => {
  it('passes for rich Head of Data Platform content', () => {
    const detail = parseSmartRecruitersDetail(HEAD_OF_DATA_PLATFORM_API);
    const result = validateLastminuteDescription(detail);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('passes for Software Engineer content', () => {
    const detail = parseSmartRecruitersDetail(SOFTWARE_ENGINEER_API);
    const result = validateLastminuteDescription(detail);
    expect(result.ok).toBe(true);
  });

  it('warns for thin content', () => {
    const detail = parseSmartRecruitersDetail(THIN_API);
    const result = validateLastminuteDescription(detail);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('too short'))).toBe(true);
  });

  it('warns when only 1 section for substantial source', () => {
    const detail = {
      description: 'A'.repeat(600),
      sourceTextLength: 1000,
      sectionCount: 1,
    };
    const result = validateLastminuteDescription(detail);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('section'))).toBe(true);
  });
});

describe('lastminute parser — extractSrIdFromUrl', () => {
  it('extracts ID from corporate URL', () => {
    expect(extractSrIdFromUrl(
      'https://corporate.lastminute.com/careers/jobs/job?id=744000111059566&jobName=Head+of+Data'
    )).toBe('744000111059566');
  });

  it('extracts ID from SmartRecruiters URL', () => {
    expect(extractSrIdFromUrl(
      'https://jobs.smartrecruiters.com/lastminutecom/744000108444345-software-engineer'
    )).toBe('744000108444345');
  });

  it('returns empty for invalid URL', () => {
    expect(extractSrIdFromUrl('not-a-url')).toBe('');
  });

  it('returns empty for URL without ID', () => {
    expect(extractSrIdFromUrl('https://lastminute.com/careers/')).toBe('');
  });
});

describe('lastminute parser — htmlToMarkdown via parseSmartRecruitersDetail', () => {
  it('handles empty sections gracefully', () => {
    const detail = parseSmartRecruitersDetail({
      name: 'Test',
      jobAd: { sections: {} },
    });
    expect(detail.title).toBe('Test');
    expect(detail.description).toBe('');
    expect(detail.sectionCount).toBe(0);
  });

  it('handles missing jobAd gracefully', () => {
    const detail = parseSmartRecruitersDetail({ name: 'Test' });
    expect(detail.title).toBe('Test');
    expect(detail.description).toBe('');
  });

  it('decodes HTML entities in content', () => {
    const detail = parseSmartRecruitersDetail({
      name: 'Test',
      jobAd: {
        sections: {
          jobDescription: {
            text: '<p>Role involves ETLs &amp; Microservices &ndash; exciting!</p>',
          },
        },
      },
    });
    expect(detail.description).toContain('ETLs & Microservices');
    expect(detail.description).toContain('\u2013'); // ndash
  });
});
