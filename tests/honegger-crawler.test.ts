/**
 * Tests for the Honegger AG dedicated job crawler.
 *
 * Honegger AG (honegger.ch) runs a custom WordPress "jobs" post type —
 * no shared ATS factory applies. Verifies:
 *   - Listing page parsing (WP query-loop <li> blocks)
 *   - Detail page parsing (taxonomy terms: job-kategorie/standorte/beschaetigungsgrade)
 *   - Multi-location taxonomy term extraction + primary-location picking
 *   - Liechtenstein-branch location handling (Schaan/Mühleholz excluded upstream)
 *   - HTML entity decoding
 *   - Workload percentage extraction
 *   - Category/experience-level detection
 *   - Description building from structured sections
 *   - Company job identification + trusted domain detection
 */
import { describe, it, expect } from 'vitest';
import {
  HONEGGER_KEY,
  HONEGGER_COMPANY_NAME,
  HONEGGER_COMPANY_DOMAIN,
  STANDORT_LOCATIONS,
  EXCLUDED_LOCATION_SLUGS,
  isHoneggerJob,
  isTrustedDomain,
  decodeWpEntities,
  extractPensum,
  detectCategory,
  detectExperienceLevel,
  pickPrimaryLocationSlug,
  parseHoneggerListingPage,
  parseHoneggerDetailPage,
  buildDescription,
} from '../scripts/lib/honegger-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Sample listing page HTML (WP query-loop) ──────────────────────────────

const LISTING_HTML = `<ul class="wp-block-query">
<li class="wp-block-post post-101 jobs type-jobs status-publish standorte-sarnen beschaetigungsgrade-40-50 positionen-mitarbeiter job-kategorie-unterhaltsreinigung">
  <h2 class="wp-block-post-title has-large-font-size">Mitarbeiter/in Reinigung (m/w/d) Sarnen 40-50%</h2>
  <div class="hon-excerpt-list-jobs">
    <p class="wp-block-post-excerpt__excerpt">Wir suchen per sofort eine motivierte Reinigungskraft für unseren Standort Sarnen.</p>
    <p class="wp-block-post-excerpt__more-text">
      <a class="wp-block-post-excerpt__more-link" href="https://honegger.ch/job/mitarbeiter-in-reinigung-m-w-d-sarnen-40-50/">Mehr erfahren</a>
    </p>
  </div>
</li>
<li class="wp-block-post post-102 jobs type-jobs status-publish standorte-adliswil standorte-horgen standorte-rapperswil-2 standorte-waedenswil beschaetigungsgrade-10-50 positionen-mitarbeiter job-kategorie-unterhaltsreinigung">
  <h2 class="wp-block-post-title has-large-font-size">Unterhaltsreiniger/in (m/w/d) Adliswil, Horgen, Rapperswil, Wädenswil 10-50%</h2>
  <div class="hon-excerpt-list-jobs">
    <p class="wp-block-post-excerpt__excerpt">Für mehrere Einsatzorte in der Region Zürichsee suchen wir Verstärkung.</p>
    <p class="wp-block-post-excerpt__more-text">
      <a class="wp-block-post-excerpt__more-link" href="https://honegger.ch/job/unterhaltsreiniger-in-m-w-d-adliswil-horgen-rapperswil-waedenswil-10-50/">Mehr erfahren</a>
    </p>
  </div>
</li>
<li class="wp-block-post post-103 jobs type-jobs status-publish standorte-schaan beschaetigungsgrade-100 positionen-mitarbeiter job-kategorie-facility-management">
  <h2 class="wp-block-post-title has-large-font-size">Facility Manager (m/w/d) Schaan 100%</h2>
  <div class="hon-excerpt-list-jobs">
    <p class="wp-block-post-excerpt__excerpt">Für unseren Standort in Schaan (FL) suchen wir eine Facility-Management-Fachperson.</p>
    <p class="wp-block-post-excerpt__more-text">
      <a class="wp-block-post-excerpt__more-link" href="https://honegger.ch/job/facility-manager-m-w-d-schaan-100/">Mehr erfahren</a>
    </p>
  </div>
</li>
</ul>`;

