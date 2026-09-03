import { beforeEach, describe, it, expect } from 'vitest';
import {
  FACHKRAFT_KEY,
  FACHKRAFT_COMPANY_NAME,
  FACHKRAFT_DESCRIPTION_MIN_WORDS,
  fetchAllFachkraftJobs,
  fetchFachkraftSnapshot,
  isPublishableFachkraftDescription,
  isFachkraftJob,
  isTrustedDomain,
  parseFachkraftListingPage,
  validateFachkraftAuthoritativeSnapshot,
} from '../scripts/lib/fachkraft-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';

const words = (count: number, prefix = 'source') => Array.from(
  { length: count },
  (_, index) => `${prefix}${index + 1}`,
).join(' ');

const listingCard = ({
  title,
  path,
  location = 'Luzern',
  canton = 'LU',
  teaser = words(24, 'teaser'),
}: {
  title: string;
  path: string;
  location?: string;
  canton?: string;
  teaser?: string;
}) => `
  <li class="ff-job-entry" data-canton="${canton}" data-jobtype="2">
    <div class="ff-job-entry__text">
      <strong class="ff-job-entry__title">
        <a href="https://www.fachkraft.ch/stellen/${path}/">${title}</a>
      </strong>
      <p class="ff-job-entry__column ff-job-entry__description">${teaser}</p>
    </div>
    <div class="ff-job-entry__column ff-job-entry__region"><span>Region:</span> ${location}</div>
  </li>`;

const listingHtml = (...cards: string[]) => `<html><body><ul>${cards.join('\n')}</ul></body></html>`;

