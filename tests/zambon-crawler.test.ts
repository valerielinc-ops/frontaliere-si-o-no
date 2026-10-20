/**
 * Zambon Svizzera SA — careers page parser tests
 *
 * Tests both the new zambon.com/en/open-positions format and
 * legacy jobopportunity.ch format for backward compatibility.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
  extractZambonJobBody,
} from '@/scripts/lib/zambon-job-parser.mjs';
import { buildZambonJob, classifyZambonApiRows, classifyZambonHtmlListings, computeZambonCrawlResult, mergeZambonJobs, parseZambonApiPayload, restoreZambonArchivedJobs, ZAMBON_FABRICATED_DESCRIPTION_RE } from '@/scripts/update-zambon-jobs.mjs';
import { isAuthoritativeEmptySnapshot } from '@/scripts/lib/authoritative-empty-snapshot.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Fixture: Legacy jobopportunity.ch format (backward compat) */
const FIXTURE_LISTING_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Zambon Svizzera SA - Offerte di lavoro</title></head>
<body>
<div id="content">
  <h1>Offerte di lavoro</h1>
  <table class="job-listing">
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2001">Quality Assurance Specialist</a></td>
      <td>Cadempino, Ticino</td>
      <td>2026-03-22</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2002">Pharmaceutical Production Operator</a></td>
      <td>Cadempino, Switzerland</td>
      <td>2026-03-20</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2003">Senior Regulatory Affairs Specialist</a></td>
      <td>Cadempino, Ticino</td>
      <td>2026-03-18</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2004">Apprendista impiegato/a di commercio</a></td>
      <td>Cadempino, Svizzera</td>
      <td>2026-03-15</td>
    </tr>
  </table>
</div>
</body>
</html>
`;

/** Fixture: NcorePlat job links on zambon.com */
const FIXTURE_NCOREPLAT_LISTING = `
<!DOCTYPE html>
<html>
<head><title>Open Positions | Zambon</title></head>
<body>
<div id="content">
  <h1>Open Positions</h1>
  <div class="career-list">
    <a href="https://app.ncoreplat.com/jobposition/112500/quality-control-analyst/zambon-svizzera">Quality Control Analyst</a>
    <a href="https://app.ncoreplat.com/jobposition/112501/production-supervisor/zambon-svizzera">Production Supervisor</a>
    <a href="https://app.ncoreplat.com/jobposition/110541/autocandidatura-it/hr-italy">Autocandidatura</a>
  </div>
</div>
</body>
</html>
`;

/** Fixture: No open positions message */
const FIXTURE_EMPTY_LISTING = `
<!DOCTYPE html>
<html>
<head><title>Open Positions | Zambon</title></head>
<body>
<div id="content">
  <p>Currently there are not open positions.</p>
  <p>If you haven't found the job position that you are looking for, you can send us your resume.</p>
</div>
</body>
</html>
`;

const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Quality Assurance Specialist - Zambon Svizzera SA</title></head>
<body>
<div class="job-detail">
  <h1>Quality Assurance Specialist</h1>
  <div class="job-description">
    <p>Zambon Svizzera SA, part of the Zambon Group, is looking for a <strong>Quality Assurance Specialist</strong> to join our quality team at our Cadempino manufacturing site in Ticino, Switzerland.</p>
    <p><strong>Key Responsibilities:</strong></p>
    <ul>
      <li>Ensure compliance with GMP regulations and internal quality standards.</li>
      <li>Manage deviation investigations, CAPA implementation, and change control processes.</li>
      <li>Support internal and external audits (Swissmedic, FDA, EMA).</li>
      <li>Review and approve batch documentation and analytical results.</li>
      <li>Maintain quality management system documentation.</li>
    </ul>
    <p><strong>Requirements:</strong></p>
    <ul>
      <li>Degree in Chemistry, Pharmacy, Biology, or related field.</li>
      <li>3+ years of QA experience in a pharmaceutical manufacturing environment.</li>
      <li>Knowledge of GMP, ICH guidelines, and Swiss/EU pharmaceutical regulations.</li>
      <li>Strong analytical skills and attention to detail.</li>
      <li>Fluent in Italian and English; German is an advantage.</li>
    </ul>
  </div>
</div>
</body>
</html>
`;

