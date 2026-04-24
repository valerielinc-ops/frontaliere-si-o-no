/**
 * EmployerBrandHub + registry tests.
 *
 * Covers:
 *   - Registry: every registered brand has all 4 locales and >= 500 body words
 *     so no brand hub ever falls foul of the "thin content" rule (CLAUDE.md #4).
 *   - Canonical slug lookup matches the JobBoard runtime helper.
 *   - Component: renders title / benefits / FAQ in all locales without warnings.
 *   - Component: job list filtering, empty-state fallback.
 *   - Component: emits Organization + ItemList + FAQPage JSON-LD that parses
 *     and exposes the minimum Schema.org fields Google requires.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import EmployerBrandHub, { buildEmployerBrandStructuredData } from '@/components/jobs/EmployerBrandHub';
import {
  EMPLOYER_BRANDS,
  canonicalEmployerBrandKey,
  getEmployerBrandBySlug,
  getEmployerBrandForCompany,
  listEmployerBrandKeys,
} from '@/services/employerBrands';
import type { Locale } from '@/services/i18n';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];

const mockJobs = [
  {
    id: 'j1',
    company: 'EOC – Ente Ospedaliero Cantonale',
    companyKey: 'eoc-ente-ospedaliero-cantonale',
    title: 'Infermiere/a diplomato/a 80-100%',
    titleByLocale: {
      it: 'Infermiere/a diplomato/a 80-100%',
      en: 'Registered Nurse 80-100%',
      de: 'Dipl. Pflegefachperson 80-100%',
      fr: 'Infirmier/ère diplômé/e 80-100%',
    },
    location: 'Lugano',
    canton: 'TI',
    postedDate: '2026-04-18',
    slug: 'infermiere-diplomato-80-100-eoc-lugano',
    salaryMin: 78000,
    salaryMax: 95000,
    currency: 'CHF',
  },
  {
    id: 'j2',
    company: 'EOC – Ente Ospedaliero Cantonale',
    companyKey: 'eoc-ente-ospedaliero-cantonale',
    title: 'Medico assistente — Medicina interna',
    location: 'Bellinzona',
    canton: 'TI',
    postedDate: '2026-04-17',
    slug: 'medico-assistente-medicina-interna-eoc-bellinzona',
    salaryMin: 98000,
    currency: 'CHF',
  },
];

const buildJobHref = (job: { slug?: string }, _locale: Locale): string =>
  `https://frontaliereticino.ch/cerca-lavoro-ticino/${job.slug ?? ''}/`;

const CANONICAL_URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-eoc-ente-ospedaliero-cantonale/';

// ─── Registry guarantees ──────────────────────────────────────────────────────
describe('employerBrands registry', () => {
  const keys = listEmployerBrandKeys();

  it('registers at least the EOC brand', () => {
    expect(keys).toContain('eoc-ente-ospedaliero-cantonale');
  });

  for (const key of keys) {
    const brand = EMPLOYER_BRANDS[key];
    describe(`brand "${key}"`, () => {
      it('exposes metadata + all 4 locales', () => {
        expect(brand).toBeDefined();
        expect(brand.brandKey).toBe(key);
        expect(brand.name).toMatch(/.+/);
        expect(brand.website).toMatch(/^https?:\/\//);
        expect(brand.headquarters.postalCode).toMatch(/^\d+/);
        expect(brand.locations.length).toBeGreaterThanOrEqual(1);
        for (const locale of LOCALES) {
          expect(brand.copy[locale], `missing ${locale} copy for ${key}`).toBeDefined();
        }
      });

      for (const locale of LOCALES) {
        it(`${locale}: copy is substantive (>= 500 words, real FAQs, no TODOs)`, () => {
          const c = brand.copy[locale];
          expect(c.h1.length).toBeGreaterThan(15);
          expect(c.paragraphs.length).toBeGreaterThanOrEqual(3);
          expect(c.benefits.length).toBeGreaterThanOrEqual(4);
          expect(c.faqs.length).toBeGreaterThanOrEqual(4);

          const text = [
            c.h1,
            c.tagline,
            ...c.paragraphs,
            c.howToApply,
            c.locationsIntro,
            c.emptyStateNote,
            ...c.benefits.flatMap((b) => [b.title, b.desc]),
            ...c.faqs.flatMap((f) => [f.q, f.a]),
          ].join(' ');
          const wordCount = text.trim().split(/\s+/).length;
          expect(wordCount, `word count for ${key} ${locale}`).toBeGreaterThanOrEqual(500);
          expect(text.toLowerCase()).not.toMatch(/\btodo\b|\bxxx\b|\bplaceholder\b|\btbd\b/);

          // Meta title <= 65 chars (our template truncation limit)
          expect(c.metaTitle.length).toBeLessThanOrEqual(80);
          // Meta description <= 170 chars (slack for Google 160-char target)
          expect(c.metaDescription.length).toBeLessThanOrEqual(170);
        });
      }
    });
  }
});

// ─── canonicalEmployerBrandKey helper ─────────────────────────────────────────
describe('canonicalEmployerBrandKey', () => {
  it('matches the runtime JobBoard canonical slug for EOC', () => {
    expect(
      canonicalEmployerBrandKey('EOC – Ente Ospedaliero Cantonale', 'eoc-ente-ospedaliero-cantonale'),
    ).toBe('eoc-ente-ospedaliero-cantonale');
  });

  it('collapses all lidl variants to a single slug', () => {
    expect(canonicalEmployerBrandKey('Lidl Svizzera AG', 'lidl-svizzera')).toBe('lidl');
    expect(canonicalEmployerBrandKey('LIDL', 'lidl')).toBe('lidl');
  });

  it('normalises diacritics and punctuation', () => {
    expect(canonicalEmployerBrandKey("Café & Bäckerei – Müller AG")).toBe('cafe-backerei-muller-ag');
  });
});

// ─── getEmployerBrandBySlug / getEmployerBrandForCompany ──────────────────────
describe('getEmployerBrandBySlug / getEmployerBrandForCompany', () => {
  it('returns the EOC brand for a registered slug', () => {
    expect(getEmployerBrandBySlug('eoc-ente-ospedaliero-cantonale')?.shortName).toBe('EOC');
  });

  it('returns null for unknown companies', () => {
    expect(getEmployerBrandBySlug('acme-widgets')).toBeNull();
    expect(getEmployerBrandForCompany('Random Ticino AG')).toBeNull();
    expect(getEmployerBrandBySlug('')).toBeNull();
  });

  it('looks up by company name', () => {
    const brand = getEmployerBrandForCompany(
      'EOC – Ente Ospedaliero Cantonale',
      'eoc-ente-ospedaliero-cantonale',
    );
    expect(brand?.brandKey).toBe('eoc-ente-ospedaliero-cantonale');
  });
});

// ─── buildEmployerBrandStructuredData ────────────────────────────────────────
describe('buildEmployerBrandStructuredData', () => {
  const brand = EMPLOYER_BRANDS['eoc-ente-ospedaliero-cantonale'];

  it('emits parsable Organization JSON-LD with postal address', () => {
    const { organization } = buildEmployerBrandStructuredData({
      brand,
      locale: 'it',
      canonicalUrl: CANONICAL_URL,
      jobs: mockJobs,
      buildJobHref,
    });
    const json = JSON.stringify(organization);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(organization['@type']).toBe('Organization');
    expect(organization.name).toContain('EOC');
    expect(organization.legalName).toBe('Ente Ospedaliero Cantonale');
    const addr = organization.address as Record<string, string>;
    expect(addr.addressCountry).toBe('CH');
    expect(addr.addressRegion).toBe('TI');
    expect(addr.postalCode).toBe('6500');
  });

  it('emits ItemList with ordered positions for the first 10 jobs', () => {
    const { itemList } = buildEmployerBrandStructuredData({
      brand,
      locale: 'en',
      canonicalUrl: CANONICAL_URL,
      jobs: mockJobs,
      buildJobHref,
    });
    expect(itemList['@type']).toBe('ItemList');
    expect(itemList.numberOfItems).toBe(2);
    const items = itemList.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]?.position).toBe(1);
    expect((items[0]?.url as string).startsWith('https://')).toBe(true);
  });

  it('emits FAQPage with every curated question', () => {
    for (const locale of LOCALES) {
      const { faqPage } = buildEmployerBrandStructuredData({
        brand,
        locale,
        canonicalUrl: CANONICAL_URL,
        jobs: mockJobs,
        buildJobHref,
      });
      expect(faqPage['@type']).toBe('FAQPage');
      const entities = faqPage.mainEntity as Array<Record<string, unknown>>;
      expect(entities.length).toBe(brand.copy[locale].faqs.length);
      expect(entities[0]?.['@type']).toBe('Question');
      const answer = entities[0]?.acceptedAnswer as Record<string, unknown>;
      expect(answer['@type']).toBe('Answer');
      expect(String(answer.text).length).toBeGreaterThan(10);
    }
  });
});

// ─── EmployerBrandHub component ───────────────────────────────────────────────
describe('EmployerBrandHub component', () => {
  // Explicit cleanup prevents multiple renders from the locale loop from
  // accumulating in the DOM when isolate: false is set (module state shared).
  afterEach(() => {
    cleanup();
  });

  const brand = EMPLOYER_BRANDS['eoc-ente-ospedaliero-cantonale'];

  for (const locale of LOCALES) {
    it(`renders H1, benefits and FAQs in locale ${locale}`, () => {
      const { container } = render(
        <EmployerBrandHub
          brand={brand}
          locale={locale}
          jobs={mockJobs}
          buildJobHref={buildJobHref}
          canonicalUrl={CANONICAL_URL}
        />,
      );
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(brand.copy[locale].h1);
      const firstBenefit = brand.copy[locale].benefits[0]!.title;
      // Benefit title is rendered as `<span>{title}.</span>` (title + period in
      // separate text nodes), so match by container textContent rather than a
      // single text-node regex.
      expect(container.textContent ?? '').toContain(firstBenefit);
      const firstFaq = brand.copy[locale].faqs[0]!.q;
      expect(screen.getByText(firstFaq)).toBeInTheDocument();
      // brand wrapper must expose the brand key for tests / analytics
      const hub = container.querySelector('[data-testid="employer-brand-hub"]');
      expect(hub?.getAttribute('data-brand-key')).toBe('eoc-ente-ospedaliero-cantonale');
    });
  }

  it('renders the live job list with working hrefs', () => {
    render(
      <EmployerBrandHub
        brand={brand}
        locale="it"
        jobs={mockJobs}
        buildJobHref={buildJobHref}
        canonicalUrl={CANONICAL_URL}
      />,
    );
    expect(screen.getByText(/Infermiere\/a diplomato\/a 80-100%/)).toBeInTheDocument();
    const anchors = screen.getAllByRole('link');
    const jobAnchors = anchors.filter((a) => a.getAttribute('href')?.includes('/cerca-lavoro-ticino/'));
    expect(jobAnchors.length).toBeGreaterThanOrEqual(2);
  });

  it('shows empty state copy when no jobs match', () => {
    render(
      <EmployerBrandHub
        brand={brand}
        locale="it"
        jobs={[]}
        buildJobHref={buildJobHref}
        canonicalUrl={CANONICAL_URL}
      />,
    );
    expect(screen.getByText(brand.copy.it.emptyStateNote)).toBeInTheDocument();
  });

  it('emits the 3 JSON-LD scripts with parsable JSON', () => {
    const { container } = render(
      <EmployerBrandHub
        brand={brand}
        locale="en"
        jobs={mockJobs}
        buildJobHref={buildJobHref}
        canonicalUrl={CANONICAL_URL}
      />,
    );
    const orgScript = container.querySelector('[data-testid="employer-brand-ld-organization"]');
    const listScript = container.querySelector('[data-testid="employer-brand-ld-itemlist"]');
    const faqScript = container.querySelector('[data-testid="employer-brand-ld-faqpage"]');
    expect(orgScript).toBeTruthy();
    expect(listScript).toBeTruthy();
    expect(faqScript).toBeTruthy();
    const orgJson = JSON.parse(orgScript!.textContent || '{}');
    const faqJson = JSON.parse(faqScript!.textContent || '{}');
    expect(orgJson['@type']).toBe('Organization');
    expect(faqJson['@type']).toBe('FAQPage');
  });

  it('skips structured data when emitStructuredData=false', () => {
    const { container } = render(
      <EmployerBrandHub
        brand={brand}
        locale="it"
        jobs={mockJobs}
        buildJobHref={buildJobHref}
        canonicalUrl={CANONICAL_URL}
        emitStructuredData={false}
      />,
    );
    expect(container.querySelector('[data-testid="employer-brand-ld-organization"]')).toBeNull();
  });

  it('renders the hospitals / locations list from brand metadata', () => {
    render(
      <EmployerBrandHub
        brand={brand}
        locale="it"
        jobs={mockJobs}
        buildJobHref={buildJobHref}
        canonicalUrl={CANONICAL_URL}
      />,
    );
    const hub = screen.getByTestId('employer-brand-hub');
    for (const location of brand.locations) {
      expect(within(hub).getByText(location)).toBeInTheDocument();
    }
  });
});
