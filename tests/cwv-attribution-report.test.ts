// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
// Contract client <-> reader: static imports on purpose. If the client module
// disappears the whole file is red, which is the point — a reader that goes
// quiet when its emitter is missing is the defect this test guards.
import {
  CWV_ATTRIBUTION_PAGE,
  CWV_ATTRIBUTION_SECTIONS,
  CWV_ATTRIBUTION_COMPONENTS,
} from '@/services/webVitalsAttribution';
import {
  ATTRIBUTION_PAGE,
  ATTRIBUTION_SECTIONS,
  ATTRIBUTION_COMPONENTS,
  attributionRequest,
  selectorRequest,
  templateRequest,
  parseTemplateRows,
} from '../scripts/lib/cwv-attribution.mjs';
import { ga4DateRange, weightedQuantile } from '../scripts/lib/ga4-service-account.mjs';
import { main, NO_EVENTS_MESSAGE, WINDOW_DAYS, LAG_DAYS } from '../scripts/cwv-attribution-report.mjs';

/**
 * scripts/cwv-attribution-report.mjs reads the CWV field attribution emitted by
 * services/webVitalsAttribution.ts (issues 8868 and 9815: every sweep closed
 * with «input mancante: profilo field con elementi»). Everything runs on a fake
 * fetch and a fake gh: no network.
 */

type Row = { dimensionValues: { value: string }[]; metricValues: { value: string }[] };
const row = (dims: string[], count: number): Row => ({
  dimensionValues: dims.map((value) => ({ value })),
  metricValues: [{ value: String(count) }],
});

// Measured on 2026-10-03 (GA4, 26-09 → 02-10): job_detail CLS p75 0.222 over
// 2161 events, jobs_index 0.215 (453), jobs_search 0.150 (238); the footer was
// the first CLS target with three Auto Ads containers, one collapsed.
const ATTRIBUTION_ROWS = [
  row(['/cerca-lavoro-ticino/annuncio/a/', 'cls', 'footer', 'complete'], 120),
  row(['/cerca-lavoro-ticino/', 'cls', 'auto_ad', 'loading'], 40),
  row(['/cerca-lavoro-ticino/annuncio/b/', 'cls', 'footer', 'complete'], 30),
  row(['/', 'inp', 'main', 'pointer'], 20),
];
const SELECTOR_ROWS = [
  row(['/cerca-lavoro-ticino/annuncio/a/', 'cls', 'footer', 'complete', 'footer>div.mt-8|ac3|cc1'], 120),
  row(['/cerca-lavoro-ticino/', 'cls', 'auto_ad', 'loading', 'ins.google-auto-placed|ac4|cc0'], 40),
  row(['/cerca-lavoro-ticino/annuncio/b/', 'cls', 'footer', 'complete', 'footer>div.mt-8|ac3|cc1'], 30),
  row(['/', 'inp', 'main', 'pointer', 'button.cta|ac2|cc2'], 20),
];
const TEMPLATE_ROWS = [
  // job_detail CLS: 2161 events, the 75th percentile falls on 222 thousandths.
  row(['job_detail', 'CLS', '30', 'mobile'], 600),
  row(['job_detail', 'CLS', '222', 'mobile'], 400),
  row(['job_detail', 'CLS', '400', 'mobile'], 300),
  row(['job_detail', 'CLS', '30', 'desktop'], 400),
  row(['job_detail', 'CLS', '222', 'desktop'], 300),
  row(['job_detail', 'CLS', '400', 'desktop'], 161),
  row(['job_detail', 'INP', '150', 'mobile'], 100),
  row(['job_detail', 'INP', '300', 'mobile'], 50),
  row(['jobs_search', 'CLS', '150', 'mobile'], 238),
  row(['jobs_index', 'CLS', '215', 'desktop'], 453),
];

