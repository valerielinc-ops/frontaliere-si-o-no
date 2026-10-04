// @vitest-environment node
/**
 * LC-07 — ogni step-verdetto registrato ha il suo reporter PROPRIETARIO, e il reporter
 * generico `Workflow Failure:` non racconta il verdetto una seconda volta.
 *
 * Prima di questa suite `seo-health-loop.yml` e `refresh-plate-auctions.yml` chiudevano
 * rossa la run apposta e la segnalavano ANCHE come «Workflow Failure:» (issue 8591 e
 * 8670): la prima dopo aver già riaperto la sua issue dedicata (run 37114707959), la
 * seconda con un thread che non nomina la fonte degradata (run 36867519369: `be`) e che
 * perciò nessuno poteva chiudere. Ogni run rossa-verdetto aggiungeva una ricorrenza.
 *
 * Il contratto si verifica sui YAML veri con un piccolo simulatore del job: valuta gli
 * `if:` (con il `success()` implicito di GitHub Actions), propaga `outcome`/`conclusion`
 * (`continue-on-error` → conclusion `success`) e costruisce il payload dei job che
 * leggono scanner e closer centrali. Così lo stesso scenario prova due cose insieme:
 * il reporter interno tace, e `isVerdictOnlyFailure` riconosce la run come di solo verdetto.
 *
 * Se questa suite diventa rossa il titolo del guasto è:
 * «Step-verdetto senza reporter proprietario: il verdetto finisce nel thread generico».
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import registry from '../data/plate-auction-sources-registry.json';

process.env.GH_REPO ||= 'o/r';
const { VERDICT_STEPS, isVerdictOnlyFailure } = await import('../scripts/ci/close-recovered-failure-issues.mjs');
const { parseWorkflow, coverageOf } = await import('../scripts/ci/failure-issue-inventory.mjs');
const { healthVerdict, SEO_HEALTH_ISSUE_TITLE } = await import('../scripts/seo/seo-health-loop.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATES = '.github/workflows/refresh-plate-auctions.yml';
const SEO = '.github/workflows/seo-health-loop.yml';

type Entry = { workflowName: string; verdict: string; producers: string[]; owner: string };
type StepDoc = {
  name?: string;
  id?: string;
  if?: string | boolean;
  run?: string;
  uses?: string;
  'continue-on-error'?: boolean | string;
};
type JobDoc = { steps?: StepDoc[] };
type Scenario = { fail?: string[]; outputs?: Record<string, Record<string, string>> };
type StepState = { outcome: string; conclusion: string; outputs: Record<string, string> };

const ENTRIES = Object.entries(VERDICT_STEPS) as Array<[string, Entry]>;
const readText = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJobs = (rel: string) => (YAML.parse(readText(rel)) as { jobs: Record<string, JobDoc> }).jobs;

/** Il job che contiene lo step-verdetto. */
function verdictJob(rel: string, entry: Entry): StepDoc[] {
  const job = Object.values(readJobs(rel)).find((j) => (j.steps ?? []).some((s) => s.name === entry.verdict));
  if (!job?.steps) throw new Error(`${rel}: nessun job contiene «${entry.verdict}»`);
  return job.steps;
}

const stepName = (step: StepDoc) => step.name ?? step.uses ?? '(anonimo)';
const isGenericReporter = (step: StepDoc) =>
  /github-issue-creator\.mjs/.test(step.run ?? '') && /Workflow Failure:/.test(step.run ?? '') && !/--resolve\b/.test(step.run ?? '');

