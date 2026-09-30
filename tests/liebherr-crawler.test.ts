import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  LIEBHERR_KEY,
  LIEBHERR_COMPANY_NAME,
  isLiebherrJob,
  isTrustedDomain,
  fetchAllLiebherrJobs,
  extractLiebherrSourceLocale,
  extractLiebherrSourceJobId,
  mergeLiebherrLanguageVariants,
  prepareExistingLiebherrJobs,
  liebherrMatchKey,
} from '../scripts/lib/liebherr-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { extractStableJobId } from '../scripts/lib/job-match-key.mjs';

describe('Liebherr crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LIEBHERR_KEY).toBe('liebherr');
    expect(LIEBHERR_COMPANY_NAME).toBe('Liebherr');
  });

  // ── isCompanyJob ──
  describe('isLiebherrJob', () => {
    it('matches by companyKey', () => {
      expect(isLiebherrJob({ companyKey: 'liebherr' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLiebherrJob({ company: 'Liebherr' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLiebherrJob({ url: 'https://liebherr.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLiebherrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLiebherrJob(null)).toBe(false);
      expect(isLiebherrJob(undefined)).toBe(false);
      expect(isLiebherrJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://liebherr.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.liebherr.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('liebherrMatchKey', () => {
    it('uses the stable URL key when source locale proof is missing', () => {
      const job = {
        liebherrSourceJobId: '81996',
        url: 'https://careers.liebherr.com/job/1378968433',
      };

      expect(liebherrMatchKey(job)).toBe(extractStableJobId(job.url));
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer liebherr ch')).toBe('developer-liebherr-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'liebherr-abc123',
      slug: 'test-position-liebherr-ch',
      slugByLocale: { de: 'test-position-liebherr-ch' },
      company: 'Liebherr',
      companyKey: 'liebherr',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://liebherr.com/jobs/test',
      source: 'Liebherr Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^liebherr-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('source-proven language variants', () => {
    const body = (label: string) => `${label} ${Array(55).fill('source').join(' ')}`;
    const variant = (options: {
      id: string;
      locale: 'de_DE' | 'en_US' | 'fr_FR' | 'it_IT';
      slug: string;
      title: string;
      sourceJobId?: string;
      bodyLabel?: string;
      firstSeenAt?: string;
    }) => {
      const sourceLangByLocale = { de_DE: 'de', en_US: 'en', fr_FR: 'fr', it_IT: 'it' } as const;
      const sourceLang = sourceLangByLocale[options.locale];
      const description = body(options.bodyLabel || options.locale);
      return {
        id: `liebherr-${options.id}`,
        jobReqId: options.id,
        sourceLocale: options.locale,
        ...(options.sourceJobId ? { liebherrSourceJobId: options.sourceJobId } : {}),
        sourceLang,
        title: options.title,
        titleByLocale: { [sourceLang]: options.title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        slug: options.slug,
        slugByLocale: { [sourceLang]: options.slug },
        location: 'Nussbaumen',
        url: `https://careers.liebherr.com/job/${options.id}/`,
        ...(options.firstSeenAt ? { firstSeenAt: options.firstSeenAt } : {}),
      };
    };

    it('reads the locale proof from the source apply link', () => {
      expect(extractLiebherrSourceLocale(
        '<a href="/apply?locale=de_DE&amp;jobid=1438005533">Jetzt bewerben</a>',
        '1438005533',
      )).toBe('de_DE');
      expect(extractLiebherrSourceLocale(
        '<a href="/apply?locale=en_US&amp;jobid=1438005433">Apply now</a>',
        '1438005433',
      )).toBe('en_US');
      expect(extractLiebherrSourceLocale(
        '<a href="/apply?locale=en_US&amp;jobid=1438005633">Apply now</a>',
        '1438005433',
      )).toBe('');
    });

    it('reads the common Job ID from the source data attribute', () => {
      expect(extractLiebherrSourceJobId(
        '<span data-careersite-propertyid="adcode"> 84657 </span>',
      )).toBe('84657');
      expect(extractLiebherrSourceJobId('<span data-careersite-propertyid="title">Role</span>')).toBe('');
    });

    it('fuses a proven DE/EN pair with the same source Job ID, even when page IDs differ by 100', () => {
      const de = variant({
        id: '1438005533',
        locale: 'de_DE',
        sourceJobId: '84657',
        slug: 'transferpreis-werkstudent-liebherr-nussbaumen',
        title: 'Transfer Pricing Working Student',
        firstSeenAt: '2026-09-01T00:00:00.000Z',
      });
      const en = variant({
        id: '1438005433',
        locale: 'en_US',
        sourceJobId: '84657',
        slug: 'transfer-pricing-working-student-liebherr-nussbaumen',
        title: 'Transfer Pricing Working Student',
        firstSeenAt: '2026-09-02T00:00:00.000Z',
      });

      const result = mergeLiebherrLanguageVariants([de, en]);
      expect(result.metrics).toMatchObject({ candidatePairs: 1, fused: 1, redirectsCreated: 1 });
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]).toMatchObject({
        sourceLang: 'de',
        slug: de.slug,
        descriptionByLocale: { de: de.description, en: en.description },
        titleByLocale: { de: de.title, en: en.title },
      });
      expect(result.jobs[0].previousSlugs).toContain(en.slug);
      expect(result.jobs[0].previousSlugsByLocale?.en).toContain(en.slug);
    });

    it('keeps an alias whose locale provenance is empty in legacy history', () => {
      const de = variant({
        id: '1438005533',
        locale: 'de_DE',
        sourceJobId: '84657',
        slug: 'primary-liebherr-role',
      });
      const secondary = {
        ...variant({
          id: '1438005433',
          locale: 'en_US',
          sourceJobId: '84657',
          slug: 'primary-liebherr-role',
        }),
        slugByLocale: { '': 'legacy-liebherr-alias' },
      };

      const result = mergeLiebherrLanguageVariants([de, secondary]);
      expect(result.metrics).toMatchObject({ candidatePairs: 1, fused: 1, redirectsCreated: 1 });
      expect(result.jobs[0].previousSlugs).toContain('legacy-liebherr-alias');
      expect(result.jobs[0].previousSlugsByLocale?.['']).toBeUndefined();
    });

    it('fuses three source-language pages that share one Job ID', () => {
      const de = variant({ id: '724771801', locale: 'de_DE', sourceJobId: '37210', slug: 'role-de', title: 'Initiativbewerbung' });
      const fr = variant({ id: '724771901', locale: 'fr_FR', sourceJobId: '37210', slug: 'role-fr', title: 'Candidature spontanée' });
      const en = variant({ id: '724772001', locale: 'en_US', sourceJobId: '37210', slug: 'role-en', title: 'Speculative application' });
      const result = mergeLiebherrLanguageVariants([de, fr, en]);
      expect(result.metrics).toMatchObject({ candidatePairs: 2, fused: 2, redirectsCreated: 2 });
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].descriptionByLocale).toEqual({ de: de.description, fr: fr.description, en: en.description });
    });

    it('keeps different source Job IDs separate despite same location, dates, and page IDs at +100', () => {
      const engine = variant({
        id: '1395958433',
        locale: 'de_DE',
        sourceJobId: '82763',
        slug: 'engine-remanufacturing-design-engineer',
        title: 'Engine Remanufacturing Design Engineer',
        bodyLabel: 'Engine responsibilities',
        firstSeenAt: '2026-09-01T00:00:00.000Z',
      });
      const control = variant({
        id: '1395958333',
        locale: 'en_US',
        sourceJobId: '82764',
        slug: 'control-systems-engineer',
        title: 'Control Systems Engineer',
        bodyLabel: 'Control systems responsibilities',
        firstSeenAt: '2026-09-02T00:00:00.000Z',
      });
      const result = mergeLiebherrLanguageVariants([engine, control]);
      expect(result.metrics.fused).toBe(0);
      expect(result.jobs).toHaveLength(2);
      expect(prepareExistingLiebherrJobs([engine, control])).toHaveLength(2);
    });

    it('does not infer a legacy merge from a matching title alone', () => {
      const first = {
        ...variant({ id: '1395958433', locale: 'en_US', slug: 'same-role-one', title: 'Same Role' }),
        sourceLocale: undefined,
      };
      const second = {
        ...variant({ id: '1395958333', locale: 'en_US', slug: 'same-role-two', title: 'Same Role' }),
        sourceLocale: undefined,
      };
      expect(prepareExistingLiebherrJobs([first, second])).toHaveLength(2);
    });

    it('leaves a monolingual source row unchanged', () => {
      const job = variant({ id: '1438005433', locale: 'en_US', slug: 'role-en', title: 'Role' });
      const result = mergeLiebherrLanguageVariants([job]);
      expect(result.metrics).toEqual({ candidatePairs: 0, fused: 0, redirectsCreated: 0 });
      expect(result.jobs[0]).toBe(job);
    });

    it('cleans stored proven-family duplicates before the standard merge', () => {
      const de = variant({
        id: '1438005533',
        locale: 'de_DE',
        slug: 'stored-de-slug',
        title: 'Transfer Pricing Working Student',
        firstSeenAt: '2026-09-01T00:00:00.000Z',
      });
      const en = variant({
        id: '1438005433',
        locale: 'en_US',
        slug: 'stored-en-slug',
        title: 'Transfer Pricing Working Student',
        firstSeenAt: '2026-09-02T00:00:00.000Z',
      });
      const legacyDe = {
        ...de,
        sourceLocale: undefined,
        liebherrSourceJobId: undefined,
        sourceLang: 'en',
        titleByLocale: { en: de.title },
        descriptionByLocale: { en: de.description },
      };
      const legacyEn = {
        ...en,
        sourceLocale: undefined,
        liebherrSourceJobId: undefined,
        sourceLang: 'en',
        titleByLocale: { en: en.title },
        descriptionByLocale: { en: en.description },
      };
      const cleaned = prepareExistingLiebherrJobs([legacyDe, legacyEn]);
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0].sourceLang).toBe('de');
      expect(cleaned[0].descriptionByLocale).toEqual({ de: legacyDe.description, en: legacyEn.description });
      expect(cleaned[0].slug).toBe(legacyDe.slug);
      expect(cleaned[0].previousSlugs).toContain(legacyEn.slug);
      expect(cleaned[0].previousSlugsByLocale?.en).toContain(legacyEn.slug);
    });
  });
});

// Only the posting's own text is published (issue 5253): without a readable
// detail body a listing used to go out as "{title} — Liebherr ({city}, CH)".
// Shapes of careers.liebherr.com (jobs2web tiles, itemprop="description").
describe('fetchAllLiebherrJobs — listing without a vacancy body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the listing with a body and skips the one without, never inventing text', async () => {
    const tile = (id: string, title: string) => `<li class="job-tile job-id-${id} job-row" data-url="/job/Bulle-${id}/${id}/">`
      + `<a class="jobTitle-link" href="/job/Bulle-${id}/${id}/">${title}</a><div id="job-${id}-desktop-section-location-value">Bulle, CH</div></li>`;
    const listing = `<ul>${tile('1438000001', 'Polymechaniker EFZ')}${tile('1438000002', 'Einkäufer')}</ul>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/search/')) return new Response(u.includes('startrow=') ? '<ul></ul>' : listing, { status: 200 });
      if (u.includes('1438000001')) {
        return new Response('<html><body><span itemprop="description"><p>Sie fertigen Präzisionsteile für unsere Baumaschinen und betreuen die CNC-Anlagen. Du arbeitest eng mit Kolleginnen und Kollegen aus mehreren Abteilungen zusammen, dokumentierst deine Arbeit sorgfältig und hilfst uns, unsere Abläufe zu verbessern. Wir bieten einen modernen Arbeitsplatz, flexible Arbeitszeiten, Weiterbildungen und eine offene Teamkultur. Gute Deutschkenntnisse und eine strukturierte Arbeitsweise runden dein Profil ab.</p></span></body></html>', { status: 200 });
      }
      return new Response('<html><body><h1>Einkäufer</h1></body></html>', { status: 200 });
    }));

    const jobs = await fetchAllLiebherrJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Polymechaniker EFZ']);
    expect(jobs[0].description).toContain('Präzisionsteile');
    for (const job of jobs) expect(job.description).not.toMatch(/— Liebherr \(/);
  }, 20_000);
});

describe('fetchAllLiebherrJobs — source-proven same-id locale variants', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps same-id locale URLs long enough to fuse their source slots', async () => {
    const body = (label: string) => `${label} ${Array(60).fill('vacancy').join(' ')}`;
    const tile = (locale: string) => `<li class="job-tile job-id-1438005433 job-row" data-url="/job/Nussbaumen-Role/1438005433/?locale=${locale}">`
      + '<a class="jobTitle-link" href="#">Role</a><div id="job-1438005433-desktop-section-location-value">Nussbaumen, CH</div></li>';
    const listing = `<ul>${tile('de_DE')}${tile('en_US')}</ul>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/search/')) return new Response(listing, { status: 200 });
      const locale = u.includes('de_DE') ? 'de_DE' : 'en_US';
      return new Response(
        `<a href="/apply?locale=${locale}&amp;jobid=1438005433">Apply</a><span data-careersite-propertyid="adcode">84657</span><span itemprop="description"><p>${body(locale)}</p></span>`,
        { status: 200 },
      );
    }));

    const jobs = await fetchAllLiebherrJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].descriptionByLocale).toEqual({ de: body('de_DE'), en: body('en_US') });
    expect(jobs.languageVariantStats).toMatchObject({ candidatePairs: 1, fused: 1 });
  }, 20_000);
});