const detailHtml = ({
  title,
  description,
  location = 'Luzern',
}: {
  title: string;
  description: string;
  location?: string;
}) => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title,
  description,
  jobLocation: {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      addressLocality: location,
      addressRegion: 'LU',
      addressCountry: 'CH',
    },
  },
})}</script></head><body></body></html>`;

const runtimeOptions = {
  spec: {
    companyKey: 'fachkraft',
    companyName: 'fachkraft.ch GmbH',
    seedUrls: ['https://www.fachkraft.ch/stellen/'],
  },
  requestTimeoutMs: 40,
  runTimeoutMs: 1_000,
  retries: 1,
  retryBaseMs: 0,
  detailWorkers: 2,
  lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  sleepImpl: async () => {},
};

describe('fachkraft.ch GmbH crawler parser', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FACHKRAFT_KEY).toBe('fachkraft');
    expect(FACHKRAFT_COMPANY_NAME).toBe('fachkraft.ch GmbH');
  });

  // ── isCompanyJob ──
  describe('isFachkraftJob', () => {
    it('matches by companyKey', () => {
      expect(isFachkraftJob({ companyKey: 'fachkraft' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFachkraftJob({ company: 'fachkraft.ch GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFachkraftJob({ url: 'https://fachkraft.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFachkraftJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFachkraftJob(null)).toBe(false);
      expect(isFachkraftJob(undefined)).toBe(false);
      expect(isFachkraftJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://fachkraft.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.fachkraft.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
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
      expect(slugify('Developer fachkraft ch')).toBe('developer-fachkraft-ch');
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
      id: 'fachkraft-abc123',
      slug: 'test-position-fachkraft-ch',
      slugByLocale: { de: 'test-position-fachkraft-ch' },
      company: 'fachkraft.ch GmbH',
      companyKey: 'fachkraft',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://fachkraft.ch/jobs/test',
      source: 'fachkraft.ch GmbH Dedicated Parser',
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
      expect(validJob.id).toMatch(/^fachkraft-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('authoritative bounded snapshot', () => {
    it('parses every source card and keeps explicit canton/location evidence', () => {
      const rows = parseFachkraftListingPage(listingHtml(
        listingCard({ title: 'Polymechaniker/in', path: 'polymechaniker-in-luzern-123' }),
        listingCard({
          title: 'Anlagenbauer/in',
          path: 'anlagenbauer-in-schweiz-456',
          location: '',
          canton: '',
        }),
      ));

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ location: 'Luzern', addressRegion: 'LU' });
      expect(rows[1]).toMatchObject({ location: '', addressRegion: '' });
    });

    it('rejects malformed or duplicate listing snapshots instead of under-collecting', () => {
      expect(() => parseFachkraftListingPage('<html></html>')).toThrow(/no ff-job-entry/i);
      const duplicate = listingCard({ title: 'Polymechaniker/in', path: 'same-123' });
      expect(() => parseFachkraftListingPage(listingHtml(duplicate, duplicate))).toThrow(/duplicate URL/i);
    });

    it('retries a transient listing status within the local request budget', async () => {
      const title = 'Polymechaniker/in';
      const url = 'https://www.fachkraft.ch/stellen/polymechaniker-in-luzern-123/';
      let listingAttempts = 0;
      const fetchImpl = async (target: string) => {
        if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (target === 'https://www.fachkraft.ch/stellen/' && listingAttempts++ === 0) {
          return new Response('busy', { status: 503 });
        }
        return new Response(listingHtml(listingCard({ title, path: 'polymechaniker-in-luzern-123' })), {
          status: 200,
        });
      };
      const existingJobs = [{
        url,
        title,
        titleByLocale: { de: title },
        sourceLang: 'de',
        description: words(55),
        descriptionByLocale: { de: words(55) },
        location: 'Luzern, Luzern',
        addressLocality: 'Luzern',
        canton: 'LU',
      }];

      const snapshot = await fetchFachkraftSnapshot({
        ...runtimeOptions,
        fetchImpl,
        existingJobs,
      });

      expect(listingAttempts).toBe(2);
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].location).toBe('Luzern, Luzern');
      expect(snapshot.fachkraftSnapshot).toMatchObject({
        complete: true,
        discovered: 1,
        reused: 1,
        detailRequested: 0,
        fetchFailures: 0,
      });
      expect(validateFachkraftAuthoritativeSnapshot(snapshot)).toBe(true);
    });

    it('recovers a rate-limited detail without losing the authoritative snapshot', async () => {
      const limitedTitle = 'Polymechaniker/in';
      const siblingTitle = 'Montage-Elektriker/in';
      const limitedUrl = 'https://www.fachkraft.ch/stellen/polymechaniker-in-luzern-123/';
      const cards = listingHtml(
        listingCard({ title: limitedTitle, path: 'polymechaniker-in-luzern-123' }),
        listingCard({ title: siblingTitle, path: 'montage-elektriker-in-luzern-456' }),
      );
      let limitedAttempts = 0;
      let now = Date.UTC(2026, 8, 1, 10, 0, 0);
      const sleeps: number[] = [];
      const fetchImpl = vi.fn(async (target: string) => {
        if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (target === 'https://www.fachkraft.ch/stellen/') return new Response(cards, { status: 200 });
        if (target === limitedUrl && limitedAttempts++ === 0) {
          return new Response('rate limited', { status: 429, headers: { 'Retry-After': '3' } });
        }
        const title = target === limitedUrl ? limitedTitle : siblingTitle;
        return new Response(detailHtml({ title, description: words(55, 'detail') }), { status: 200 });
      });
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let snapshot;
      try {
        snapshot = await fetchFachkraftSnapshot({
          ...runtimeOptions,
          fetchImpl,
          existingJobs: [],
          detailWorkers: 1,
          sleepImpl: async (ms: number) => { sleeps.push(ms); now += ms; },
        });
      } finally {
        nowSpy.mockRestore();
      }

      expect(limitedAttempts).toBe(2);
      expect(sleeps.some((ms) => ms >= 2_900 && ms <= 3_000)).toBe(true);
      expect(snapshot).toHaveLength(2);
      expect(snapshot.fachkraftSnapshot).toMatchObject({
        complete: true,
        discovered: 2,
        detailRequested: 2,
        detailCompleted: 2,
        fetchFailures: 0,
        accounted: 2,
      });
      expect(validateFachkraftAuthoritativeSnapshot(snapshot)).toBe(true);
    });

    it('aborts a hung request and exhausts only the configured bounded retry count', async () => {
      let attempts = 0;
      const fetchImpl = () => {
        attempts++;
        return new Promise<Response>(() => {});
      };
      const startedAt = Date.now();

      await expect(fetchFachkraftSnapshot({
        ...runtimeOptions,
        fetchImpl,
        existingJobs: [],
      })).rejects.toThrow(/listing failed/i);

      expect(attempts).toBeGreaterThanOrEqual(2); // robots (fail-open) + listing
      expect(attempts).toBeLessThanOrEqual(3); // at most two bounded listing attempts
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it('enforces the whole-run deadline even when the per-request budget is longer', async () => {
      const fetchImpl = async (target: string) => {
        if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
        return new Response('busy', { status: 503 });
      };
      const startedAt = Date.now();

      await expect(fetchFachkraftSnapshot({
        ...runtimeOptions,
        requestTimeoutMs: 500,
        runTimeoutMs: 50,
        retryBaseMs: 500,
        sleepImpl: () => new Promise(() => {}),
        fetchImpl,
        existingJobs: [],
      })).rejects.toThrow(/listing failed/i);

      expect(Date.now() - startedAt).toBeLessThan(300);
    });

    it('aborts sibling detail workers and rejects the whole snapshot on a hung detail', async () => {
      const cards = listingHtml(
        listingCard({ title: 'Polymechaniker/in', path: 'polymechaniker-in-luzern-123' }),
        listingCard({ title: 'Montage-Elektriker/in', path: 'montage-elektriker-in-zug-456' }),
      );
      const fetchImpl = async (target: string) => {
        if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (target === 'https://www.fachkraft.ch/stellen/') return new Response(cards, { status: 200 });
        return new Promise<Response>(() => {});
      };

      await expect(fetchFachkraftSnapshot({
        ...runtimeOptions,
        fetchImpl,
        existingJobs: [],
      })).rejects.toThrow(/detail/i);
    });

    it('publishes only source descriptions at or above 50 words and accounts for soft landings', async () => {
      const goodTitle = 'Polymechaniker/in';
      const thinTitle = 'Montage-Elektriker/in';
      const cards = listingHtml(
        listingCard({ title: goodTitle, path: 'polymechaniker-in-luzern-123' }),
        listingCard({ title: thinTitle, path: 'montage-elektriker-in-zug-456', location: 'Zug', canton: 'ZG' }),
      );
      const fetchImpl = async (target: string) => {
        if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (target === 'https://www.fachkraft.ch/stellen/') return new Response(cards, { status: 200 });
        if (target.includes('polymechaniker')) {
          return new Response(detailHtml({ title: goodTitle, description: words(50, 'good') }), { status: 200 });
        }
        return new Response(detailHtml({ title: thinTitle, description: words(49, 'thin'), location: 'Zug' }), {
          status: 200,
        });
      };

      const jobs = await fetchAllFachkraftJobs({
        ...runtimeOptions,
        fetchImpl,
        existingJobs: [],
      });

      expect(FACHKRAFT_DESCRIPTION_MIN_WORDS).toBe(50);
      expect(jobs).toHaveLength(1);
      expect(isPublishableFachkraftDescription(jobs[0].description)).toBe(true);
      expect(jobs.fachkraftSnapshot).toMatchObject({
        discovered: 2,
        published: 1,
        qualityDropped: 1,
        accounted: 2,
      });
      expect(validateFachkraftAuthoritativeSnapshot(jobs)).toBe(true);
      expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
      expect(new Set(jobs.map((job) => job.url)).size).toBe(jobs.length);
      expect(new Set(jobs.map((job) => job.slug)).size).toBe(jobs.length);
    });

    it('publishes a job whose canton is only inferred from rendered detail text, not re-rejected on re-derivation (#7134)', async () => {
      const title = 'Montage-Elektriker/in';
      const cards = listingHtml(listingCard({ title, path: 'montage-elektriker-in-zug-789', location: '', canton: '' }));
      const fetchImpl = async (target: string) => {
        if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (target === 'https://www.fachkraft.ch/stellen/') return new Response(cards, { status: 200 });
        const html = `<html><body>
          <h1>${title}</h1>
          <div class="job-location">Grossraum Zug</div>
          <div class="job-description"><p>${words(55, 'rendered')}</p></div>
        </body></html>`;
        return new Response(html, { status: 200 });
      };

      const jobs = await fetchAllFachkraftJobs({
        ...runtimeOptions,
        fetchImpl,
        existingJobs: [],
      });

      // The snapshot audit ("published") reflects what fetchFachkraftSnapshot
      // already accepted; a job counted there must not silently disappear
      // from the final jobs array, or validateFachkraftAuthoritativeSnapshot
      // rejects a genuinely complete, correct snapshot (#7134).
      expect(jobs.fachkraftSnapshot?.published).toBe(1);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.canton).toBe('ZG');
      expect(validateFachkraftAuthoritativeSnapshot(jobs)).toBe(true);
    });

    it('is idempotent across two runs and preserves every prior route token on merge', async () => {
      const title = 'Polymechaniker/in';
      const cards = listingHtml(listingCard({ title, path: 'polymechaniker-in-luzern-123' }));
      const fetchImpl = async (target: string) => {
        if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (target === 'https://www.fachkraft.ch/stellen/') return new Response(cards, { status: 200 });
        return new Response(detailHtml({ title, description: words(55, 'stable') }), { status: 200 });
      };
      const run = () => fetchAllFachkraftJobs({
        ...runtimeOptions,
        fetchImpl,
        existingJobs: [],
      });

      const first = await run();
      clearPoliteFetchStateForTests();
      const second = await run();
      const identity = (job: Record<string, unknown>) => ({
        id: job.id,
        url: job.url,
        slug: job.slug,
        description: job.description,
        location: job.location,
      });
      expect(second.map(identity)).toEqual(first.map(identity));

      const existing = [{
        ...first[0],
        previousSlugs: ['indexed-master-route'],
        previousSlugsByLocale: { de: ['indexed-de-route'] },
      }];
      const merged = mergePreserveLocaleData(existing, second, { retainMissingJobs: false });
      const beforeRoutes = new Set([
        existing[0].slug,
        ...existing[0].previousSlugs,
        ...Object.values(existing[0].slugByLocale || {}),
        ...Object.values(existing[0].previousSlugsByLocale || {}).flat(),
      ]);
      const afterRoutes = new Set([
        merged[0].slug,
        ...(merged[0].previousSlugs || []),
        ...Object.values(merged[0].slugByLocale || {}),
        ...Object.values(merged[0].previousSlugsByLocale || {}).flat(),
      ]);
      expect([...beforeRoutes].filter((route) => !afterRoutes.has(route))).toEqual([]);
    });
  });
});