type Kind = 'attribution' | 'selectors' | 'template';
function kindOf(body: any): Kind {
  const names = body.dimensions.map((d: { name: string }) => d.name);
  if (names.includes('customEvent:page_template')) return 'template';
  if (names.includes('customEvent:details')) return 'selectors';
  return 'attribution';
}

function fakeGa4(rows: Partial<Record<Kind, Row[]>>) {
  const bodies: any[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const data = { rows: rows[kindOf(body)] ?? [], rowCount: (rows[kindOf(body)] ?? []).length };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  });
  return { fetchImpl, bodies };
}

const OPEN_LABELLED = { number: 8868, title: 'CWV Regression (CLS): /cerca-lavoro-ticino/', state: 'OPEN' };
const CLOSED_LABELLED = { number: 7001, title: 'CWV Regression (INP): /', state: 'CLOSED' };
const WATCHLIST = { number: 9815, title: 'CWV field regression on a tracked page (#5001 watchlist)', state: 'OPEN' };
const LOOKALIKE = { number: 9999, title: 'Re: CWV field regression on a tracked page', state: 'OPEN' };

function fakeGh() {
  const comments: { issue: string; body: string }[] = [];
  const gh = vi.fn((args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'list' && args.includes('--label')) {
      return JSON.stringify([OPEN_LABELLED, CLOSED_LABELLED]);
    }
    if (args[0] === 'issue' && args[1] === 'list' && args.includes('--search')) {
      return JSON.stringify([WATCHLIST, OPEN_LABELLED, LOOKALIKE]);
    }
    if (args[0] === 'issue' && args[1] === 'comment') {
      const file = args[args.indexOf('--body-file') + 1];
      comments.push({ issue: args[2], body: readFileSync(file, 'utf8') });
      return '';
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  return { gh, comments };
}

async function run(argv: string[], rows: Partial<Record<Kind, Row[]>>, ghFake = fakeGh()) {
  const { fetchImpl, bodies } = fakeGa4(rows);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({
    argv,
    env: {},
    fetchImpl,
    getToken: async () => 'token',
    gh: ghFake.gh,
    log: (line: string) => out.push(line),
    logError: (line: string) => err.push(line),
  });
  return { code, bodies, out: out.join('\n'), err: err.join('\n'), ...ghFake };
}

const FULL = { attribution: ATTRIBUTION_ROWS, selectors: SELECTOR_ROWS, template: TEMPLATE_ROWS };

describe('client <-> reader contract', () => {
  it('the reader constants equal the client ones, same order', () => {
    expect(ATTRIBUTION_PAGE).toBe(CWV_ATTRIBUTION_PAGE);
    expect(ATTRIBUTION_SECTIONS).toEqual([...CWV_ATTRIBUTION_SECTIONS]);
    expect(ATTRIBUTION_COMPONENTS).toEqual([...CWV_ATTRIBUTION_COMPONENTS]);
  });

  it('request (a) filters on the client page value', () => {
    const body = attributionRequest({ startDate: 'a', endDate: 'b' });
    expect(body.dimensionFilter.andGroup.expressions).toContainEqual({
      filter: { fieldName: 'customEvent:page', stringFilter: { value: CWV_ATTRIBUTION_PAGE, matchType: 'EXACT' } },
    });
  });
});

describe('GA4 requests', () => {
  it('runs the three requests with the listed dimensions and filters on a 7-day window lagged 2 days', async () => {
    const { code, bodies } = await run(['--dry-run'], FULL);
    expect(code).toBe(0);
    expect(bodies.map(kindOf)).toEqual(['attribution', 'selectors', 'template']);
    const range = ga4DateRange(WINDOW_DAYS, LAG_DAYS);
    for (const body of bodies) expect(body.dateRanges).toEqual([range]);
    const [a, b, c] = bodies;

    const scope = {
      orGroup: { expressions: [
        { filter: { fieldName: 'pagePath', stringFilter: { value: '/', matchType: 'EXACT' } } },
        { filter: { fieldName: 'pagePath', stringFilter: { value: '/cerca-lavoro', matchType: 'BEGINS_WITH' } } },
      ] },
    };
    const attributionFilter = { andGroup: { expressions: [
      { filter: { fieldName: 'eventName', stringFilter: { value: 'ui_interaction', matchType: 'EXACT' } } },
      { filter: { fieldName: 'customEvent:page', stringFilter: { value: 'web_vitals', matchType: 'EXACT' } } },
      scope,
    ] } };

    expect(a.dimensions.map((d: any) => d.name)).toEqual(['pagePath', 'customEvent:section', 'customEvent:component', 'customEvent:action']);
    expect(a.metrics).toEqual([{ name: 'eventCount' }]);
    expect(a.dimensionFilter).toEqual(attributionFilter);

    expect(b.dimensions.map((d: any) => d.name)).toEqual([
      'pagePath', 'customEvent:section', 'customEvent:component', 'customEvent:action', 'customEvent:details',
    ]);
    expect(b.dimensionFilter).toEqual(attributionFilter);
    expect(b.limit).toBe(200);
    expect(b.orderBys).toEqual([{ metric: { metricName: 'eventCount' }, desc: true }]);

    expect(c.dimensions.map((d: any) => d.name)).toEqual([
      'customEvent:page_template', 'customEvent:metric_name', 'customEvent:metric_value', 'deviceCategory',
    ]);
    expect(c.dimensionFilter).toEqual({ andGroup: { expressions: [
      { filter: { fieldName: 'eventName', stringFilter: { value: 'web_vitals', matchType: 'EXACT' } } },
      { filter: { fieldName: 'customEvent:metric_name', inListFilter: { values: ['CLS', 'INP'] } } },
      { filter: { fieldName: 'pagePath', stringFilter: { value: '/cerca-lavoro', matchType: 'BEGINS_WITH' } } },
    ] } });
    // The exported builders are what main() sends.
    expect(a).toEqual(attributionRequest(range));
    expect(b).toEqual(selectorRequest(range));
    expect(c).toEqual(templateRequest(range));
  });

  it('a 400 «not a valid dimension» exits 1 and names the dimension', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: {
        code: 400,
        message: 'Field customEvent:component is not a valid dimension. For a list of valid dimensions and metrics, see https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema',
        status: 'INVALID_ARGUMENT',
      } }),
      json: async () => ({}),
    }));
    const { gh } = fakeGh();
    const err: string[] = [];
    const code = await main({
      argv: ['--comment'], env: {}, fetchImpl, getToken: async () => 'token', gh, log: () => {}, logError: (l: string) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('customEvent:component');
    expect(gh).not.toHaveBeenCalled();
  });

  it('any other 4xx also exits 1', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'PERMISSION_DENIED', json: async () => ({}) }));
    const code = await main({ argv: ['--dry-run'], env: {}, fetchImpl, getToken: async () => 'token', gh: vi.fn(), log: () => {}, logError: () => {} });
    expect(code).toBe(1);
  });

  it('a missing service-account token exits 1 without querying', async () => {
    const fetchImpl = vi.fn();
    const code = await main({ argv: ['--comment'], env: {}, fetchImpl, getToken: async () => null, gh: vi.fn(), log: () => {}, logError: () => {} });
    expect(code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('report', () => {
  it('no attribution rows → «nessun evento di attribuzione», exit 0, no comment', async () => {
    const { code, out, gh } = await run(['--comment'], { template: TEMPLATE_ROWS });
    expect(code).toBe(0);
    expect(out).toContain(NO_EVENTS_MESSAGE);
    expect(gh).not.toHaveBeenCalled();
  });

  it('reports the element, the selectors and the template p75 measured on 03-10, in order', async () => {
    const { code, out } = await run(['--dry-run'], FULL);
    expect(code).toBe(0);

    // (i) section × component × action, most events first, summed over paths.
    const footer = out.indexOf('| cls | footer | complete | 150 |');
    const autoAd = out.indexOf('| cls | auto_ad | loading | 40 |');
    const inp = out.indexOf('| inp | main | pointer | 20 |');
    expect(footer).toBeGreaterThan(-1);
    expect(autoAd).toBeGreaterThan(footer);
    expect(inp).toBeGreaterThan(autoAd);

    // (ii) the footer is the first CLS target, with ac3|cc1; INP rows are not CLS selectors.
    expect(out).toContain('| 1 | `footer>div.mt-8` | footer | 150 | 3.0 | 1.0 |');
    expect(out).toContain('| 2 | `ins.google-auto-placed` | auto_ad | 40 | 4.0 | 0.0 |');
    expect(out).not.toContain('button.cta');

    // (iii) p75 per template, the most measured template first; equal to weightedQuantile.
    const jobDetail = parseTemplateRows({ rows: TEMPLATE_ROWS }).filter((r) => r.template === 'job_detail' && r.metric === 'CLS');
    const expected = weightedQuantile(jobDetail, 0.75);
    expect(expected).toBe(0.222);
    const n = jobDetail.reduce((sum, r) => sum + r.count, 0);
    expect(out).toContain(`| job_detail | tutti | ${expected.toFixed(3)} | ${n} |`);
    const mobile = jobDetail.filter((r) => r.device === 'mobile');
    expect(out).toContain(`| job_detail | mobile | ${weightedQuantile(mobile, 0.75).toFixed(3)} | ${mobile.reduce((s, r) => s + r.count, 0)} |`);
    const order = ['| job_detail | tutti |', '| jobs_index | tutti |', '| jobs_search | tutti |'].map((s) => out.indexOf(s));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
    expect(out).toContain('| jobs_index | tutti | 0.215 | 453 |');
  });

  it('--dry-run never invokes gh', async () => {
    const { code, gh } = await run(['--dry-run'], FULL);
    expect(code).toBe(0);
    expect(gh).not.toHaveBeenCalled();
  });

  it('--comment posts a new comment on each open CWV issue and never on closed or look-alike ones', async () => {
    const { code, comments, out } = await run(['--comment'], FULL);
    expect(code).toBe(0);
    expect(comments.map((c) => c.issue)).toEqual(['8868', '9815']);
    for (const c of comments) expect(c.body).toContain('| cls | footer | complete | 150 |');
    expect(out).toContain('Commentate: #8868, #9815');
  });
});

describe('cwv-monitor.yml wiring', () => {
  const ROOT = path.resolve(__dirname, '..');
  const source = readFileSync(path.join(ROOT, '.github/workflows/cwv-monitor.yml'), 'utf8');
  const steps: any[] = YAML.parse(source).jobs.monitor.steps;
  const index = (name: string) => steps.findIndex((s) => s.name === name);

  it('runs the report with --comment after the measurement and before the snapshot PR, failing the run on error', () => {
    const report = index('Report CWV attribution');
    expect(report).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(index('Check CWV regressions + record weekly snapshot'));
    expect(index('Check CWV regressions + record weekly snapshot')).toBeGreaterThan(-1);
    expect(report).toBeLessThan(index('Open PR with snapshot'));
    const step = steps[report];
    expect(step.run).toContain('node scripts/cwv-attribution-report.mjs --comment');
    expect(step).not.toHaveProperty('continue-on-error');
    expect(step).not.toHaveProperty('if');
    expect(step['timeout-minutes']).toBeGreaterThan(0);
    expect(step['timeout-minutes']).toBeLessThan(YAML.parse(source).jobs.monitor['timeout-minutes']);
    expect(step.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(step.env.GH_REPO).toBe('${{ github.repository }}');
    expect(YAML.parse(source).permissions.issues).toBe('write');
  });
});
