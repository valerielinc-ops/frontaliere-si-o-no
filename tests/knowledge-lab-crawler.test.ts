import { describe, expect, it } from 'vitest';

import {
  inferKnowledgeLabCanton,
  isKnowledgeLabSwissRelevant,
  parseKnowledgeLabPublicDetailHtml,
  parseKnowledgeLabPublicListingHtml,
  parseKnowledgeLabListingJson,
} from '../scripts/lib/knowledge-lab-job-parser.mjs';

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

describe('Knowledge Lab nationwide location filtering', () => {
  it('keeps Swiss branch cities and rejects foreign cities even with a Swiss state', () => {
    const { items } = parseKnowledgeLabListingJson([
      { id: 1, title: 'Engineer Zurich', branch: { city: 'Zurich', state: 'ZH', country_code: 'CH' } },
      { id: 2, title: 'Engineer abroad', branch: { city: 'Madrid', state: 'ZH', country_code: 'ES' } },
    ]);

    expect(items).toHaveLength(2);
    expect(isKnowledgeLabSwissRelevant(items[0])).toBe(true);
    expect(inferKnowledgeLabCanton(items[0])).toBe('ZH');
    expect(isKnowledgeLabSwissRelevant(items[1])).toBe(false);
    expect(inferKnowledgeLabCanton(items[1])).toBe('');
  });
});

describe('Knowledge Lab public Freshteam portal parsing', () => {
  it('extracts tenant detail links and ignores duplicate or foreign links', () => {
    const { items, recognized } = parseKnowledgeLabPublicListingHtml(`
      <html>
        <head><link rel="canonical" href="https://klab.freshteam.com/jobs/" /></head>
        <body>
          <h1>Open Positions</h1>
          <a href="/jobs/i3GLY8sDKKC5/initiative-application"><h2>Initiative Application</h2></a>
          <a href="/jobs/i3GLY8sDKKC5/initiative-application">Duplicate</a>
          <a href="https://other.example/jobs/not-ours">Ignore</a>
        </body>
      </html>
    `);

    expect(recognized).toBe(true);
    expect(items).toEqual([{
      jobId: 'i3GLY8sDKKC5',
      title: 'Initiative Application',
      detailUrl: 'https://klab.freshteam.com/jobs/i3GLY8sDKKC5/initiative-application',
      applyUrl: 'https://klab.freshteam.com/jobs/i3GLY8sDKKC5/initiative-application',
    }]);
  });

  it('reads rich JobPosting metadata and rejects thin open details', () => {
    const description = [
      'Knowledge Lab builds digital solutions for banks, insurers, and the public sector.',
      ...Array.from({ length: 12 }, (_, index) => `Requirement ${index + 1} includes meaningful experience, collaboration, and delivery context for this role.`),
    ].join(' ');
    const postedAt = daysAgo(3);
    const detail = parseKnowledgeLabPublicDetailHtml(`
      <html>
        <head>
          <script type="application/ld+json">${JSON.stringify({
            '@type': 'JobPosting',
            description: `<p>${description}</p>`,
            datePosted: postedAt,
            employmentType: 'FULL_TIME',
            jobLocation: { address: {
              addressLocality: 'Zurich',
              postalCode: '8000',
              addressCountry: 'CH',
            } },
          })}</script>
        </head>
        <body>
          <div><span>Services &amp; Delivery</span><h1>Initiative Application</h1><div>Zurich</div><div>Work Type: Full Time</div></div>
        </body>
      </html>
    `, 'https://klab.freshteam.com/jobs/i3GLY8sDKKC5/initiative-application');

    expect(detail.incomplete).toBe(false);
    expect(detail.title).toBe('Initiative Application');
    expect(detail.location).toBe('Zurich');
    expect(detail.postalCode).toBe('8000');
    expect(detail.employmentType).toBe('full-time');
    expect(detail.postedDate).toBe(postedAt.slice(0, 10));
    expect(detail.descriptionWordCount).toBeGreaterThanOrEqual(50);
    expect(isKnowledgeLabSwissRelevant(detail)).toBe(true);

    const thin = parseKnowledgeLabPublicDetailHtml(
      '<html><body><h1>Short role</h1><p>Zurich</p><p>Apply now.</p></body></html>',
      'https://klab.freshteam.com/jobs/short/short-role',
    );
    expect(thin.incomplete).toBe(true);
  });

  it('treats a closed detail page as terminal instead of a parser failure', () => {
    expect(parseKnowledgeLabPublicDetailHtml(
      '<html><body><p>We are currently not accepting applications for this job.</p></body></html>',
      'https://klab.freshteam.com/jobs/nMw3fT2cfVDY/system-engineer-belgrade-remote',
    )).toEqual({
      closed: true,
      detailUrl: 'https://klab.freshteam.com/jobs/nMw3fT2cfVDY/system-engineer-belgrade-remote',
    });
  });
});