// ─── Sample detail page HTML — single location ─────────────────────────────

const DETAIL_HTML_SINGLE = `<html><head>
<meta property="article:published_time" content="2026-06-01T09:00:00+00:00">
<meta property="article:modified_time" content="2026-06-20T08:00:00+00:00">
</head><body>
<h2 class="wp-block-heading has-deepwhite-color has-text-color has-xx-large-font-size">Mitarbeiter/in Reinigung (m/w/d)</h2>
<div class="taxonomy-job-kategorie has-link-color wp-block-post-terms"><a href="https://honegger.ch/job-kategorie/unterhaltsreinigung/" rel="tag">Unterhaltsreinigung</a></div>
<p class="hon-inline-image-spez"><img src="/wp-content/uploads/abwann.svg" alt="">01.08.2026 oder nach Vereinbarung</p>
<div class="taxonomy-standorte has-link-color hon-inline-image-spez wp-block-post-terms"><a href="https://honegger.ch/standort/sarnen/" rel="tag">Sarnen</a></div>
<div class="taxonomy-beschaetigungsgrade has-link-color wp-block-post-terms"><a href="https://honegger.ch/beschaetigungsgrad/40-50/" rel="tag">40 – 50%</a></div>
<h2 class="wp-block-heading">Das kannst du bei uns bewirken</h2>
<ul class="wp-block-list hon-list">
<li>Reinigung von Büro- und Sanitärräumen</li>
<li>Selbstständige Einteilung deiner Arbeiten</li>
</ul>
<h2 class="wp-block-heading">Das bringst du mit</h2>
<ul class="wp-block-list hon-list">
<li>Erfahrung im Reinigungsbereich von Vorteil</li>
<li>Zuverlässigkeit und Genauigkeit</li>
</ul>
<h2 class="wp-block-heading">Wir als Arbeitgeber</h2>
<ul class="wp-block-list hon-list">
<li>Faire Anstellungsbedingungen</li>
<li>Einführung und Einarbeitung</li>
</ul>
</body></html>`;

// ─── Sample detail page HTML — multi-location ──────────────────────────────

const DETAIL_HTML_MULTI = `<html><head>
<meta property="article:modified_time" content="2026-06-26T06:24:51+00:00">
</head><body>
<h2 class="wp-block-heading has-deepwhite-color has-text-color has-xx-large-font-size">Unterhaltsreiniger/in (m/w/d)</h2>
<div class="taxonomy-job-kategorie has-link-color wp-block-post-terms"><a href="https://honegger.ch/job-kategorie/unterhaltsreinigung/" rel="tag">Unterhaltsreinigung</a></div>
<p class="hon-inline-image-spez"><img src="/wp-content/uploads/abwann.svg" alt="">Nach Vereinbarung</p>
<div class="taxonomy-standorte has-link-color hon-inline-image-spez wp-block-post-terms"><span class="wp-block-post-terms__prefix"><img src="wo.svg"></span><a href="https://honegger.ch/standort/adliswil/" rel="tag">Adliswil</a><span class="wp-block-post-terms__separator">, </span><a href="https://honegger.ch/standort/horgen/" rel="tag">Horgen</a><span class="wp-block-post-terms__separator">, </span><a href="https://honegger.ch/standort/rapperswil-2/" rel="tag">Rapperswil</a><span class="wp-block-post-terms__separator">, </span><a href="https://honegger.ch/standort/waedenswil/" rel="tag">Wädenswil</a></div>
<div class="taxonomy-beschaetigungsgrade has-link-color wp-block-post-terms"><a href="https://honegger.ch/beschaetigungsgrad/10-50/" rel="tag">10 – 50%</a></div>
<h2 class="wp-block-heading">Das kannst du bei uns bewirken</h2>
<ul class="wp-block-list hon-list">
<li>Unterhaltsreinigung an mehreren Einsatzorten</li>
</ul>
</body></html>`;

// ─── Constants ──────────────────────────────────────────────────────────────

