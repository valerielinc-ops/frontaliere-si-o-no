import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

// The script is pure ESM (.mjs); main() is gated on process.argv[1], so
// importing it is side-effect-free — same pattern as
// tests/scripts/revenue-monitor.test.ts.
import * as reportModule from '../../scripts/adsense-format-ab-report.mjs';
import * as planModule from '../../scripts/lib/adsense-format-ab-plan.mjs';
import { SKIP_LIVE_DATA } from '../helpers/live-data';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  ADSENSE_ACCOUNT,
  CANTON_PAGE_PATHS,
  CONTROL_CHANNEL,
  TREATMENT_CHANNEL,
  EXPERIMENTS,
  DEFAULT_EXPERIMENT,
  ACTIVE_EXPERIMENTS,
  CWV_METRICS,
  POSTHOG_CWV_WINDOW_DAYS,
  SMALL_SAMPLE_PAGEVIEWS,
  parseCellNumber,
  parseCoveragePct,
  pctDelta,
  computeDeltas,
  computePrimaryMetric,
  computePrimaryDeltas,
  buildMeasurementMetadata,
  computeEngagementDeltas,
  postHogTrickleHasAnyData,
  fetchChannelReport,
  fetchCruxRecord,
  fetchGa4WebVitalsRatings,
  buildMarkdown,
  buildHistoryEntry,
  readHistorySummary,
  findExperiment,
  experimentFromArgs,
  classifyWindow,
} = reportModule as unknown as {
  ADSENSE_ACCOUNT: string;
  CANTON_PAGE_PATHS: { control: string; treatment: string };
  CONTROL_CHANNEL: string;
  TREATMENT_CHANNEL: string;
  EXPERIMENTS: readonly any[];
  DEFAULT_EXPERIMENT: any;
  ACTIVE_EXPERIMENTS: readonly any[];
  CWV_METRICS: readonly string[];
  POSTHOG_CWV_WINDOW_DAYS: number;
  SMALL_SAMPLE_PAGEVIEWS: number;
  parseCellNumber: (v: unknown) => number | null;
  parseCoveragePct: (v: unknown) => number | null;
  pctDelta: (treatment: number | null, control: number | null) => number | null;
  computeDeltas: (control: any, treatment: any) => { rpmPct: number | null; coveragePct: number | null; earningsPerPageviewPct: number | null };
  computePrimaryMetric: (row: any) => number | null;
  computePrimaryDeltas: (control: any, treatment: any) => number | null;
  buildMeasurementMetadata: (experiment: any, currencyCode?: string) => Record<string, unknown>;
  computeEngagementDeltas: (control: any, treatment: any) => Record<string, number | null>;
  postHogTrickleHasAnyData: (posthog: any) => boolean;
  fetchChannelReport: (token: string, experiment?: any) => Promise<any>;
  fetchCruxRecord: (url: string, apiKey?: string | null) => Promise<any>;
  fetchGa4WebVitalsRatings: (token: string, experiment?: any) => Promise<any>;
  buildMarkdown: (report: any, history?: any) => string;
  buildHistoryEntry: (report: any) => Record<string, unknown>;
  readHistorySummary: (experiment?: any, historyFile?: string) => any;
  findExperiment: (id: string) => any | null;
  experimentFromArgs: (args: string[]) => any;
  classifyWindow: (experiment: any, window: { start: string; end: string }) => string;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('adsense-format-ab-report / identifiers', () => {
  it('loads the TypeScript slot registry through Node ESM, as the scheduled workflow does', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const m = await import('./services/adsenseSlots.ts'); if (m.AD_CLIENT !== 'ca-pub-8628054934855353') throw new Error('slot registry not loaded'); console.log('loaded');",
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(output.trim()).toBe('loaded');
  });

  it('derives the AdSense account resource name from AD_CLIENT (no second hardcoded literal)', () => {
    expect(ADSENSE_ACCOUNT).toBe('accounts/pub-8628054934855353');
  });

  it('keeps the closed high-volume pair available for historical helpers', () => {
    expect(ACTIVE_EXPERIMENTS).toEqual([]);
    expect(CONTROL_CHANNEL).toBe('https://frontaliereticino.ch/cerca-lavoro-svizzera/');
    expect(TREATMENT_CHANNEL).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/');
    expect(CANTON_PAGE_PATHS).toEqual({ control: '/cerca-lavoro-svizzera/', treatment: '/cerca-lavoro-ticino/' });
    expect(DEFAULT_EXPERIMENT.id).toBe('svizzera-ticino');
  });

  it('retains the exact-PAGE_URL history schema without treating it as active', () => {
    expect(EXPERIMENTS.map((experiment) => experiment.id)).toEqual(['svizzera-ticino']);
    const experiment = findExperiment('svizzera-ticino');
    expect(experiment).toMatchObject({
      targetPageviewsPerSide: 4000,
      adsenseDimension: 'PAGE_URL',
      control: {
        label: 'Svizzera',
        adsenseValue: 'https://frontaliereticino.ch/cerca-lavoro-svizzera/',
        path: '/cerca-lavoro-svizzera/',
      },
      treatment: {
        label: 'Ticino',
        adsenseValue: 'https://frontaliereticino.ch/cerca-lavoro-ticino/',
        path: '/cerca-lavoro-ticino/',
      },
    });
  });

  it('selects an experiment from either CLI syntax and rejects unknown ids', () => {
    expect(experimentFromArgs(['--experiment', 'svizzera-ticino']).id).toBe('svizzera-ticino');
    expect(() => experimentFromArgs(['--experiment=basilea-lucerna'])).toThrow(/Esperimento sconosciuto/);
    expect(() => experimentFromArgs(['--experiment=unknown'])).toThrow(/Esperimento sconosciuto/);
  });

  it('counts only explicitly post-treatment rows and never inherits the active default', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adsense-format-ab-history-'));
    const historyFile = path.join(dir, 'history.jsonl');
    writeFileSync(historyFile, [
      JSON.stringify({ control: { pageViews: 165 }, treatment: { pageViews: 114 } }),
      JSON.stringify({ experimentId: 'svizzera-ticino', windowPhase: 'pre-treatment', control: { pageViews: 100 }, treatment: { pageViews: 200 } }),
      JSON.stringify({ experimentId: 'svizzera-ticino', windowPhase: 'mixed', control: { pageViews: 300 }, treatment: { pageViews: 400 } }),
      JSON.stringify({ experimentId: 'svizzera-ticino', windowPhase: 'post-treatment', control: { pageViews: 10 }, treatment: { pageViews: 20 } }),
    ].join('\n') + '\n');

    try {
      expect(readHistorySummary(DEFAULT_EXPERIMENT, historyFile)).toEqual({
        weeksWithData: 1,
        cumulativePageViews: { control: 10, treatment: 20 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Dato vivo: data/adsense-format-ab-history.jsonl, a cui il report settimanale appende una riga per run.
  it.skipIf(SKIP_LIVE_DATA)('keeps every checked-in history row explicitly attributed', () => {
    const entries = readFileSync(path.resolve(REPO_ROOT, 'data/adsense-format-ab-history.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.every((entry) => typeof entry.experimentId === 'string' && entry.experimentId.length > 0)).toBe(true);
    expect(entries.slice(0, 2).map((entry) => entry.experimentId)).toEqual(['basilea-lucerna', 'basilea-lucerna']);
  });

  it('classifies pre, mixed and clean post-treatment reporting windows', () => {
    const experiment = findExperiment('svizzera-ticino');
    const boundary = new Date(`${experiment.firstFullTreatmentDate}T00:00:00Z`);
    const before = new Date(boundary);
    before.setUTCDate(before.getUTCDate() - 1);
    const after = new Date(boundary);
    after.setUTCDate(after.getUTCDate() + 1);
    const date = (value: Date) => value.toISOString().slice(0, 10);

    expect(classifyWindow(experiment, { start: date(before), end: date(before) })).toBe('pre-treatment');
    expect(classifyWindow(experiment, { start: date(before), end: date(boundary) })).toBe('mixed');
    expect(classifyWindow(experiment, { start: date(boundary), end: date(after) })).toBe('post-treatment');
  });
});

/**
 * Observer for the "zombie monitor" defect: with the experiment retired the
 * weekly workflow kept posting one fixed sentence on the tracking issue every
 * Monday (and `github-issue-creator.mjs` reopens it when closed). The plan is
 * the single switch: no active experiment, no tracking-issue update.
 */
describe('adsense-format-ab-report / weekly plan gates the tracking issue', () => {
  type Plan = { active: boolean; experimentIds: string[]; message: string };
  const { EXPERIMENT_SURFACES, ACTIVE_EXPERIMENT_IDS, buildReportPlan, publishReportPlan } = planModule as unknown as {
    EXPERIMENT_SURFACES: readonly { id: string; canton: string }[];
    ACTIVE_EXPERIMENT_IDS: readonly string[];
    buildReportPlan: (ids?: readonly string[]) => Plan;
    publishReportPlan: (plan: Plan, env?: Record<string, string | undefined>) => void;
  };

  const PLAN_MODULE = 'scripts/lib/adsense-format-ab-plan.mjs';
  const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/adsense-format-ab-report.yml');
  const ACTIVE_CONDITION = "needs.plan.outputs.active == 'true'";
  const TRACKING_TITLE = 'AdSense in-feed A/B: monitor settimanale';
  type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string };
  type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; steps: Step[] };
  const jobs = (): Record<string, Job> => YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')).jobs;
  const callsTrackingIssue = (step: Step) => String(step.run ?? '').includes('github-issue-creator.mjs') && String(step.run).includes(TRACKING_TITLE);

  // What GitHub would run for a given plan: a job whose `if:` carries the
  // plan condition runs only when the plan is active.
  const trackingIssueCalls = (active: boolean) =>
    Object.values(jobs())
      .filter((job) => !String(job.if ?? '').includes(ACTIVE_CONDITION) || active)
      .flatMap((job) => job.steps.filter(callsTrackingIssue));

  const publish = (ids: readonly string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adsense-ab-plan-'));
    const outputFile = path.join(dir, 'output');
    const summaryFile = path.join(dir, 'summary');
    writeFileSync(outputFile, '');
    writeFileSync(summaryFile, '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      publishReportPlan(buildReportPlan(ids), { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile });
      return { output: readFileSync(outputFile, 'utf8'), summary: readFileSync(summaryFile, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('with no active experiment the plan is inactive and the issue creator is not invoked', () => {
    expect(buildReportPlan([])).toMatchObject({ active: false, experimentIds: [] });
    expect(publish([]).output).toBe('active=false\nexperiments=\n');
    expect(trackingIssueCalls(false)).toEqual([]);
  });

  it('with an active experiment the plan is active and the issue creator is invoked', () => {
    const id = DEFAULT_EXPERIMENT.id;
    expect(buildReportPlan([id])).toMatchObject({ active: true, experimentIds: [id] });
    expect(publish([id]).output).toBe(`active=true\nexperiments=${id}\n`);
    expect(trackingIssueCalls(true).length).toBeGreaterThan(0);
  });

  it('says why nothing is reported instead of going silent', () => {
    expect(publish([]).summary).toMatch(/PAUSED: nessun esperimento in-feed attivo/);
  });

  it('gate and report read the same switch: the report experiments are exactly the planned ones', () => {
    expect(ACTIVE_EXPERIMENTS.map((experiment) => experiment.id)).toEqual([...ACTIVE_EXPERIMENT_IDS]);
    expect(buildReportPlan().active).toBe(ACTIVE_EXPERIMENTS.length > 0);
    // Every surface the gate can turn on is an experiment the report can run.
    for (const surface of EXPERIMENT_SURFACES) {
      expect(findExperiment(surface.id)?.id).toBe(surface.id);
    }
  });

  it('refuses an experiment id that is not safe to pass to the workflow shell loop', () => {
    expect(() => buildReportPlan(['a; rm -rf .'])).toThrow(/non valido/);
  });

  it('runs the plan through the real CLI, as the workflow does', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adsense-ab-plan-cli-'));
    const outputFile = path.join(dir, 'output');
    writeFileSync(outputFile, '');
    try {
      execFileSync(process.execPath, [PLAN_MODULE], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile },
      });
      expect(readFileSync(outputFile, 'utf8')).toBe(
        `active=${ACTIVE_EXPERIMENT_IDS.length > 0}\nexperiments=${ACTIVE_EXPERIMENT_IDS.join(' ')}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the gate job stays light: the plan runs with no installed dependency and without the report script', () => {
    // The gate job runs without `npm ci` and with a sparse checkout; the
    // report script would drag in the full-checkout closure of revenue-monitor.
    // Run the CLI from a copy that holds only the two files of the declared
    // closure, away from any node_modules: a new import on either side
    // (static, bare or dynamic) fails here before it fails on a Monday.
    const dir = mkdtempSync(path.join(tmpdir(), 'adsense-ab-plan-light-'));
    const closure = [PLAN_MODULE, 'services/adExperiment.ts'];
    try {
      for (const file of closure) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        copyFileSync(path.join(REPO_ROOT, file), path.join(dir, file));
      }
      const outputFile = path.join(dir, 'output');
      writeFileSync(outputFile, '');
      execFileSync(process.execPath, [PLAN_MODULE], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile },
      });
      expect(readFileSync(outputFile, 'utf8')).toMatch(/^active=(true|false)\nexperiments=/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the workflow publishes the plan from a job that cannot fail open', () => {
    const { plan } = jobs();
    const planStep = plan.steps.find((step) => step.id === 'plan');
    expect(planStep?.run).toContain(`node ${PLAN_MODULE}`);
    expect(planStep).not.toHaveProperty('continue-on-error');
    expect(planStep).not.toHaveProperty('if');
    expect(plan).not.toHaveProperty('continue-on-error');
    expect(plan.outputs?.active).toBe('${{ steps.plan.outputs.active }}');
    expect(plan.outputs?.experiments).toBe('${{ steps.plan.outputs.experiments }}');
    // The gate itself never installs, loads credentials or touches the tracking issue.
    for (const step of plan.steps) {
      expect(String(step.run ?? '')).not.toMatch(/npm ci|load-rc-env|firebase-sa/);
      expect(callsTrackingIssue(step)).toBe(false);
    }
  });

  it('every other job of the workflow runs only with an active plan', () => {
    const others = Object.entries(jobs()).filter(([id]) => id !== 'plan');
    expect(others.length).toBeGreaterThan(0);
    for (const [id, job] of others) {
      expect([job.needs].flat(), `job ${id}`).toContain('plan');
      expect(String(job.if ?? ''), `job ${id}`).toContain(ACTIVE_CONDITION);
      // `always()` / `failure()` at job level would run the job despite a skipped or failed gate.
      expect(String(job.if ?? ''), `job ${id}`).not.toMatch(/always\(\)|failure\(\)|\|\|/);
    }
  });

  it('the tracking-issue body comes from the report script, never from a fixed sentence', () => {
    const steps = Object.values(jobs()).flatMap((job) => job.steps);
    const reportStep = steps.find((step) => /adsense-format-ab-report\.mjs --experiment/.test(String(step.run ?? '')));
    expect(reportStep?.run).toContain('--markdown');
    expect(reportStep?.run).toContain('/tmp/adsense-format-ab-report.md');
    // Only that step writes the file, and besides truncating it and adding a
    // blank separator, every write into it is the report script's own output.
    const writesReportFile = />{1,2}\s*\/tmp\/adsense-format-ab-report\.md/;
    expect(steps.filter((step) => writesReportFile.test(String(step.run ?? '')))).toEqual([reportStep]);
    const contentWrites = String(reportStep?.run ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => writesReportFile.test(line) && !/^(:|echo)\s*>{1,2}/.test(line));
    expect(contentWrites.length).toBeGreaterThan(0);
    expect(contentWrites.filter((line) => !line.startsWith('node scripts/adsense-format-ab-report.mjs '))).toEqual([]);
  });
});

describe('adsense-format-ab-report / parseCellNumber()', () => {
  it('parses a bare numeric string', () => {
    expect(parseCellNumber('18.34')).toBe(18.34);
  });

  it('strips a trailing percent sign (AdSense percentage-metric format observed either way)', () => {
    expect(parseCellNumber('18.34%')).toBe(18.34);
  });

  it('returns null for null/undefined/non-numeric input', () => {
    expect(parseCellNumber(null)).toBeNull();
    expect(parseCellNumber(undefined)).toBeNull();
    expect(parseCellNumber('n/a')).toBeNull();
  });
});

describe('adsense-format-ab-report / parseCoveragePct()', () => {
  it('normalizes both API fractions and percent-formatted values to percentage points', () => {
    expect(parseCoveragePct('0.6114')).toBe(61.14);
    expect(parseCoveragePct('61.14%')).toBe(61.14);
    expect(parseCoveragePct('61.14')).toBe(61.14);
  });
});

describe('adsense-format-ab-report / pctDelta()', () => {
  it('computes a signed percent delta of treatment vs control', () => {
    expect(pctDelta(1.5, 1.0)).toBe(50);
    expect(pctDelta(0.5, 1.0)).toBe(-50);
  });

  it('returns null when either side is null/undefined, or control is zero (no division by zero)', () => {
    expect(pctDelta(null, 1)).toBeNull();
    expect(pctDelta(1, null)).toBeNull();
    expect(pctDelta(1, 0)).toBeNull();
  });
});

describe('adsense-format-ab-report / computeDeltas() + computeEngagementDeltas()', () => {
  it('returns all-null deltas when either side of the AdSense comparison is missing (never throws)', () => {
    expect(computeDeltas(null, { rpmCHF: 1 })).toEqual({ rpmPct: null, coveragePct: null, earningsPerPageviewPct: null });
    expect(computeDeltas({ rpmCHF: 1 }, null)).toEqual({ rpmPct: null, coveragePct: null, earningsPerPageviewPct: null });
  });

  it('computes rpm/coverage/earnings-per-pageview deltas from two channel rows', () => {
    const control = { rpmCHF: 1.0, coveragePct: 15, earningsPerPageviewCHF: 0.002 };
    const treatment = { rpmCHF: 2.0, coveragePct: 18, earningsPerPageviewCHF: 0.003 };
    const d = computeDeltas(control, treatment);
    expect(d.rpmPct).toBe(100);
    expect(d.coveragePct).toBe(20);
    expect(d.earningsPerPageviewPct).toBe(50);
  });

  it('returns all-null engagement deltas when either side is missing', () => {
    const expected = {
      avgSessionDurationPct: null,
      engagementRatePct: null,
      bounceRatePct: null,
      pageViewsPerSessionPct: null,
    };
    expect(computeEngagementDeltas(null, {})).toEqual(expected);
    expect(computeEngagementDeltas({}, null)).toEqual(expected);
  });
});

describe('adsense-format-ab-report / primary metric', () => {
  it('normalizes estimated earnings to the AdSense page-view denominator', () => {
    const control = { earnings: 0.49, pageViews: 165 };
    const treatment = { earnings: 0.43, pageViews: 114 };
    expect(computePrimaryMetric(control)).toBe(2.9697);
    expect(computePrimaryMetric(treatment)).toBe(3.7719);
    expect(computePrimaryDeltas(control, treatment)).toBe(27);
  });

  it('keeps zero/unknown denominators unmeasurable instead of inventing a zero', () => {
    expect(computePrimaryMetric({ earnings: 1, pageViews: 0 })).toBeNull();
    expect(computePrimaryMetric({ earnings: 1, pageViews: null })).toBeNull();
  });

  it('declares the source, currency and denominator in the machine-readable measurement', () => {
    const measurement = buildMeasurementMetadata(findExperiment('svizzera-ticino'), 'EUR');
    expect(measurement).toMatchObject({
      source: 'AdSense Reporting API v2',
      numerator: 'ESTIMATED_EARNINGS',
      denominator: 'PAGE_VIEWS',
      scale: 1000,
      currencyCode: 'EUR',
      assignmentUnit: 'canonical_url',
    });
  });
});

describe('adsense-format-ab-report / postHogTrickleHasAnyData()', () => {
  it('is false when every metric/side has n=0 (and when posthog itself is missing)', () => {
    const empty = { control: { LCP: { n: 0 }, INP: { n: 0 }, CLS: { n: 0 } }, treatment: { LCP: { n: 0 }, INP: { n: 0 }, CLS: { n: 0 } } };
    expect(postHogTrickleHasAnyData(empty)).toBe(false);
    expect(postHogTrickleHasAnyData(null)).toBe(false);
  });

  it('is true as soon as ONE metric on ONE side has a sample', () => {
    const trickle = { control: { LCP: { n: 0 }, INP: { n: 0 }, CLS: { n: 0 } }, treatment: { LCP: { n: 1, p75: 1200 }, INP: { n: 0 }, CLS: { n: 0 } } };
    expect(postHogTrickleHasAnyData(trickle)).toBe(true);
  });
});

describe('adsense-format-ab-report / fetchChannelReport()', () => {
  it('picks the active control and treatment rows by exact page URL and computes earnings-per-pageview', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          totalMatchedRows: '3',
          rows: [
            { cells: [{ value: CONTROL_CHANNEL }, { value: '420' }, { value: '0.48' }, { value: '0.20' }, { value: '15.00%' }, { value: '72' }] },
            { cells: [{ value: TREATMENT_CHANNEL }, { value: '255' }, { value: '1.01' }, { value: '0.26' }, { value: '18.00%' }, { value: '54' }] },
            { cells: [{ value: 'frontaliereticino.ch/cerca-lavoro-zurigo' }, { value: '9999' }, { value: '9.9' }, { value: '9.9' }, { value: '99%' }, { value: '9999' }] },
          ],
        };
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await fetchChannelReport('test-token');

    expect(report.control?.impressions).toBe(420);
    expect(report.control?.earningsPerPageviewCHF).toBe(Number((0.20 / 72).toFixed(4)));
    expect(report.treatment?.rpmCHF).toBe(1.01);
    expect(report.treatment?.coveragePct).toBe(18);

    // Only one request — both channels picked out of the SAME broad
    // dimensioned response, never two separate filtered requests.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(ADSENSE_ACCOUNT);
    expect(url).toContain('dimensions=PAGE_URL');
  });

  it('uses PAGE_URL and exact canonical hub URLs for the Svizzera/Ticino experiment', async () => {
    const experiment = findExperiment('svizzera-ticino');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          totalMatchedRows: '3',
          headers: [{ name: 'ESTIMATED_EARNINGS', currencyCode: 'EUR' }],
          rows: [
            { cells: [{ value: experiment.control.adsenseValue }, { value: '1900' }, { value: '10.43' }, { value: '12.25' }, { value: '61%' }, { value: '1175' }] },
            { cells: [{ value: experiment.treatment.adsenseValue }, { value: '2300' }, { value: '7.11' }, { value: '11.86' }, { value: '63%' }, { value: '1668' }] },
            { cells: [{ value: 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermieri/' }, { value: '9999' }, { value: '99' }, { value: '99' }, { value: '99%' }, { value: '9999' }] },
          ],
        };
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await fetchChannelReport('test-token', experiment);

    expect(report.currencyCode).toBe('EUR');
    expect(report.control?.channel).toBe('https://frontaliereticino.ch/cerca-lavoro-svizzera/');
    expect(report.treatment?.channel).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/');
    expect(report.treatment?.pageViews).toBe(1668);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('dimensions=PAGE_URL');
  });

  it('returns null (not throw) for a channel absent from the report (e.g. zero impressions this week)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, async json() { return { totalMatchedRows: '0', rows: [] }; } }));
    const report = await fetchChannelReport('test-token');
    expect(report.control).toBeNull();
    expect(report.treatment).toBeNull();
  });

  it('rejects a truncated comparison instead of treating the omitted channel as zero impressions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, async json() { return { totalMatchedRows: '2', rows: [{ cells: [{ value: CONTROL_CHANNEL }] }] }; } }));
    await expect(fetchChannelReport('test-token')).rejects.toThrow(/truncated or completeness unknown/);
  });

  it('throws on a non-ok AdSense response (caught by main() and surfaced as a warning)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, async text() { return 'forbidden'; } }));
    await expect(fetchChannelReport('bad-token')).rejects.toThrow(/adsense reports:generate 403/);
  });
});

describe('adsense-format-ab-report / fetchCruxRecord()', () => {
  it('reports unavailable with a clear reason when no API key is configured', async () => {
    const out = await fetchCruxRecord('https://frontaliereticino.ch/cerca-lavoro-lucerna/', undefined);
    expect(out).toEqual({ available: false, reason: 'PAGESPEED_API_KEY not set' });
  });

  it('reports unavailable (below traffic threshold) on a 404 — verified live behaviour for both canton pages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, async text() { return 'not found'; } }));
    const out = await fetchCruxRecord('https://frontaliereticino.ch/cerca-lavoro-lucerna/', 'key');
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/below the minimum/);
  });

  it('parses p75 metrics from a successful CrUX record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          record: {
            metrics: {
              largest_contentful_paint: { percentiles: { p75: 1800 } },
              interaction_to_next_paint: { percentiles: { p75: 190 } },
              cumulative_layout_shift: { percentiles: { p75: 0.05 } },
            },
          },
        };
      },
    }));
    const out = await fetchCruxRecord('https://frontaliereticino.ch/cerca-lavoro-basilea/', 'key');
    expect(out).toEqual({ available: true, lcpMs: 1800, inpMs: 190, cls: 0.05 });
  });
});

describe('adsense-format-ab-report / fetchGa4WebVitalsRatings()', () => {
  it('reports unavailable with the raw error when the metric_name/metric_rating custom dimensions are not registered (verified live 2026-08-25: 400 INVALID_ARGUMENT)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      async text() { return 'Field customEvent:metric_name is not a valid dimension.'; },
    }));
    const out = await fetchGa4WebVitalsRatings('test-token');
    expect(out.available).toBe(false);
    expect(out.reason).toContain('400');
  });

  it('reports unavailable (not a thrown error) when the query succeeds but returns zero rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, async json() { return { rows: [] }; } }));
    const out = await fetchGa4WebVitalsRatings('test-token');
    expect(out.available).toBe(false);
  });

  it('reports available with rows when the dimensions ARE registered (future-proofing: this path activates automatically if the owner registers them)', async () => {
    const experiment = findExperiment('svizzera-ticino');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          rows: [
            {
              dimensionValues: [{ value: experiment.treatment.path }, { value: 'LCP' }, { value: 'good' }],
              metricValues: [{ value: '10' }],
            },
          ],
        };
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchGa4WebVitalsRatings('test-token', experiment);
    expect(out.available).toBe(true);
    expect(out.rows).toHaveLength(1);
    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(request.body).dimensionFilter.andGroup.expressions[1].filter.inListFilter.values)
      .toEqual(['/cerca-lavoro-svizzera/', '/cerca-lavoro-ticino/']);
  });
});

describe('adsense-format-ab-report / buildMarkdown()', () => {
  const baseReport = {
    window: { start: '2026-08-17', end: '2026-08-23' },
    control: { impressions: 1498, rpmCHF: 0.29, earningsCHF: 0.44, coveragePct: 15, pageViews: 2028, earningsPerPageviewCHF: 0.0002 },
    treatment: { impressions: 1536, rpmCHF: 0.28, earningsCHF: 0.43, coveragePct: 18, pageViews: 1608, earningsPerPageviewCHF: 0.0003 },
    deltas: { rpmPct: -3.4, coveragePct: 20, earningsPerPageviewPct: 50 },
    engagement: { control: { sessions: 11, avgSessionDurationSec: 48, engagementRatePct: 45.5, bounceRatePct: 54.5, pageViewsPerSession: 1.6 }, treatment: { sessions: 30, avgSessionDurationSec: 20.6, engagementRatePct: 66.7, bounceRatePct: 33.3, pageViewsPerSession: 4.9 } },
    engagementDeltas: { avgSessionDurationPct: -57.1, engagementRatePct: 46.6, bounceRatePct: -38.9, pageViewsPerSessionPct: 197 },
    cwv: {
      ga4: { available: false, reason: 'GA4 web_vitals query 400: Field customEvent:metric_name is not a valid dimension.' },
      posthog: { control: { LCP: { n: 0, p75: null }, INP: { n: 0, p75: null }, CLS: { n: 0, p75: null } }, treatment: { LCP: { n: 0, p75: null }, INP: { n: 0, p75: null }, CLS: { n: 0, p75: null } } },
      crux: { control: { available: false, reason: 'no CrUX record for this URL (below the minimum real-Chrome-traffic threshold)' }, treatment: { available: false, reason: 'no CrUX record for this URL (below the minimum real-Chrome-traffic threshold)' } },
    },
    warnings: [],
  };
  const targetReachedHistory = { weeksWithData: 3, cumulativePageViews: { control: 4000, treatment: 4000 } };

  it('publishes one compact progress row until both cumulative sides reach the target', () => {
    const md = buildMarkdown(baseReport, { weeksWithData: 2, cumulativePageViews: { control: 165, treatment: 114 } });

    expect(md).toContain('campione 165/4000 controllo · 114/4000 trattamento — nessuna lettura');
    expect(md.split('\n').length).toBeLessThanOrEqual(6);
    expect(md).not.toContain('| Metrica |');
    expect(md).not.toContain('## Engagement');
    expect(md).not.toContain('## Core Web Vitals');
  });

  it('restores the full report once both cumulative sides reach the target', () => {
    const md = buildMarkdown(baseReport, targetReachedHistory);

    expect(md).toContain('| Metrica |');
    expect(md).toContain('## Engagement (GA4) — guardrail');
    expect(md).toContain('## Core Web Vitals — guardrail (LCP / INP / CLS)');
  });

  it('always includes the small-sample disclaimer — this script must never claim statistical significance', () => {
    const md = buildMarkdown(baseReport, targetReachedHistory);
    expect(md).toContain('NON è un test di significatività statistica');
    expect(md).toContain('i sotto-URL sono esclusi');
  });

  it('renders the configured treatment description instead of the treatment data object', () => {
    const md = buildMarkdown(baseReport, targetReachedHistory);
    expect(md).toContain('**Trattamento osservato:** manual in-feed slot suppressed; Auto Ads and CMP unchanged.');
    expect(md).not.toContain('[object Object]');
  });

  it('prints the configured threshold when either weekly sample is small', () => {
    const md = buildMarkdown(
      { ...baseReport, control: { ...baseReport.control, pageViews: SMALL_SAMPLE_PAGEVIEWS - 1 } },
      targetReachedHistory,
    );
    expect(md).toContain(`${SMALL_SAMPLE_PAGEVIEWS} pageview/settimana`);
  });

  it('states explicitly (never silently) when CWV is not measurable on any of the three sources', () => {
    const md = buildMarkdown(baseReport, targetReachedHistory);
    expect(md).toContain('CWV non misurabile per queste pagine questa settimana');
    // The reason for each of the three sources is surfaced, not just the verdict.
    expect(md).toContain('metric_name');
    expect(md).toContain('below the minimum');
  });

  it('renders the PostHog trickle table (with sample counts) instead of the "not measurable" line once ANY sample exists', () => {
    const report = {
      ...baseReport,
      cwv: {
        ...baseReport.cwv,
        posthog: { control: { LCP: { n: 3, p75: 3435 }, INP: { n: 1, p75: 1952 }, CLS: { n: 1, p75: 0.892 } }, treatment: { LCP: { n: 6, p75: 1122 }, INP: { n: 3, p75: 6372 }, CLS: { n: 1, p75: 0.005 } } },
      },
    };
    const md = buildMarkdown(report, targetReachedHistory);
    expect(md).not.toContain('CWV non misurabile per queste pagine questa settimana');
    expect(md).toContain(`finestra di fallback ${POSTHOG_CWV_WINDOW_DAYS} giorni`);
    for (const m of CWV_METRICS) expect(md).toContain(m);
    expect(md).toContain('n=3, p75=3435ms');
  });

  it('surfaces the engagement guardrail hypothesis and table', () => {
    const md = buildMarkdown(baseReport, targetReachedHistory);
    expect(md).toContain('NON deve peggiorare l\'engagement');
    expect(md).toContain('Bounce rate');
    expect(md).toContain('46.6%'); // engagementRatePct delta
  });

  it('renders the selected experiment labels and exact AdSense dimension without leaking legacy labels', () => {
    const experiment = findExperiment('svizzera-ticino');
    const md = buildMarkdown(
      { ...baseReport, experiment, currencyCode: 'EUR' },
      targetReachedHistory,
    );
    expect(md).toContain('Svizzera (controllo) vs Ticino (trattamento)');
    expect(md).toContain('AdSense `PAGE_URL`');
    expect(md).toContain('i sotto-URL sono esclusi');
    expect(md).toContain('questa run è una baseline');
    expect(md).toContain('https://frontaliereticino.ch/cerca-lavoro-ticino/');
    expect(md).not.toContain('Basilea (controllo)');
    expect(md).not.toContain('Lucerna (trattamento)');
  });

  it('flags missing AdSense data with a warning instead of rendering a fabricated table', () => {
    const md = buildMarkdown({ ...baseReport, control: null, treatment: null }, targetReachedHistory);
    expect(md).toContain('Dati AdSense mancanti o incompleti');
  });

  it('renders the Warning section when warnings are present', () => {
    const md = buildMarkdown({ ...baseReport, warnings: ['AdSense fetch failed: boom'] }, targetReachedHistory);
    expect(md).toContain('## Warning');
    expect(md).toContain('AdSense fetch failed: boom');
  });
});

describe('adsense-format-ab-report / buildHistoryEntry()', () => {
  it('round-trips through JSON.stringify (what actually gets appended to the .jsonl file)', () => {
    const report = {
      window: { start: '2026-08-17', end: '2026-08-23' },
      control: { impressions: 1498, rpmCHF: 0.29, earningsCHF: 0.44, coveragePct: 15, pageViews: 2028, earningsPerPageviewCHF: 0.0002 },
      treatment: { impressions: 1536, rpmCHF: 0.28, earningsCHF: 0.43, coveragePct: 18, pageViews: 1608, earningsPerPageviewCHF: 0.0003 },
      deltas: { rpmPct: -3.4, coveragePct: 20, earningsPerPageviewPct: 50 },
      engagement: null,
      engagementDeltas: {},
      cwv: null,
    };
    const entry = buildHistoryEntry(report);
    const parsed = JSON.parse(JSON.stringify(entry));
    expect(parsed.experimentId).toBe('svizzera-ticino');
    expect(parsed.adsenseDimension).toBe('PAGE_URL');
    expect(parsed.control.channel).toBe(CONTROL_CHANNEL);
    expect(parsed.treatment.channel).toBe(TREATMENT_CHANNEL);
    expect(parsed.deltas.rpmPct).toBe(-3.4);
    expect(parsed.engagement).toBeNull();
    expect(parsed.cwv).toBeNull();
  });

  it('tags the Svizzera/Ticino history independently and stores its exact paths', () => {
    const experiment = findExperiment('svizzera-ticino');
    const report = {
      experiment,
      currencyCode: 'EUR',
      window: { start: 'window-start', end: 'window-end' },
      control: { impressions: 1, rpmCHF: 1, earningsCHF: 1, coveragePct: 1, pageViews: 1, earningsPerPageviewCHF: 1 },
      treatment: { impressions: 1, rpmCHF: 1, earningsCHF: 1, coveragePct: 1, pageViews: 1, earningsPerPageviewCHF: 1 },
      deltas: {},
      engagement: null,
      engagementDeltas: {},
      cwv: null,
    };
    const entry: any = buildHistoryEntry(report);
    expect(entry.experimentId).toBe('svizzera-ticino');
    expect(entry.adsenseDimension).toBe('PAGE_URL');
    expect(entry.control.path).toBe('/cerca-lavoro-svizzera/');
    expect(entry.treatment.path).toBe('/cerca-lavoro-ticino/');
  });

  it('carries engagement and CWV along in the SAME history line when available, never gating on them', () => {
    const report = {
      window: { start: '2026-08-17', end: '2026-08-23' },
      control: { impressions: 1, rpmCHF: 1, earningsCHF: 1, coveragePct: 1, pageViews: 1, earningsPerPageviewCHF: 1 },
      treatment: { impressions: 1, rpmCHF: 1, earningsCHF: 1, coveragePct: 1, pageViews: 1, earningsPerPageviewCHF: 1 },
      deltas: {},
      engagement: { control: { sessions: 11 }, treatment: { sessions: 30 } },
      engagementDeltas: { engagementRatePct: 46.6 },
      cwv: {
        ga4: { available: false, reason: 'x' },
        posthog: { control: {}, treatment: {} },
        crux: { control: { available: false }, treatment: { available: false } },
      },
    };
    const entry: any = buildHistoryEntry(report);
    expect(entry.engagement.deltas.engagementRatePct).toBe(46.6);
    expect(entry.cwv.ga4Available).toBe(false);
    expect(entry.cwv.posthogWindowDays).toBe(POSTHOG_CWV_WINDOW_DAYS);
  });
});
