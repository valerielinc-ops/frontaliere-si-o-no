import { describe, expect, it } from 'vitest';
import {
  parseDelvitechCareerPage,
  parseDelvitechJobDetail,
  isDelvitechTicinoJob,
} from '../scripts/lib/delvitech-job-parser.mjs';

describe('Delvitech job parser', () => {
  it('extracts vacancy links from the career page cards', () => {
    const html = `
      <div class="post-content">
        <a class="fusion-column-anchor" href="https://legacy.delvi.tech/application-engineer-2/"></a>
        <div class="fusion-layout-column"><h5>Application Engineer</h5></div>
        <a class="fusion-column-anchor" href="https://legacy.delvi.tech/customer-support-manager/"></a>
        <div class="fusion-layout-column"><h5>Customer Support Manager</h5></div>
      </div>
    `;
    const jobs = parseDelvitechCareerPage(html);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].href).toContain('/application-engineer-2/');
  });

  it('parses detail sections and apply email', () => {
    const html = `
      <div class="post-content">
        <div class="fusion-fullwidth">
          <div class="fusion-text"><h1>Application Engineer</h1></div>
          <div class="fusion-text"><p><strong>ABOUT DELVITECH</strong></p></div>
          <div class="fusion-text"><p>This role is based at our headquarters in Mendrisio.</p></div>
          <div class="fusion-text"><p><strong>KEY RESPONSIBILITIES</strong></p></div>
          <div class="fusion-text"><ul><li>Support customers</li><li>Travel onsite</li></ul></div>
          <div class="fusion-text"><p>Please send your CV to <a href="mailto:career@delvi.tech">career@delvi.tech</a></p></div>
        </div>
      </div>
    `;
    const detail = parseDelvitechJobDetail(html, 'https://legacy.delvi.tech/application-engineer-2/');
    expect(detail.title).toBe('Application Engineer');
    expect(detail.location).toBe('Mendrisio');
    expect(detail.email).toBe('career@delvi.tech');
    expect(detail.description).toContain('## ABOUT DELVITECH');
    expect(detail.description).toContain('- Support customers');
  });

  it('filters out the explicit Germany role', () => {
    expect(isDelvitechTicinoJob({
      title: 'Office Manager Germany',
      location: 'Germany',
      description: 'Based in Germany',
    })).toBe(false);
    expect(isDelvitechTicinoJob({
      title: 'Customer Support Manager',
      location: 'Mendrisio',
      description: 'Based at our headquarters in Mendrisio',
    })).toBe(true);
  });
});
