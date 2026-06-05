import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SLIM_INDEX_FIELDS, buildLocaleJob, buildSlimSeed } from '../build-plugins/shared/slimJobIndex';

const root = path.resolve(__dirname, '..');

/**
 * Per-job seed (2026-06-05): active job-detail pages inject window.__JOB_SEED__
 * (a slim job record) so the SPA resolves `selectedJob` on the first paint and
 * fetches only /data/job-detail/<id>.json (~2-4 KB gzip) for the body — instead
 * of blocking the detail render on the ~1.2 MB (gzip) slim index.
 *
 * The seed MUST be byte-shape-identical to a jobs-<locale>-index.json entry, so
 * both are built from one shared module (build-plugins/shared/slimJobIndex).
 */
describe('Per-job detail seed (window.__JOB_SEED__)', () => {
  const sampleJob = {
    id: 'kulm-675',
    slug: 'assistant-front-office-it',
    slugByLocale: { it: 'assistant-front-office-it', de: 'assistant-front-office-de' },
    titleByLocale: { it: 'Assistant IT', de: 'Assistant DE' },
    title: 'Assistant base',
    company: 'Kulm Hotel',
    location: 'St. Moritz',
    canton: 'GR',
    category: 'hospitality',
    salaryMin: 50000,
    salaryMax: 60000,
    currency: 'CHF',
    // detail-only — must NOT leak into the slim seed:
    description: 'A very long description that belongs in the per-job file only.',
    descriptionByLocale: { it: 'descrizione lunga', de: 'lange Beschreibung' },
    requirements: ['a', 'b', 'c'],
    baseSalary: { value: { minValue: 50000, maxValue: 60000, currency: 'CHF' } },
    streetAddress: 'Via Maistra 1',
    postalCode: '7500',
  };

  describe('shared slimJobIndex.buildSlimSeed', () => {
    it('flattens *ByLocale into the requested locale', () => {
      const seed = buildSlimSeed(sampleJob, 'de');
      expect(seed.title).toBe('Assistant DE');
      expect(seed.slug).toBe('assistant-front-office-de');
    });

    it('falls back to base fields when the locale is missing', () => {
      const seed = buildSlimSeed({ id: 'x', slug: 's', title: 'Base only', company: 'C' }, 'fr');
      expect(seed.title).toBe('Base only');
      expect(seed.slug).toBe('s');
    });

    it('keeps only SLIM_INDEX_FIELDS — never detail-only payload', () => {
      const seed = buildSlimSeed(sampleJob, 'it');
      for (const key of Object.keys(seed)) {
        expect(SLIM_INDEX_FIELDS.has(key)).toBe(true);
      }
      // Detail-only fields that would bloat the inline <script> must be absent.
      expect(seed).not.toHaveProperty('description');
      expect(seed).not.toHaveProperty('descriptionByLocale');
      expect(seed).not.toHaveProperty('requirements');
      expect(seed).not.toHaveProperty('baseSalary');
      expect(seed).not.toHaveProperty('streetAddress');
      expect(seed).not.toHaveProperty('postalCode');
    });

    it('carries the header/JSON-LD identification fields the detail view reads', () => {
      const seed = buildSlimSeed(sampleJob, 'it');
      for (const key of ['id', 'company', 'location', 'canton', 'category', 'salaryMin', 'salaryMax', 'currency']) {
        expect(seed).toHaveProperty(key);
      }
    });

    it('buildLocaleJob and buildSlimSeed agree on the slim subset', () => {
      const full = buildLocaleJob(sampleJob, 'it');
      const seed = buildSlimSeed(sampleJob, 'it');
      for (const key of Object.keys(seed)) {
        expect(seed[key]).toEqual(full[key]);
      }
    });
  });

  describe('single source of truth (no drift)', () => {
    it('localeJobsSplitPlugin imports the field set from shared, does not redefine it', () => {
      const src = fs.readFileSync(path.resolve(root, 'build-plugins/localeJobsSplitPlugin.ts'), 'utf-8');
      expect(src).toMatch(/from '\.\/shared\/slimJobIndex'/);
      // The local copy must be gone — only one SLIM_INDEX_FIELDS definition in the repo (the shared one).
      expect(src).not.toMatch(/const SLIM_INDEX_FIELDS\s*=/);
    });

    it('jobsSeoPagesPlugin builds the seed via the shared helper', () => {
      const src = fs.readFileSync(path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');
      expect(src).toMatch(/import \{ buildSlimSeed \} from '\.\/shared\/slimJobIndex'/);
      expect(src).toMatch(/buildSlimSeed\(job, locale\)/);
    });
  });

  describe('jobsSeoPagesPlugin emit', () => {
    const src = fs.readFileSync(path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');

    it('injects window.__JOB_SEED__ as an inline script', () => {
      expect(src).toMatch(/window\.__JOB_SEED__=/);
    });

    it('forces the seed slug to the canonical per-locale slug (bridge-safe)', () => {
      expect(src).toMatch(/__jobSeed\.slug = perLocaleSlug\[locale\]/);
    });

    it('escapes "<" so a title/company cannot break out of the inline script', () => {
      expect(src).toMatch(/JSON\.stringify\(__jobSeed\)\.replace\(\/<\/g, '\\\\u003c'\)/);
    });

    it('places the seed before the SPA action-redirect script', () => {
      const seedIdx = src.indexOf('${seedScript}');
      const spaIdx = src.indexOf('${SPA_ACTION_REDIRECT_SCRIPT}');
      expect(seedIdx).toBeGreaterThan(0);
      expect(spaIdx).toBeGreaterThan(0);
      expect(seedIdx).toBeLessThan(spaIdx);
    });
  });

  describe('JobBoard consumption', () => {
    const src = fs.readFileSync(path.resolve(root, 'components/community/JobBoard.tsx'), 'utf-8');

    it('reads window.__JOB_SEED__ via readSeededJob (memoised once per mount)', () => {
      expect(src).toMatch(/window as unknown as Record<string, unknown>\)\.__JOB_SEED__/);
      expect(src).toMatch(/const seededJob = useMemo\(\(\) => readSeededJob\(\), \[\]\)/);
    });

    it('seeds the initial jobs state with the build-injected record', () => {
      expect(src).toMatch(/useState<JobListing\[\]>\(\(\) => \(seededJob \? \[seededJob\] : \[\]\)\)/);
    });

    it('re-applies fetched detail in finalize so the full-index load does not clobber it', () => {
      expect(src).toMatch(/resolvedJobDetail\.get\(j\.id\)/);
    });

    it('keeps the seed in finalize when the loaded shard lacks it (no orphan flash at jobsLoading===false)', () => {
      expect(src).toMatch(/seededJob\?\.id && !reEnriched\.some\(\(j\) => j\.id === seededJob\.id\)/);
      expect(src).toMatch(/setJobs\(finalJobs\)/);
    });

    it('renders a seeded active detail immediately instead of the jobsLoading spinner', () => {
      // Without this the unconditional `if (jobsLoading) return <spinner>` masks
      // the seed until the full index lands — the seed would be dead weight.
      expect(src).toMatch(/const seededActiveDetail = selectedJob && initialJobSlug/);
      expect(src).toMatch(/if \(!seededActiveDetail\) \{[\s\S]{0,1200}Loader2/);
    });
  });
});
