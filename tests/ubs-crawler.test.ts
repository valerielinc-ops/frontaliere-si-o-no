import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  UBS_KEY,
  UBS_COMPANY_NAME,
  isUbsJob,
  isTrustedDomain,
  __internals,
  fetchAllUbsJobs,
} from '../scripts/lib/ubs-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ── Item 1 (issue #3055): Taleo siteid loop ──
describe('Taleo siteid loop (issue #3055 item 1)', () => {
  it('fetches the main, apprenticeship, and graduate UBS Switzerland tenants', () => {
    expect(__internals.SITE_IDS).toEqual(['5012', '5054', '5131']);
  });
});

// ── Items 2/3 (issue #3055): inferAnyCanton(city) must not bypass the
// isSwissRegion guard — sibling fix, see update-galenica-jobs.test.ts for the
// Galenica counterpart. ──
describe('resolveSwissLocation region guard (issue #3055 item 2)', () => {
  it('rejects a foreign region even when the city aliases a Swiss canton', () => {
    // "Lugano" resolves to TI purely via the shared inferAnyCanton fuzzy
    // city-name match (not one of inferCanton's explicit canton-name
    // substring checks) — confirm the alias exists, then confirm a clearly
    // non-Swiss region blocks it from resolving.
    const foreignRegion = 'France - Auvergne-Rhône-Alpes';
    expect(__internals.isSwissRegion(foreignRegion)).toBe(false);
    expect(__internals.inferCanton('Lugano', foreignRegion)).toBe('TI');

    // Pre-fix this would have returned { city: 'Lugano', canton: 'TI' } purely
    // from the city alias, ignoring the foreign region. Post-fix it must be
    // rejected.
    expect(__internals.resolveSwissLocation('Lugano', foreignRegion)).toBeNull();
  });

  it('still resolves a genuine Swiss region normally (no regression)', () => {
    const swissRegion = 'Schweiz - Ticino';
    expect(__internals.isSwissRegion(swissRegion)).toBe(true);
    expect(__internals.resolveSwissLocation('Lugano', swissRegion)).toEqual({
      city: 'Lugano',
      canton: 'TI',
    });
  });

  it('still resolves a bare Swiss city with a blank region (no regression)', () => {
    // Cathedral CH-wide expansion: Taleo entries can have an empty region
    // string yet a clearly Swiss city — this must keep working.
    expect(__internals.resolveSwissLocation('Lugano', '')).toEqual({
      city: 'Lugano',
      canton: 'TI',
    });
  });

  it('rejects a genuine real-world namesake: Baden bei Wien (Austria), not Baden (AG)', () => {
    // "Baden" is both an Aargau (AG) municipality and a town near Vienna,
    // Austria — the exact kind of foreign-city/Swiss-placename collision
    // called out in issue #3055 item 2. inferAnyCanton matches the city
    // string alone; the region guard must still reject it.
    const austrianRegion = 'Österreich - Niederösterreich';
    expect(__internals.isSwissRegion(austrianRegion)).toBe(false);
    expect(__internals.inferCanton('Baden', austrianRegion)).toBe('AG');
    expect(__internals.resolveSwissLocation('Baden', austrianRegion)).toBeNull();
  });
});

