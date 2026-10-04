/**
 * audit-cls-live — una regressione CLS apre una issue nel backlog invece di
 * bloccare il deploy (decisione del proprietario, 2026-10-04: «nessun blocco
 * deploy, solo issue nel backlog»).
 *
 * Prima di questo contratto lo step `CLS regression gate` di
 * `post-deploy-validate-live.yml` usciva 1 su ogni regressione hard: il deploy
 * diventava rosso e la sola traccia era la issue generica
 * `Validation Failure (live): post-deploy`. Misurato sul codice di origin/main
 * con PSI finto (campo e lab 1,2 su ogni target mobile, baseline 0,73-0,91):
 * 7 regressioni hard, exit 1. Dopo, con `--report-issue`: exit 0 e una issue
 * `[Monitor] CLS regression after deploy` con URL, CLS di campo e di lab,
 * baseline, soglia e link alla run.
 *
 * Tre livelli: il verdetto puro (`decideClsGate`), la sincronizzazione della
 * issue con creator e resolver iniettati, e lo script vero eseguito come
 * processo con `fetch` e `gh` finti — è quello che decide l'exit code dello step.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CLS_REGRESSION_ISSUE_TITLE,
  buildClsRegressionIssue,
  decideClsGate,
  syncClsRegressionIssue,
} from '../scripts/audit-cls-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-cls-live.mjs');

function row(key: string, effective: number | null, state: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    url: `https://example.test/${key.split('@')[0]}/`,
    strategy: key.split('@')[1],
    effective,
    source: 'crux_url',
    cruxP75: effective,
    cruxOriginP75: 0.4,
    lab: 0.9,
    baseline: 0.5,
    verdict: { state, reason: `fixture ${state}` },
    ...extra,
  };
}

const HARD = row('home@mobile', 1.2, 'hard_regression');
const FLAT = row('jobs_index@mobile', 0.5, 'flat');

describe('decideClsGate — verdetto puro', () => {
  it('regressione hard con --report-issue: issue da aprire, exit 0', () => {
    const gate = decideClsGate({ results: [HARD, FLAT], errors: [], expectedCalls: 2, reportIssue: true });
    expect(gate.issueAction).toBe('report');
    expect(gate.exitCode).toBe(0);
    expect(gate.hardRegressions.map((r: { key: string }) => r.key)).toEqual(['home@mobile']);
  });

  it('senza --report-issue (verdetto locale) la regressione hard resta exit 1 e non tocca issue', () => {
    const gate = decideClsGate({ results: [HARD, FLAT], errors: [], expectedCalls: 2, reportIssue: false });
    expect(gate.exitCode).toBe(1);
    expect(gate.issueAction).toBe('none');
  });

  it('misura completa senza regressioni hard: chiude la issue', () => {
    const gate = decideClsGate({ results: [FLAT, row('home@mobile', 0.6, 'soft_regression')], errors: [], expectedCalls: 2, reportIssue: true });
    expect(gate.issueAction).toBe('resolve');
    expect(gate.exitCode).toBe(0);
  });

  it('misura incompleta (un errore, una chiamata mancante, un CLS assente) non chiude niente', () => {
    const inconclusive = { key: 'home@mobile', error: 'PSI 429 for https://example.test/' };
    expect(decideClsGate({ results: [FLAT], errors: [inconclusive], expectedCalls: 2, reportIssue: true }).issueAction).toBe('none');
    expect(decideClsGate({ results: [FLAT], errors: [], expectedCalls: 2, reportIssue: true }).issueAction).toBe('none');
    expect(decideClsGate({
      results: [FLAT, row('home@mobile', null, 'unknown')], errors: [], expectedCalls: 2, reportIssue: true,
    }).issueAction).toBe('none');
  });

  it('errori PSI: politica invariata — un errore bloccante esce 1 anche con la issue aperta', () => {
    const blocking = { key: 'x', error: 'PSI 400 for https://example.test/' };
    const gate = decideClsGate({ results: [HARD], errors: [blocking], expectedCalls: 2, reportIssue: true });
    expect(gate.exitCode).toBe(1);
    expect(gate.issueAction).toBe('report');

    const allProvider = decideClsGate({
      results: [], errors: [{ error: 'PSI 403 for a' }, { error: 'PSI 503 for b' }], expectedCalls: 2, reportIssue: true,
    });
    expect(allProvider.allPsiProviderErrors).toBe(true);
    expect(allProvider.exitCode).toBe(0);
    expect(allProvider.issueAction).toBe('none');
  });
});

describe('syncClsRegressionIssue — creator e resolver iniettati', () => {
  it('regressione → issue col titolo stabile esatto e i fatti della misura nel corpo', async () => {
    const created: Array<Record<string, unknown>> = [];
    const out = await syncClsRegressionIssue(
      {
        issueAction: 'report',
        hardRegressions: [HARD],
        baselineGenerated: '2026-05-08T05:53:52.420Z',
        runUrl: 'https://github.com/example/repo/actions/runs/123',
        buildSha: 'abc1234',
        baseUrl: 'https://example.test',
      },
      {
        create: async (opts: Record<string, unknown>) => { created.push(opts); return { number: 7, persisted: true }; },
        resolve: () => { throw new Error('resolve non deve partire su una regressione'); },
      },
    );
    expect(out).toMatchObject({ action: 'report', tracked: true });
    expect(created).toHaveLength(1);
    const [opts] = created;
    expect(opts.title).toBe(CLS_REGRESSION_ISSUE_TITLE);
    expect(opts.exactTitle).toBe(true);
    const body = String(opts.description);
    for (const fact of [
      'https://example.test/home/', // URL
      '1.200 (`crux_url`)', // CLS effettivo e fonte
      '| 0.400 |', // campo origine
      '| 0.900 |', // lab
      '| 0.500 |', // baseline del target
      '2026-05-08T05:53:52.420Z', // baseline file
      'CLS > 0.25', // soglia
      'https://github.com/example/repo/actions/runs/123', // run
      'abc1234',
      '2026-10-04', // decisione del proprietario
    ]) expect(body).toContain(fact);
  });

  it('scrittura non confermata o fallita → tracked false (lo script allora esce 1)', async () => {
    const notPersisted = await syncClsRegressionIssue(
      { issueAction: 'report', hardRegressions: [HARD] },
      { create: async () => ({ number: 7, persisted: false }), reportingDisabled: () => false },
    );
    expect(notPersisted.tracked).toBe(false);
    const thrown = await syncClsRegressionIssue(
      { issueAction: 'report', hardRegressions: [HARD] },
      { create: async () => { throw new Error('gh: 502'); }, reportingDisabled: () => false },
    );
    expect(thrown.tracked).toBe(false);
    const nullUnexpected = await syncClsRegressionIssue(
      { issueAction: 'report', hardRegressions: [HARD] },
      { create: async () => null, reportingDisabled: () => false },
    );
    expect(nullUnexpected.tracked).toBe(false);
  });

  it('ENABLE_FAILURE_REPORT=false spento di proposito → tracked "disabled", non un errore', async () => {
    const out = await syncClsRegressionIssue(
      { issueAction: 'report', hardRegressions: [HARD] },
      { create: async () => null, reportingDisabled: () => true },
    );
    expect(out.tracked).toBe('disabled');
  });

  it('nessuna regressione → resolve sul titolo stabile esatto; un errore del resolve non è fatale', async () => {
    const resolved: Array<[string, Record<string, unknown>]> = [];
    const out = await syncClsRegressionIssue(
      { issueAction: 'resolve', runUrl: 'https://github.com/example/repo/actions/runs/124' },
      {
        create: async () => { throw new Error('create non deve partire su una run pulita'); },
        resolve: (title: string, ctx: Record<string, unknown>) => { resolved.push([title, ctx]); return { number: 7, persisted: true }; },
      },
    );
    expect(out).toMatchObject({ action: 'resolve', tracked: true });
    expect(resolved).toEqual([[CLS_REGRESSION_ISSUE_TITLE, expect.objectContaining({ exactTitle: true })]]);

    const failed = await syncClsRegressionIssue(
      { issueAction: 'resolve' },
      { resolve: () => { throw Object.assign(new Error('close refused'), { persisted: false }); } },
    );
    expect(failed).toMatchObject({ action: 'resolve', tracked: false });
  });

  it('il titolo resta stabile: niente numeri di run o valori nei primi 60 caratteri', () => {
    const { title } = buildClsRegressionIssue({ hardRegressions: [HARD], runUrl: 'https://x/runs/999' });
    expect(title).toBe(CLS_REGRESSION_ISSUE_TITLE);
    expect(title.slice(0, 60)).not.toMatch(/\d/);
  });
});

describe('lo script come processo — exit code dello step', () => {
  let tmp: string;
  let fakeFetch: string;
  let fakeGh: string;
  let baselinePath: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-issue-gate-'));
    fakeFetch = path.join(tmp, 'fake-fetch.mjs');
    fs.writeFileSync(fakeFetch, `
const FIELD = Number(process.env.FAKE_FIELD);
const LAB = Number(process.env.FAKE_LAB);
const STATUS = Number(process.env.FAKE_STATUS || '200');
globalThis.fetch = async () => {
  const metric = { percentile: Math.round(FIELD * 100), category: 'SLOW' };
  const body = {
    loadingExperience: { metrics: { CUMULATIVE_LAYOUT_SHIFT_SCORE: metric } },
    originLoadingExperience: { metrics: { CUMULATIVE_LAYOUT_SHIFT_SCORE: metric } },
    lighthouseResult: { audits: { 'cumulative-layout-shift': { numericValue: LAB } } },
  };
  return { ok: STATUS < 400, status: STATUS, text: async () => (STATUS < 400 ? JSON.stringify(body) : 'bad request') };
};
`);
    fakeGh = path.join(tmp, 'fake-gh.sh');
    fs.writeFileSync(fakeGh, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") echo '[]';;
  "issue create") [ "$FAKE_GH_CREATE_FAIL" = 1 ] && exit 1; echo 'https://github.com/example/repo/issues/4242';;
  *) :;;
esac
exit 0
`);
    fs.chmodSync(fakeGh, 0o755);
    // Baseline di fixture: il verdetto non dipende da data/cls-baseline.json,
    // che un --rebaseline può riscrivere. Solo `home` ha una baseline, gli
    // altri target escono `new`.
    baselinePath = path.join(tmp, 'cls-baseline.json');
    fs.writeFileSync(baselinePath, JSON.stringify({
      generated: '2026-05-08T05:53:52.420Z',
      entries: { 'home@mobile': { cls: 0.5, source: 'crux_url' } },
    }));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runGate(name: string, { field, lab, status = 200, reportIssue = true, createFail = false }: {
    field: number; lab: number; status?: number; reportIssue?: boolean; createFail?: boolean;
  }) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const ghLog = path.join(dir, 'gh.log');
    fs.writeFileSync(ghLog, '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FAKE_FIELD: String(field),
      FAKE_LAB: String(lab),
      FAKE_STATUS: String(status),
      FAKE_GH_LOG: ghLog,
      FAKE_GH_CREATE_FAIL: createFail ? '1' : '0',
      TRUSTED_GH_BIN: fakeGh,
      GH_REPO: 'example/repo',
      GITHUB_REPOSITORY: 'example/repo',
      GITHUB_RUN_ID: '123',
      // Mai i file del job CI che esegue vitest.
      GITHUB_OUTPUT: path.join(dir, 'output.txt'),
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
      LIVE_BASE_URL: 'https://example.test',
      CLS_BASELINE_PATH: baselinePath,
      CLS_LIVE_REPORTS_DIR: path.join(dir, 'reports'),
      AUDIT_REPORTS_DIR: path.join(dir, 'audit-reports'),
    };
    delete env.ENABLE_FAILURE_REPORT;
    delete env.PAGESPEED_API_KEY;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const args = ['--import', pathToFileURL(fakeFetch).href, SCRIPT, '--strategy=mobile'];
    if (reportIssue) args.push('--report-issue');
    const res = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    return {
      status: res.status,
      stdout: res.stdout,
      gh: fs.readFileSync(ghLog, 'utf8'),
      output: fs.existsSync(env.GITHUB_OUTPUT!) ? fs.readFileSync(env.GITHUB_OUTPUT!, 'utf8') : '',
    };
  }

  it('regressione catastrofica con --report-issue: exit 0 e issue di monitor creata', () => {
    const r = runGate('regression', { field: 1.2, lab: 1.2 });
    expect(r.status, r.stdout).toBe(0);
    expect(r.gh).toContain(`issue create --title ${CLS_REGRESSION_ISSUE_TITLE}`);
    expect(r.stdout).toContain('::warning::CLS: 1 hard regression(s), tracked in https://github.com/example/repo/issues/4242');
    expect(r.output).toContain('hard_regressions=1');
  });

  it('la stessa regressione senza --report-issue (verdetto locale) esce ancora 1, senza toccare GitHub', () => {
    const r = runGate('local', { field: 1.2, lab: 1.2, reportIssue: false });
    expect(r.status).toBe(1);
    expect(r.gh).toBe('');
  });

  it('scrittura della issue fallita: lo step esce 1 per non perdere la regressione', () => {
    const r = runGate('create-fail', { field: 1.2, lab: 1.2, createFail: true });
    expect(r.status).toBe(1);
    expect(r.gh).toContain('issue create');
  });

  it('run sana: exit 0 e tentativo di chiusura della issue sul titolo esatto', () => {
    const r = runGate('clean', { field: 0.1, lab: 0.1 });
    expect(r.status, r.stdout).toBe(0);
    expect(r.gh).toContain(`issue list --state open --search in:title "${CLS_REGRESSION_ISSUE_TITLE}"`);
    expect(r.gh).not.toContain('issue create');
    expect(r.output).toContain('hard_regressions=0');
  });

  it('errore PSI bloccante (400): exit 1 come oggi, nessuna issue di monitor', () => {
    const r = runGate('psi-400', { field: 0.1, lab: 0.1, status: 400 });
    expect(r.status).toBe(1);
    expect(r.gh).toBe('');
  });
});
