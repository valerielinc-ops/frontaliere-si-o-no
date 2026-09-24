/**
 * Tests for the Giardino Group dedicated job crawler.
 *
 * Verifies:
 *   - Giardino Talents microsite parsing (board + detail page), the source
 *     since the WordPress jobs route went empty (issue #6694)
 *   - Source-proven empty board vs an unrecognised page
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
  buildEnglishIndex,
  jobTitleKey,
  resolvePublicUrl,
  detectTalentsHotel,
  parseTalentsListing,
  parseTalentsJobPage,
  fetchAllGiardinoJobs,
  TALENTS_URL,
  TALENTS_EN_URL,
} from '../scripts/lib/giardino-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';

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

describe('jobTitleKey', () => {
  it('matches the German and English gender markers of the same post', () => {
    expect(jobTitleKey('Steward (m/w)')).toBe(jobTitleKey('Steward (m/f)'));
  });

  it('decodes WP entities before normalizing', () => {
    expect(jobTitleKey('Reservations &amp; Front Office Specialist (m/w)')).toBe(
      'reservations front office specialist',
    );
  });

  it('keeps distinct roles distinct', () => {
    expect(jobTitleKey('Chef de Rang (m/w)')).not.toBe(
      jobTitleKey('Chef de Rang Ecco (m/w)'),
    );
  });
});

// The English listing carries its own WPML slugs; only entries present there
// have a real /en/ permalink.
const EN_LISTINGS = [
  {
    slug: 'staff-cook-m-f',
    link: 'https://giardinohotels.ch/en/jobs/staff-cook-m-f/',
    title: { rendered: 'Staff Cook (m/f)' },
  },
  {
    slug: 'steward-m-f',
    link: 'https://giardinohotels.ch/en/jobs/steward-m-f/',
    title: { rendered: 'Steward (m/f)' },
  },
  {
    slug: 'ga-child-care-attendant',
    link: 'https://giardinohotels.ch/en/jobs/ga-child-care-attendant/',
    title: { rendered: 'Child Care Attendant (m/f)' },
  },
];

describe('buildEnglishIndex', () => {
  it('indexes by slug and by title key', () => {
    const index = buildEnglishIndex(EN_LISTINGS);
    expect(index.bySlug.get('steward-m-f')).toBe(
      'https://giardinohotels.ch/en/jobs/steward-m-f/',
    );
    expect(index.byTitle.get('staff cook')).toBe(
      'https://giardinohotels.ch/en/jobs/staff-cook-m-f/',
    );
  });

  it('drops ambiguous title keys rather than guessing', () => {
    const index = buildEnglishIndex([
      ...EN_LISTINGS,
      {
        slug: 'gm-steward-m-f',
        link: 'https://giardinohotels.ch/en/jobs/gm-steward-m-f/',
        title: { rendered: 'Steward (m/f)' },
      },
    ]);
    expect(index.byTitle.has('steward')).toBe(false);
    expect(index.bySlug.get('gm-steward-m-f')).toBe(
      'https://giardinohotels.ch/en/jobs/gm-steward-m-f/',
    );
  });

  it('ignores entries from an untrusted domain', () => {
    const index = buildEnglishIndex([
      { slug: 'evil', link: 'https://malicious-site.com/en/jobs/evil/', title: { rendered: 'Evil' } },
    ]);
    expect(index.bySlug.size).toBe(0);
  });

  it('tolerates a missing English listing', () => {
    expect(buildEnglishIndex([]).bySlug.size).toBe(0);
    expect(buildEnglishIndex(undefined).byTitle.size).toBe(0);
  });

  // Slug prefissati per hotel (`gm-`/`gl-`) ma titoli nudi: due annunci TEDESCHI
  // collassano sullo stesso title-key. Se solo uno e' tradotto, il ramo byTitle
  // manderebbe entrambi sull'unico link inglese — apply link di un ALTRO hotel.
  it('drops title keys ambiguous on the GERMAN side too', () => {
    const deListings = [
      { slug: 'gm-steward', title: { rendered: 'Steward (m/w)' } },
      { slug: 'gl-steward-m-w', title: { rendered: 'Steward (m/w)' } },
    ];
    const index = buildEnglishIndex(EN_LISTINGS, deListings);
    expect(index.byTitle.has('steward')).toBe(false);
    // lo slug-exact resta intatto: e' una corrispondenza univoca, non un indovinello
    expect(index.bySlug.get('steward-m-f')).toBe(
      'https://giardinohotels.ch/en/jobs/steward-m-f/',
    );
  });

  it('keeps title keys unique on the German side', () => {
    const index = buildEnglishIndex(EN_LISTINGS, [
      { slug: 'staff-cook-m-w', title: { rendered: 'Staff Cook (m/w)' } },
    ]);
    expect(index.byTitle.get('staff cook')).toBe(
      'https://giardinohotels.ch/en/jobs/staff-cook-m-f/',
    );
  });

  it('a German collision makes the untranslated ad fall back to its German permalink', () => {
    const deListings = [
      { slug: 'gm-steward', title: { rendered: 'Steward (m/w)' } },
      { slug: 'gl-steward-m-w', title: { rendered: 'Steward (m/w)' } },
    ];
    const index = buildEnglishIndex(EN_LISTINGS, deListings);
    // 'gl-steward-m-w' non e' tradotto: senza il de-dup bilaterale avrebbe
    // ereditato il permalink inglese di un altro hotel.
    expect(
      resolvePublicUrl(
        {
          slug: 'gl-steward-m-w',
          title: { rendered: 'Steward (m/w)' },
          link: 'https://giardinohotels.ch/de/jobs/gl-steward-m-w/',
        },
        index,
      ),
    ).toBe('https://giardinohotels.ch/de/jobs/gl-steward-m-w/');
  });
});

describe('resolvePublicUrl', () => {
  const index = buildEnglishIndex(EN_LISTINGS);

  it('uses the English permalink when the slug matches exactly', () => {
    expect(
      resolvePublicUrl(
        {
          slug: 'ga-child-care-attendant',
          link: 'https://giardinohotels.ch/de/jobs/ga-child-care-attendant/',
          title: { rendered: 'Child Care Attendant (m/w)' },
        },
        index,
      ),
    ).toBe('https://giardinohotels.ch/en/jobs/ga-child-care-attendant/');
  });

  it('finds the translation whose slug differs (staff-cook-m-w -> staff-cook-m-f)', () => {
    expect(
      resolvePublicUrl(
        {
          slug: 'staff-cook-m-w',
          link: 'https://giardinohotels.ch/de/jobs/staff-cook-m-w/',
          title: { rendered: 'Staff Cook (m/w)' },
        },
        index,
      ),
    ).toBe('https://giardinohotels.ch/en/jobs/staff-cook-m-f/');
  });

  it('finds the translation whose slug prefix differs (gm-steward -> steward-m-f)', () => {
    expect(
      resolvePublicUrl(
        {
          slug: 'gm-steward',
          link: 'https://giardinohotels.ch/de/jobs/gm-steward/',
          title: { rendered: 'Steward (m/w)' },
        },
        index,
      ),
    ).toBe('https://giardinohotels.ch/en/jobs/steward-m-f/');
  });

  it('falls back to the German permalink when the post is untranslated', () => {
    expect(
      resolvePublicUrl(
        {
          slug: 'restaurant-manager-m-w',
          link: 'https://giardinohotels.ch/de/jobs/restaurant-manager-m-w/',
          title: { rendered: 'Restaurant Manager &#8211; Fine Dining Restaurant Ecco' },
        },
        index,
      ),
    ).toBe('https://giardinohotels.ch/de/jobs/restaurant-manager-m-w/');
  });

  it('never pastes a German slug into the /en/ path', () => {
    const url = resolvePublicUrl(
      {
        slug: 'gm-chef-de-rang',
        link: 'https://giardinohotels.ch/de/jobs/gm-chef-de-rang/',
        title: { rendered: 'Chef de Rang (m/w)' },
      },
      index,
    );
    expect(url).not.toContain('/en/jobs/gm-chef-de-rang/');
    expect(url).toBe('https://giardinohotels.ch/de/jobs/gm-chef-de-rang/');
  });

  it('resolves a bare German file name against the German Talents board', () => {
    expect(
      resolvePublicUrl({ slug: 'job-chef-de-rang.html', title: { rendered: 'Chef de Rang (m/w)' } }, index),
    ).toBe('https://giardinohotels.ch/talents/job-chef-de-rang.html');
  });

  it('degrades to the German permalink when the English listing is unavailable', () => {
    expect(
      resolvePublicUrl(
        {
          slug: 'staff-cook-m-w',
          link: 'https://giardinohotels.ch/de/jobs/staff-cook-m-w/',
          title: { rendered: 'Staff Cook (m/w)' },
        },
        buildEnglishIndex([]),
      ),
    ).toBe('https://giardinohotels.ch/de/jobs/staff-cook-m-w/');
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

// ─── Giardino Talents microsite (issue #6694) ───────────────────────────────────
//
// The WordPress jobs route now answers `[]` (X-WP-Total: 0) while the Talents
// microsite lists the open positions. Synthetic fixtures below reproduce the
// microsite's markup shape (JOBS-START/JOBS-ENDE block, `job-card` anchors,
// `jobs-count`, JSON-LD JobPosting, `<span class="hash">#</span>` headings);
// names, contacts and copy are invented.

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const talentsCard = (file: string, loc: string, dep: string, title: string) =>
  `<a class="job-card" data-job data-loc="${loc}" data-dep="${dep}" href="${file}">`
  + `<span class="job-badges"><span class="job-badge loc">X</span></span><h3>${title}</h3>`
  + '<ul class="job-benefits"><li>Highlight</li></ul><span class="job-more">View</span></a>';

const talentsBoard = (cards: string[], count: number | null = cards.length) => `<!doctype html><html><body>
<nav><a href="index.html">Home</a><a href="#stellen">Stellen</a></nav>
<section id="stellen"><div class="filter">${
  count === null ? '' : `<p class="filter-count"><strong id="jobs-count">${count}</strong> offene Stellen</p>`
}</div>
<div class="jobs-grid"><!--JOBS-START-->${cards.join('')}<!--JOBS-ENDE--></div></section>
<a href="job-not-a-card.html">stray link</a></body></html>`;

const talentsJobPage = ({
  h1,
  ldTitle,
  intro,
  datePosted,
}: { h1: string; ldTitle: string; intro: string; datePosted: string }) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: ldTitle,
  employmentType: 'FULL_TIME',
  hiringOrganization: { '@type': 'Organization', name: 'Giardino Group' },
  datePosted,
})}</script></head><body><main>
<section class="job-hero"><div><h1>${h1}</h1><p class="lead">Lead.</p></div></section>
<section><div class="aboutus"><p class="eyebrow"><span class="num">#</span>aboutus</p>
<p class="big">Das Haus steht für Gastfreundschaft.</p><p class="intro">${intro}</p></div></section>
<section><div class="container detail-grid"><div><div>
<h2 class="detail-h"><span class="hash">#</span>aboutthejob</h2>
<p class="detail-text">Du betreust unsere Gäste mit Leidenschaft.</p>
<p class="detail-text">Du arbeitest eng mit der Küche zusammen.</p></div>
<div><h2 class="detail-h"><span class="hash">#</span>aboutyou</h2>
<ul class="detail-list"><li>Berufsausbildung in der Hotellerie</li><li>Sehr gute Deutschkenntnisse</li></ul></div></div>
<aside class="offer"><div class="offer-box"><h2 class="detail-h"><span class="hash">#</span>talentculture</h2>
<ul><li>Regelmässige Schulungen</li><li>Mitarbeiterbenefits</li></ul></div></aside></div></section>
</main></body></html>`;

const DE_BOARD = talentsBoard([
  talentsCard('job-restaurant-manager.html', 'ascona stmoritz', 'service', 'Restaurant Manager (m/w)'),
  talentsCard('job-night-auditor.html', 'stmoritz', 'frontoffice', 'Night Auditor (m/w)'),
  talentsCard('job-rang-hide-seek.html', 'lago', 'service', 'Chef de Rang - 50% Hide &amp; Seek (m/w)'),
]);
// The English board renames one ad's file (as the live one does:
// job-night-auditor.html ↔ job-chef-de-partie-kopie.html) and leaves one out.
const EN_BOARD = talentsBoard([
  talentsCard('job-restaurant-manager.html', 'ascona stmoritz', 'service', 'Restaurant Manager (m/f)'),
  talentsCard('job-chef-de-partie-kopie.html', 'stmoritz', 'frontoffice', 'Night Auditor (m/f)'),
]);
const POSTED = isoDaysAgo(5);
const DETAIL_PAGES: Record<string, string> = {
  [`${TALENTS_URL}job-restaurant-manager.html`]: talentsJobPage({
    h1: 'Restaurant Manager (m/w)',
    ldTitle: 'Restaurant Manager',
    intro: 'Für unser Restaurant im Hotel Giardino Mountain in Champfèr-St.Moritz suchen wir eine/n Restaurant Manager.',
    datePosted: POSTED,
  }),
  [`${TALENTS_URL}job-night-auditor.html`]: talentsJobPage({
    h1: 'Night Auditor (m/w)',
    ldTitle: 'Night Auditor',
    intro: 'Für die Wintersaison suchen wir eine/n Night Auditor.',
    datePosted: POSTED,
  }),
};

function stubFetchPage(pages: Record<string, string>) {
  const requested: string[] = [];
  const fetchPage = async (url: string) => {
    requested.push(url);
    if (url in pages) return pages[url];
    throw new Error(`HTTP 404 from ${url}`);
  };
  return { fetchPage, requested };
}

describe('parseTalentsListing', () => {
  it('reads every job card of the board, and nothing outside it', () => {
    const listing = parseTalentsListing(DE_BOARD, TALENTS_URL);
    expect(listing.recognized).toBe(true);
    expect(listing.declaredCount).toBe(3);
    expect(listing.cards.map((c) => c.file)).toEqual([
      'job-restaurant-manager.html',
      'job-night-auditor.html',
      'job-rang-hide-seek.html',
    ]);
    expect(listing.cards[0]).toMatchObject({
      url: 'https://giardinohotels.ch/talents/job-restaurant-manager.html',
      title: 'Restaurant Manager',
      rawTitle: 'Restaurant Manager (m/w)',
      locKeys: ['ascona', 'stmoritz'],
      department: 'service',
    });
    expect(listing.cards[2].title).toBe('Chef de Rang - 50% Hide & Seek');
  });

  it('resolves English cards against the English board', () => {
    const listing = parseTalentsListing(EN_BOARD, TALENTS_EN_URL);
    expect(listing.cards[1].url).toBe('https://giardinohotels.ch/talents/en/job-chef-de-partie-kopie.html');
  });

  it('does not recognise a page without the JOBS block (redirect to the homepage, redesign)', () => {
    const listing = parseTalentsListing('<html><body><h1>Welcome</h1><a class="job-card" href="job-x.html"><h3>X</h3></a></body></html>');
    expect(listing.recognized).toBe(false);
    expect(listing.cards).toEqual([]);
  });

  it('skips duplicate cards and hrefs that are not job pages', () => {
    const listing = parseTalentsListing(talentsBoard([
      talentsCard('job-a-role.html', 'ascona', 'service', 'A Role (m/w)'),
      talentsCard('job-a-role.html', 'ascona', 'service', 'A Role (m/w)'),
      talentsCard('https://evil.example/job-b.html', 'ascona', 'service', 'B Role (m/w)'),
      talentsCard('index.html#stellen', 'ascona', 'service', 'C Role (m/w)'),
    ]), TALENTS_URL);
    expect(listing.cards.map((c) => c.file)).toEqual(['job-a-role.html']);
  });
});

describe('parseTalentsJobPage', () => {
  const page = parseTalentsJobPage(DETAIL_PAGES[`${TALENTS_URL}job-restaurant-manager.html`]);

  it('takes the title from the <h1>, not from the non-unique JSON-LD title', () => {
    const other = parseTalentsJobPage(talentsJobPage({
      h1: 'Chef de Rang - 50% Hide &amp; Seek (m/w)',
      ldTitle: 'Chef de Rang',
      intro: '',
      datePosted: POSTED,
    }));
    expect(other?.title).toBe('Chef de Rang - 50% Hide & Seek');
    expect(page?.title).toBe('Restaurant Manager');
  });

  it('reads intro, datePosted and the three sections of the microsite markup', () => {
    expect(page?.intro).toContain('Giardino Mountain');
    expect(page?.datePosted).toBe(POSTED);
    expect(page?.sections.aboutJob).toContain('Du betreust unsere Gäste');
    expect(page?.sections.aboutJob).toContain('eng mit der Küche');
    expect(page?.sections.aboutYou).toEqual(['Berufsausbildung in der Hotellerie', 'Sehr gute Deutschkenntnisse']);
    expect(page?.sections.talentCulture).toEqual(['Regelmässige Schulungen', 'Mitarbeiterbenefits']);
  });

  it('returns null on a page without a JobPosting (an unknown job page redirects to the board)', () => {
    expect(parseTalentsJobPage(DE_BOARD)).toBeNull();
  });
});

describe('detectTalentsHotel', () => {
  it('prefers the hotel named by the intro', () => {
    expect(detectTalentsHotel('im Hotel Giardino Ascona suchen wir', ['stmoritz'])).toBe('ascona');
  });

  it('falls back to the card data-loc keys', () => {
    expect(detectTalentsHotel('', ['ascona', 'stmoritz'])).toBe('ascona');
    expect(detectTalentsHotel('Für die Wintersaison.', ['stmoritz'])).toBe('mountain');
    expect(detectTalentsHotel('', ['lago'])).toBe('lago');
  });

  it('defaults to the company HQ', () => {
    expect(detectTalentsHotel('', [])).toBe('mountain');
  });
});

describe('fetchAllGiardinoJobs — Talents board (issue #6694)', () => {
  it('builds the ads from the Talents board, never from the empty WordPress route', async () => {
    const { fetchPage, requested } = stubFetchPage({
      [TALENTS_URL]: DE_BOARD,
      [TALENTS_EN_URL]: EN_BOARD,
      ...DETAIL_PAGES,
    });
    const jobs = await fetchAllGiardinoJobs({ fetchPage });

    expect(jobs).toHaveLength(3);
    expect(requested.some((url) => url.includes('wp-json'))).toBe(false);

    const [manager, auditor, rang] = jobs;
    expect(manager).toMatchObject({
      title: 'Restaurant Manager',
      location: 'Champfèr',
      canton: 'GR',
      postedDate: POSTED,
      url: 'https://giardinohotels.ch/talents/en/job-restaurant-manager.html',
      requirements: ['Berufsausbildung in der Hotellerie', 'Sehr gute Deutschkenntnisse'],
      sourceLang: 'de',
      companyKey: 'giardino',
    });
    expect(manager.description).toContain('## Anforderungen');
    expect(manager.id).toMatch(/^giardino-[0-9a-f]{12}$/);

    // Translated under another file name: matched by title, not pasted.
    expect(auditor.url).toBe('https://giardinohotels.ch/talents/en/job-chef-de-partie-kopie.html');

    // Detail page unavailable and no English twin: the card alone still
    // carries title, hotel (data-loc) and the German permalink.
    expect(rang).toMatchObject({
      title: 'Chef de Rang - 50% Hide & Seek',
      location: 'Minusio',
      canton: 'TI',
      url: 'https://giardinohotels.ch/talents/job-rang-hide-seek.html',
    });
    expect(new Set(jobs.map((j) => j.id)).size).toBe(3);
  });

  it('degrades to German permalinks when the English board fails', async () => {
    const { fetchPage } = stubFetchPage({ [TALENTS_URL]: DE_BOARD, ...DETAIL_PAGES });
    const jobs = await fetchAllGiardinoJobs({ fetchPage });
    expect(jobs.map((j) => j.url)).toEqual([
      'https://giardinohotels.ch/talents/job-restaurant-manager.html',
      'https://giardinohotels.ch/talents/job-night-auditor.html',
      'https://giardinohotels.ch/talents/job-rang-hide-seek.html',
    ]);
  });

  it('publishes a source-proven zero when the board renders 0 positions and no card', async () => {
    const { fetchPage } = stubFetchPage({ [TALENTS_URL]: talentsBoard([], 0) });
    const jobs = await fetchAllGiardinoJobs({ fetchPage });
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
  });

  it('does NOT prove a zero on an unrecognised page', async () => {
    const { fetchPage } = stubFetchPage({ [TALENTS_URL]: '<html><body><h1>Welcome home</h1></body></html>' });
    const jobs = await fetchAllGiardinoJobs({ fetchPage });
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('does NOT prove a zero when the board declares positions no card parses', async () => {
    const { fetchPage } = stubFetchPage({ [TALENTS_URL]: talentsBoard([], 2) });
    const jobs = await fetchAllGiardinoJobs({ fetchPage });
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('does NOT prove a zero when the rendered count is missing', async () => {
    const { fetchPage } = stubFetchPage({ [TALENTS_URL]: talentsBoard([], null) });
    const jobs = await fetchAllGiardinoJobs({ fetchPage });
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('propagates a failed board fetch instead of swallowing it', async () => {
    const { fetchPage } = stubFetchPage({});
    await expect(fetchAllGiardinoJobs({ fetchPage })).rejects.toThrow(/HTTP 404/);
  });
});
