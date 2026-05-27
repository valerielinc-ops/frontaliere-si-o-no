/**
 * Tests for the Giardino Group dedicated job crawler.
 *
 * Verifies:
 *   - WordPress REST API response parsing
 *   - HTML entity decoding (WordPress title.rendered)
 *   - Hotel detection from content text and WP categories
 *   - Location resolution (Champfèr / Ascona / Minusio)
 *   - Content section parsing (#aboutthejob, #aboutyou, #talentculture)
 *   - H1 title extraction from content HTML
 *   - Description building with structured sections
 *   - Company job identification
 *   - Trusted domain detection
 *   - Slug generation
 *   - Public URL construction
 */
import { describe, it, expect } from 'vitest';
import {
  GIARDINO_KEY,
  GIARDINO_COMPANY_NAME,
  GIARDINO_COMPANY_DOMAIN,
  isGiardinoJob,
  isTrustedDomain,
  decodeWpEntities,
  detectHotel,
  getHotelLocation,
  extractH1Title,
  parseContentSections,
  buildDescription,
  buildPublicUrl,
} from '../scripts/lib/giardino-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Sample WordPress API data ─────────────────────────────────────────────────

const STEWARD_CONTENT = `<div id="introduction">
<h3>#aboutus</h3>
<p>Die Giardino Hotels liegen alle in den schönsten Destinationen der Schweiz.</p>
<p>Für unser Hotel Giardino Lago in Minusio suchen wir <strong>ab</strong> <strong>Juni 2026 oder nach Vereinbarung</strong> eine/n:</p>
<h1>Steward</h1>
<h3>#aboutthejob</h3>
<p>In dieser Funktion bist du verantwortlich für die gesamte Sauberkeit im Backoffice und der Küche.</p>
</div>
<div id="tasks">
<h3></h3>
<h3>#aboutyou</h3>
<ul>
<li>Erfahrung in einer gleichwertigen Position</li>
<li>Belastbarkeit, Flexibilität und Begeisterungsfähigkeit</li>
<li>Teamplayer in hektischen Situationen</li>
</ul>
</div>
<div id="benefits">
<h3></h3>
<h3>#talentculture</h3>
<ul>
<li>Einen innovativen und gut organisierten Arbeitsplatz</li>
<li>Regelmässige Schulungen und Weiterbildungen</li>
</ul>
<h3>Kontakt</h3>
<p>Du bringst die Anforderungen mit? Dann bewirb dich jetzt.</p>
</div>`;

const CHILD_CARE_CONTENT = `<div id="introduction">
<h3>#aboutus</h3>
<p>Die Giardino Hotels liegen alle in den schönsten Destinationen der Schweiz.</p>
<p>Für unser Soul Retreat Giardino Ascona im Tessin suchen für die nächste <strong>Sommersaison</strong> eine/n:</p>
<h1>Child Care Attendant</h1>
<h3>#aboutthejob</h3>
<p>Zu deinen Aufgaben gehört die Betreuung von Kindern zwischen 3 bis 12 Jahren.</p>
</div>
<div id="tasks">
<h3>#aboutyou</h3>
<ul>
<li>Spass an der Arbeit mit Kindern</li>
<li>Erfahrung in vergleichbarer Position</li>
<li>Gute Deutsch- und Englischkenntnisse</li>
</ul>
</div>
<div id="benefits">
<h3>#talentculture</h3>
<ul>
<li>Einen innovativen und gut organisierten Arbeitsplatz</li>
</ul>
<h3>Kontakt</h3>
<p>Bewirb dich jetzt.</p>
</div>`;

const MOUNTAIN_CONTENT = `<div id="introduction">
<h3>#aboutus</h3>
<p>Das Giardino Mountain in Champfèr bei St. Moritz.</p>
<p>Für unser Alpine Hideaway Giardino Mountain in Champfèr suchen wir eine/n:</p>
<h1>Sous Chef</h1>
<h3>#aboutthejob</h3>
<p>Leitung des Küchenteams in Abwesenheit des Küchenchefs.</p>
</div>`;