// ─── parseListingPage tests — legacy format ───────────────────────────────────

describe('parseListingPage — legacy jobopportunity.ch format', () => {
  it('finds four jobs in the fixture', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs).toHaveLength(4);
  });

  it('extracts correct titles', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].title).toBe('Quality Assurance Specialist');
    expect(jobs[1].title).toBe('Pharmaceutical Production Operator');
    expect(jobs[3].title).toBe('Apprendista impiegato/a di commercio');
  });

  it('extracts job IDs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].id).toBe('2001');
    expect(jobs[1].id).toBe('2002');
  });

  it('builds absolute URLs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].url).toContain('zambon.com');
    expect(jobs[0].url).toContain('id=2001');
  });
});

// ─── parseListingPage tests — NcorePlat format ───────────────────────────────

describe('parseListingPage — NcorePlat format', () => {
  it('finds two jobs (skips autocandidatura)', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs).toHaveLength(2);
  });

  it('extracts correct titles from NcorePlat links', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs[0].title).toBe('Quality Control Analyst');
    expect(jobs[1].title).toBe('Production Supervisor');
  });

  it('extracts NcorePlat job IDs', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs[0].id).toBe('112500');
    expect(jobs[1].id).toBe('112501');
  });

  it('preserves NcorePlat URLs', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs[0].url).toContain('ncoreplat.com');
  });
});

// ─── Empty/guard tests ─────────────────────────────────────────────────────

describe('parseListingPage — guards', () => {
  it('returns empty array for "no positions" message', () => {
    expect(parseListingPage(FIXTURE_EMPTY_LISTING)).toHaveLength(0);
  });

  it('keeps a discovered listing when no-position copy is incidental page text', () => {
    const jobs = parseListingPage(
      '<main><p>No open positions</p>'
      + '<a href="https://app.ncoreplat.com/jobposition/112500/quality-control-analyst">Quality Control Analyst</a></main>',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('112500');
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
  });
});

describe('Zambon location outcome guard', () => {
  it('fails closed for an unknown API country instead of proving filtered_empty', () => {
    const data = parseZambonApiPayload({ status: 200, data: [{ id: 1, country: 'XX', country_label: 'mystery' }] });
    const result = classifyZambonApiRows(data);
    expect(result).toMatchObject({ lastFetchOutcome: 'selector_miss', abortKind: 'no-jobs-parsed' });
    expect(result.lastFetchOutcome).not.toBe('filtered_empty');
  });

  it('fails closed for an unknown HTML location instead of proving filtered_empty', () => {
    const result = classifyZambonHtmlListings([{ id: '1', location: 'mystery' }]);
    expect(result).toMatchObject({ lastFetchOutcome: 'selector_miss', abortKind: 'no-jobs-parsed' });
    expect(result.lastFetchOutcome).not.toBe('filtered_empty');
  });

  it('keeps filtered_empty for rows with explicit foreign country evidence', () => {
    expect(classifyZambonApiRows([{ id: 1, country: 'IT', country_label: 'Italy' }])).toMatchObject({
      lastFetchOutcome: 'filtered_empty',
      abortKind: null,
    });
    expect(classifyZambonHtmlListings([{ id: '1', location: 'Milan, Italy' }])).toMatchObject({
      lastFetchOutcome: 'filtered_empty',
      abortKind: null,
    });
  });
});

// ─── parseDetailPage tests ──────────────────────────────────────────────────

describe('parseDetailPage', () => {
  it('extracts the title', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.title).toBe('Quality Assurance Specialist');
  });

  it('extracts the description body', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.body).toContain('Zambon Svizzera SA');
    expect(result.body).toContain('GMP');
  });

  it('description meets minimum length', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.sourceBodyLength).toBeGreaterThanOrEqual(MIN_DESC_LENGTH);
  });

  it('returns empty for empty input', () => {
    const result = parseDetailPage('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
  });
});

