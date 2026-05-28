import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('job-detail URLs route per job.canton (Phase 1)', () => {
  it('a Zurich job in jobs.json emits at /cerca-lavoro-zurigo/<slug>/ with canton-aware canonical', () => {
    if (!fs.existsSync(DIST)) return;
    const jobsPath = path.resolve(__dirname, '../../data/jobs.json');
    if (!fs.existsSync(jobsPath)) return;
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const zhJob = jobs.find((j: { canton?: string }) => j.canton === 'ZH');
    if (!zhJob) return; // skip if dataset has no ZH job
    const slug = zhJob.slugByLocale?.it || zhJob.slug;
    // Phase 1: the canonical canton-aware page MUST exist. This is the URL the
    // SPA navigates to, the URL in the sitemap, and the canonical target every
    // bridge points at.
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-zurigo', slug, 'index.html'))).toBe(true);
    // Phase 8b/c (cross-canton legacy TI bridge — see jobsSeoPagesPlugin.ts:3236-3265):
    // the legacy /cerca-lavoro-ticino/<slug>/ MAY exist for non-TI jobs as a
    // soft-landing for Google-indexed pre-cathedral URLs. When it exists, its
    // canonical MUST point back to the canton-aware URL so link equity
    // consolidates on the cathedral target instead of cannibalising the new
    // section. The behavioural assertion in
    // cathedral-previous-slug-canton.test.ts already enforces this for
    // previousSlugs; here we extend the same contract to the current slug.
    const legacyBridge = path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html');
    if (fs.existsSync(legacyBridge)) {
      const html = fs.readFileSync(legacyBridge, 'utf8');
      // The HTML minifier strips quotes around simple attribute values
      // (`rel=canonical href=...`), so the regex must tolerate quoted +
      // unquoted forms in either attribute order.
      const m = html.match(/<link\b[^>]*\brel=["']?canonical["']?[^>]*\bhref=["']?([^"'\s>]+)/i)
        ?? html.match(/<link\b[^>]*\bhref=["']?([^"'\s>]+)[^>]*\brel=["']?canonical["']?/i);
      expect(m, `legacy TI bridge for ZH job ${slug} has no <link rel=canonical>`).toBeTruthy();
      expect(m![1], `legacy TI bridge for ZH job ${slug} canonicalises to TI instead of /cerca-lavoro-zurigo/: ${m![1]}`)
        .toMatch(/\/cerca-lavoro-zurigo\//);
    }
  });

  it('a Lugano job stays at /cerca-lavoro-ticino/<slug>/ (TI invariance)', () => {
    if (!fs.existsSync(DIST)) return;
    const jobsPath = path.resolve(__dirname, '../../data/jobs.json');
    if (!fs.existsSync(jobsPath)) return;
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const tiJob = jobs.find(
      (j: { canton?: string; location?: string }) =>
        j.canton === 'TI' || /lugano|mendrisio|bellinzona/i.test(j.location || ''),
    );
    if (!tiJob) return;
    const slug = tiJob.slugByLocale?.it || tiJob.slug;
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html'))).toBe(true);
  });
});
