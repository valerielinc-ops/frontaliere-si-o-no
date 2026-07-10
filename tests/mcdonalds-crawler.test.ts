import { describe, it, expect } from 'vitest';
import {
  MCDO_KEY,
  COMPANY_NAME,
  parseMcdoDetailPage,
  buildMcdoJob,
  inferCanton,
  inferEmploymentType,
} from '../scripts/lib/mcdonalds-job-parser.mjs';

const DETAIL_HTML = `
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Crew Member",
  "url": "https://jobs.mcdonalds.ch/de-ch/crew-member/job/P8-317976-1",
  "identifier": { "@type": "PropertyValue", "value": "P8-317976-1" },
  "datePosted": "2026-06-19T08:00:00.000Z",
  "validThrough": "2026-09-19T08:00:00.000Z",
  "employmentType": [],
  "description": "<p>Als Crew Member bist du das Herz unseres Restaurants.</p>",
  "jobLocation": [{
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "Rue de la Gare 1",
      "addressLocality": "Nyon",
      "addressRegion": "VD",
      "postalCode": "1260",
      "addressCountry": "CH"
    }
  }]
}
</script>
</head><body>SSR page body</body></html>`;

describe("McDonald's Switzerland crawler parser", () => {
  it('exports valid company key and name', () => {
    expect(MCDO_KEY).toBe('mcdonald-s-switzerland');
    expect(COMPANY_NAME).toBe("McDonald's Switzerland");
  });

  describe('parseMcdoDetailPage', () => {
    it('extracts JSON-LD JobPosting fields', () => {
      const parsed = parseMcdoDetailPage(DETAIL_HTML, 'https://jobs.mcdonalds.ch/de-ch/x/job/P8-317976-1');
      expect(parsed).not.toBeNull();
      expect(parsed!.title).toBe('Crew Member');
      expect(parsed!.city).toBe('Nyon');
      expect(parsed!.canton).toBe('VD');
      expect(parsed!.jobReqId).toBe('P8-317976-1');
      expect(parsed!.datePosted).toBe('2026-06-19');
      expect(parsed!.validThrough).toBe('2026-09-19');
    });

    it('returns null when no JobPosting block is present', () => {
      expect(parseMcdoDetailPage('<html><body>no ld+json</body></html>')).toBeNull();
      expect(parseMcdoDetailPage('')).toBeNull();
    });
  });

  describe('buildMcdoJob', () => {
    const parsed = parseMcdoDetailPage(DETAIL_HTML)!;

    it('emits the canonical postedDate field (never datePosted)', () => {
      const job = buildMcdoJob(parsed)!;
      // #3843 item 5: the pipeline/consumers (JobBoard, sitemap, newsletter,
      // assemble-jobs-dataset churn guard) read `postedDate`; the schema.org
      // name `datePosted` must not leak into the built job object.
      expect(job.postedDate).toBe('2026-06-19');
      expect(job).not.toHaveProperty('datePosted');
    });

    it('falls back to today for postedDate when the source has no date', () => {
      const job = buildMcdoJob({ ...parsed, datePosted: '' })!;
      expect(job.postedDate).toBe(new Date().toISOString().split('T')[0]);
    });

    it('builds a stable slug and company identity', () => {
      const job = buildMcdoJob(parsed)!;
      expect(job.companyKey).toBe(MCDO_KEY);
      expect(job.company).toBe(COMPANY_NAME);
      expect(job.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(job.slug).toContain('crew-member');
    });

    it('returns null for empty parse results', () => {
      expect(buildMcdoJob(null)).toBeNull();
      expect(buildMcdoJob({ title: '' } as never)).toBeNull();
    });
  });

  describe('inferCanton', () => {
    it('passes through 2-letter codes', () => {
      expect(inferCanton('VD', 'Nyon')).toBe('VD');
    });

    it('maps full canton names', () => {
      expect(inferCanton('Ticino', '')).toBe('TI');
      expect(inferCanton('', 'Genève')).toBe('GE');
    });

    it('returns empty string when unknown', () => {
      expect(inferCanton('', 'Nowhere')).toBe('');
    });
  });

  describe('inferEmploymentType', () => {
    it('defaults crew postings to PART_TIME', () => {
      expect(inferEmploymentType('Crew Member', [])).toBe('PART_TIME');
    });

    it('detects apprenticeships as FULL_TIME', () => {
      expect(inferEmploymentType('Apprenti(e) employé(e) de commerce', [])).toBe('FULL_TIME');
    });

    it('respects explicit JSON-LD employmentType', () => {
      expect(inferEmploymentType('Crew Member', ['FULL_TIME'])).toBe('FULL_TIME');
    });
  });
});