// ─── Utility tests ──────────────────────────────────────────────────────────

describe('slugify', () => {
  it('creates slug from title', () => {
    expect(slugify('Quality Assurance Specialist', 'zambon')).toBe('quality-assurance-specialist-zambon');
  });

  it('handles Italian characters', () => {
    const slug = slugify('Apprendista impiegato/a di commercio');
    expect(slug).toContain('apprendista');
    expect(slug).toContain('commercio');
  });
});

describe('detectCategory', () => {
  it('detects quality for QA Specialist', () => {
    expect(detectCategory('Quality Assurance Specialist')).toBe('quality');
  });

  it('detects pharma for Regulatory Affairs', () => {
    expect(detectCategory('Senior Regulatory Affairs Specialist')).toBe('pharma');
  });

  it('detects pharma for Pharmaceutical Production Operator (pharma keyword first)', () => {
    expect(detectCategory('Pharmaceutical Production Operator')).toBe('pharma');
  });

  it('detects production for Production Operator', () => {
    expect(detectCategory('Production Operator')).toBe('production');
  });

  it('detects internship for Apprendista', () => {
    expect(detectCategory('Apprendista impiegato/a di commercio')).toBe('internship');
  });
});

describe('detectExperienceLevel', () => {
  it('detects SENIOR for Senior title', () => {
    expect(detectExperienceLevel('Senior Regulatory Affairs Specialist')).toBe('SENIOR');
  });

  it('detects ENTRY for Apprendista', () => {
    expect(detectExperienceLevel('Apprendista impiegato/a di commercio')).toBe('ENTRY');
  });

  it('detects MID for regular title', () => {
    expect(detectExperienceLevel('Quality Assurance Specialist')).toBe('MID');
  });
});

// ─── Source text only (issue 5253) ──────────────────────────────────────────
// Minimized from the live NcorePlat page of job 811390 (2026-09-29). The
// careers API carries only metadata; the runner used to publish a description
// it wrote itself from those fields (3/3 stored jobs).
const NCOREPLAT_PAGE = `
<html><body>
<div class="row paddedIn"><div class="col-lg-12 singlePosition">
  <h1 class="iniziacon nCore_branding_heading"><strong>Buyer Procurement Indirect</strong></h1>
  <div class="pTesto"><div class="nCore_branding_text break-word">
    <p><strong>Zambon Switzerland SA</strong>, the Swiss affiliate of the multinational pharmaceutical group Zambon, based in Cadempino (Canton Ticino), is looking for a <strong>Buyer</strong> to join its <strong>Indirect Procurement</strong> team.</p>
    <p>We are looking for a highly challenge-driven individual with a strong appetite for change and continuous improvement, who will contribute to the evolution of purchasing strategies and processes while developing valuable partnerships with suppliers and internal stakeholders.</p>
    <p><strong>Key responsibilities:</strong></p>
    <ul><li>Proactively conduct supplier scouting, qualification and evaluation activities at both national and international level.</li>
    <li>Negotiate commercial agreements, contracts, Service Level Agreements (SLAs) and Key Performance Indicators (KPIs).</li></ul>
  </div></div>
</div></div>
</body></html>`;
const STORED_INVENTED = 'Buyer Procurement Indirect: opportunità professionale presso Zambon Svizzera SA, azienda farmaceutica internazionale con sede a Cadempino, Canton TI (Svizzera). Zambon è un gruppo farmaceutico fondato nel 1906, leader nel settore delle malattie respiratorie, del dolore e delle malattie rare, con oltre 2.800 dipendenti e presenza in più di 20 paesi.';
const JOB_URL = 'https://app.ncoreplat.com/jobposition/811390/buyer-procurement-indirect-ch/hr-switzerland';
const STORED = {
  id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect', companyKey: 'zambon', sourceLang: 'it',
  description: STORED_INVENTED,
  descriptionByLocale: { it: STORED_INVENTED, en: 'Buyer Procurement Indirect: professional opportunity at Zambon Switzerland SA, an international pharmaceutical company.' },
  titleByLocale: { it: 'Buyer Procurement Indirect' },
  slugByLocale: { it: 'buyer-procurement-indirect-zambon' },
};

