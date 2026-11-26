import { describe, expect, it } from 'vitest';
import {
  extractDetail,
  isTrustedDomain,
  parseListing,
} from '../scripts/lib/suedhang-job-parser.mjs';

const currentJobUrl = 'https://suedhang.jobportal.abaservices.ch/job-advertisement/3a65545b-9f99-823e-510b-0dd3414edcd8';
const sourceBody = 'Die Klinik Südhang bietet eine anspruchsvolle und sinnstiftende Tätigkeit in einem interprofessionellen Team. '.repeat(12);

describe('Suedhang crawler', () => {
  it('accepts legacy and current Abacus listing links but rejects other hosts', () => {
    const rows = parseListing(`
      <a href="https://www.suedhang.ch/karriere/offene-stellen/pflege/">Legacy Pflege</a>
      <a class="job" href="${currentJobUrl}"><span>Fachfrau Gesundheit</span></a>
      <a href="/job-advertisement/271c262f-de56-5fca-6381-5a1d0b542c11">Psychologin</a>
      <a href="https://example.com/job-advertisement/not-suedhang">Nicht übernehmen</a>
    `);

    expect(rows).toEqual([
      {
        url: 'https://www.suedhang.ch/karriere/offene-stellen/pflege/',
        titleHint: 'Legacy Pflege',
      },
      { url: currentJobUrl, titleHint: 'Fachfrau Gesundheit' },
      {
        url: 'https://suedhang.jobportal.abaservices.ch/job-advertisement/271c262f-de56-5fca-6381-5a1d0b542c11',
        titleHint: 'Psychologin',
      },
    ]);
  });

  it('extracts Abacus detail sections and selected JobPosting metadata', () => {
    const detail = extractDetail(`
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Fachfrau Gesundheit',
        datePosted: '2026-11-20',
        description: `<p>${sourceBody}</p>`,
        jobLocation: { address: { addressLocality: 'Kirchlindach' } },
      })}</script>
      <h1>Fachfrau Gesundheit</h1>
      <div class="col-xs-12 introduction">${sourceBody}</div>
      <div class="col-xs-12 jobtitle">Arbeitsort: Klinik Südhang, Kirchlindach Beschäftigungsgrad: 50%</div>
    `, currentJobUrl, 'Fachfrau Gesundheit');

    expect(detail.title).toBe('Fachfrau Gesundheit');
    expect(detail.description.split(/\s+/).length).toBeGreaterThan(50);
    expect(detail.location).toBe('Kirchlindach');
    expect(detail.pensum).toBe('50%');
    expect(detail.datePosted).toBe('2026-11-20');
  });

  it('trusts only Suedhang-owned hosts', () => {
    expect(isTrustedDomain(currentJobUrl)).toBe(true);
    expect(isTrustedDomain('https://jobs.suedhang.ch/')).toBe(true);
    expect(isTrustedDomain('https://evil.jobportal.abaservices.ch/job-advertisement/x')).toBe(false);
  });
});
