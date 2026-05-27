/**
 * Hugo Boss — Phenom People parser tests
 *
 * Tests parseSearchPage(), parseDetailPage(), buildDetailUrl(),
 * detectCategory(), detectExperienceLevel(), and isHugoBossTargetLocation().
 */
import { describe, it, expect } from 'vitest';

import {
  extractPhenomDdo,
  parseSearchPage,
  parseDetailPage,
  buildDetailUrl,
  isHugoBossTargetLocation,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/hugo-boss-job-parser.mjs';

// ─── Fixture: Phenom DDO embedded in a search page ──────────────────────────

const FIXTURE_SEARCH_PAGE = `
<!DOCTYPE html>
<html>
<head><title>HUGO BOSS Careers</title></head>
<body>
<script>
phApp.ddo = {
  "eagerLoadRefineSearch": {
    "data": {
      "jobs": [
        {
          "jobId": "142143",
          "reqId": "142143",
          "title": "Designer Bodywear, Nightwear & Loungewear HUGO Man",
          "city": "Coldrerio",
          "state": "Ticino",
          "cityState": "Coldrerio, Ticino",
          "cityStateCountry": "Coldrerio, Ticino, Switzerland",
          "address": "",
          "category": "Design & Brands",
          "multi_category": ["Design & Brands"],
          "postedDate": "2026-03-15",
          "description": "Join our design team in Coldrerio creating innovative HUGO Man collections.",
          "applyUrl": "/global/en/job/142143/apply",
          "jobSeqNo": "HUBOGLOBAL142143EXTERNALENGLOBAL"
        },
        {
          "jobId": "140407",
          "reqId": "140407",
          "title": "Intern Process Automation",
          "city": "Coldrerio",
          "state": "Ticino",
          "cityState": "Coldrerio, Ticino",
          "cityStateCountry": "Coldrerio, Ticino, Switzerland",
          "address": "",
          "category": "Product Development & Digital Excellence",
          "multi_category": ["Product Development & Digital Excellence"],
          "postedDate": "2026-03-10",
          "description": "Internship opportunity in process automation at our Coldrerio site.",
          "applyUrl": "/global/en/job/140407/apply",
          "jobSeqNo": "HUBOGLOBAL140407EXTERNALENGLOBAL"
        },
        {
          "jobId": "999999",
          "reqId": "999999",
          "title": "Store Manager Frankfurt",
          "city": "Frankfurt",
          "state": "Hessen",
          "cityState": "Frankfurt, Hessen",
          "cityStateCountry": "Frankfurt, Hessen, Germany",
          "address": "",
          "category": "Retail",
          "postedDate": "2026-03-12",
          "description": "Manage our flagship store in Frankfurt.",
          "applyUrl": "/global/en/job/999999/apply",
          "jobSeqNo": "HUBOGLOBAL999999EXTERNALENGLOBAL"
        }
      ]
    }
  }
}; phApp.experimentData = {};
</script>
</body>
</html>
`;

const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head>
  <title>Designer Bodywear - HUGO BOSS Careers</title>
</head>
<body>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Designer Bodywear, Nightwear & Loungewear HUGO Man",
  "description": "<p>We are looking for a creative and passionate <strong>Designer Bodywear, Nightwear & Loungewear HUGO Man</strong> to join our team in Coldrerio, Ticino, Switzerland.</p><p><strong>Your Responsibilities:</strong></p><ul><li>Design and develop seasonal collections for HUGO Man bodywear, nightwear and loungewear.</li><li>Create mood boards, color palettes and technical flat drawings.</li><li>Collaborate closely with product development and sourcing teams.</li><li>Conduct market research and trend analysis.</li><li>Ensure design intent is maintained through the product development process.</li></ul><p><strong>Your Profile:</strong></p><ul><li>Degree in Fashion Design or related field.</li><li>3+ years experience in bodywear/nightwear design.</li><li>Proficiency in Adobe Creative Suite and CLO 3D.</li><li>Strong understanding of fabrics and construction techniques.</li><li>Fluent in English; Italian is a plus.</li></ul>",
  "datePosted": "2026-03-15",
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Coldrerio",
      "addressRegion": "Ticino",
      "addressCountry": "CH"
    }
  },
  "hiringOrganization": {
    "@type": "Organization",
    "name": "HUGO BOSS"
  }
}
</script>
<h1>Designer Bodywear, Nightwear & Loungewear HUGO Man</h1>
<script>
phApp.ddo = {
  "jobDetail": {
    "data": {
      "job": {
        "title": "Designer Bodywear, Nightwear & Loungewear HUGO Man",
        "description": "<p>We are looking for a creative and passionate Designer Bodywear.</p>",
        "city": "Coldrerio",
        "state": "Ticino"
      }
    }
  }
}; phApp.experimentData = {};
</script>
</body>
</html>
`;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('extractPhenomDdo', () => {
  it('extracts the DDO object from HTML', () => {
    const ddo = extractPhenomDdo(FIXTURE_SEARCH_PAGE);
    expect(ddo).not.toBeNull();
    expect(ddo?.eagerLoadRefineSearch?.data?.jobs).toBeDefined();
  });

  it('returns null for HTML without DDO', () => {
    expect(extractPhenomDdo('<html><body>No DDO here</body></html>')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractPhenomDdo('')).toBeNull();
  });
});

describe('parseSearchPage', () => {
  it('finds all three jobs from the fixture', () => {
    const jobs = parseSearchPage(FIXTURE_SEARCH_PAGE);
    expect(jobs).toHaveLength(3);
  });

  it('extracts correct title for first job', () => {
    const jobs = parseSearchPage(FIXTURE_SEARCH_PAGE);
    expect(jobs[0].title).toBe('Designer Bodywear, Nightwear & Loungewear HUGO Man');
  });

  it('extracts correct city and state', () => {
    const jobs = parseSearchPage(FIXTURE_SEARCH_PAGE);
    expect(jobs[0].city).toBe('Coldrerio');
    expect(jobs[0].state).toBe('Ticino');
  });

  it('returns empty array for empty input', () => {
    expect(parseSearchPage('')).toHaveLength(0);
  });

  it('returns empty array for HTML without DDO', () => {
    expect(parseSearchPage('<html><body>No jobs</body></html>')).toHaveLength(0);
  });
});

describe('isHugoBossTargetLocation', () => {
  it('matches Coldrerio Ticino', () => {
    expect(isHugoBossTargetLocation({ city: 'Coldrerio', state: 'Ticino' })).toBe(true);
  });

  it('matches cityStateCountry containing Ticino', () => {
    expect(isHugoBossTargetLocation({ cityStateCountry: 'Coldrerio, Ticino, Switzerland' })).toBe(true);
  });

  it('does not match Frankfurt', () => {
    expect(isHugoBossTargetLocation({ city: 'Frankfurt', state: 'Hessen' })).toBe(false);
  });

  it('does not match empty job', () => {
    expect(isHugoBossTargetLocation({})).toBe(false);
  });
});

describe('buildDetailUrl', () => {
  it('builds correct URL from job data', () => {
    const url = buildDetailUrl({ jobSeqNo: 'HUBOGLOBAL142143EXTERNALENGLOBAL', title: 'Designer Bodywear' });
    expect(url).toContain('careers.hugoboss.com');
    expect(url).toContain('HUBOGLOBAL142143EXTERNALENGLOBAL');
    expect(url).toContain('designer-bodywear');
  });

  it('returns empty string for missing data', () => {
    expect(buildDetailUrl({})).toBe('');
  });
});

describe('parseDetailPage', () => {
  it('extracts the title from JSON-LD', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.title).toContain('Designer Bodywear');
  });

  it('extracts a description body', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.body.length).toBeGreaterThan(0);
  });

  it('returns empty for empty input', () => {
    const result = parseDetailPage('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
  });
});

describe('detectCategory', () => {
  it('detects design category', () => {
    expect(detectCategory('Designer Bodywear HUGO Man')).toBe('design');
  });

  it('detects technology for Intern Process Automation (automation keyword)', () => {
    expect(detectCategory('Intern Process Automation')).toBe('technology');
  });

  it('detects internship for Intern Marketing', () => {
    expect(detectCategory('Intern Marketing')).toBe('internship');
  });

  it('detects sales for Store Manager', () => {
    expect(detectCategory('Store Manager')).toBe('sales');
  });

  it('returns general for unknown', () => {
    expect(detectCategory('Office Coordinator')).toBe('general');
  });
});

describe('detectExperienceLevel', () => {
  it('detects ENTRY for intern', () => {
    expect(detectExperienceLevel('Intern Process Automation')).toBe('ENTRY');
  });

  it('detects SENIOR for Senior Designer', () => {
    expect(detectExperienceLevel('Senior Designer')).toBe('SENIOR');
  });

  it('detects MID for regular title', () => {
    expect(detectExperienceLevel('Designer Bodywear')).toBe('MID');
  });
});
