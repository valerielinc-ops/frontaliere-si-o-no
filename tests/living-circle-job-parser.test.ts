import { describe, expect, it } from 'vitest';
import { parseLivingCircleFeed, buildLivingCircleLocalizedContent } from '../scripts/lib/living-circle-job-parser.mjs';

const FEED = {
  dataFeedElement: [
    {
      item: {
        title: 'Assistant Gouvernante 100%',
        url: 'https://jobs.thelivingcircle.ch/jobs/63228739/Assistant-Gouvernante-100%25/',
        datePosted: '2026-03-01T10:00:00.000+01:00',
        employmentType: 'FULL_TIME',
        description:
          '<p>Für die kommende Sommersaison suchen wir dich.</p><b>WAS DICH ERWARTET</b><p>Zur Unterstützung unseres Gouvernanten Teams.</p><b>ÜBER DICH</b><ul><li>Luxushotellerie Erfahrung</li><li>Teamarbeit ist dir wichtig</li></ul><b>BENEFITS</b><p>Unterkunft und Vergünstigungen.</p>',
        hiringOrganization: { name: 'Castello del Sole' },
        jobLocation: {
          address: {
            addressLocality: 'Ascona',
            addressRegion: 'Ticino',
            addressCountry: 'Schweiz',
          },
        },
      },
    },
  ],
};

describe('living-circle-job-parser', () => {
  it('parses the Softgarden feed and extracts the Ascona role', () => {
    const roles = parseLivingCircleFeed(FEED);
    expect(roles).toHaveLength(1);
    expect(roles[0].location).toBe('Ascona');
    expect(roles[0].title).toContain('Assistant Gouvernante');
  });

  it('builds localized content with locale-specific slugs', () => {
    const role = parseLivingCircleFeed(FEED)[0];
    const localized = buildLivingCircleLocalizedContent(role);
    // Title is passed through as-is; translation happens in the locale pipeline
    expect(localized.it.title).toContain('Assistant Gouvernante');
    expect(localized.en.slug).toContain('the-living-circle');
    expect(localized.fr.description).toContain('The Living Circle recrute');
  });
});