describe('Honegger crawler constants', () => {
  it('has correct company key', () => {
    expect(HONEGGER_KEY).toBe('honegger');
  });

  it('has correct company name', () => {
    expect(HONEGGER_COMPANY_NAME).toBe('Honegger AG');
  });

  it('has correct company domain', () => {
    expect(HONEGGER_COMPANY_DOMAIN).toBe('honegger.ch');
  });

  it('excludes Liechtenstein branch slugs from the CH location map', () => {
    expect(STANDORT_LOCATIONS.schaan).toBeUndefined();
    expect(STANDORT_LOCATIONS.muehleholz).toBeUndefined();
    expect(EXCLUDED_LOCATION_SLUGS.has('schaan')).toBe(true);
    expect(EXCLUDED_LOCATION_SLUGS.has('muehleholz')).toBe(true);
  });
});

// ─── HTML entity decoding ───────────────────────────────────────────────────

describe('decodeWpEntities', () => {
  it('decodes en-dash entity', () => {
    expect(decodeWpEntities('40 &#8211; 50%')).toBe('40 – 50%');
  });

  it('decodes ampersand and quote entities', () => {
    expect(decodeWpEntities('Facility &amp; Cleaning &#8217;Services&#8217;')).toBe(
      "Facility & Cleaning ’Services’",
    );
  });

  it('handles plain text unchanged', () => {
    expect(decodeWpEntities('Sarnen')).toBe('Sarnen');
  });
});

// ─── Workload percentage extraction ─────────────────────────────────────────

describe('extractPensum', () => {
  it('extracts a percentage range with en-dash', () => {
    expect(extractPensum('40 – 50%')).toEqual({ min: 40, max: 50 });
  });

  it('extracts a percentage range with hyphen', () => {
    expect(extractPensum('10-50%')).toEqual({ min: 10, max: 50 });
  });

  it('extracts a single percentage', () => {
    expect(extractPensum('100%')).toEqual({ min: 100, max: 100 });
  });

  it('returns null when no percentage present', () => {
    expect(extractPensum('Nach Vereinbarung')).toBeNull();
  });
});

// ─── Category / experience-level detection ─────────────────────────────────

describe('detectCategory', () => {
  it('detects gardening roles from title', () => {
    expect(detectCategory('Gärtner/in (m/w/d)', 'facility-management')).toBe('Giardinaggio');
  });

  it('maps facility-management taxonomy slug', () => {
    expect(detectCategory('Facility Manager (m/w/d)', 'facility-management')).toBe(
      'Facility Management',
    );
  });

  it('maps unterhaltsreinigung taxonomy slug', () => {
    expect(detectCategory('Mitarbeiter/in Reinigung', 'unterhaltsreinigung')).toBe(
      'Pulizie di Manutenzione',
    );
  });

  it('maps spezialreinigung taxonomy slug', () => {
    expect(detectCategory('Spezialreiniger/in', 'spezialreinigung')).toBe(
      'Pulizie Specializzate',
    );
  });
});

describe('detectExperienceLevel', () => {
  it('detects leadership titles as senior', () => {
    expect(detectExperienceLevel('Teamleiter Unterhaltsreinigung')).toBe('senior');
    expect(detectExperienceLevel('Einsatzleiter/in Reinigung')).toBe('senior');
  });

  it('detects intern/apprentice titles', () => {
    expect(detectExperienceLevel('Lernender Facility Management')).toBe('intern');
  });

  it('defaults to mid for regular roles', () => {
    expect(detectExperienceLevel('Mitarbeiter/in Reinigung')).toBe('mid');
  });
});

// ─── Primary location picking ───────────────────────────────────────────────

