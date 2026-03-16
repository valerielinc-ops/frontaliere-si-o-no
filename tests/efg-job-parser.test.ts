import { describe, expect, it } from 'vitest';
import { parseEfgOracleDescription } from '@/scripts/lib/efg-job-parser.mjs';

describe('parseEfgOracleDescription', () => {
  it('extracts structured sections, requirements and responsibilities from Oracle HTML', () => {
    const rawHtml = `
      <p><strong>General Info</strong></p>
      <p>Entity: EFG International</p>
      <p><strong>Job Description</strong></p>
      <p>The role supports the trading and treasury platform.</p>
      <p><strong>Main responsibilities</strong></p>
      <ul>
        <li>Support front-to-back treasury workflows</li>
        <li>Coordinate releases with internal IT teams</li>
      </ul>
      <p><strong>Skills and experience</strong></p>
      <ul>
        <li>Experience with trading systems</li>
        <li>Strong SQL knowledge</li>
      </ul>
      <p><strong>Our Values</strong></p>
      <ul>
        <li>Entrepreneurship</li>
      </ul>
    `;

    const parsed = parseEfgOracleDescription(rawHtml);

    expect(parsed.description).toContain('## Main responsibilities');
    expect(parsed.canonical.summary).toContain('The role supports the trading and treasury platform.');
    expect(parsed.canonical.responsibilities).toContain('Support front-to-back treasury workflows');
    expect(parsed.requirements).toContain('Experience with trading systems');
    expect(parsed.canonical.benefits).toContain('Entrepreneurship');
  });

  it('keeps the application block even when Oracle renders the heading without strong markup', () => {
    const rawHtml = `
      <p><strong>Please ensure to attach a cover letter to your CV when filling the application.</strong></p>
      <p>Application</p>
      <p>Should you wish to apply for this position use this link to apply.</p>
    `;

    const parsed = parseEfgOracleDescription(rawHtml);

    expect(parsed.description).toContain('## Application');
    expect(parsed.canonical.process).toContain('Should you wish to apply for this position use this link to apply.');
  });
});