/** Uno step il cui `run:` è solo `echo …` + `exit 1`: fallisce ogni volta che gira. */
function alwaysFails(step: StepDoc): boolean {
  const lines = String(step.run ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.length > 0 && lines.at(-1) === 'exit 1' && lines.every((l) => l === 'exit 1' || l.startsWith('echo '));
}

const STATUS_FN = /\b(?:success|failure|always|cancelled)\(\)/;

/**
 * Valuta un `if:` come GitHub Actions, per il sottoinsieme che questi workflow usano.
 * Un contesto non gestito fa fallire il test invece di valere `false` in silenzio.
 */
function evalIf(raw: StepDoc['if'], ctx: { jobFailed: boolean; steps: Record<string, StepState> }): boolean {
  if (typeof raw === 'boolean') return raw;
  let expr = raw === undefined ? 'success()' : String(raw).trim();
  const wrapped = expr.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) expr = wrapped[1].trim();
  // Senza una funzione di stato GitHub antepone `success() &&`.
  if (!STATUS_FN.test(expr)) expr = `success() && (${expr})`;
  const js = expr
    .replace(/\bsteps\.([A-Za-z_][\w-]*)\.(outcome|conclusion)\b/g, (_m, id, field) => JSON.stringify(ctx.steps[id]?.[field as 'outcome'] ?? ''))
    .replace(/\bsteps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)/g, (_m, id, key) => JSON.stringify(ctx.steps[id]?.outputs?.[key] ?? ''))
    .replace(/\binputs\.[A-Za-z_][\w-]*/g, '""')
    .replace(/\bgithub\.event_name\b/g, '"schedule"')
    .replace(/\bsuccess\(\)/g, String(!ctx.jobFailed))
    .replace(/\bfailure\(\)/g, String(ctx.jobFailed))
    .replace(/\balways\(\)/g, 'true')
    .replace(/\bcancelled\(\)/g, 'false');
  const bare = js.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  if (/[A-Za-z_$][\w$]*\s*\.|[A-Za-z_$][\w$]*\s*\(/.test(bare)) throw new Error(`contesto non simulato nell'if: ${String(raw)}`);
  return Boolean(new Function(`return (${js});`)());
}

/** Esegue il job sullo scenario: chi gira, chi fallisce, e il payload dei job dell'API. */
function simulate(steps: StepDoc[], scenario: Scenario) {
  const ctx = { jobFailed: false, steps: {} as Record<string, StepState> };
  const fail = new Set(scenario.fail ?? []);
  const ran: string[] = [];
  const apiSteps: Array<{ name: string; conclusion: string; status: string }> = [];
  for (const step of steps) {
    const name = stepName(step);
    const runs = evalIf(step.if, ctx);
    const outcome = !runs ? 'skipped' : (fail.has(name) || alwaysFails(step) ? 'failure' : 'success');
    if (runs) ran.push(name);
    const coe = step['continue-on-error'] === true || step['continue-on-error'] === 'true';
    const conclusion = outcome === 'failure' && coe ? 'success' : outcome;
    if (conclusion === 'failure') ctx.jobFailed = true;
    if (step.id) ctx.steps[step.id] = { outcome, conclusion, outputs: runs ? (scenario.outputs?.[step.id] ?? {}) : {} };
    apiSteps.push({ name, conclusion, status: 'completed' });
  }
  for (const name of fail) {
    if (!steps.some((s) => stepName(s) === name)) throw new Error(`scenario: step inesistente «${name}»`);
  }
  const jobs = {
    total_count: 1,
    jobs: [{ name: 'job', status: 'completed', conclusion: ctx.jobFailed ? 'failure' : 'success', steps: apiSteps }],
  };
  return { ran, jobFailed: ctx.jobFailed, jobs, failedSteps: apiSteps.filter((s) => s.conclusion === 'failure').map((s) => s.name) };
}

/**
 * Scenari per workflow registrato. `soloVerdict` = la run rossa per il SOLO verdetto
 * (la forma delle run misurate); `failures` = guasti veri, che il reporter generico deve
 * continuare a segnalare. Una voce nuova del registro senza scenari fa fallire la suite.
 */
