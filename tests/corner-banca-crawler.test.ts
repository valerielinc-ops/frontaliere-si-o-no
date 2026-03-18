/**
 * Cornèr Banca — Recruitee API offer parser tests
 *
 * Tests parseCornerOfferFull(), buildFullDescription(), buildSectionsHtml(),
 * stripHtml(), parseBullets() using Recruitee API fixtures.
 *
 * Regression case: "candidatura-spontanea-apprendistato-corner-banca-switzerland"
 *   https://jobs.corner.ch/o/unsolicited-application-apprenticeship
 *   — description was only the short teaser from offer.description
 *   — fix: also extract offer.offer_sections which contains the full vacancy body
 */
import { describe, it, expect } from 'vitest';

// @ts-expect-error — ESM .mjs module
import {
  parseCornerOfferFull,
  buildFullDescription,
  buildSectionsHtml,
  stripHtml,
  parseBullets,
  MIN_CORNER_DESC_LENGTH,
} from '@/scripts/lib/corner-job-parser.mjs';

// ─── Fixtures: Recruitee API offer objects ─────────────────────────────────

// Regression case: offer with teaser-only description, full content in offer_sections
const OFFER_WITH_SECTIONS: any = {
  id: 12345,
  slug: 'unsolicited-application-apprenticeship',
  title: 'Candidatura spontanea - Apprendistato',
  description: '<p>Candidatura spontanea per apprendistato presso Cornèr Banca.</p>',
  requirements: '',
  offer_sections: [
    {
      name: 'Chi siamo',
      description:
        '<p>Cornèr Banca SA, fondata nel 1952 a Lugano, è una banca svizzera indipendente ' +
        'specializzata nella gestione patrimoniale e nelle carte di credito. ' +
        'Offre un ambiente di lavoro dinamico e orientato alla crescita professionale.</p>',
    },
    {
      name: 'Cosa cerchiamo',
      description:
        '<ul>' +
        '<li>Diplomato o in procinto di diplomarsi con interesse per il settore bancario</li>' +
        '<li>Buona conoscenza della lingua italiana, francese o tedesca</li>' +
        '<li>Motivazione, curiosità e voglia di imparare</li>' +
        '</ul>',
    },
    {
      name: 'Cosa offriamo',
      description:
        '<ul>' +
        '<li>Apprendistato triennale con formazione pratica e teorica</li>' +
        '<li>Mentoring da professionisti del settore bancario</li>' +
        '<li>Opportunità di crescita al termine del percorso formativo</li>' +
        '</ul>',
    },
  ],
  translations: {
    it: {
      title: 'Candidatura spontanea - Apprendistato',
      description: '<p>Candidatura spontanea per apprendistato presso Cornèr Banca.</p>',
      requirements: '',
      offer_sections: [
        {
          name: 'Chi siamo',
          description:
            '<p>Cornèr Banca SA, fondata nel 1952 a Lugano, è una banca svizzera indipendente ' +
            'specializzata nella gestione patrimoniale e nelle carte di credito. ' +
            'Offre un ambiente di lavoro dinamico e orientato alla crescita professionale.</p>',
        },
        {
          name: 'Cosa cerchiamo',
          description:
            '<ul>' +
            '<li>Diplomato o in procinto di diplomarsi con interesse per il settore bancario</li>' +
            '<li>Buona conoscenza della lingua italiana, francese o tedesca</li>' +
            '<li>Motivazione, curiosità e voglia di imparare</li>' +
            '</ul>',
        },
        {
          name: 'Cosa offriamo',
          description:
            '<ul>' +
            '<li>Apprendistato triennale con formazione pratica e teorica</li>' +
            '<li>Mentoring da professionisti del settore bancario</li>' +
            '<li>Opportunità di crescita al termine del percorso formativo</li>' +
            '</ul>',
        },
      ],
    },
    en: {
      title: 'Unsolicited Application – Apprenticeship',
      description: '<p>Unsolicited application for apprenticeship at Cornèr Banca.</p>',
      requirements: '',
      offer_sections: [],
    },
  },
  locations: [{ city: 'Lugano', state_code: 'TI' }],
  published_at: '2026-01-15T10:00:00Z',
};

// Offer with only teaser description and no sections (should trigger warning, but still return job)
const OFFER_SHORT_NO_SECTIONS: any = {
  id: 99999,
  slug: 'short-job',
  title: 'Impiegato Banca',
  description: '<p>Posizione disponibile.</p>',
  requirements: '',
  offer_sections: [],
  translations: { it: { title: 'Impiegato Banca', description: '<p>Posizione disponibile.</p>' } },
  locations: [{ city: 'Lugano', state_code: 'TI' }],
};

