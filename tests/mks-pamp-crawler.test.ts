import { describe, expect, it } from 'vitest';
import {
  buildMksPampLocalizedContent,
  teamtailorHtmlToMarkdown,
} from '../scripts/lib/mkspamp-job-parser.mjs';

// Minimized from the JSON-LD `description` of
// https://careers.mkspamp.com/jobs/8241072-precious-metal-control-manager (2026-09-29):
// Teamtailor serves the markup entity-encoded inside the JSON string.
const JSONLD_DESCRIPTION = '&lt;h2&gt;MISSION&lt;/h2&gt;&lt;p&gt;The Precious Metal Control Manager&#39;s mission is to provide business assurance that all precious metal on site is accounted for.&lt;/p&gt;&lt;h2&gt;MAIN ACTIVITIES AND RESPONSIBILITIES&lt;/h2&gt;&lt;p&gt;&lt;strong&gt;Metal Accountability &amp;amp; Balance&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;&lt;p&gt;Independently assure the site metal balance across the full cycle for each metal&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;Monitor and challenge process loss tolerances set by Production, IT and Finance&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;';

describe('MKS PAMP Teamtailor description (flat 5/5)', () => {
  it('turns the entity-encoded JSON-LD markup into markdown with headings and bullets', () => {
    expect(teamtailorHtmlToMarkdown(JSONLD_DESCRIPTION)).toBe([
      '## MISSION',
      '',
      "The Precious Metal Control Manager's mission is to provide business assurance that all precious metal on site is accounted for.",
      '',
      '## MAIN ACTIVITIES AND RESPONSIBILITIES',
      '',
      'Metal Accountability & Balance',
      '',
      '- Independently assure the site metal balance across the full cycle for each metal',
      '- Monitor and challenge process loss tolerances set by Production, IT and Finance',
    ].join('\n'));
  });

  it('keeps the list structure in the published description', () => {
    const detailDescription = teamtailorHtmlToMarkdown(JSONLD_DESCRIPTION)
      + '\n\n' + Array(40).fill('- Verify fine-weight tracking and weighing controls').join('\n');
    const { descriptionByLocale } = buildMksPampLocalizedContent({
      title: 'Precious Metal Control Manager',
      city: 'Castel San Pietro',
      descriptionHtml: '',
      detailDescription,
    });
    expect(descriptionByLocale.it).toMatch(/^Precious Metal Control Manager — MKS PAMP SA, Castel San Pietro \(TI\)\.\n\n## MISSION/);
    expect(descriptionByLocale.it).toMatch(/^- Independently assure the site metal balance/m);
  });
});
