import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pluginSource = fs.readFileSync(
  path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf-8'
);
const seoServiceSource = fs.readFileSync(
  path.resolve(root, 'services/seoService.ts'),
  'utf-8'
);
const jobBoardSource = fs.readFileSync(
  path.resolve(root, 'components/community/JobBoard.tsx'),
  'utf-8'
);

describe('Soft-landing SEO pages for expired jobs', () => {
  it('uses noindex only for expired pages WITHOUT rich content (thin-content orphans)', () => {
    const expiredSection = pluginSource.slice(pluginSource.indexOf('Expired-job'));
    // Robots directive is conditional on content quality via robotsMetaForContent()
    // Pages with >= MIN_INDEXABLE_WORDS get index,follow; below threshold get noindex,follow
    expect(expiredSection).toContain('robotsMetaForContent');
    // The computed tag is stored as expiredRobotsTag and injected into HTML
    expect(expiredSection).toContain('expiredRobotsTag');
  });

  it('uses self-referencing canonical for expired pages', () => {
    const expiredSection = pluginSource.slice(pluginSource.indexOf('Expired-job'));
    expect(expiredSection).not.toContain('canonical" href="${redirectUrl}"');
  });

  it('reads expired-jobs.json for data', () => {
    expect(pluginSource).toContain('expired-jobs.json');
  });

  it('generates previousSlugs full-content pages for active jobs', () => {
    expect(pluginSource).toContain('previousSlugs');
  });

  it('includes JobPosting with validThrough in expired pages (FRO-194)', () => {
    // Expired pages now include a JobPosting with a past validThrough date
    // so Google recognizes the job as expired while keeping semantic data
    const expiredStart = pluginSource.indexOf('Expired-job') ?? pluginSource.indexOf('expired');
    const fullContentStart = pluginSource.indexOf('Full-content pages for previousSlugs');
    const expiredSection = fullContentStart > expiredStart
      ? pluginSource.slice(expiredStart, fullContentStart)
      : pluginSource.slice(expiredStart);
    expect(expiredSection).toContain('JobPosting');
    expect(expiredSection).toContain('validThrough');
  });

  it('includes expired jobs in sitemap at low priority', () => {
    expect(pluginSource).toContain('sitemap-jobs-expired.xml');
  });
});

describe('SPA does not override static HTML metadata for expired job pages', () => {
  it('seoService.ts skips metadata update when __EXPIRED_JOB_DATA__ is present', () => {
    // The updateMetaTags function must detect expired job pages via the build-plugin-seeded
    // window.__EXPIRED_JOB_DATA__ and bail out before overwriting static HTML metadata
    expect(seoServiceSource).toContain('__EXPIRED_JOB_DATA__');
    // The guard must check isJobDetailPage && !jobSeo (job not in active dataset)
    expect(seoServiceSource).toContain('isJobDetailPage && !jobSeo');
  });

  it('JobBoard.tsx preserves metadata when expiredJob is detected', () => {
    // The canonical/title useEffect and schema useEffect must skip updates for expired jobs.
    // The guard checks initialJobSlug && !selectedJob && (expiredJob || hasSeededExpiredData())
    expect(jobBoardSource).toContain('initialJobSlug && !selectedJob && (expiredJob || hasSeededExpiredData())');
  });

  it('JobBoard.tsx skips dynamic JobPosting schema injection for expired jobs', () => {
    // The structured data useEffect (identified by jobposting-structured-data ID) must
    // include the expired job guard before generating listing-page schemas.
    // The guard checks initialJobSlug && !selectedJob to skip expired/orphan pages.
    const schemaEffectStart = jobBoardSource.indexOf("const CONTRACT_MAP: Record<string, string>");
    const schemaEffectEnd = jobBoardSource.indexOf('jobposting-structured-data');
    const schemaSection = jobBoardSource.slice(
      Math.max(0, schemaEffectStart - 500),
      schemaEffectEnd
    );
    expect(schemaSection).toContain('initialJobSlug && !selectedJob');
  });
});
