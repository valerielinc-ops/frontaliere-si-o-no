import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveCantonSection, SECTION_LEGACY_TI } from '../../build-plugins/shared/cantonSection';
import { readJobsDataset } from '../helpers/jobsDataset';
import { SCAN_TEST_TIMEOUT_MS } from '../helpers/distHtmlScan';

const DIST = path.resolve(__dirname, '../../dist');
const JOBS_PATH = path.resolve(__dirname, '../../data/jobs.json');

// Cantons sampled by the behavioural matrix below. Each is mapped to its
// IT section slug via the canonical `resolveCantonSection` helper (same
// path-derivation logic the build plugins use) so the test stays in sync
// with the build emit without duplicating the dePrefix / group-merge rules.
// Coverage across multiple cantons catches regressions where a single
// canton's section slug drifts (group-merge, dePrefix override, etc.)
// without requiring a separate test per canton.
const SAMPLED_NON_TI_CANTONS = ['ZH', 'VD', 'BE', 'GR', 'LU', 'GE', 'BS'] as const;

interface Job {
  canton?: string;
  location?: string;
  slug?: string;
  slugByLocale?: Record<string, string>;
}

// Read once, not once per `it()` — see tests/helpers/jobsDataset.ts for why
// the 8 re-parses this file used to do were what pushed a single case past
// vitest's 15s timeout and failed gate:seo-source.
const readJobs = () => readJobsDataset<Job>(JOBS_PATH);

function pickItSlug(job: Job): string | undefined {
  return job.slugByLocale?.it ?? job.slug;
}

// Read the <link rel="canonical"> href out of an emitted HTML page.
// Uses the DOM parser provided by vitest's jsdom environment so the
// assertion survives every flavour of HTML-minify output (stripped quotes,
// reordered attributes, surrounding whitespace) — the regex variant was
// fragile and silently false-negatived minified bridges in post-deploy run
// 26592389280.
function extractCanonicalHref(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const link = doc.querySelector('link[rel~="canonical" i]');
  return link?.getAttribute('href') ?? null;
}

describe('job-detail URLs route per job.canton (Phase 1)', () => {
  it('TI invariance: a Lugano job stays at /cerca-lavoro-ticino/<slug>/', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
    if (!fs.existsSync(DIST)) return;
    const jobs = readJobs();
    if (!jobs) return;
    const tiJob = jobs.find(
      (j) => j.canton === 'TI' || /lugano|mendrisio|bellinzona/i.test(j.location || ''),
    );
    if (!tiJob) return;
    const slug = pickItSlug(tiJob);
    if (!slug) return;
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html'))).toBe(true);
  });

  // ── Behavioural matrix: for every non-TI canton sampled, pick a job and
  //    assert
  //      (1) the canton-aware page MUST exist (Phase 1 routing contract),
  //      (2) if the legacy /cerca-lavoro-ticino/<slug>/ bridge ALSO exists
  //          (Phase 8c cross-canton legacy TI bridge,
  //          jobsSeoPagesPlugin.ts:3236-3265), its <link rel="canonical">
  //          MUST point back at the canton-aware URL so link equity
  //          consolidates instead of cannibalising the new section.
  for (const cantonCode of SAMPLED_NON_TI_CANTONS) {
    const sectionSlug = resolveCantonSection('it', cantonCode);
    it(`non-TI ${cantonCode}: emits at /${sectionSlug}/<slug>/ + legacy TI bridge canonicalises to it`, { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
      if (!fs.existsSync(DIST)) return;
      const jobs = readJobs();
      if (!jobs) return;
      const job = jobs.find((j) => j.canton === cantonCode);
      if (!job) return; // canton not represented in current dataset — skip
      const slug = pickItSlug(job);
      if (!slug) return;

      // (1) Canonical canton-aware page MUST exist.
      const canonPage = path.join(DIST, sectionSlug, slug, 'index.html');
      expect(fs.existsSync(canonPage), `canton-aware page missing for ${cantonCode} job ${slug} at /${sectionSlug}/`).toBe(true);

      // (2) Legacy TI bridge MAY exist; when it does, canonical → canton-aware.
      const legacyBridge = path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html');
      if (!fs.existsSync(legacyBridge)) return;
      const href = extractCanonicalHref(fs.readFileSync(legacyBridge, 'utf8'));
      expect(href, `legacy TI bridge for ${cantonCode} job ${slug} has no <link rel=canonical>`).toBeTruthy();
      expect(href!, `legacy TI bridge for ${cantonCode} job ${slug} canonicalises to TI instead of /${sectionSlug}/: ${href}`)
        .toMatch(new RegExp(`/${sectionSlug}/`));
      expect(href!, `legacy TI bridge for ${cantonCode} job ${slug} canonicalises to legacy TI section: ${href}`)
        .not.toMatch(/\/cerca-lavoro-ticino\//);
    });
  }
});

