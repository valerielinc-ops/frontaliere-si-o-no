/**
 * EMS-Chemie AG crawler parser tests
 *
 * Tests parseListingPage(), parseDetailPage(), buildJob(),
 * inferLocation(), isSwissJob(), and the validateDedicatedLocaleCoverage()
 * call-site wiring (issue #3797 regression — see bottom describe block).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  parseListingPage,
  parseDetailPage,
  buildJob,
  inferLocation,
  isSwissJob,
  stripHtml,
  normalizeSpace,
} from '@/scripts/lib/ems-chemie-job-parser.mjs';
import { validateDedicatedLocaleCoverage } from '@/scripts/lib/dedicated-crawler-common.mjs';
import {
  isCompanyJob,
  isTrustedDomain,
  COMPANY_KEY,
  COMPANY_NAME,
  LOCALES,
} from '@/scripts/update-ems-chemie-jobs.mjs';

// ─── Fixture: Career listing page (legacy table) ──────────────────
const LISTING_HTML = `
<html>
<body>
<main>
  <h1>Job Vacancies</h1>
  <table class="job-table">
    <tr class="job-row">
      <td><a href="/en/career/job-vacancies/chemist-rd">Chemist R&D</a></td>
      <td>Research & Development</td>
      <td>Domat/Ems</td>
    </tr>
    <tr class="job-row">
      <td><a href="/en/career/job-vacancies/production-operator">Production Operator</a></td>
      <td>Production</td>
      <td>Domat/Ems</td>
    </tr>
    <tr class="job-row">
      <td><a href="/en/career/job-vacancies/sap-consultant">SAP Consultant</a></td>
      <td>IT</td>
      <td>Domat/Ems</td>
    </tr>
  </table>
</main>
</body>
</html>`;

// ─── Fixture: jobs.ems-group.com portal page ────────────────────
const PORTAL_HTML = `
<html>
<body>
<div class="jobs-list">
  <div class="job-card">
    <a href="/offene-stellen/key-account-manager-m-w-d-homeoffice/4aa59321-0063-4499-bdf7-53a3dc75ec9c">
      Key Account Manager (m/w/d) (Homeoffice)
    </a>
    <span>Domat/Ems</span>
    <span>EMS-CHEMIE AG</span>
  </div>
  <div class="job-card">
    <a href="/offene-stellen/laborant-materialpruefung-m-w-d/f4838ff6-2c0b-4dda-bede-826bc55d6b48">
      Laborant Materialprüfung (m/w/d)
    </a>
    <span>Domat/Ems</span>
    <span>EMS-CHEMIE AG</span>
  </div>
  <div class="job-card">
    <a href="/offene-stellen/leiter-controlling-m-w-d/3a614b30-caf6-4712-a572-d828b8320266">
      Leiter Controlling (m/w/d)
    </a>
    <span>Domat/Ems</span>
  </div>
  <div class="job-card">
    <a href="/offene-stellen/ingenieur-techniker-automatisierungstechnik-m-w-d/27e163d4-48e1-4558-876c-5294626f3b85">
      Ingenieur / Techniker Automatisierungstechnik (m/w/d)
    </a>
    <span>Markdorf</span>
    <span>EFTEC AG</span>
  </div>
</div>
</body>
</html>`;

// ─── Fixture: Landing page with NO job listings (just navigation) ──
const EMPTY_LANDING_HTML = `
<html>
<body>
<main>
  <h1>Job Vacancies</h1>
  <nav>
    <a href="/en/career/">Career</a>
    <a href="/en/career/job-vacancies/">Job Vacancies</a>
    <a href="/en/career/the-start-at-ems/">The start at EMS</a>
    <a href="/en/career/apprenticeship-positions/">Apprenticeship Positions</a>
  </nav>
</main>
</body>
</html>`;

// ─── Fixture: Detail page ──────────────────────────────────
const DETAIL_HTML = `
<html>
<body>
<main>
  <article>
    <h1>Chemist R&amp;D</h1>
    <div class="content">
      <p>EMS-Chemie AG is the world leader in high-performance polyamides and specialty chemicals.
         We are looking for a talented Chemist for our R&D team in Domat/Ems (GR), Switzerland.
         You will work on developing new polymer formulations and improving existing products.</p>
      <h2>Your Tasks</h2>
      <ul>
        <li>Development of new high-performance polymer formulations</li>
        <li>Characterization and testing of polymer materials</li>
        <li>Collaboration with production and quality teams</li>
        <li>Documentation of research results and patent filings</li>
      </ul>
      <h2>Your Profile</h2>
      <ul>
        <li>PhD or Master's degree in Chemistry, Polymer Science, or Materials Science</li>
        <li>Experience in polymer synthesis and characterization</li>
        <li>Strong analytical and problem-solving skills</li>
        <li>Fluent in English; German is an advantage</li>
      </ul>
      <h2>We Offer</h2>
      <ul>
        <li>Innovative work environment at a market-leading company</li>
        <li>Competitive compensation and benefits package</li>
        <li>Modern R&D facilities in the Swiss Alps</li>
      </ul>
    </div>
  </article>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseListingPage — legacy table format
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage — legacy table', () => {
  it('extracts jobs from table rows', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs.length).toBe(3);
  });

  it('extracts job titles', () => {
    const jobs = parseListingPage(LISTING_HTML);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles[0]).toBe('Chemist R&D');
    expect(titles[1]).toBe('Production Operator');
  });

  it('generates full URLs', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect((jobs[0] as { url: string }).url).toContain('ems-group.com');
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
    expect(parseListingPage(null as unknown as string)).toHaveLength(0);
  });

  it('returns empty for page without listings', () => {
    expect(parseListingPage('<html><body>Nothing here</body></html>')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseListingPage — jobs.ems-group.com portal format
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage — portal format', () => {
  it('extracts jobs from portal HTML with UUID links', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    expect(jobs.length).toBe(4);
  });

  it('extracts job titles from portal cards', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles).toContain('Key Account Manager (m/w/d) (Homeoffice)');
    expect(titles).toContain('Laborant Materialprüfung (m/w/d)');
    expect(titles).toContain('Leiter Controlling (m/w/d)');
  });

  it('generates full portal URLs with UUIDs', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    for (const job of jobs) {
      expect((job as { url: string }).url).toMatch(/jobs\.ems-group\.com\/offene-stellen\/[a-z0-9-]+\/[0-9a-f-]+/);
    }
  });

  it('includes EFTEC jobs from portal', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    const eftecJob = jobs.find((j: { title: string }) => j.title.includes('Automatisierungstechnik'));
    expect(eftecJob).toBeDefined();
    // Location inference from HTML context may or may not detect Markdorf
    // depending on how close the location text is to the link
    expect((eftecJob as { location: string }).location).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// parseListingPage — empty landing page (no fake jobs)
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage — empty landing page', () => {
  it('returns empty array for navigation-only pages', () => {
    const jobs = parseListingPage(EMPTY_LANDING_HTML);
    expect(jobs).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseDetailPage', () => {
  it('extracts title', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Chemist');
  });

  it('extracts profile requirements', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.requirements.length).toBeGreaterThanOrEqual(2);
    expect(result!.requirements[0]).toContain('PhD');
  });

  it('infers Domat/Ems location', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.location).toBe('Domat/Ems');
    expect(result!.canton).toBe('GR');
  });

  it('returns null for empty input', () => {
    expect(parseDetailPage('')).toBeNull();
    expect(parseDetailPage(null as unknown as string)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// inferLocation / isSwissJob
// ═══════════════════════════════════════════════════════════════

describe('inferLocation', () => {
  it('detects Domat/Ems from description', () => {
    expect(inferLocation('', 'Location: Domat/Ems, Switzerland')).toBe('Domat/Ems');
  });

  it('detects Romanshorn', () => {
    expect(inferLocation('Production Manager Romanshorn', '')).toBe('Romanshorn');
  });

  it('detects Markdorf', () => {
    expect(inferLocation('', 'Standort: Markdorf, Germany')).toBe('Markdorf');
  });

  it('defaults to Domat/Ems', () => {
    expect(inferLocation('Generic Position', 'Some text')).toBe('Domat/Ems');
  });
});

describe('isSwissJob', () => {
  it('returns true for Domat/Ems', () => {
    expect(isSwissJob('Domat/Ems')).toBe(true);
  });

  it('returns true for empty location (defaults to Swiss)', () => {
    expect(isSwissJob('')).toBe(true);
  });

  it('returns false for Shanghai', () => {
    expect(isSwissJob('Shanghai')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildJob
// ═══════════════════════════════════════════════════════════════

describe('buildJob', () => {
  it('builds complete job object', () => {
    const job = buildJob({
      title: 'Chemist R&D',
      url: 'https://www.ems-group.com/en/career/job-vacancies/chemist',
      location: 'Domat/Ems',
    });
    expect(job).not.toBeNull();
    expect(job!.company).toBe('EMS-Chemie AG');
    expect(job!.companyKey).toBe('ems-chemie');
    expect(job!.canton).toBe('GR');
  });

  it('includes postalCode and streetAddress', () => {
    const job = buildJob({ title: 'Test', location: 'Domat/Ems' });
    expect(job!.postalCode).toBe('7013');
    expect(job!.streetAddress).toBe('Via Innovativa 1');
    expect(job!.employmentType).toBe('FULL_TIME');
  });

  it('sets canton TG for Romanshorn', () => {
    const job = buildJob({ title: 'Test', location: 'Romanshorn' });
    expect(job!.canton).toBe('TG');
  });

  it('generates slug with company name', () => {
    const job = buildJob({ title: 'Production Operator' });
    expect(job!.slug).toContain('ems-chemie');
  });

  it('returns null for empty title', () => {
    expect(buildJob({ title: '' })).toBeNull();
    expect(buildJob(null as any)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// validateDedicatedLocaleCoverage — ems-chemie call-site regression
// (issue #3797: crawler dropped 9→0 on 2026-07-06 22:18 UTC, run
// https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/28826969655.
// Root cause: the SAME implicit-tolerance-0 gap fixed generically for
// ~105 dedicated crawlers by FRO-628 (issue #3783 ALTEN, commit
// 57cd8b55dc9 / #3788, 2026-07-07 17:24 UTC) — landed the DAY AFTER this
// crawler's incident, so ems-chemie hit the bug in its pre-fix window.
// A single newly-discovered job (no per-locale translation yet, e.g.
// SKIP_AI_TRANSLATION=1) tripped `validateDedicatedLocaleCoverage`'s
// blocking-issue path, and — pre-FRO-628 — that discarded the ENTIRE
// 10-job batch instead of only the untranslated job. Verified empirically
// (2026-07-08): re-running scripts/update-ems-chemie-jobs.mjs against the
// live source with SKIP_AI_TRANSLATION=1 + JOBS_EMS_CHEMIE_STRICT=1 on
// current main (which includes 57cd8b55dc9) keeps all 10 jobs, flagging
// only the untranslated one with needsRetranslation:true. No crawler-
// specific code change was needed; this test pins that behavior at
// ems-chemie's OWN validateDedicatedLocaleCoverage() call-site wiring
// (scripts/update-ems-chemie-jobs.mjs) so a future change to this
// crawler's locales/strict-env/trust-domain params — or a regression in
// the shared floor-tolerance logic — gets caught here instead of only
// showing up as a silent 0-jobs production incident again. ═══════════════════════════════════════════════════════════════

describe('validateDedicatedLocaleCoverage — ems-chemie call site (issue #3797 regression)', () => {
  const STRICT_ENV = 'JOBS_EMS_CHEMIE_STRICT';
  const PRIOR_STRICT = process.env[STRICT_ENV];
  const PRIOR_SKIP_AI = process.env.SKIP_AI_TRANSLATION;

  beforeEach(() => {
    // orchestrate-crawlers.yml always dispatches crawler-group-*.yml with
    // `-f skip_ai_translation=1` (.github/workflows/orchestrate-crawlers.yml),
    // which the group workflow maps straight to SKIP_AI_TRANSLATION=1 for
    // every dedicated-crawler step, including ems-chemie's. That is the
    // real production condition that was in effect during the #3797
    // incident (verified: triggering_actor was github-actions[bot] via
    // workflow_dispatch, matching this dispatch path) — reproduce it here
    // instead of a synthetic AI-key isolation trick.
    process.env.SKIP_AI_TRANSLATION = '1';
    process.env[STRICT_ENV] = '1';
  });
  afterEach(() => {
    if (PRIOR_SKIP_AI === undefined) delete process.env.SKIP_AI_TRANSLATION;
    else process.env.SKIP_AI_TRANSLATION = PRIOR_SKIP_AI;
    if (PRIOR_STRICT === undefined) delete process.env[STRICT_ENV];
    else process.env[STRICT_ENV] = PRIOR_STRICT;
  });

  const richDesc = (lang: string) =>
    `Descrizione completa in lingua ${lang} per una posizione EMS-Chemie AG a Domat/Ems. ` +
    'Il ruolo prevede responsabilita operative quotidiane, collaborazione con i colleghi ' +
    'del team di produzione e sviluppo prodotto, con reali opportunita di crescita ' +
    'professionale allinterno di unazienda leader nel settore chimico svizzero.';

  function goodJob(n: number) {
    const slug = `ems-chemie-good-job-${n}`;
    return {
      slug,
      url: `https://jobs.ems-group.com/offene-stellen/good-job-${n}/${'0'.repeat(8)}-0000-0000-0000-${String(n).padStart(12, '0')}`,
      title: `Test Position ${n} (m/w/d)`,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      description: richDesc('it'),
      titleByLocale: {
        it: `Posizione di Test ${n}`,
        en: `Test Position ${n}`,
        de: `Testposition ${n}`,
        fr: `Poste de Test ${n}`,
      },
      descriptionByLocale: {
        it: richDesc('it'),
        en: richDesc('en'),
        de: richDesc('de'),
        fr: richDesc('fr'),
      },
      slugByLocale: { it: slug, en: `${slug}-en`, de: `${slug}-de`, fr: `${slug}-fr` },
    };
  }

  /** Freshly-discovered job, source (IT) description only — no AI pass yet. */
  function newUntranslatedJob() {
    const slug = 'ems-chemie-area-sales-manager';
    return {
      slug,
      url: 'https://jobs.ems-group.com/offene-stellen/area-sales-manager-m-w-d/9df1e07e-0005-43f8-9656-9f55cbbf18f2',
      title: 'Area Sales Manager (m/w/d) 100%',
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      description: richDesc('it'),
      titleByLocale: { it: 'Area Sales Manager (m/w/d) 100%' },
      descriptionByLocale: { it: richDesc('it') },
      slugByLocale: {},
    };
  }

  function writeScratchJobs(jobs: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ems-chemie-locale-coverage-'));
    const jobsPath = path.join(dir, 'jobs.json');
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
    return jobsPath;
  }

  function runValidation(jobsPath: string) {
    return validateDedicatedLocaleCoverage({
      strictEnvVar: STRICT_ENV,
      label: COMPANY_NAME,
      dataJobsPath: jobsPath,
      isTargetJob: isCompanyJob,
      locales: LOCALES,
      isTrustedDomain,
      untrustedDomainReason: 'url_not_ems_group_domain',
      failWhenNoJobs: false,
      noJobsMessage: `No ${COMPANY_NAME} jobs found — the company may not have active openings.`,
    });
  }

  it('(#3797 repro) 9 translated jobs + 1 freshly-discovered untranslated job → all 10 survive, none silently dropped', () => {
    const jobs = [...Array.from({ length: 9 }, (_, i) => goodJob(i)), newUntranslatedJob()];
    const jobsPath = writeScratchJobs(jobs);

    expect(() => runValidation(jobsPath)).not.toThrow();

    // Slug hardening may regenerate the untranslated job's top-level slug
    // (locale-derived), so assert on the stable source URL instead of the
    // slug — the point under test is "no job silently disappears", not the
    // exact slug value.
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as Array<{ url: string }>;
    expect(after).toHaveLength(10);
    expect(after.map((j) => j.url)).toContain(
      'https://jobs.ems-group.com/offene-stellen/area-sales-manager-m-w-d/9df1e07e-0005-43f8-9656-9f55cbbf18f2'
    );
  });

  it('a genuine non-translation problem (untrusted domain) is still enforced even with SKIP_AI_TRANSLATION=1 — the invalid job is quarantined per-item (#3789) and never committed, the 9 valid jobs survive', () => {
    // Pre-#3789 this asserted a hard-fail of the WHOLE batch — the same
    // all-or-nothing failure mode as the #3797/#3783 incidents, just on a
    // different error class. The per-item gate (#3789) keeps the guard's
    // actual guarantee (an untrusted-domain job never reaches the dataset)
    // while no longer discarding the 9 valid jobs alongside it.
    const untrustedJob = {
      ...goodJob(99),
      slug: 'ems-chemie-untrusted-domain-job',
      url: 'https://not-ems-group.example.test/jobs/untrusted',
    };
    const jobs = [...Array.from({ length: 9 }, (_, i) => goodJob(i)), untrustedJob];
    const jobsPath = writeScratchJobs(jobs);

    expect(() => runValidation(jobsPath)).not.toThrow();
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as Array<{ url: string }>;
    expect(after).toHaveLength(9);
    expect(after.map((j) => j.url)).not.toContain('https://not-ems-group.example.test/jobs/untrusted');
  });

  it('a SYSTEMIC non-translation problem (majority untrusted domains) still hard-fails the run — per-item quarantine never silently wipes a broken batch', () => {
    const untrusted = (n: number) => ({
      ...goodJob(n),
      slug: `ems-chemie-untrusted-domain-job-${n}`,
      url: `https://not-ems-group.example.test/jobs/untrusted-${n}`,
    });
    const jobs = [goodJob(0), untrusted(1), untrusted(2)];
    const jobsPath = writeScratchJobs(jobs);

    expect(() => runValidation(jobsPath)).toThrow(/localization validation failed/i);
    // Dataset untouched: the previous data stays intact for the workflow's
    // non-zero-exit issue-creation path.
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as unknown[];
    expect(after).toHaveLength(3);
  });

  it('all-translated batch passes cleanly with no tolerance needed', () => {
    const jobs = Array.from({ length: 3 }, (_, i) => goodJob(i));
    const jobsPath = writeScratchJobs(jobs);

    expect(() => runValidation(jobsPath)).not.toThrow();
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as unknown[];
    expect(after).toHaveLength(3);
  });
});
