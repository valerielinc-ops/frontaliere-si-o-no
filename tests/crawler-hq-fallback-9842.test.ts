import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchAllSulzerJobs } from '../scripts/lib/sulzer-job-parser.mjs';
import { fetchAllLombardOdierJobs } from '../scripts/lib/lombard-odier-job-parser.mjs';
import { fetchAllBobstJobs, __testables as bobst } from '../scripts/lib/bobst-job-parser.mjs';
import { __testables as pictet } from '../scripts/lib/pictet-job-parser.mjs';
import { fetchAllAbbottJobs } from '../scripts/lib/abbott-job-parser.mjs';
import { fetchAllStrykerJobs } from '../scripts/lib/stryker-job-parser.mjs';
import { fetchAllArdianJobs } from '../scripts/lib/ardian-job-parser.mjs';
import { fetchAllAlconJobs } from '../scripts/lib/alcon-job-parser.mjs';
import { fetchAllNovartisJobs } from '../scripts/lib/novartis-job-parser.mjs';
import { fetchAllRitualsCosmeticsJobs } from '../scripts/lib/rituals-cosmetics-job-parser.mjs';
import { fetchAllKsbJobs } from '../scripts/lib/ksb-job-parser.mjs';
import { fetchAllBossardJobs } from '../scripts/lib/bossard-job-parser.mjs';
import { fetchWorkdayPrimarySwissLocation } from '../scripts/lib/workday-swiss-job-parser-common.mjs';

/**
 * Issue 9842 — the legacy crawler scaffold filled a vacancy's geography with
 * the employer HQ (`listing.location || 'Winterthur'`,
 * `inferSwissTargetCanton(location) || 'ZH'`). On a multinational board that
 * published foreign vacancies as Swiss ones: on origin/main 41343cb the slices
 * carried 403 such rows (sulzer 355, bobst 22, lombard-odier 15, pictet 11).
 * On a Workday tenant the same default also caught every `N Locations`
 * roll-up, whatever the req's own primary workplace was: 23 of the 25 sulzer
 * «Winterthur» rows and a roche «Basel» row per Warsaw req.
 *
 * Owner rule: explicitly non-Swiss rows are dropped, unknown geography stays
 * fail-closed, no HQ/defaultCity/defaultCanton fallback.
 *
 * The rows below are real slice rows (titles, locations and Workday paths of
 * public vacancies, no personal data), replayed through each parser with the
 * network stubbed. Every expectation fails on origin/main.
 */

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

type WorkdayPosting = {
  title: string;
  locationsText: string;
  path: string;
  /** The req's own primary workplace in the detail, or null when the detail fails. */
  primary: string | null;
};