// ─── Constants ──────────────────────────────────────────────────────────────────

describe('Giardino crawler constants', () => {
  it('has correct company key', () => {
    expect(GIARDINO_KEY).toBe('giardino');
  });

  it('has correct company name', () => {
    expect(GIARDINO_COMPANY_NAME).toBe('Giardino Group');
  });

  it('has correct company domain', () => {
    expect(GIARDINO_COMPANY_DOMAIN).toBe('giardinohotels.ch');
  });
});

// ─── WordPress entity decoding ──────────────────────────────────────────────────

describe('decodeWpEntities', () => {
  it('decodes en-dash entity', () => {
    expect(decodeWpEntities('Steward &#8211; Restaurant Lago')).toBe(
      'Steward \u2013 Restaurant Lago',
    );
  });

  it('decodes ampersand entities', () => {
    expect(decodeWpEntities('Foo &#038; Bar')).toBe('Foo & Bar');
    expect(decodeWpEntities('Foo &amp; Bar')).toBe('Foo & Bar');
  });

  it('strips backslashes from escaped content', () => {
    expect(decodeWpEntities('Chef de Partie (m\\/w)')).toBe(
      'Chef de Partie (m/w)',
    );
  });

  it('handles empty/null input', () => {
    expect(decodeWpEntities('')).toBe('');
    expect(decodeWpEntities(undefined as unknown as string)).toBe('');
  });

  it('decodes smart quotes', () => {
    expect(decodeWpEntities('&#8220;Title&#8221;')).toBe('\u201CTitle\u201D');
  });
});

// ─── Hotel detection ────────────────────────────────────────────────────────────

describe('detectHotel', () => {
  it('detects Giardino Lago from content text', () => {
    expect(detectHotel(STEWARD_CONTENT)).toBe('lago');
  });

  it('detects Giardino Ascona from content text', () => {
    expect(detectHotel(CHILD_CARE_CONTENT)).toBe('ascona');
  });

  it('detects Giardino Mountain from Champfèr mention', () => {
    expect(detectHotel(MOUNTAIN_CONTENT)).toBe('mountain');
  });

  it('detects Giardino Mountain from St. Moritz mention', () => {
    expect(detectHotel('<p>in St. Moritz suchen wir</p>')).toBe('mountain');
  });

  it('falls back to WP category for Ascona (674)', () => {
    expect(detectHotel('', [674])).toBe('ascona');
  });

  it('falls back to WP category for Locarno/Lago (676)', () => {
    expect(detectHotel('', [676])).toBe('lago');
  });

  it('defaults to mountain when no signals', () => {
    expect(detectHotel('')).toBe('mountain');
    expect(detectHotel('', [])).toBe('mountain');
  });

  it('content text takes priority over categories', () => {
    // Content says Ascona but category says Locarno
    expect(detectHotel(CHILD_CARE_CONTENT, [676])).toBe('ascona');
  });
});

// ─── Hotel location resolution ──────────────────────────────────────────────────

describe('getHotelLocation', () => {
  it('returns Champfèr for mountain', () => {
    const loc = getHotelLocation('mountain');
    expect(loc.city).toBe('Champfèr');
    expect(loc.canton).toBe('GR');
    expect(loc.postalCode).toBe('7512');
  });

  it('returns Ascona for ascona', () => {
    const loc = getHotelLocation('ascona');
    expect(loc.city).toBe('Ascona');
    expect(loc.canton).toBe('TI');
    expect(loc.postalCode).toBe('6612');
  });

  it('returns Minusio for lago', () => {
    const loc = getHotelLocation('lago');
    expect(loc.city).toBe('Minusio');
    expect(loc.canton).toBe('TI');
    expect(loc.postalCode).toBe('6648');
  });

  it('falls back to mountain for unknown key', () => {
    const loc = getHotelLocation('unknown');
    expect(loc.city).toBe('Champfèr');
  });
});

// ─── H1 title extraction ───────────────────────────────────────────────────────

