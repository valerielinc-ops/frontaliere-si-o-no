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

  it('keeps the native canton for EXPIRED canton-drifted slugs (no Ticino hijack)', () => {
    // COMPAT_JOB_PATTERNS only match Ticino sections, so a canton-drifted job
    // indexed under its native non-TI canton (e.g. Zurich) AND a legacy TI
    // section used to have its rich soft-landing moved onto the TI path,
    // abandoning the native indexed URL to the thin cfHot404 "Pagina archiviata"
    // stub. The guard keeps the native ledger path for EXPIRED (non-current)
    // slugs while preserving the #2600 override for ACTIVE slugs (whose native
    // canton is already served by the live job page).
    const driftStart = pluginSource.indexOf('Canton-drift recovery');
    const guardIdx = pluginSource.indexOf('if (known && !currentSlugs.has(slug)) break;');
    expect(driftStart).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(driftStart);
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

// Regression guard for PR #2397 🔴: the prose / Auto-Ads gate (__slKeepProse) and the
// thin-shell gate (__slDecision) probe DELIBERATELY DIFFERENT path-sets. The dedup PR
// #2397 originally collapsed them into one set, which dropped the legacy IT mirror
// `/cerca-lavoro-ticino/${slug}` from the IT-locale prose gate for canton-aware jobs,
// silently stripping prose + Auto Ads from genuinely-trafficked expired pages.
describe('soft-landing prose gate path-set (PR #2397 set-equality)', () => {
  it('prose gate uses its own __slProsePaths set distinct from the thin __slCandidatePaths', () => {
    expect(pluginSource).toContain('const __slKeepProse = trafficFilter.decideMulti(__slProsePaths');
    // The thin-shell gate keeps probing __slCandidatePaths (unchanged scope).
    expect(pluginSource).toContain('const __slDecision = trafficFilter.decideMulti(__slCandidatePaths');
  });

  it('prose set unconditionally probes the IT legacy mirror (incl. for it-locale canton-aware jobs)', () => {
    expect(pluginSource).toContain('const __slItLegacyMirror = `/${localePrefix.it}/${sectionByLocale.it}/${slug}`');
    expect(pluginSource).toContain('[...__slCandidatePaths, __slItLegacyMirror]');
  });

  // Algebraic proof that the live builders reproduce the ORIGINAL __slProsePaths
  // semantics (relPath ∪ {legacy section path for EVERY locale}) while keeping the
  // thin __slCandidatePaths scope intact. We replicate the exact builder algebra and
  // assert the invariant for an IT-locale NON-TI (canton-aware) job — the bug class.
  const localeList = ['it', 'en', 'de', 'fr'] as const;
  const localePrefix: Record<(typeof localeList)[number], string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
  const sectionByLocale: Record<(typeof localeList)[number], string> = {
    it: 'cerca-lavoro-ticino',
    en: 'find-jobs-ticino',
    de: 'jobs-im-tessin',
    fr: 'trouver-emploi-tessin',
  };
  const slug = 'sviluppatore-software-argovia';

  // The ORIGINAL __slProsePaths (pre-#2397): relPath + every locale's legacy section.
  function originalProsePaths(relPath: string): string[] {
    const out: string[] = [relPath];
    for (const L of localeList) {
      const p = `/${localePrefix[L]}/${sectionByLocale[L]}/${slug}`.replace(/\/+/g, '/');
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  // The CURRENT builders (must mirror jobsSeoPagesPlugin.ts exactly).
  function currentSets(locale: (typeof localeList)[number], relPath: string): { candidate: string[]; prose: string[] } {
    const candidate: string[] = [relPath];
    if (locale !== 'it') {
      const legacyRel = `/${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
      if (legacyRel !== relPath) candidate.push(legacyRel);
    }
    for (const other of localeList) {
      if (other === locale) continue;
      const p = `/${localePrefix[other]}/${sectionByLocale[other]}/${slug}`.replace(/\/+/g, '/');
      if (!candidate.includes(p)) candidate.push(p);
    }
    const itMirror = `/${localePrefix.it}/${sectionByLocale.it}/${slug}`.replace(/\/+/g, '/');
    const prose = candidate.includes(itMirror) ? candidate : [...candidate, itMirror];
    return { candidate, prose };
  }

  it('IT-locale canton-aware page: prose set is set-equal to the original and contains the TI mirror', () => {
    const relPath = `/cerca-lavoro-argovia/${slug}`; // non-TI IT canton-aware page
    const { candidate, prose } = currentSets('it', relPath);
    // Bug repro: thin-gate (candidate) MUST NOT contain the IT TI mirror...
    expect(candidate).not.toContain(`/cerca-lavoro-ticino/${slug}`);
    // ...but the prose gate MUST (this is the dropped historical signal).
    expect(prose).toContain(`/cerca-lavoro-ticino/${slug}`);
    // And the prose set is exactly the original __slProsePaths set (order-insensitive).
    expect([...prose].sort()).toEqual([...originalProsePaths(relPath)].sort());
  });

  it('set-equality holds across all locales (incl. TI relPath)', () => {
    const cases: Array<{ locale: (typeof localeList)[number]; relPath: string }> = [
      { locale: 'it', relPath: `/cerca-lavoro-argovia/${slug}` },
      { locale: 'it', relPath: `/cerca-lavoro-ticino/${slug}` },
      { locale: 'en', relPath: `/en/find-jobs-aargau/${slug}` },
      { locale: 'de', relPath: `/de/jobs-im-aargau/${slug}` },
      { locale: 'fr', relPath: `/fr/trouver-emploi-argovie/${slug}` },
    ];
    for (const { locale, relPath } of cases) {
      const { prose } = currentSets(locale, relPath);
      expect([...prose].sort()).toEqual([...originalProsePaths(relPath)].sort());
    }
  });
});