const SCENARIOS: Record<string, { soloVerdict: Scenario; failures: Array<[string, Scenario]> }> = {
  '.github/workflows/crawler-health-monitor.yml': {
    soloVerdict: { fail: ['Run health check'] },
    failures: [
      ['il check fallisce senza il file delle issue', { fail: ['Run health check', 'Open issues for stale crawlers'] }],
      ['lo stato non si pubblica', { fail: ['Open PR with updated health state'] }],
    ],
  },
  [SEO]: {
    // Run 37114707959: riapre la issue 8748, `1 actionable after 2 runs`, exit 1.
    soloVerdict: { fail: ['Run five-phase SEO health loop'], outputs: { health: { verdict: 'finding' } } },
    failures: [
      ['crash dello script (nessun verdetto in output)', { fail: ['Run five-phase SEO health loop'] }],
      ['finding la cui issue non è stata scritta', { fail: ['Run five-phase SEO health loop'], outputs: { health: { verdict: 'error' } } }],
      ['la riconciliazione 404 fallisce', { fail: ['Reconcile 404 compatibility store'], outputs: { health: { verdict: 'ok' } } }],
    ],
  },
  [PLATES]: {
    // Run 36867519369: `be` degradata, blocking=false, solo il verdetto rosso.
    soloVerdict: {
      fail: ['Fail closed on source health or snapshot drift'],
      outputs: { health: { blocking: 'false', health_failed: 'true' } },
    },
    failures: [
      ['check-health va in crash (nessun output)', { fail: ['Fail closed on source health or snapshot drift'] }],
      ['snapshot strutturalmente inutilizzabile', {
        fail: ['Fail closed on source health or snapshot drift'],
        outputs: { health: { blocking: 'true', health_failed: 'true' } },
      }],
      ['la issue per fonte non si scrive', {
        fail: ['Fail closed on source health or snapshot drift', 'Open one issue per degraded plate-auction source (dedup, zero-Claude)'],
        outputs: { health: { blocking: 'false', health_failed: 'true' } },
      }],
      ['il commit dello snapshot fallisce', { fail: ['Commit and push static snapshot'], outputs: { health: { blocking: 'false', health_failed: 'false' } } }],
    ],
  },
};

describe('registro degli step-verdetto: ogni voce ha uno scenario e un id', () => {
  it('ogni voce del registro ha i suoi scenari in questa suite', () => {
    expect(ENTRIES.length).toBeGreaterThan(0);
    expect(Object.keys(SCENARIOS).sort()).toEqual(ENTRIES.map(([rel]) => rel).sort());
  });

  it.each(ENTRIES)('%s: lo step-verdetto ha un `id`', (rel, entry) => {
    const verdict = verdictJob(rel, entry).find((s) => s.name === entry.verdict);
    expect(verdict?.id, `${rel}: «${entry.verdict}» senza id`).toMatch(/^[A-Za-z_][\w-]*$/);
  });
});

describe('il reporter generico `Workflow Failure:` esclude il caso solo-verdetto', () => {
  describe.each(ENTRIES)('%s', (rel, entry) => {
    const steps = verdictJob(rel, entry);
    const reporters = steps.filter(isGenericReporter).map(stepName);
    const { soloVerdict, failures } = SCENARIOS[rel] ?? { soloVerdict: {}, failures: [] };

    it('una run rossa per il solo verdetto non tocca il thread generico', () => {
      const sim = simulate(steps, soloVerdict);
      expect(sim.failedSteps, 'lo scenario deve chiudere rossa la run col solo verdetto').toEqual([entry.verdict]);
      expect(
        reporters.filter((r) => sim.ran.includes(r)),
        'Step-verdetto senza reporter proprietario: il verdetto finisce nel thread generico',
      ).toEqual([]);
      // Lo stesso payload è quello che leggono scanner e closer centrali.
      expect(isVerdictOnlyFailure(rel, sim.jobs)).toBe(true);
    });

    it.each(failures)('guasto vero (%s): il reporter generico segnala, e la run non passa per verdetto', (_label, scenario) => {
      const sim = simulate(steps, scenario);
      expect(sim.jobFailed).toBe(true);
      expect(reporters.length).toBeGreaterThan(0);
      expect(reporters.some((r) => sim.ran.includes(r)), `nessun reporter generico è partito: ${sim.ran.join(' | ')}`).toBe(true);
      expect(isVerdictOnlyFailure(rel, sim.jobs)).toBe(false);
    });
  });
});