describe('extractH1Title', () => {
  it('extracts Steward from content HTML', () => {
    expect(extractH1Title(STEWARD_CONTENT)).toBe('Steward');
  });

  it('extracts Child Care Attendant from content HTML', () => {
    expect(extractH1Title(CHILD_CARE_CONTENT)).toBe('Child Care Attendant');
  });

  it('extracts Sous Chef from content HTML', () => {
    expect(extractH1Title(MOUNTAIN_CONTENT)).toBe('Sous Chef');
  });

  it('returns empty for content without h1', () => {
    expect(extractH1Title('<p>No heading here</p>')).toBe('');
  });

  it('handles empty input', () => {
    expect(extractH1Title('')).toBe('');
    expect(extractH1Title(undefined as unknown as string)).toBe('');
  });
});

// ─── Content section parsing ────────────────────────────────────────────────────

describe('parseContentSections', () => {
  it('parses aboutJob from steward content', () => {
    const sections = parseContentSections(STEWARD_CONTENT);
    expect(sections.aboutJob).toContain('Sauberkeit im Backoffice');
  });

  it('parses aboutYou requirements', () => {
    const sections = parseContentSections(STEWARD_CONTENT);
    expect(sections.aboutYou).toHaveLength(3);
    expect(sections.aboutYou[0]).toContain('Erfahrung');
    expect(sections.aboutYou[1]).toContain('Belastbarkeit');
  });

  it('parses talentCulture benefits', () => {
    const sections = parseContentSections(STEWARD_CONTENT);
    expect(sections.talentCulture).toHaveLength(2);
    expect(sections.talentCulture[0]).toContain('innovativen');
  });

  it('parses child care content sections', () => {
    const sections = parseContentSections(CHILD_CARE_CONTENT);
    expect(sections.aboutJob).toContain('Betreuung von Kindern');
    expect(sections.aboutYou).toHaveLength(3);
    expect(sections.talentCulture).toHaveLength(1);
  });

  it('returns empty sections for empty content', () => {
    const sections = parseContentSections('');
    expect(sections.aboutJob).toBe('');
    expect(sections.aboutYou).toHaveLength(0);
    expect(sections.talentCulture).toHaveLength(0);
  });
});

// ─── Description building ───────────────────────────────────────────────────────

describe('buildDescription', () => {
  it('builds description with all sections', () => {
    const sections = parseContentSections(STEWARD_CONTENT);
    const desc = buildDescription(sections, 'Steward', 'lago', 'Minusio');

    expect(desc).toContain('Giardino Lago');
    expect(desc).toContain('Minusio');
    expect(desc).toContain('Steward');
    expect(desc).toContain('## Aufgaben');
    expect(desc).toContain('## Anforderungen');
    expect(desc).toContain('## Benefits');
  });

  it('includes hotel name for mountain', () => {
    const sections = { aboutJob: 'Test', aboutYou: [], talentCulture: [] };
    const desc = buildDescription(sections, 'Chef', 'mountain', 'Champfèr');
    expect(desc).toContain('Giardino Mountain');
    expect(desc).toContain('Champfèr');
  });

  it('formats requirements as bullet list', () => {
    const sections = {
      aboutJob: '',
      aboutYou: ['Requirement A', 'Requirement B'],
      talentCulture: [],
    };
    const desc = buildDescription(sections, 'Test', 'ascona', 'Ascona');
    expect(desc).toContain('- Requirement A');
    expect(desc).toContain('- Requirement B');
  });

  it('skips empty sections', () => {
    const sections = { aboutJob: '', aboutYou: [], talentCulture: [] };
    const desc = buildDescription(sections, 'Test', 'lago', 'Minusio');
    expect(desc).not.toContain('## Aufgaben');
    expect(desc).not.toContain('## Anforderungen');
    expect(desc).not.toContain('## Benefits');
  });
});

// ─── Public URL construction ────────────────────────────────────────────────────