// Offer with no title — should return null
const OFFER_NO_TITLE: any = {
  id: 11111,
  slug: 'no-title',
  description: '<p>Some content here.</p>',
  offer_sections: [],
  translations: {},
};

// Full offer with multilingual sections
const OFFER_MULTILINGUAL: any = {
  id: 22222,
  slug: 'relationship-manager',
  title: 'Relationship Manager',
  description: '<p>We are looking for a Relationship Manager.</p>',
  requirements: '<ul><li>Banking experience required</li><li>Client-focused attitude</li></ul>',
  offer_sections: [
    {
      name: 'About the Role',
      description:
        '<p>As a Relationship Manager at Cornèr Banca, you will manage a portfolio of ' +
        'private banking clients and develop long-term wealth management strategies.</p>',
    },
  ],
  translations: {
    it: {
      title: 'Relationship Manager',
      description: '<p>Stiamo cercando un Relationship Manager.</p>',
      requirements: '<ul><li>Esperienza bancaria richiesta</li><li>Orientamento al cliente</li></ul>',
      offer_sections: [
        {
          name: 'Il Ruolo',
          description:
            '<p>Come Relationship Manager presso Cornèr Banca, gestirai un portafoglio di ' +
            'clienti private banking e svilupperai strategie di gestione patrimoniale.</p>',
        },
      ],
    },
    de: {
      title: 'Relationship Manager',
      description: '<p>Wir suchen einen Relationship Manager.</p>',
      offer_sections: [
        {
          name: 'Die Rolle',
          description:
            '<p>Als Relationship Manager bei Cornèr Banca verwalten Sie ein Portfolio von ' +
            'Private-Banking-Kunden.</p>',
        },
      ],
    },
  },
  locations: [{ city: 'Lugano', state_code: 'TI' }],
  published_at: '2026-02-01T10:00:00Z',
};

// ─── parseCornerOfferFull — regression (offer_sections) ───────────────────

describe(`parseCornerOfferFull — MIN_CORNER_DESC_LENGTH is ${MIN_CORNER_DESC_LENGTH}`, () => {
  it('MIN_CORNER_DESC_LENGTH equals 300', () => {
    expect(MIN_CORNER_DESC_LENGTH).toBe(300);
  });
});

describe('parseCornerOfferFull — candidatura spontanea apprendistato regression', () => {
  it('returns a non-null result for a complete offer', () => {
    expect(parseCornerOfferFull(OFFER_WITH_SECTIONS)).not.toBeNull();
  });

  it(`produces a description >= ${MIN_CORNER_DESC_LENGTH} characters`, () => {
    const result = parseCornerOfferFull(OFFER_WITH_SECTIONS);
    expect(result!.description.length).toBeGreaterThanOrEqual(MIN_CORNER_DESC_LENGTH);
  });

  it('includes offer_sections content (not just the teaser)', () => {
    const result = parseCornerOfferFull(OFFER_WITH_SECTIONS);
    expect(result!.description).toContain('fondata nel 1952');
    expect(result!.description).toContain('Apprendistato triennale');
  });

  it('includes the section headings in the description', () => {
    const result = parseCornerOfferFull(OFFER_WITH_SECTIONS);
    expect(result!.description).toContain('Chi siamo');
    expect(result!.description).toContain('Cosa cerchiamo');
    expect(result!.description).toContain('Cosa offriamo');
  });

  it('includes content from the teaser description', () => {
    const result = parseCornerOfferFull(OFFER_WITH_SECTIONS);
    expect(result!.description).toContain('Candidatura spontanea');
  });

  it('extracts the Italian title', () => {
    const result = parseCornerOfferFull(OFFER_WITH_SECTIONS);
    expect(result!.title).toBe('Candidatura spontanea - Apprendistato');
  });

  it('extracts the English locale title into titleByLocale', () => {
    const result = parseCornerOfferFull(OFFER_WITH_SECTIONS);
    expect(result!.titleByLocale.en).toBe('Unsolicited Application – Apprenticeship');
  });

  it('provides Italian description in descriptionByLocale.it', () => {
    const result = parseCornerOfferFull(OFFER_WITH_SECTIONS);
    expect(result!.descriptionByLocale.it).toContain('fondata nel 1952');
  });
});

// ─── parseCornerOfferFull — guards ────────────────────────────────────────