describe('ogni voce del registro ha il reporter della issue proprietaria e il suo resolve', () => {
  /** Titolo della issue proprietaria esportato dagli script che la aprono e la risolvono. */
  const SCRIPT_OWNER_TITLES: Record<string, string> = {
    'scripts/seo/seo-health-loop.mjs': SEO_HEALTH_ISSUE_TITLE,
  };
  /** Gli script `node scripts/….mjs` eseguiti dai produttori del verdetto. */
  const producerScripts = (rel: string, entry: Entry) => verdictJob(rel, entry)
    .filter((s) => entry.producers.includes(stepName(s)))
    .flatMap((s) => [...String(s.run ?? '').matchAll(/\bnode\s+(scripts\/[\w./-]+\.mjs)/g)].map((m) => m[1]));

  it.each(ENTRIES)('%s', (rel, entry) => {
    const record = parseWorkflow(readText(rel), path.basename(rel));
    const yamlOpeners = record.openers.filter((o: { title: string }) => o.title.startsWith(entry.owner));
    const yamlClosers = record.closers.filter((c: { title: string }) => c.title.startsWith(entry.owner));
    if (yamlOpeners.length || yamlClosers.length) {
      // Owner nel YAML: apertura e resolve con lo STESSO titolo, e l'opener gira nella
      // run di solo verdetto (prima del verdetto, quindi prima che la run diventi rossa).
      expect(yamlOpeners.length, `${rel}: opener «${entry.owner}…»`).toBeGreaterThan(0);
      for (const opener of yamlOpeners) {
        expect(record.closers.map((c: { title: string }) => c.title), `${rel}: resolve di «${opener.title}»`).toContain(opener.title);
      }
      const steps = verdictJob(rel, entry);
      const sim = simulate(steps, SCENARIOS[rel].soloVerdict);
      const openerSteps = steps.filter((s) => /github-issue-creator\.mjs/.test(s.run ?? '') && !/--resolve\b/.test(s.run ?? '')
        && (s.run ?? '').includes(entry.owner)).map(stepName);
      expect(openerSteps.some((n) => sim.ran.includes(n)), `${rel}: l'opener proprietario non gira nella run di solo verdetto`).toBe(true);
      return;
    }
    // Owner nello script del produttore: lo script esporta la costante del titolo che
    // usa sia per createGithubIssue sia per resolveGithubIssue, e la costante sta
    // nella famiglia dichiarata dal registro.
    const scripts = producerScripts(rel, entry);
    const owned = scripts.filter((s) => s in SCRIPT_OWNER_TITLES);
    expect(owned, `${rel}: nessun owner nel YAML né uno script proprietario nei produttori (${scripts.join(', ')})`).not.toEqual([]);
    for (const script of owned) {
      expect(SCRIPT_OWNER_TITLES[script].startsWith(entry.owner), `${script}: «${SCRIPT_OWNER_TITLES[script]}» fuori da «${entry.owner}…»`).toBe(true);
    }
  });

  it('la issue per fonte delle aste ha un chiuditore nello stesso workflow (gate failure-issue-closers)', () => {
    const record = parseWorkflow(readText(PLATES), path.basename(PLATES));
    const opener = record.openers.find((o: { title: string }) => o.title.startsWith('Plate auction source degraded: '));
    expect(opener?.failureGated).toBe(true);
    expect(coverageOf(opener, record)).toEqual({ by: 'sibling-resolve-step' });
  });
});

describe('seo-health-loop.mjs: il verdetto che il workflow legge', () => {
  const actionable = [{ code: 'source-unavailable', url: 'source:ga4' }];
  it('ok senza finding azionabili, finding solo se la issue proprietaria è stata scritta', () => {
    expect(healthVerdict({ findings: { actionable: [] }, issue: { persisted: false } })).toBe('ok');
    expect(healthVerdict({ findings: { actionable }, issue: { attempted: true, persisted: true } })).toBe('finding');
    expect(healthVerdict({ findings: { actionable }, issue: { attempted: true, persisted: false } })).toBe('error');
    expect(healthVerdict({ findings: { actionable }, issue: { attempted: false, persisted: false } })).toBe('error');
    expect(healthVerdict({ findings: { actionable } })).toBe('error');
    expect(healthVerdict(null)).toBe('error');
  });
});

