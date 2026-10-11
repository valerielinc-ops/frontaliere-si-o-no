import { describe, expect, it } from 'vitest';
import { extractPsgnDetail } from '../scripts/lib/psgn-job-parser.mjs';

describe('PSGN detail parser', () => {
  it('uses the vacancy JSON-LD locality instead of the listing fallback', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Dipl. Pflegefachperson HF/FH',
      description: 'Einleitung zur ausgeschriebenen Stelle.',
      responsibilities: '<ul><li>Pflege und Betreuung der Patientinnen und Patienten.</li></ul>',
      qualifications: '<ul><li>Abschluss als diplomierte Pflegefachperson.</li></ul>',
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Pfäfers',
          addressRegion: 'Pfäfers',
          postalCode: '7312',
          addressCountry: 'Schweiz',
        },
      },
    })}</script>`;

    expect(extractPsgnDetail(html)).toMatchObject({
      location: 'Pfäfers',
      postalCode: '7312',
    });
    expect(extractPsgnDetail(html).description).toContain('Pflege und Betreuung');
  });

  it('selects the matching Swiss posting when a foreign sibling comes first', () => {
    const pageUrl = 'https://jobs.psychiatrie-sg.ch/karriere/offene-stellen/pflegefachperson/abc';
    const title = 'Dipl. Pflegefachperson HF/FH';
    const html = `<script type="application/ld+json">${JSON.stringify([
      {
        '@type': 'JobPosting',
        title: 'Recommended Nurse Position',
        url: 'https://example.test/jobs/recommended',
        description: 'Foreign recommendation that does not describe the requested vacancy.',
        jobLocation: {
          '@type': 'Place',
          address: { '@type': 'PostalAddress', addressLocality: 'Madrid', postalCode: '28001', addressCountry: 'ES' },
        },
      },
      {
        '@type': 'JobPosting',
        title,
        url: pageUrl,
        description: 'Einleitung zur ausgeschriebenen Stelle.',
        responsibilities: 'Pflege und Betreuung der Patientinnen und Patienten.',
        jobLocation: {
          '@type': 'Place',
          address: { '@type': 'PostalAddress', addressLocality: 'Pfäfers', postalCode: '7312', addressCountry: 'CH' },
        },
      },
    ])}</script>`;

    const detail = extractPsgnDetail(html, pageUrl, title);
    expect(detail).toMatchObject({ location: 'Pfäfers', postalCode: '7312' });
    expect(detail.description).toContain('Pflege und Betreuung');
    expect(detail.description).not.toContain('Foreign recommendation');
  });
});
