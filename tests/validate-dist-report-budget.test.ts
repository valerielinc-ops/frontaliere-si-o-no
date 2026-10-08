import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * `validate:page-seo` e' un passo report-only: una camminata seriale su tutto
 * dist/ che costa 60-115 minuti. Girava PRIMA dei validatori bloccanti e ne
 * consumava il budget. Nella pubblicazione 37754770528 il timeout del job
 * (300 min) ha tagliato i gate a meta': un job `cancelled` viene letto da
 * integrity-verdict come `__UNKNOWN__:dist`, quindi integrity_ok=false e il
 * job `publish` (IndexNow, Indexing API, GSC) e' stato saltato.
 *
 * Contratto fissato qui: il report gira per ultimo, con un limite proprio pari
 * al tempo rimasto del job, e non puo' mai essere lui a far scattare il timeout
 * del job.
 */

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'post-deploy-validate-dist.yml');

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
  'timeout-minutes'?: number | string;
};

const workflow = YAML.parse(fs.readFileSync(workflowPath, 'utf8'));
const job = workflow.jobs['validate-dist-postbuild'] as { 'timeout-minutes': number; steps: Step[] };
const steps = job.steps;
const indexOf = (name: string) => steps.findIndex((step) => step.name === name);

const REPORT = 'Validate page SEO quality (report-only)';
const BUDGET = 'Budget for the report-only SEO quality walk';

function runBudget(env: Record<string, string>): { minutes: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-report-budget-'));
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
  try {
    const log = execFileSync('bash', ['-c', String(steps[indexOf(BUDGET)].run)], {
      env: { PATH: process.env.PATH ?? '', ...steps[indexOf(BUDGET)].env, ...env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    const match = /^minutes=(.*)$/m.exec(fs.readFileSync(output, 'utf8'));
    return { minutes: match ? match[1] : '(missing)', log };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const startedMinutesAgo = (minutes: number) => String(Math.floor(Date.now() / 1000) - minutes * 60);

describe('validate-dist: il report SEO non consuma il budget dei gate', () => {
  it('registra l\'inizio del job come primo passo', () => {
    expect(steps[0].name).toBe('Record job start');
    expect(steps[0].run).toContain('VALIDATE_DIST_STARTED_AT=');
    expect(steps[0].run).toContain('$GITHUB_ENV');
  });

  it('esegue il report dopo ogni validatore e dopo la pubblicazione del verdetto', () => {
    const report = indexOf(REPORT);
    expect(report).toBe(steps.length - 1);
    expect(indexOf(BUDGET)).toBe(report - 1);
    for (const earlier of [
      'Run source validators (parallel — 4 vCPU)',
      'Post-build validations + SEO audits (capped parallel)',
      'BFS-depth + orphan-sitemap-pages audits (serial chain)',
      'Publish combined gate results',
      'Fail when a dist validator failed',
    ]) {
      expect(indexOf(earlier), earlier).toBeGreaterThan(-1);
      expect(indexOf(earlier), earlier).toBeLessThan(report);
    }
  });

  it('tiene il report non bloccante e limitato dal budget calcolato', () => {
    const report = steps[indexOf(REPORT)];
    expect(report['continue-on-error']).toBe(true);
    expect(String(report['timeout-minutes'])).toContain('steps.seo_report_budget.outputs.minutes');
    expect(report.if).toContain("steps.seo_report_budget.outputs.minutes != '0'");
    expect(report.if).toContain('always()');
    expect(steps[indexOf(BUDGET)].id).toBe('seo_report_budget');
    expect(steps[indexOf(BUDGET)].if).toBe('always()');
  });

  it('calcola il budget sullo stesso timeout dichiarato dal job', () => {
    expect(steps[indexOf(BUDGET)].env?.VALIDATE_DIST_TIMEOUT_MIN).toBe(String(job['timeout-minutes']));
    expect(job['timeout-minutes']).toBeLessThan(360);
  });

  it('in una giornata normale lascia al report il tempo rimasto meno il margine', () => {
    // 191 min di gate (run dell'8 ottobre 01:00 UTC): 350 - 10 - 191 = 149.
    const { minutes } = runBudget({ VALIDATE_DIST_STARTED_AT: startedMinutesAgo(191) });
    expect(Number(minutes)).toBeGreaterThanOrEqual(148);
    expect(Number(minutes)).toBeLessThanOrEqual(149);
  });

  it('in una giornata lenta salta il report invece di sforare il timeout del job', () => {
    const { minutes, log } = runBudget({ VALIDATE_DIST_STARTED_AT: startedMinutesAgo(330) });
    expect(minutes).toBe('0');
    expect(log).toContain('SEO quality report skipped');
  });

  it('non concede mai piu\' del tempo rimasto', () => {
    for (const elapsed of [0, 60, 200, 300, 324, 326, 349, 400]) {
      const { minutes } = runBudget({ VALIDATE_DIST_STARTED_AT: startedMinutesAgo(elapsed) });
      const granted = Number(minutes);
      expect(granted === 0 || granted >= 15, `elapsed=${elapsed}`).toBe(true);
      expect(granted + elapsed, `elapsed=${elapsed}`).toBeLessThanOrEqual(job['timeout-minutes'] - 10 + (granted === 0 ? elapsed : 0));
    }
  });

  it('salta il report se manca l\'orario di inizio', () => {
    const { minutes, log } = runBudget({ VALIDATE_DIST_STARTED_AT: '' });
    expect(minutes).toBe('0');
    expect(log).toContain('job start timestamp missing');
  });
});
