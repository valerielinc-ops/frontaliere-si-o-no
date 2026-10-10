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
});