describe('buildPublicUrl', () => {
  it('builds English URL from WP slug', () => {
    expect(buildPublicUrl('gl-steward-m-w')).toBe(
      'https://giardinohotels.ch/en/jobs/gl-steward-m-w/',
    );
  });

  it('builds URL for child care slug', () => {
    expect(buildPublicUrl('ga-child-care-attendant')).toBe(
      'https://giardinohotels.ch/en/jobs/ga-child-care-attendant/',
    );
  });
});

// ─── Job identification ─────────────────────────────────────────────────────────

describe('isGiardinoJob detection', () => {
  it('identifies by companyKey', () => {
    expect(isGiardinoJob({ companyKey: 'giardino' })).toBe(true);
  });

  it('identifies by company name (exact)', () => {
    expect(isGiardinoJob({ company: 'Giardino Group' })).toBe(true);
  });

  it('identifies by company name (Giardino Hotels)', () => {
    expect(isGiardinoJob({ company: 'Giardino Hotels AG' })).toBe(true);
  });

  it('identifies by URL domain', () => {
    expect(
      isGiardinoJob({
        url: 'https://giardinohotels.ch/en/jobs/gl-steward-m-w/',
      }),
    ).toBe(true);
  });

  it('rejects non-Giardino jobs', () => {
    expect(
      isGiardinoJob({
        companyKey: 'lonza',
        company: 'Lonza',
        url: 'https://lonza.com/job/123',
      }),
    ).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isGiardinoJob(null)).toBe(false);
    expect(isGiardinoJob(undefined)).toBe(false);
    expect(isGiardinoJob({})).toBe(false);
  });
});

// ─── Trusted domain check ───────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts giardinohotels.ch', () => {
    expect(
      isTrustedDomain('https://giardinohotels.ch/en/giardino-group/jobs/'),
    ).toBe(true);
  });

  it('trusts www.giardinohotels.ch', () => {
    expect(
      isTrustedDomain('https://www.giardinohotels.ch/en/jobs/test/'),
    ).toBe(true);
  });

  it('trusts subdomains', () => {
    expect(
      isTrustedDomain('https://careers.giardinohotels.ch/job/456'),
    ).toBe(true);
  });

  it('rejects untrusted domains', () => {
    expect(isTrustedDomain('https://malicious-site.com/giardinohotels')).toBe(
      false,
    );
  });

  it('handles invalid URLs gracefully', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
    expect(isTrustedDomain('')).toBe(false);
  });
});

// ─── Slug generation ────────────────────────────────────────────────────────────

describe('slug generation', () => {
  it('generates slug for German job title with company', () => {
    const slug = slugify('Steward giardino-group Minusio');
    expect(slug).toBe('steward-giardino-group-minusio');
  });

  it('generates slug for English job title', () => {
    const slug = slugify('Child Care Attendant giardino-group Ascona');
    expect(slug).toBe('child-care-attendant-giardino-group-ascona');
  });

  it('handles special characters in Chef de Partie', () => {
    const slug = slugify('Chef de Partie giardino-group Minusio');
    expect(slug).toBe('chef-de-partie-giardino-group-minusio');
  });

  it('handles Champfèr diacritics', () => {
    const slug = slugify('Sous Chef giardino-group Champfèr');
    expect(slug).toBe('sous-chef-giardino-group-champfer');
  });

  it('respects max length', () => {
    const longTitle = 'A'.repeat(200);
    expect(slugify(longTitle).length).toBeLessThanOrEqual(90);
  });
});

// ─── WordPress API response structure ───────────────────────────────────────────