describe('pickPrimaryLocationSlug', () => {
  it('prefers Basel-Stadt over Baselland when both present', () => {
    expect(pickPrimaryLocationSlug(['basel-land', 'basel-stadt'])).toBe('basel-stadt');
  });

  it('prefers Schwyz over generic route descriptor', () => {
    expect(pickPrimaryLocationSlug(['thalwil-bis-uznach', 'schwyz'])).toBe('schwyz');
  });

  it('falls back to first valid slug in document order', () => {
    expect(pickPrimaryLocationSlug(['adliswil', 'horgen', 'rapperswil-2', 'waedenswil'])).toBe(
      'adliswil',
    );
  });

  it('skips unmapped slugs and returns the first mappable one', () => {
    expect(pickPrimaryLocationSlug(['not-a-real-slug', 'sarnen'])).toBe('sarnen');
  });

  it('returns null when no slug is mappable', () => {
    expect(pickPrimaryLocationSlug(['schaan'])).toBeNull();
  });
});

// ─── Listing page parsing ───────────────────────────────────────────────────

describe('parseHoneggerListingPage', () => {
  const listings = parseHoneggerListingPage(LISTING_HTML);

  it('extracts all job posts from the query loop', () => {
    expect(listings).toHaveLength(3);
  });

  it('extracts title, detail URL and excerpt for each listing', () => {
    const first = listings[0];
    expect(first.postId).toBe('101');
    expect(first.title).toBe('Mitarbeiter/in Reinigung (m/w/d) Sarnen 40-50%');
    expect(first.detailUrl).toBe(
      'https://honegger.ch/job/mitarbeiter-in-reinigung-m-w-d-sarnen-40-50/',
    );
    expect(first.excerpt).toContain('motivierte Reinigungskraft');
  });

  it('extracts the multi-location listing correctly', () => {
    const second = listings[1];
    expect(second.title).toContain('Adliswil, Horgen, Rapperswil, Wädenswil');
  });

  it('returns an empty array for a page with no job posts', () => {
    expect(parseHoneggerListingPage('<html><body>No jobs here</body></html>')).toEqual([]);
  });

  it('keeps a quote-balanced href when attributes are reordered', () => {
    const [listing] = parseHoneggerListingPage(`
      <li class="wp-block-post post-104 jobs type-jobs status-publish">
        <h2 class="wp-block-post-title">Responsabile dell'economia</h2>
        <a href="https://honegger.ch/job/d'emploi/" data-role="job"
           class="cta wp-block-post-excerpt__more-link">Apri</a>
      </li>
    `);
    expect(listing.detailUrl).toBe("https://honegger.ch/job/d'emploi/");
  });
});

// ─── Detail page parsing ────────────────────────────────────────────────────

describe('parseHoneggerDetailPage — single location', () => {
  const detail = parseHoneggerDetailPage(DETAIL_HTML_SINGLE, 'fallback title');

  it('extracts the clean title', () => {
    expect(detail.title).toBe('Mitarbeiter/in Reinigung (m/w/d)');
  });

  it('extracts the job-kategorie taxonomy term', () => {
    expect(detail.categorySlug).toBe('unterhaltsreinigung');
    expect(detail.categoryLabel).toBe('Unterhaltsreinigung');
  });

  it('extracts a single standorte slug', () => {
    expect(detail.locationSlugs).toEqual(['sarnen']);
  });

  it('extracts the beschaetigungsgrade label', () => {
    expect(detail.pensumLabel).toBe('40 – 50%');
  });

  it('extracts the "since when" text', () => {
    expect(detail.sinceWhen).toBe('01.08.2026 oder nach Vereinbarung');
  });

  it('extracts tasks, requirements and employer sections', () => {
    expect(detail.tasks).toEqual([
      'Reinigung von Büro- und Sanitärräumen',
      'Selbstständige Einteilung deiner Arbeiten',
    ]);
    expect(detail.requirements).toEqual([
      'Erfahrung im Reinigungsbereich von Vorteil',
      'Zuverlässigkeit und Genauigkeit',
    ]);
    expect(detail.employerBenefits).toEqual([
      'Faire Anstellungsbedingungen',
      'Einführung und Einarbeitung',
    ]);
  });

  it('extracts the posted date from article:modified_time meta', () => {
    expect(detail.postedDate).toBe('2026-06-20');
  });
});

