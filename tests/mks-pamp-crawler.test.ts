import { describe, expect, it } from 'vitest';
import {
  buildMksPampLocalizedContent,
  clearMksPampInventedSlots,
  clearMksPampSourceCopies,
  isMksPampInventedDescription,
  resolveMksPampJobBody,
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
    expect(descriptionByLocale.en).toMatch(/^Precious Metal Control Manager — MKS PAMP SA, Castel San Pietro \(TI\)\.\n\n## MISSION/);
    expect(descriptionByLocale.en).toMatch(/^- Independently assure the site metal balance/m);
  });
});

// The company paragraph the parser used to publish when a posting had < 50 words.
const LEGACY_PARAGRAPH = "MKS PAMP SA, leader mondiale nella raffinazione di metalli preziosi con sede a Castel San Pietro, cerca un profilo HR Business Partner. Fondata nel 1979, MKS PAMP SA è parte del gruppo MKS PAMP GROUP. Candidati tramite il portale ufficiale careers.mkspamp.com.";
const STORED_SOURCE = `Operatore reparto raffineria — MKS PAMP SA, Castel San Pietro (TI).\n\n## MISSIONE\n\n${Array(60).fill('raffinazione').join(' ')}`;

describe('MKS PAMP source-only rule (no padded company paragraph)', () => {
  it('recognises the legacy paragraph, not a real posting', () => {
    expect(isMksPampInventedDescription(LEGACY_PARAGRAPH)).toBe(true);
    expect(isMksPampInventedDescription(STORED_SOURCE)).toBe(false);
  });

  it('keeps the stored source text when this run read no posting text', () => {
    const job = { url: 'https://careers.mkspamp.com/jobs/7130612-operatore-reparto-raffineria', description: '', sourceLang: 'it', descriptionByLocale: {} };
    const resolved = resolveMksPampJobBody(job, { sourceLang: 'it', description: STORED_SOURCE, descriptionByLocale: { it: STORED_SOURCE } });
    expect(resolved?.description).toBe(STORED_SOURCE);
    expect(resolved?.descriptionByLocale).toEqual({ it: STORED_SOURCE });
  });

  it('does not publish a job without posting text and without stored source text', () => {
    const job = { url: 'x', description: '', sourceLang: 'it', descriptionByLocale: {} };
    expect(resolveMksPampJobBody(job, null)).toBeNull();
    expect(resolveMksPampJobBody(job, { sourceLang: 'it', description: LEGACY_PARAGRAPH, descriptionByLocale: { it: LEGACY_PARAGRAPH } })).toBeNull();
  });

  it('clears stale paragraph copies from the locale slots', () => {
    const merged = { descriptionByLocale: { it: STORED_SOURCE, en: LEGACY_PARAGRAPH } };
    expect(clearMksPampInventedSlots(merged)).toBe(1);
    expect(merged.descriptionByLocale).toEqual({ it: STORED_SOURCE });
  });
});

// First 50+ words of the English JSON-LD description of
// https://careers.mkspamp.com/jobs/8241072-precious-metal-control-manager (2026-09-29).
const ENGLISH_DETAIL = [
  '## MISSION',
  '',
  "The Precious Metal Control Manager's mission is to provide business assurance that all precious metal on site is accounted for, continuously, accurately, and to a full metal balance.",
  '',
  'The job holder will report directly to the Chief Risk and Compliance Officer and will act as a second line of control, independently challenging the design, integrity, and application of controls covering metal custody.',
].join('\n');

describe('MKS PAMP source-language slot only (review #10348)', () => {
  it('puts an English posting of 50+ words in the en slot only', () => {
    const result = buildMksPampLocalizedContent({
      title: 'Precious Metal Control Manager',
      city: 'Castel San Pietro',
      descriptionHtml: '',
      detailDescription: ENGLISH_DETAIL,
    });
    expect(result.sourceLang).toBe('en');
    expect(Object.keys(result.descriptionByLocale)).toEqual(['en']);
    expect(result.description).toBe(result.descriptionByLocale.en);
  });

  it('clears stale copies of the source from the other slots', () => {
    const source = `Precious Metal Control Manager — MKS PAMP SA, Castel San Pietro (TI).\n\n${ENGLISH_DETAIL}`;
    const flattened = source.replace(/\n+/g, ' ').replace(/## /g, '');
    const merged = {
      sourceLang: 'en',
      description: source,
      descriptionByLocale: {
        en: source,
        fr: flattened, // older run: source copied into every slot
        it: 'Precious Metal Control Manager — MKS PAMP SA, Castel San Pietro (TI).\n\n## MISSIONE\n\nLa missione del Precious Metal Control Manager è garantire che tutto il metallo prezioso presente in sede sia contabilizzato in modo continuo e preciso, con un bilancio completo del metallo, riferendo direttamente al Chief Risk and Compliance Officer.',
      },
    };
    expect(clearMksPampSourceCopies(merged)).toBe(1);
    expect(Object.keys(merged.descriptionByLocale).sort()).toEqual(['en', 'it']);
  });
});