/* ── Aste: gli step per fonte eseguiti davvero, sul report vero di check-health ───────── */

const OPEN_STEP = 'Open one issue per degraded plate-auction source (dedup, zero-Claude)';
const RESOLVE_STEP = 'Resolve issues of plate-auction sources that are healthy again';
const SOURCES = registry.sources as Record<string, Record<string, unknown>>;

/** Uno snapshot che il gate accetta, costruito dal registro (come in plate-auction-ingest.test.ts). */
function healthySnapshot() {
  const auctions: Record<string, unknown>[] = [];
  const sources: Record<string, Record<string, unknown>> = {};
  for (const [key, source] of Object.entries(SOURCES)) {
    const active = source.status === 'active';
    if (active) {
      auctions.push({ id: `${key}-1`, sourceKey: String(source.plateCode), platePrefix: String(source.plateCode), auctionStatus: 'active' });
    }
    sources[key] = {
      ...source,
      rowCount: active ? 1 : 0,
      lastCheckedAt: '2026-10-01T06:00:00.000Z',
      ...(active ? { lastFetchedAt: '2026-10-01T06:00:00.000Z', lastSuccessAt: '2026-10-01T06:00:00.000Z' } : {}),
    };
  }
  return { schema: 1, complete: true, sources, auctions, counts: { active: auctions.length, upcoming: 0, closed: 0 } };
}

const activeKeys = Object.entries(SOURCES).filter(([, s]) => s.status === 'active').map(([k]) => k).sort();

/** Snapshot con alcune fonti attive degradate, come le scrive ingest.mjs. */
function degraded(keys: string[]) {
  const snapshot = healthySnapshot();
  for (const key of keys) snapshot.sources[key].status = 'degraded';
  return snapshot;
}