describe('parseHoneggerDetailPage — multi-location', () => {
  const detail = parseHoneggerDetailPage(DETAIL_HTML_MULTI, 'fallback title');

  it('extracts all comma-separated standorte slugs from one taxonomy block', () => {
    expect(detail.locationSlugs).toEqual(['adliswil', 'horgen', 'rapperswil-2', 'waedenswil']);
  });

  it('resolves the primary location deterministically (first in doc order)', () => {
    expect(pickPrimaryLocationSlug(detail.locationSlugs)).toBe('adliswil');
    expect(STANDORT_LOCATIONS[pickPrimaryLocationSlug(detail.locationSlugs)]).toEqual({
      city: 'Adliswil',
      canton: 'ZH',
      postalCode: '8134',
    });
  });

  it('falls back to published_time when modified_time is absent', () => {
    const html = DETAIL_HTML_SINGLE.replace(
      '<meta property="article:modified_time" content="2026-06-20T08:00:00+00:00">',
      '',
    );
    const d = parseHoneggerDetailPage(html, 'fallback');
    expect(d.postedDate).toBe('2026-06-01');
  });

  it('reads the modified time independently from meta attribute order', () => {
    const html = DETAIL_HTML_SINGLE.replace(
      '<meta property="article:modified_time" content="2026-06-20T08:00:00+00:00">',
      '<meta content="2026-06-21T08:00:00+00:00" data-source="wp" property="article:modified_time">',
    );
    expect(parseHoneggerDetailPage(html, 'fallback').postedDate).toBe('2026-06-21');
  });
});

// ─── Description building ───────────────────────────────────────────────────

describe('buildDescription', () => {
  it('builds a structured description with all sections', () => {
    const detail = parseHoneggerDetailPage(DETAIL_HTML_SINGLE, 'fallback');
    const description = buildDescription(detail, 'fallback excerpt');

    expect(description).toContain('Eintritt:');
    expect(description).toContain('01.08.2026');
    expect(description).toContain('Das kannst du bei uns bewirken');
    expect(description).toContain('Büro- und Sanitärräumen');
    expect(description).toContain('Das bringst du mit');
    expect(description).toContain('Wir als Arbeitgeber');
    expect(description.split(/\s+/).filter(Boolean).length).toBeGreaterThan(15);
  });

  it('falls back to the listing excerpt when no tasks section is present', () => {
    const detail = {
      sinceWhen: '',
      tasks: [],
      requirements: [],
      employerBenefits: [],
    };
    const description = buildDescription(detail, 'A short teaser about the role.');
    expect(description).toContain('A short teaser about the role.');
  });
});

// ─── Company job identification ─────────────────────────────────────────────

describe('isHoneggerJob', () => {
  it('matches by companyKey', () => {
    expect(isHoneggerJob({ companyKey: 'honegger' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isHoneggerJob({ company: 'Honegger AG' })).toBe(true);
  });

  it('matches by URL domain', () => {
    expect(isHoneggerJob({ url: 'https://honegger.ch/job/some-role/' })).toBe(true);
  });

  it('does not match unrelated companies', () => {
    expect(isHoneggerJob({ company: 'Vontobel', url: 'https://vontobel.com/careers/x' })).toBe(
      false,
    );
  });
});

describe('isTrustedDomain', () => {
  it('trusts the apex domain', () => {
    expect(isTrustedDomain('https://honegger.ch/job/some-role/')).toBe(true);
  });

  it('trusts subdomains', () => {
    expect(isTrustedDomain('https://www.honegger.ch/job/some-role/')).toBe(true);
  });

  it('rejects unrelated domains', () => {
    expect(isTrustedDomain('https://example.com/honegger.ch/job')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
  });
});

// ─── Slug generation sanity check ───────────────────────────────────────────

describe('slug generation', () => {
  it('produces a stable, URL-safe slug for a Honegger job title', () => {
    const slug = slugify('Mitarbeiter/in Reinigung (m/w/d) honegger ag Sarnen');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('(');
    expect(slug.length).toBeGreaterThan(0);
  });
});