describe('Zambon source text only (issue 5253)', () => {
  it('reads the vacancy text of the NcorePlat page, lists included', () => {
    const body = extractZambonJobBody(NCOREPLAT_PAGE);
    expect(body).toContain('Zambon Switzerland SA , the Swiss affiliate');
    expect(body).toContain('• Proactively conduct supplier scouting');
    expect(body).not.toContain('Buyer Procurement Indirect\n');
    expect(extractZambonJobBody('<html><body><div>AWS WAF challenge</div></body></html>')).toBe('');
  });

  it('builds the job from that text, in its own language', () => {
    const job = buildZambonJob({ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }, extractZambonJobBody(NCOREPLAT_PAGE));
    expect(job.sourceLang).toBe('en');
    expect(job.descriptionByLocale).toEqual({ en: job.description });
    expect(ZAMBON_FABRICATED_DESCRIPTION_RE.test(job.description)).toBe(false);
  });

  it('replaces the stored invented description and drops its translations', () => {
    const fresh = buildZambonJob({ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }, extractZambonJobBody(NCOREPLAT_PAGE));
    const [merged] = mergeZambonJobs([STORED], [fresh]);
    expect(merged.description).toBe(fresh.description);
    expect(merged.descriptionByLocale).toEqual({ en: fresh.description });
    expect(merged.needsRetranslation).toBe(true);
    expect(merged.slugByLocale.it).toBe('buyer-procurement-indirect-zambon');
  });

  it('drops the stored invented description when it lives only in the flat field, with its translations (main slice shape)', () => {
    // The three stored Zambon jobs on main: sourceLang it, no `it` slot, the
    // invented text in `description` and en/de/fr translated from it.
    const flatOnly = { ...STORED, descriptionByLocale: { en: STORED.descriptionByLocale.en, de: 'Buyer Procurement Indirekt: Berufsmöglichkeit bei Zambon Switzerland SA.' } };
    const fresh = buildZambonJob({ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }, extractZambonJobBody(NCOREPLAT_PAGE));
    const [merged] = mergeZambonJobs([flatOnly], [fresh]);
    expect(merged.descriptionByLocale).toEqual({ en: fresh.description });
    expect(merged.needsRetranslation).toBe(true);
    expect(mergeZambonJobs([flatOnly], [buildZambonJob({ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }, '')])).toEqual([]);
    // Pure: the caller's stored record is untouched.
    expect(flatOnly.description).toBe(STORED_INVENTED);
  });

  it('does not publish a job whose page gives no text and whose stored text is invented', () => {
    const fresh = buildZambonJob({ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }, '');
    expect(fresh.description).toBe('');
    expect(mergeZambonJobs([STORED], [fresh])).toEqual([]);
  });

  it('leaves the stored slice unchanged when no row was read from the source (review #10396)', () => {
    // readZambonBodies() returns [] when no NcorePlat page is readable (a WAF):
    // a total read failure never unpublishes the stored jobs, legacy text included.
    const legacy = { url: 'https://app.ncoreplat.com/jobposition/1', description: 'Ruolo: opportunità professionale presso Zambon Svizzera SA' };
    const merged = mergeZambonJobs([legacy], []);
    expect(merged.map((job: { url: string }) => job.url)).toEqual(['https://app.ncoreplat.com/jobposition/1']);
    expect(merged).toEqual([legacy]);
    expect(merged[0]).not.toBe(legacy);
  });

  it('recognizes only the successful API empty envelope as an authoritative zero', () => {
    const empty = parseZambonApiPayload({ status: 200, data: [] });
    expect(empty).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(empty)).toBe(true);
    expect(Object.keys(empty)).toEqual([]);

    expect(isAuthoritativeEmptySnapshot(parseZambonApiPayload([]))).toBe(false);
    expect(isAuthoritativeEmptySnapshot(parseZambonApiPayload({ status: 503, data: [] }))).toBe(false);
    expect(isAuthoritativeEmptySnapshot(parseZambonApiPayload({ status: 200, data: [{ id: 12, country: 'IT' }] }))).toBe(false);
    expect(() => parseZambonApiPayload({ status: 200, data: null })).toThrow('API response is not an array');
  });

  it('retires stored Zambon jobs only for the source-stamped empty envelope', () => {
    const authoritativeEmpty = parseZambonApiPayload({ status: 200, data: [] });
    expect(mergeZambonJobs([STORED], authoritativeEmpty)).toEqual([]);
    expect(mergeZambonJobs([STORED], [])).toEqual([STORED]);
  });

  it('archives routes retired by the slice produced by an authoritative empty snapshot', () => {
    const retired = buildZambonJob(
      { id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' },
      extractZambonJobBody(NCOREPLAT_PAGE),
    );
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-zambon-expired-'));
    try {
      const { diff, archived } = computeZambonCrawlResult([retired], [], {
        archiveRemoved: true,
        archiveDir,
      });
      expect(diff.removedJobs.map((job) => job.url)).toEqual([JOB_URL]);
      expect(archived).toBe(1);
      const entries = JSON.parse(fs.readFileSync(path.join(archiveDir, 'zambon.json'), 'utf8'));
      expect(entries.map((entry: { slug: string }) => entry.slug)).toEqual([retired.slug]);
    } finally {
      fs.rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it('publishes a body only from the shared 50-word floor (review #10396)', () => {
    const words = (count: number) => Array.from({ length: count }, (_, index) => `parola${index}`).join(' ');
    const row = { id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' };
    expect(buildZambonJob(row, words(49)).description).toBe('');
    expect(buildZambonJob(row, words(50)).description).toBe(words(50));
  });

  it('keeps the source text an earlier run read when the page gives none', () => {
    const real = buildZambonJob({ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }, extractZambonJobBody(NCOREPLAT_PAGE));
    const [first] = mergeZambonJobs([STORED], [real]);
    const [second] = mergeZambonJobs([first], [buildZambonJob({ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }, '')]);
    expect(second.description).toBe(real.description);
    expect(second.sourceLang).toBe('en');
  });

  it('restores a current row from its source-backed expired record after detail blocking', () => {
    const source = buildZambonJob(
      { id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' },
      extractZambonJobBody(NCOREPLAT_PAGE),
    );
    const [restored] = restoreZambonArchivedJobs(
      [{ id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' }],
      [{
        sourceIdentity: `url:${JOB_URL}`,
        slug: 'buyer-procurement-indirect-zambon',
        descriptionByLocale: { en: source.description },
      }],
    );
    expect(restored.description).toBe(source.description);
    expect(restored.sourceLang).toBe('en');
    expect(restored.descriptionByLocale).toEqual({ en: source.description });
    expect(restored.url).toBe(JOB_URL);
  });

  it('does not choose an arbitrary archived locale or publish a thin archive body', () => {
    const words = (count: number) => Array.from({ length: count }, (_, index) => `parola${index}`).join(' ');
    const row = { id: 'zambon-811390', url: JOB_URL, title: 'Buyer Procurement Indirect' };
    expect(restoreZambonArchivedJobs([row], [{
      sourceIdentity: `url:${JOB_URL}`,
      descriptionByLocale: { it: words(80), en: words(49) },
    }])).toEqual([]);
  });
});
