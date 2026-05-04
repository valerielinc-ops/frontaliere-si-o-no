import { describe, it, expect } from 'vitest';
import { isFixtureJob, isFixtureSlug, isFixturePath, filterFixtureJobs, filterFixtureSlugs } from '../scripts/lib/fixture-data-filter.mjs';

describe('fixture-data-filter', () => {
  describe('isFixtureSlug', () => {
    it('matches the canonical fixture slug', () => {
      expect(isFixtureSlug('software-engineer-fixture-corp-sa-lugano')).toBe(true);
      expect(isFixtureSlug('software-engineer-fixture-corp-sa-lugano-de')).toBe(true);
      expect(isFixtureSlug('software-engineer-fixture-corp-sa-lugano-en')).toBe(true);
      expect(isFixtureSlug('software-engineer-fixture-corp-sa-lugano-fr')).toBe(true);
    });

    it('matches slugs with fixture- prefix', () => {
      expect(isFixtureSlug('fixture-job-1')).toBe(true);
      expect(isFixtureSlug('fixture-canonical-abc')).toBe(true);
    });

    it('does not match real Sintetica / Lonza / Medacta slugs', () => {
      expect(isFixtureSlug('front-desk-office-support-50-70-mendrisio-site-ticino-sintetica')).toBe(false);
      expect(isFixtureSlug('clinical-medical-project-manager-mendrisio-site-ticino-sintetica')).toBe(false);
      expect(isFixtureSlug('apprendista-impiegato-di-commercio-afc-sintetica')).toBe(false);
      expect(isFixtureSlug('senior-software-engineer-java-fincons-group-lugano')).toBe(false);
    });

    it('handles empty / null / undefined', () => {
      expect(isFixtureSlug('')).toBe(false);
      expect(isFixtureSlug(null as unknown as string)).toBe(false);
      expect(isFixtureSlug(undefined as unknown as string)).toBe(false);
    });
  });

  describe('isFixtureJob', () => {
    it('detects the canonical fixture record', () => {
      const job = {
        id: 'fixture-corp-canonical-abc123',
        company: 'Fixture Corp SA',
        slug: 'software-engineer-fixture-corp-sa-lugano',
      };
      expect(isFixtureJob(job)).toBe(true);
    });

    it('detects via id alone', () => {
      expect(isFixtureJob({ id: 'fixture-anything', company: 'Real Co', slug: 'real-job' })).toBe(true);
    });

    it('detects via company name alone', () => {
      expect(isFixtureJob({ id: 'real-1', company: 'Fixture Corp SA', slug: 'real-job' })).toBe(true);
      expect(isFixtureJob({ id: 'real-1', company: 'fixture corp', slug: 'real-job' })).toBe(true);
    });

    it('detects via slug alone', () => {
      expect(isFixtureJob({ id: 'real-1', company: 'Real Co', slug: 'fixture-anything' })).toBe(true);
      expect(isFixtureJob({ id: 'real-1', company: 'Real Co', slug: 'job-fixture-corp-here' })).toBe(true);
    });

    it('detects via slugByLocale', () => {
      const job = {
        id: 'real-1',
        company: 'Real Co',
        slug: 'real-job',
        slugByLocale: { de: 'fixture-something' },
      };
      expect(isFixtureJob(job)).toBe(true);
    });

    it('does not flag real Ticino jobs', () => {
      expect(isFixtureJob({
        id: 'sintetica-788434',
        company: 'Sintetica SA',
        companyKey: 'sintetica',
        slug: 'front-desk-office-support-50-70-mendrisio-site-ticino-sintetica',
      })).toBe(false);

      expect(isFixtureJob({
        id: 'lonza-001',
        company: 'Lonza',
        companyKey: 'lonza',
        slug: 'operatore-apollo-lonza',
      })).toBe(false);
    });

    it('does not flag a real company with "fix" in the name', () => {
      // Defensive test: "Fix" alone must not trigger the filter.
      expect(isFixtureJob({ id: 'fix-1', company: 'Fix It AG', slug: 'plumber-fix-it' })).toBe(false);
    });

    it('handles malformed input safely', () => {
      expect(isFixtureJob(null)).toBe(false);
      expect(isFixtureJob(undefined)).toBe(false);
      expect(isFixtureJob({})).toBe(false);
    });
  });

  describe('isFixturePath', () => {
    it('matches the canonical fixture URL paths', () => {
      expect(isFixturePath('/cerca-lavoro-ticino/software-engineer-fixture-corp-sa-lugano')).toBe(true);
      expect(isFixturePath('/cerca-lavoro-ticino/software-engineer-fixture-corp-sa-lugano/')).toBe(true);
      expect(isFixturePath('/de/jobs-im-tessin/software-engineer-fixture-corp-sa-lugano-de')).toBe(true);
    });

    it('does not match real job paths', () => {
      expect(isFixturePath('/cerca-lavoro-ticino/front-desk-office-support-50-70-mendrisio-site-ticino-sintetica')).toBe(false);
    });
  });

  describe('filterFixtureJobs', () => {
    it('drops fixture records and keeps real jobs', () => {
      const input = [
        { id: 'sintetica-1', company: 'Sintetica SA', slug: 'real-job-1' },
        { id: 'fixture-corp-canonical-abc123', company: 'Fixture Corp SA', slug: 'software-engineer-fixture-corp-sa-lugano' },
        { id: 'lonza-1', company: 'Lonza', slug: 'real-job-2' },
      ];
      const out = filterFixtureJobs(input);
      expect(out).toHaveLength(2);
      expect(out.map((j: { slug: string }) => j.slug)).toEqual(['real-job-1', 'real-job-2']);
    });

    it('returns the input untouched when no fixtures present', () => {
      const input = [{ id: '1', company: 'Real', slug: 'real' }];
      expect(filterFixtureJobs(input)).toEqual(input);
    });

    it('handles non-array input safely', () => {
      expect(filterFixtureJobs(null)).toBeNull();
      expect(filterFixtureJobs(undefined)).toBeUndefined();
    });
  });

  describe('filterFixtureSlugs', () => {
    it('drops fixture string slugs', () => {
      const input = ['real-job', 'software-engineer-fixture-corp-sa-lugano', 'another-real'];
      expect(filterFixtureSlugs(input)).toEqual(['real-job', 'another-real']);
    });

    it('drops { locale, path } entries pointing at fixture pages', () => {
      const input = [
        { locale: 'it', path: '/cerca-lavoro-ticino/real-job' },
        { locale: 'de', path: '/de/jobs-im-tessin/software-engineer-fixture-corp-sa-lugano-de' },
        { locale: 'en', path: '/en/find-jobs-ticino/another-real' },
      ];
      const out = filterFixtureSlugs(input);
      expect(out).toHaveLength(2);
    });
  });
});
