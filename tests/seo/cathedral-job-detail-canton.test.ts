import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveCantonSection } from '../../build-plugins/shared/cantonSection';

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

function readJobs(): Job[] | null {
  if (!fs.existsSync(JOBS_PATH)) return null;
  return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8')) as Job[];
}

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
  it('TI invariance: a Lugano job stays at /cerca-lavoro-ticino/<slug>/', () => {
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
    it(`non-TI ${cantonCode}: emits at /${sectionSlug}/<slug>/ + legacy TI bridge canonicalises to it`, () => {
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