describe('UBS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(UBS_KEY).toBe('ubs');
    expect(UBS_COMPANY_NAME).toBe('UBS');
  });

  describe('Taleo token parsing', () => {
    it('extracts the RFT token from the current hidden input shape', () => {
      const html = `<input name="__RequestVerificationToken" type="hidden" value="abc-123" />`;

      expect(__internals.extractRequestVerificationToken(html)).toBe('abc-123');
    });

    it('handles attributes before the token name', () => {
      const html = `<input type='hidden' value='token-456' name='__RequestVerificationToken'>`;

      expect(__internals.extractRequestVerificationToken(html)).toBe('token-456');
    });
  });

  // ── isCompanyJob ──
  describe('isUbsJob', () => {
    it('matches by companyKey', () => {
      expect(isUbsJob({ companyKey: 'ubs' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isUbsJob({ company: 'UBS' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isUbsJob({ url: 'https://ubs.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isUbsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isUbsJob(null)).toBe(false);
      expect(isUbsJob(undefined)).toBe(false);
      expect(isUbsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ubs.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ubs.com/job/456')).toBe(true);
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
      expect(slugify('Developer ubs ch')).toBe('developer-ubs-ch');
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
      id: 'ubs-abc123',
      slug: 'test-position-ubs-ch',
      slugByLocale: { en: 'test-position-ubs-ch' },
      company: 'UBS',
      companyKey: 'ubs',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ubs.com/jobs/test',
      source: 'UBS Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^ubs-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Minimised from the Taleo job-details payload
// (POST /TgNewUI/Search/Ajax/JobDetails) of jobid 348353 on site 5131
// (2026-09-29). The search rows only carry the first section ("Your role"):
// UBS postings were published at 6-7 % of their source page.
describe('Taleo job details', () => {
  const QUESTIONS = [
    { QuestionName: '', AnswerValue: '2026 Internship – German language expert / translation specialist – ZH', VerityZone: 'jobtitle', ClassName: 'jobtitleInJobDetails' },
    { QuestionName: 'City', AnswerValue: 'Zürich ', VerityZone: 'formtext2', ClassName: 'section2RightfieldsInJobDetails' },
    { QuestionName: 'Your role', AnswerValue: 'We’re looking for ambitious students.<br><br>You’ll get to:<br><br>• craft clear, engaging UX content<br>• translate content from English into German', VerityZone: 'jobdescription', ClassName: 'section2LeftfieldsInJobDetails jobDetailTextArea' },
    { QuestionName: 'Your team', AnswerValue: 'Join the software localization team in Zurich.', VerityZone: 'formtext58', ClassName: 'section2LeftfieldsInJobDetails jobDetailTextArea' },
    { QuestionName: 'Your expertise', AnswerValue: 'We’re looking for a candidate who:<br><br>• has completed at least 4 semesters of a bachelor’s degree', VerityZone: 'formtext59', ClassName: 'section2LeftfieldsInJobDetails jobDetailTextArea' },
    { QuestionName: 'About us', AnswerValue: 'UBS is a leading and truly global wealth manager.', VerityZone: 'formtext60', ClassName: 'section2LeftfieldsInJobDetails jobDetailTextArea' },
    { QuestionName: 'Empty', AnswerValue: '', VerityZone: 'formtext61', ClassName: 'section2LeftfieldsInJobDetails jobDetailTextArea' },
    { QuestionName: '', AnswerValue: '348353', VerityZone: 'reqid', ClassName: null },
  ];

  it('composes every text section under its own heading, in page order', () => {
    const text = __internals.composeTaleoJobDetailDescription(QUESTIONS);
    const order = ['Your role', 'Your team', 'Your expertise', 'About us'].map((heading) => text.indexOf(`${heading}\n`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/^• craft clear, engaging UX content$/m);
    expect(text).not.toContain('348353');
    expect(text).not.toContain('Empty');
    expect(__internals.composeTaleoJobDetailDescription(null)).toBe('');
  });

  function taleoRow(lang: string, reqid: string) {
    const q = (name: string, value: string) => ({ QuestionName: name, Value: value });
    return {
      Questions: [
        q('reqid', reqid), q('jobtitle', 'Spécialiste Crédits 80-100%'), q('jobdescription', 'Votre rôle au sein de notre équipe crédit.'),
        q('formtext23', 'Suisse - Suisse romande'), q('formtext2', 'Lausanne'), q('jobreqlanguage', lang),
        q('lastupdated', '29-Sep-2026'),
      ],
    };
  }

  it('points every posting to its locale site (main tenant and apprenticeship board)', () => {
    // Opened through the English site 5012, jobid 350552 rendered the German
    // "Spezialist/in Hypotheken und Grundbuchwesen" (overlap 0.01 in the audit).
    const fr = __internals.buildJobFromTaleo(taleoRow('34', '350552'), '5012');
    expect(fr.url).toContain('siteid=5049&jobid=350552');
    expect(fr._ubsMeta.detailSiteId).toBe('5049');
    const de = __internals.buildJobFromTaleo(taleoRow('23', '350553'), '5012');
    expect(de.url).toContain('siteid=5050&jobid=350553');
    const en = __internals.buildJobFromTaleo(taleoRow('1', '348000'), '5012');
    expect(en.url).toContain('siteid=5012&jobid=348000');
    // The apprenticeship board has its own locale sites (2026-09-29: the
    // French BEM jobid 348474 returns its body only through 5055).
    const apprenticeFr = __internals.buildJobFromTaleo(taleoRow('34', '346345'), '5054');
    expect(apprenticeFr.url).toContain('siteid=5055&jobid=346345');
    expect(__internals.buildJobFromTaleo(taleoRow('23', '348480'), '5054').url).toContain('siteid=5054&jobid=348480');
    expect(__internals.buildJobFromTaleo(taleoRow('52', '348468'), '5054').url).toContain('siteid=5056&jobid=348468');
    // The graduate board serves its (English) postings itself.
    expect(__internals.buildJobFromTaleo(taleoRow('1', '351839'), '5131').url).toContain('siteid=5131&jobid=351839');
  });
});

// Only the whole posting is published (issue 5253). A posting whose search
// row and job-details both carry no text used to go out as "{title} — UBS",
// and one whose job-details could not be read went out as its search-row
// "Your role" teaser alone (6-7 % of the source page); neither is published
// any more. Taleo TGNewUI shapes
// (HomeWithPreLoad token, MatchedJobs envelope, JobDetails questions) as
// served by jobs.ubs.com on 2026-09-29.
describe('fetchAllUbsJobs — posting without any vacancy text', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the whole posting and skips one without job-details text, even with a search-row teaser', async () => {
    const q = (name: string, value: string) => ({ QuestionName: name, Value: value });
    const row = (reqid: string, title: string, desc: string) => ({
      Questions: [q('reqid', reqid), q('jobtitle', title), q('jobdescription', desc), q('formtext23', 'Switzerland - Zurich'), q('formtext2', 'Zürich'), q('jobreqlanguage', '1'), q('lastupdated', '29-Sep-2026')],
    });
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
      const u = String(url);
      if (u.includes('HomeWithPreLoad')) {
        return new Response('<input name="__RequestVerificationToken" type="hidden" value="tok123" />', { status: 200, headers: { 'set-cookie': 'a=b; Path=/' } });
      }
      const body = JSON.parse(init.body || '{}');
      if (u.includes('MatchedJobs')) {
        if (!JSON.stringify(body).includes('5012')) return json({ Jobs: { Job: [] }, JobsCount: 0 });
        return json({
          Jobs: { Job: [
            row('350001', 'Client Advisor 80-100%', 'Your role: advise private clients in Zurich.'),
            row('350002', 'Credit Officer', ''),
            row('350003', 'Relationship Manager', 'Your role: manage a portfolio of corporate clients in Zurich.'),
          ] },
          JobsCount: 3,
        });
      }
      if (u.includes('JobDetails')) {
        const text = body.jobid === '350001'
          ? '<p>Your role: advise private clients in Zurich and build lasting relationships with them across the whole wealth-planning cycle.</p>'
          : '';
        return json({ ServiceResponse: { Jobdetails: { JobDetailQuestions: text ? [{ ClassName: 'jobDetailTextArea', QuestionName: 'Your role', AnswerValue: text }] : [] } } });
      }
      return new Response('', { status: 404 });
    }));

    expect(__internals.buildJobFromTaleo(row('350002', 'Credit Officer', ''), '5012').description).toBe('');
    const jobs = await fetchAllUbsJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Client Advisor 80-100%']);
    expect(jobs[0].description).toContain('across the whole wealth-planning cycle');
    for (const job of jobs) expect(job.description).not.toMatch(/— UBS$/);
    // 350003 has a search-row teaser but its JobDetails stub returns '': not published.
    expect(jobs.map((job) => job.title)).not.toContain('Relationship Manager');
  }, 20_000);
});