describe('WordPress API response structure', () => {
  const SAMPLE_WP_JOB = {
    id: 20638,
    date: '2025-05-19T15:39:32',
    modified: '2026-02-20T12:20:48',
    slug: 'gl-steward-m-w',
    status: 'publish',
    title: { rendered: 'Steward &#8211; Restaurant Lago (m\\/w)' },
    content: { rendered: STEWARD_CONTENT },
    categories: [670, 677, 676, 668],
  };

  it('has required WordPress fields', () => {
    expect(SAMPLE_WP_JOB.id).toBeTruthy();
    expect(SAMPLE_WP_JOB.title.rendered).toBeTruthy();
    expect(SAMPLE_WP_JOB.slug).toBeTruthy();
    expect(SAMPLE_WP_JOB.content.rendered).toBeTruthy();
  });

  it('title.rendered contains HTML entities', () => {
    expect(SAMPLE_WP_JOB.title.rendered).toContain('&#8211;');
  });

  it('decoded title is clean text', () => {
    const decoded = decodeWpEntities(SAMPLE_WP_JOB.title.rendered);
    expect(decoded).toContain('Steward');
    expect(decoded).toContain('Restaurant Lago');
    expect(decoded).not.toContain('&#');
  });

  it('content contains #aboutthejob section', () => {
    expect(SAMPLE_WP_JOB.content.rendered).toContain('#aboutthejob');
  });

  it('content contains #aboutyou section', () => {
    expect(SAMPLE_WP_JOB.content.rendered).toContain('#aboutyou');
  });

  it('content contains #talentculture section', () => {
    expect(SAMPLE_WP_JOB.content.rendered).toContain('#talentculture');
  });

  it('categories include department and resort IDs', () => {
    expect(SAMPLE_WP_JOB.categories).toContain(670); // Department
    expect(SAMPLE_WP_JOB.categories).toContain(676); // Locarno
  });
});

// ─── Full job shape validation ──────────────────────────────────────────────────

describe('job shape', () => {
  const validJob = {
    id: 'giardino-abc123def456',
    slug: 'steward-giardino-group-minusio',
    slugByLocale: { de: 'steward-giardino-group-minusio' },
    company: 'Giardino Group',
    companyKey: 'giardino',
    companyDomain: 'giardinohotels.ch',
    title: 'Steward',
    titleByLocale: { de: 'Steward' },
    description: 'Giardino Group sucht für das Giardino Lago in Minusio eine/n Steward.',
    descriptionByLocale: {
      de: 'Giardino Group sucht für das Giardino Lago in Minusio eine/n Steward.',
    },
    location: 'Minusio',
    canton: 'TI',
    url: 'https://giardinohotels.ch/en/jobs/gl-steward-m-w/',
    source: 'Giardino Group Dedicated Parser',
    sourceLang: 'de',
    crawledAt: new Date().toISOString(),
    addressLocality: 'Minusio',
    postalCode: '6648',
    addressRegion: 'TI',
    addressCountry: 'CH',
    country: 'CH',
    sector: 'Ospitalità / Hotellerie',
    employmentType: 'FULL_TIME',
    currency: 'CHF',
  };

  it('has all required fields', () => {
    const required = [
      'id',
      'slug',
      'slugByLocale',
      'company',
      'companyKey',
      'title',
      'titleByLocale',
      'description',
      'descriptionByLocale',
      'location',
      'canton',
      'url',
      'source',
      'sourceLang',
      'crawledAt',
    ];
    for (const field of required) {
      expect(validJob).toHaveProperty(field);
    }
  });

  it('slug only contains source locale (de)', () => {
    const locales = Object.keys(validJob.slugByLocale);
    expect(locales).toHaveLength(1);
    expect(locales[0]).toBe('de');
  });

  it('id starts with company key', () => {
    expect(validJob.id).toMatch(/^giardino-/);
  });

  it('slug is URL-safe', () => {
    expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('canton is valid Swiss canton code', () => {
    expect(validJob.canton).toMatch(/^(GR|TI)$/);
  });

  it('sector is hospitality', () => {
    expect(validJob.sector).toBe('Ospitalità / Hotellerie');
  });

  it('URL points to English jobs page', () => {
    expect(validJob.url).toMatch(
      /^https:\/\/giardinohotels\.ch\/en\/jobs\/[a-z0-9-]+\/$/,
    );
  });

  it('has postal code', () => {
    expect(validJob.postalCode).toMatch(/^\d{4}$/);
  });
});