// en/de/fr: the legacy TI URL of a NON-TI job is not a page any more. The build
// used to write the expired soft-landing there again (index,follow, canonical =
// the native canton page: 911k canonicalMismatch advisories on the full-corpus
// replay) and a noindex copy of every active cross-canton job; both are gone,
// the shard origin 404s and the locale-router Worker 301s the URL to the canton
// page (tests/locale-router-canton-drift-301.test.ts). Anything still found at
// such a path must therefore be a page that canonicalises to ITSELF (another
// job's real TI page), never a bridge pointing elsewhere.
const NON_IT_LOCALES = ['en', 'de', 'fr'] as const;
const REGISTRY_SAMPLE_PART = path.resolve(__dirname, '../../data/all-known-job-slugs/part-00.json');
const REGISTRY_SAMPLE_SIZE = 400;

function legacyTiFile(locale: (typeof NON_IT_LOCALES)[number], slug: string): string {
  return path.join(DIST, locale, SECTION_LEGACY_TI[locale], slug, 'index.html');
}

function expectSelfCanonicalOrAbsent(file: string, url: string, what: string): void {
  if (!fs.existsSync(file)) return;
  const href = extractCanonicalHref(fs.readFileSync(file, 'utf8'));
  expect(href, `${what}: a page is still emitted at ${url} with canonical ${href}`).toBe(`https://frontaliereticino.ch${url}`);
}

describe('en/de/fr: no legacy TI copy of a non-TI job', () => {
  for (const locale of NON_IT_LOCALES) {
    it(`${locale}: active non-TI jobs have no page under /${locale}/${SECTION_LEGACY_TI[locale]}/`, { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
      if (!fs.existsSync(path.join(DIST, locale))) return;
      const jobs = readJobs();
      if (!jobs) return;
      for (const cantonCode of SAMPLED_NON_TI_CANTONS) {
        const job = jobs.find((j) => j.canton === cantonCode && j.slug);
        if (!job?.slug) continue;
        const url = `/${locale}/${SECTION_LEGACY_TI[locale]}/${job.slug}/`;
        expectSelfCanonicalOrAbsent(legacyTiFile(locale, job.slug), url, `active ${cantonCode} job`);
      }
    });

    it(`${locale}: expired non-TI registry slugs have no page under /${locale}/${SECTION_LEGACY_TI[locale]}/`, { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
      if (!fs.existsSync(path.join(DIST, locale)) || !fs.existsSync(REGISTRY_SAMPLE_PART)) return;
      const part = JSON.parse(fs.readFileSync(REGISTRY_SAMPLE_PART, 'utf8')) as { slugs?: Record<string, Record<string, string>> };
      const section = `/${locale}/${SECTION_LEGACY_TI[locale]}/`;
      let checked = 0;
      for (const [slug, paths] of Object.entries(part.slugs ?? {})) {
        const localePath = paths?.[locale];
        if (!localePath || localePath.startsWith(section)) continue; // TI job, or no page in this locale
        expectSelfCanonicalOrAbsent(legacyTiFile(locale, slug), `${section}${slug}/`, `registry slug living at ${localePath}`);
        if (++checked >= REGISTRY_SAMPLE_SIZE) break;
      }
    });
  }
});