describe('parseCornerOfferFull — guards', () => {
  it('returns null when offer has no title', () => {
    expect(parseCornerOfferFull(OFFER_NO_TITLE)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseCornerOfferFull(undefined as any)).toBeNull();
  });

  it('returns null when description is extremely short (< 50 chars)', () => {
    const tinyOffer = { ...OFFER_SHORT_NO_SECTIONS, description: '<p>OK</p>', offer_sections: [], translations: {} };
    expect(parseCornerOfferFull(tinyOffer)).toBeNull();
  });

  it('returns non-null for short-but-above-50-char description with no sections (with warning)', () => {
    // "Posizione disponibile." → after stripHtml = "Posizione disponibile." = 22 chars < 300
    // → warning emitted, but still returned (> 50 chars threshold)
    // Actually 22 chars is < 50, so null. Let us use a slightly longer one:
    const shortOffer = {
      ...OFFER_SHORT_NO_SECTIONS,
      description: '<p>Posizione disponibile per candidature spontanee nel settore bancario.</p>',
      offer_sections: [],
      translations: { it: { title: 'Impiegato Banca', description: '<p>Posizione disponibile per candidature spontanee nel settore bancario.</p>' } },
    };
    const result = parseCornerOfferFull(shortOffer);
    // 73 chars > 50, so should return a result (even if < MIN_CORNER_DESC_LENGTH)
    expect(result).not.toBeNull();
  });
});

// ─── parseCornerOfferFull — multilingual ──────────────────────────────────

describe('parseCornerOfferFull — multilingual offer', () => {
  it('extracts Italian sections content', () => {
    const result = parseCornerOfferFull(OFFER_MULTILINGUAL);
    expect(result!.descriptionByLocale.it).toContain('portafoglio di clienti private banking');
  });

  it('extracts German sections content', () => {
    const result = parseCornerOfferFull(OFFER_MULTILINGUAL);
    expect(result!.descriptionByLocale.de).toContain('Private-Banking-Kunden');
  });

  it('extracts requirements bullets (Italian translation takes priority)', () => {
    const result = parseCornerOfferFull(OFFER_MULTILINGUAL);
    // Italian translation is preferred; its requirements are in Italian
    expect(result!.requirements).toContain('Esperienza bancaria richiesta');
  });
});

// ─── buildSectionsHtml ────────────────────────────────────────────────────

describe('buildSectionsHtml', () => {
  it('combines section names and bodies into HTML', () => {
    const html = buildSectionsHtml([
      { name: 'Section A', description: '<p>Content A.</p>' },
      { name: 'Section B', description: '<p>Content B.</p>' },
    ]);
    expect(html).toContain('Section A');
    expect(html).toContain('Content A');
    expect(html).toContain('Section B');
    expect(html).toContain('Content B');
  });

  it('returns empty string for empty or non-array input', () => {
    expect(buildSectionsHtml([])).toBe('');
    expect(buildSectionsHtml(null as any)).toBe('');
  });

  it('skips sections with empty body', () => {
    const html = buildSectionsHtml([
      { name: 'Empty', description: '' },
      { name: 'Present', description: '<p>Has content.</p>' },
    ]);
    expect(html).not.toContain('Empty');
    expect(html).toContain('Present');
  });
});

// ─── buildFullDescription ─────────────────────────────────────────────────

describe('buildFullDescription', () => {
  it('combines teaser, sections, and requirements', () => {
    const result = buildFullDescription(
      '<p>Intro teaser.</p>',
      [{ name: 'Section', description: '<p>Main body content here.</p>' }],
      '<ul><li>Requirement one</li></ul>'
    );
    expect(result).toContain('Intro teaser');
    expect(result).toContain('Main body content here');
    expect(result).toContain('Requirement one');
  });

  it('returns empty string when all inputs are empty', () => {
    expect(buildFullDescription('', [], '')).toBe('');
  });

  it('produces plain text (no HTML tags)', () => {
    const result = buildFullDescription('<p>Test <b>bold</b>.</p>', [], '');
    expect(result).not.toMatch(/<[a-z]/i);
  });
});

// ─── stripHtml ────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('converts <br> to newline', () => {
    expect(stripHtml('<p>First<br>Second</p>')).toContain('\n');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

// ─── parseBullets ─────────────────────────────────────────────────────────

describe('parseBullets', () => {
  it('extracts li text as array', () => {
    const bullets = parseBullets('<ul><li>First item here</li><li>Second item here</li></ul>');
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toContain('First item here');
  });

  it('skips very short li items (< 10 chars)', () => {
    const bullets = parseBullets('<ul><li>Hi</li><li>Long enough item to be included</li></ul>');
    expect(bullets).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseBullets('')).toHaveLength(0);
  });
});
