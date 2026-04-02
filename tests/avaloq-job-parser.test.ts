import { describe, expect, it } from 'vitest';
import {
  parseAvaloqListingLinks,
  parseAvaloqJobDetail,
  isAvaloqTargetLocation,
  inferAvaloqCanton,
} from '../scripts/lib/avaloq-job-parser.mjs';

describe('avaloq-job-parser', () => {
  it('extracts public job detail links from listing page html', () => {
    const html = `
      <div style="display:none">
        <a href="/careers/job-openings/744000113443570-data-platform-manager">Data Platform Manager</a>
        <a href="/careers/job-openings/744000112640738-apprendista-di-commercio-afc-con-maturita">Apprendista</a>
      </div>
    `;
    expect(parseAvaloqListingLinks(html)).toEqual([
      'https://www.avaloq.com/careers/job-openings/744000113443570-data-platform-manager',
      'https://www.avaloq.com/careers/job-openings/744000112640738-apprendista-di-commercio-afc-con-maturita',
    ]);
  });

  it('extracts links from SmartRecruiters embedded IDs when no href links exist', () => {
    const html = `<script>{"props":{"pageProps":{"jobs":[{"applyUrl":"https:\\/\\/smartrecruiters.com\\/v1\\/companies\\/Avaloq1\\/postings\\/744000118386833"},{"applyUrl":"https:\\/\\/smartrecruiters.com\\/v1\\/companies\\/Avaloq1\\/postings\\/744000118375717"}]}}}</script>`;
    expect(parseAvaloqListingLinks(html)).toEqual([
      'https://www.avaloq.com/careers/job-openings/744000118386833',
      'https://www.avaloq.com/careers/job-openings/744000118375717',
    ]);
  });

  it('parses an Avaloq detail page and extracts location, apply url and sections', () => {
    const html = `
      <html>
        <head><title>Data Platform Manager | Job Openings - Avaloq</title></head>
        <body>
          <h1>Data Platform Manager</h1>
          Location
          Strada Regina 40
          6934 Bioggio
          Switzerland
          Work arrangement
          Full-time
          Apply
          Data Platform Manager
          A bit about the role
          This is an exciting opportunity for you to lead the platform team.
          Your key tasks
          Lead, mentor and manage a team of DBAs.
          A bit about you
          7+ years of experience and strong Oracle knowledge.
          It would be a real bonus if you have
          Oracle Certified Professional.
          Additional information
          We offer hybrid work and an inclusive workplace.
          <a href="https://jobs.smartrecruiters.com/Avaloq1/744000113443570-data-platform-manager?oga=true">Apply</a>
        </body>
      </html>
    `;
    const parsed = parseAvaloqJobDetail(html, 'https://www.avaloq.com/careers/job-openings/744000113443570-data-platform-manager');
    expect(parsed.title).toBe('Data Platform Manager');
    expect(parsed.location).toBe('Bioggio');
    expect(parsed.postalCode).toBe('6934');
    expect(parsed.applyUrl).toContain('jobs.smartrecruiters.com/Avaloq1/');
    expect(parsed.description).toContain('Il ruolo');
    expect(parsed.description).toContain('Le tue responsabilita');
    expect(parsed.description).toContain('Il tuo profilo');
  });

  it('matches Ticino and Grigioni locations', () => {
    expect(isAvaloqTargetLocation('Bioggio')).toBe(true);
    expect(isAvaloqTargetLocation('Chur')).toBe(true);
    expect(inferAvaloqCanton('Bioggio')).toBe('TI');
    expect(inferAvaloqCanton('Chur')).toBe('GR');
  });
});