/** Esegue check-health.mjs sullo snapshot e restituisce il path del report per gli step. */
function healthReport(dir: string, snapshot: unknown) {
  const snapshotPath = path.join(dir, 'plate-auctions.json');
  const report = path.join(dir, 'plate-health.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
  const res = spawnSync(process.execPath, ['scripts/plate-auctions/check-health.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PLATE_AUCTION_OUTPUT: snapshotPath, PLATE_AUCTION_HEALTH_REPORT: report, GITHUB_OUTPUT: '' },
  });
  expect(fs.existsSync(report), res.stderr).toBe(true);
  return report;
}

/**
 * Esegue il `run:` di uno step del workflow con bash, `node scripts/lib/github-issue-creator.mjs`
 * e `gh` sostituiti da stub che registrano gli argomenti. `jq` e `node` restano veri.
 */
function runPlateStep(stepTitle: string, { dir, report, openIssues = [] }: { dir: string; report: string; openIssues?: unknown[] }) {
  const step = verdictJob(PLATES, VERDICT_STEPS[PLATES] as Entry).find((s) => s.name === stepTitle);
  if (!step?.run) throw new Error(`step senza run: ${stepTitle}`);
  const calls = path.join(dir, 'calls.jsonl');
  const ghFixture = path.join(dir, 'gh-issues.json');
  fs.writeFileSync(calls, '', 'utf8');
  fs.writeFileSync(ghFixture, JSON.stringify(openIssues), 'utf8');
  const stubs = [
    'node() {',
    '  if [ "${1:-}" = scripts/lib/github-issue-creator.mjs ]; then',
    '    shift',
    `    command node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@" >> "$CALLS"`,
    '    return 0',
    '  fi',
    '  command node "$@"',
    '}',
    'gh() { cat "$GH_FIXTURE"; }',
  ].join('\n');
  const script = path.join(dir, `step-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(script, `${stubs}\n${step.run}`, 'utf8');
  const res = spawnSync('bash', ['--noprofile', '--norc', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CALLS: calls,
      GH_FIXTURE: ghFixture,
      HEALTH_REPORT: report,
      RUNNER_TEMP: dir,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '42',
      GITHUB_WORKFLOW: 'Refresh Plate Auctions',
    },
  });
  const argv = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  return {
    status: res.status,
    output: `${res.stdout}\n${res.stderr}`,
    opened: argv.filter((a) => !a.includes('--resolve')).map((a) => ({ title: flag(a, '--title'), body: flag(a, '--description') })),
    resolved: argv.filter((a) => a.includes('--resolve')).map((a) => flag(a, '--title')),
  };
}

describe('aste targhe: una issue per fonte degradata, chiusa al rientro', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-owner-'));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const code = (key: string) => String(SOURCES[key].plateCode).toUpperCase();

  it('le fonti attive esistono (precondizione delle fixture)', () => {
    expect(activeKeys.length).toBeGreaterThan(1);
    expect(activeKeys).toContain('be');
  });

  it('una fonte in errore in UNA run → una issue col nome della fonte, alla prima run', () => {
    const dir = tmp();
    const report = healthReport(dir, degraded(['be']));
    const res = runPlateStep(OPEN_STEP, { dir, report });
    expect(res.status, res.output).toBe(0);
    expect(res.opened.map((o) => o.title)).toEqual(['Plate auction source degraded: BE']);
    expect(res.opened[0].body).toContain('be: active source was not fetched successfully (degraded)');
    expect(res.opened[0].body).toContain('https://github.com/o/r/actions/runs/42');
    // Il discriminante sta dentro il prefisso di dedup (60 caratteri).
    expect(res.opened[0].title.length).toBeLessThanOrEqual(60);
  });

  it('due fonti in errore → due issue distinte', () => {
    const [a, b] = [activeKeys[0], activeKeys[1]];
    const dir = tmp();
    const report = healthReport(dir, degraded([a, b]));
    const res = runPlateStep(OPEN_STEP, { dir, report });
    expect(res.status, res.output).toBe(0);
    expect(res.opened.map((o) => o.title).sort()).toEqual([
      `Plate auction source degraded: ${code(a)}`,
      `Plate auction source degraded: ${code(b)}`,
    ].sort());
  });

  it('fonte rientrata → resolve della sua issue, non di quella ancora degradata né di altre famiglie', () => {
    const other = activeKeys.find((k) => k !== 'be') as string;
    const dir = tmp();
    const report = healthReport(dir, degraded([other]));
    const res = runPlateStep(RESOLVE_STEP, {
      dir,
      report,
      openIssues: [
        { number: 1, title: 'Plate auction source degraded: BE' },
        { number: 2, title: `Plate auction source degraded: ${code(other)}` },
        { number: 3, title: 'Workflow Failure: Refresh Plate Auctions' },
      ],
    });
    expect(res.status, res.output).toBe(0);
    expect(res.resolved).toEqual(['Plate auction source degraded: BE']);
    expect(res.opened).toEqual([]);
  });

  it('report illeggibile → lo step proprietario fallisce (e il reporter generico prende la run)', () => {
    const dir = tmp();
    const res = runPlateStep(OPEN_STEP, { dir, report: path.join(dir, 'missing.json') });
    expect(res.status).not.toBe(0);
    expect(res.opened).toEqual([]);
  });

  it('snapshot strutturalmente rotto → nessuna issue per fonte e nessun resolve', () => {
    const dir = tmp();
    const report = healthReport(dir, null);
    const open = runPlateStep(OPEN_STEP, { dir, report });
    expect(open.status, open.output).toBe(0);
    expect(open.opened).toEqual([]);
    const resolve = runPlateStep(RESOLVE_STEP, { dir, report, openIssues: [{ number: 1, title: 'Plate auction source degraded: BE' }] });
    expect(resolve.resolved).toEqual([]);
  });
});