const LONG_BODY = '<p>'
  + 'Responsibilities and requirements of the role, described at length by the employer. '.repeat(3)
  + '</p>';

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A Workday CXS tenant. `rejectCountryFacet` answers HTTP 400 to any facet
 * (Lombard Odier's live behaviour); otherwise the tenant ignores the facet and
 * returns the whole global board (Roche's live behaviour), which is the case
 * the per-row geography has to survive on its own.
 */
function mockWorkdayTenant(postings: WorkdayPosting[], { rejectCountryFacet = false } = {}) {
  global.fetch = vi.fn(async (url: any, init: any = {}) => {
    const href = String(url);
    if (init?.method === 'POST' && href.endsWith('/jobs')) {
      const body = JSON.parse(init.body || '{}');
      if (rejectCountryFacet && Object.keys(body.appliedFacets || {}).length > 0) {
        return json({ errorCode: 'HTTP_400', httpStatus: 400, message: '' }, 400);
      }
      if (body.offset > 0) return json({ total: postings.length, jobPostings: [] });
      return json({
        total: postings.length,
        jobPostings: postings.map((posting, index) => ({
          title: posting.title,
          externalPath: posting.path,
          locationsText: posting.locationsText,
          postedOn: 'Posted Today',
          bulletFields: [`JR9842${index}`],
        })),
      });
    }
    const posting = postings.find((candidate) => href.endsWith(candidate.path));
    if (posting && posting.primary !== null) {
      return json({
        jobPostingInfo: {
          title: posting.title,
          location: posting.primary,
          jobDescription: LONG_BODY,
        },
      });
    }
    return new Response('', { status: 404 });
  }) as any;
}

const geography = (jobs: any[]) => jobs
  .map((job) => [job.title, job.location, job.canton])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('sulzer — global Workday board, no Winterthur/ZH fallback', () => {
  it('publishes only the reqs whose own primary workplace is Swiss', async () => {
    mockWorkdayTenant([
      { title: 'SAP Inhouse Consultant FICO', locationsText: 'Madrid', path: '/job/Madrid/SAP-Inhouse-Consultant-FICO_SJR95638', primary: 'Madrid' },
      { title: 'Estagiário(a) de Vendas', locationsText: 'Jundiai', path: '/job/Jundiai/Estagirio-a--de-Vendas_SJR95210', primary: 'Jundiai' },
      { title: 'Engineer Rotating Equipment (Shop)', locationsText: 'Venlo', path: '/job/Venlo/Engineer-Rotating-Equipment--Shop-_SJR95128', primary: 'Venlo' },
      // `N Locations` roll-ups: published as «Winterthur» by the old default.
      { title: 'Electrical Fitter', locationsText: '2 Locations', path: '/job/Laverton/Electrical-Fitter_JR101522', primary: 'Laverton' },
      { title: 'Tendering Engineer', locationsText: '3 Locations', path: '/job/Pune/Tendering-Engineer_JR103309', primary: 'Pune' },
      { title: 'HR Administration & Payroll Manager', locationsText: 'Winterthur', path: '/job/Winterthur/HR-Administration---Payroll-Manager_JR102620', primary: 'Winterthur' },
      { title: 'Head of Product, Solution & Segment Marketing', locationsText: '2 Locations', path: '/job/Winterthur/Head-of-Product--Solution---Segment-Marketing_JR103919', primary: 'Winterthur' },
    ]);

    const jobs = await fetchAllSulzerJobs();

    expect(geography(jobs)).toEqual([
      ['Head of Product, Solution & Segment Marketing', 'Winterthur', 'ZH'],
      ['HR Administration & Payroll Manager', 'Winterthur', 'ZH'],
    ]);
  }, 20_000);
});

describe('lombard-odier — tenant rejects the country facet, no Geneva/GE fallback', () => {
  it('drops Luxembourg, London, Milan and Hong Kong and keeps the Swiss offices', async () => {
    mockWorkdayTenant([
      { title: 'Intern Risk Management - 6-month Internship', locationsText: 'Luxembourg', path: '/job/Luxembourg/Intern-Risk-Management---6-month-Internship_R0007399', primary: 'Luxembourg' },
      { title: 'Office Manager (12-month contract)', locationsText: 'London', path: '/job/London/Office-Manager--12-month-contract-_R0007334', primary: 'London' },
      { title: 'Private Banker Assistant - Milan', locationsText: 'Milan', path: '/job/Milan/Private-Banker-Assistant---Milan_R0007396', primary: 'Milan' },
      { title: 'Head of Compliance, Hong Kong', locationsText: 'Hong Kong', path: '/job/Hong-Kong/Head-of-Compliance--Hong-Kong_R0007567', primary: 'Hong Kong' },
      { title: 'Private Assets Investment Analyst', locationsText: 'Geneva', path: '/job/Geneva/Private-Assets-Investment-Analyst_R0006952', primary: 'Geneva' },
      { title: 'EAM Banker - Business Developer (80-100%)', locationsText: 'Zürich', path: '/job/Zrich/EAM-Banker---Business-Developer--80-100--_R0007469', primary: 'Zürich' },
    ], { rejectCountryFacet: true });

    const jobs = await fetchAllLombardOdierJobs();

    expect(geography(jobs)).toEqual([
      ['EAM Banker - Business Developer (80-100%)', 'Zürich', 'ZH'],
      ['Private Assets Investment Analyst', 'Geneva', 'GE'],
    ]);
  }, 20_000);
});

describe('bobst — global Umantis board, no Mex/VD fallback', () => {
  it('resolves a `Country (City)` cell only when the country is Switzerland', () => {
    expect(bobst.resolveBobstSwissGeography('Switzerland (Mex)')).toEqual({ location: 'Switzerland (Mex)', canton: 'VD' });
    expect(bobst.resolveBobstSwissGeography('Switzerland (Grenchen)')).toEqual({ location: 'Switzerland (Grenchen)', canton: 'SO' });
    for (const foreign of [
      'Italy (San Giorgio Monferrato)',
      'USA (Parsippany)',
      'India (Pune)',
      'Germany (Meerbusch)',
      'Thailand (Bangkok)',
      'Mexico (Mexico city)',
      'Poland (Lodz)',
    ]) {
      expect(bobst.resolveBobstSwissGeography(foreign), foreign).toBeNull();
    }
    // No cell at all, or a Swiss cell that names no resolvable locality.
    expect(bobst.resolveBobstSwissGeography('')).toBeNull();
    expect(bobst.resolveBobstSwissGeography('Switzerland (Headquarters)')).toBeNull();
  });

  it('drops the foreign rows of the board end to end', async () => {
    global.fetch = vi.fn(async () => new Response('', { status: 404 })) as any;
    const rows = [
      ['Collaudatore meccanico', '/Vacancies/8613/Description/2', 'Italy (San Giorgio Monferrato)'],
      ['Area Sales Manager - Canada', '/Vacancies/9247/Description/2', 'USA (Parsippany)'],
      ['Field Service Technician (m/w/d)', '/Vacancies/8700/Description/2', 'Germany (Bielefeld)'],
      ['Senior Writing Systems Engineer', '/Vacancies/8743/Description/2', 'Switzerland (Mex)'],
      ['Technical Support Specialist 100%', '/Vacancies/7707/Description/2', 'Switzerland (Grenchen)'],
    ].map(([title, href, location]) => ({
      title,
      href,
      cellText: `Engineering | Online since: 05.05.2026 ${title} | Type: Full time | ${location}`,
    }));
    let page = -1;
    const runtime = {
      createBrowser: vi.fn(async () => ({})),
      createPoliteContext: vi.fn(async () => ({})),
      fetchWithRateLimit: vi.fn(async () => {
        page += 1;
        const batch = page === 0 ? rows : [];
        return {
          waitForSelector: vi.fn(async () => {
            if (batch.length === 0) throw new Error('selector timeout');
            return null;
          }),
          $$eval: vi.fn(async () => batch),
          close: vi.fn(async () => undefined),
        };
      }),
      closeAll: vi.fn(async () => undefined),
      AntiBotBlockError: class extends Error {},
      NavigationTimeout: class extends Error {},
      BrowserLaunchError: class extends Error {},
    };

    const jobs = await fetchAllBobstJobs({ _runtime: async () => runtime, _sleepMs: 0 });

    expect(geography(jobs)).toEqual([
      ['Senior Writing Systems Engineer', 'Switzerland (Mex)', 'VD'],
      ['Technical Support Specialist 100%', 'Switzerland (Grenchen)', 'SO'],
    ]);
  }, 20_000);
});

describe('pictet — global SuccessFactors board, no Genève/GE fallback', () => {
  const build = (location: string) => pictet.buildParsedJobFromSf({
    title: 'Client Relationship Officer',
    location,
    applyUrl: 'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=125057',
  });

  it('keeps a vacancy located in Geneva', () => {
    expect(build('Geneva')).toMatchObject({ location: 'Geneva', canton: 'GE', addressRegion: 'GE' });
  });

  it('drops the foreign offices and a vacancy without a location', () => {
    for (const location of ['Singapore', 'Hong Kong', 'London', 'Luxembourg', 'Turin', 'Frankfurt', 'Paris', '']) {
      expect(build(location), location || '(empty)').toBeNull();
    }
  });
});

/**
 * Dedicated Workday parsers that predate `createWorkdaySwissParser`: a row
 * whose listing names no single site (`N Locations`) was filled with the HQ.
 * Abbott published a req worked in Neustadt am Rübenberge as `Basel/BS`.
 */
const WORKDAY_ROLLUP_CASES = [
  { name: 'abbott', fetchAll: fetchAllAbbottJobs, swiss: ['Switzerland - Zug', 'Zug'], rollupPrimary: ['Bern, Switzerland', 'Bern'], foreignPrimary: 'Germany - Neustadt am Rübenberge' },
  { name: 'stryker', fetchAll: fetchAllStrykerJobs, swiss: ['Bern, Switzerland', 'Bern'], rollupPrimary: ['Selzach, Switzerland', 'Selzach'], foreignPrimary: 'Cork, Ireland' },
  { name: 'ardian', fetchAll: fetchAllArdianJobs, swiss: ['Zurich', 'Zurich'], rollupPrimary: ['Geneva, Switzerland', 'Geneva'], foreignPrimary: 'Paris, France' },
  { name: 'alcon', fetchAll: fetchAllAlconJobs, swiss: ['Geneva, Switzerland', 'Geneva'], rollupPrimary: ['Fribourg, Switzerland', 'Fribourg'], foreignPrimary: 'Fort Worth, Texas, United States of America' },
  { name: 'novartis', fetchAll: fetchAllNovartisJobs, swiss: ['Basel', 'Basel'], rollupPrimary: ['Rotkreuz, Switzerland', null], foreignPrimary: 'Hyderabad, India' },
  { name: 'rituals-cosmetics', fetchAll: fetchAllRitualsCosmeticsJobs, swiss: ['Manor Winterthur', 'Winterthur'], rollupPrimary: ['Chur, Switzerland', 'Chur'], foreignPrimary: 'Amsterdam, Netherlands' },
  { name: 'ksb', fetchAll: fetchAllKsbJobs, swiss: ['Baden', 'Baden'], rollupPrimary: ['Brugg, Switzerland', 'Brugg'], foreignPrimary: 'Waldshut-Tiengen, Germany' },
  { name: 'bossard', fetchAll: fetchAllBossardJobs, swiss: ['Zug', 'Zug'], rollupPrimary: ['Zug, Switzerland', 'Zug'], foreignPrimary: 'Illerrieden, Germany' },
] as const;

describe('dedicated Workday parsers — an `N Locations` roll-up is placed by its own primary, never by the HQ', () => {
  for (const { name, fetchAll, swiss, rollupPrimary, foreignPrimary } of WORKDAY_ROLLUP_CASES) {
    it(`${name}: keeps Swiss reqs, drops a roll-up worked abroad`, async () => {
      mockWorkdayTenant([
        { title: 'Swiss single-site vacancy', locationsText: swiss[0], path: '/job/Swiss/Swiss-single-site-vacancy_JR1', primary: swiss[0] },
        { title: 'Roll-up with Swiss primary', locationsText: '2 Locations', path: '/job/Swiss/Roll-up-with-Swiss-primary_JR2', primary: rollupPrimary[0] },
        { title: 'Roll-up worked abroad', locationsText: '2 Locations', path: '/job/Abroad/Roll-up-worked-abroad_JR3', primary: foreignPrimary },
        { title: 'Roll-up whose detail did not load', locationsText: '3 Locations', path: '/job/Unknown/Roll-up-whose-detail-did-not-load_JR4', primary: null },
      ]);

      const jobs: any[] = await fetchAll();
      const titles = jobs.map((job) => job.title).sort();

      expect(titles).not.toContain('Roll-up worked abroad');
      expect(titles).not.toContain('Roll-up whose detail did not load');
      expect(jobs.find((job) => job.title === 'Swiss single-site vacancy')?.location).toBe(swiss[1]);
      const rollup = jobs.find((job) => job.title === 'Roll-up with Swiss primary');
      if (rollupPrimary[1] === null) {
        // `Rotkreuz` is a village of Risch (ZG), not a BFS municipality: the
        // primary is unresolvable, so the req is dropped rather than guessed.
        expect(rollup).toBeUndefined();
      } else {
        expect(rollup?.location).toBe(rollupPrimary[1]);
      }
      for (const job of jobs) expect(job.canton, `${job.title}`).toMatch(/^[A-Z]{2}$/);
    }, 20_000);
  }

  it('rituals-cosmetics: files the Schönbühl store under Bern, not under the Landquart legal seat', async () => {
    mockWorkdayTenant([
      { title: 'Sales Advisor', locationsText: 'Manor Schoenbuehl', path: '/job/Manor-Schoenbuehl/Sales-Advisor_JR1', primary: 'Manor Schoenbuehl' },
    ]);

    const jobs: any[] = await fetchAllRitualsCosmeticsJobs();

    expect(geography(jobs)).toEqual([['Sales Advisor', 'Schoenbuehl', 'BE']]);
  }, 20_000);
});

describe('fetchWorkdayPrimarySwissLocation', () => {
  const detail = (location: unknown) => async () => ({ jobPostingInfo: { location } });

  it('returns the req own Swiss primary workplace', async () => {
    expect(await fetchWorkdayPrimarySwissLocation('https://x/wday/cxs/x/y', '/job/a', { fetchDetail: detail('Winterthur, Switzerland') })).toBe('Winterthur');
  });

  it('returns empty for a foreign, missing or failed primary', async () => {
    expect(await fetchWorkdayPrimarySwissLocation('https://x/wday/cxs/x/y', '/job/a', { fetchDetail: detail('Sao Paulo, Brazil') })).toBe('');
    expect(await fetchWorkdayPrimarySwissLocation('https://x/wday/cxs/x/y', '/job/a', { fetchDetail: detail(undefined) })).toBe('');
    expect(await fetchWorkdayPrimarySwissLocation('https://x/wday/cxs/x/y', '/job/a', { fetchDetail: async () => null })).toBe('');
    expect(await fetchWorkdayPrimarySwissLocation('https://x/wday/cxs/x/y', '/job/a', {
      fetchDetail: async () => { throw new Error('network'); },
    })).toBe('');
    expect(await fetchWorkdayPrimarySwissLocation('https://x/wday/cxs/x/y', '')).toBe('');
  });
});
