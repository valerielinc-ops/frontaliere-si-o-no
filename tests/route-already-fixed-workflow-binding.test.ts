// Osservatore della scheda LC-27. Titolo di fallimento se questi casi tornano
// rossi: «already-fixed instradato con una run di un workflow diverso da quello
// del guasto».
//
// Caso reale: la issue 7421 (`CI Failure: cathedral-seo-gates-check`) e la 10731
// hanno ricevuto `maybe-resolved` + `ALREADY_FIXED_ROUTED` citando la run
// 36841197125, una run `tests`, mentre sulla STESSA SHA la run del workflow
// interessato (36841197066) era fallita. Dopo il legame per i soli timeout
// (#10878) lo stesso difetto si e' ripetuto su 11178 (`CI Failure: Loop fleet
// independent lifecycle observer`, corpo del reporter generico, senza la firma
// dello scanner): prova = run `tests.yml` creata PRIMA della issue.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  failureReportBinding,
  timeoutReportSourceRun,
  verifyEvidence,
} from '../scripts/ci/route-already-fixed.mjs';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const FIX_SHA = 'f44c0bb2fb691b84d3a75e4f0d48dfb3b5cf0dde';
const RUN_HEAD = 'b'.repeat(40);
const runUrl = (id: number | string, repo = REPO) => `https://github.com/${repo}/actions/runs/${id}`;

// Corpo reale della 7421 (report dello scanner dei timeout).
const BODY_7421_TIMEOUT = [
  '**Workflow:** cathedral-seo-gates-check',
  '',
  '## Job cancellati per timeout',
  '',
  `**Run:** ${runUrl(33919268604)}`,
  '**Trigger:** push',
  '**Ref:** main',
  '',
  '### Job 1: check',
  '**Motivo:** The job has exceeded the maximum execution time of 3h0m0s',
  '',
  'Rilevato da `scripts/ci/scan-job-timeouts.mjs` (scan periodico, non dal workflow stesso).',
].join('\n');

// Forma del reporter generico (`report-workflow-failure`), senza firma dello scanner.
const BODY_REPORTER_CATHEDRAL = [
  '**Workflow:** cathedral-seo-gates-check',
  '',
  `**Run:** ${runUrl(36841197066)}`,
  '**Branch:** main',
  '**Trigger:** push',
].join('\n');

// Corpo reale della 11178 (osservatore delle run silenziose).
const BODY_11178 = [
  '**Workflow:** Loop fleet independent lifecycle observer',
  '',
  'Il workflow `Loop fleet independent lifecycle observer` è uscito `failure` e **nessuno step interno l\'ha segnalato**.',
  '',
  `- run: ${runUrl(37126966010)}`,
  '- event: `schedule` · branch: `main`',
  '',
  'Job falliti:',
  '- `observe` — step: `Observe PR, Actions and post-merge evidence`',
  `  ${runUrl(37126966010)}/job/111214109430`,
].join('\n');

describe('failureReportBinding (pura)', () => {
  it('titoli `Workflow|CI Failure` in tutte le forme → legame obbligatorio con la prima run del corpo', () => {
    expect(failureReportBinding('CI Failure: cathedral-seo-gates-check', BODY_REPORTER_CATHEDRAL, REPO))
      .toMatchObject({ required: true, runId: 36841197066 });
    expect(failureReportBinding('Workflow Failure: Refresh Plate Auctions', `**Run:** ${runUrl(34904486750)}`, REPO))
      .toMatchObject({ required: true, runId: 34904486750 });
    expect(failureReportBinding('CI Failure (build): Deploy to GitHub Pages', `**Run:** ${runUrl(35397312111)}`, REPO))
      .toMatchObject({ required: true, runId: 35397312111 });
    expect(failureReportBinding('CI Failure: Loop fleet independent lifecycle observer', BODY_11178, REPO))
      .toMatchObject({ required: true, runId: 37126966010 });
    // Piu' run citate: la prima del corpo, come per i timeout.
    const two = `- **Run:** ${runUrl(111)} (attempt 1)\nRicorrenza: ${runUrl(222)}`;
    expect(failureReportBinding('Workflow Failure: live-data gates', two, REPO)).toMatchObject({ required: true, runId: 111 });
  });

  it('nessuna run leggibile dello stesso repo → legame obbligatorio ma non verificabile', () => {
    expect(failureReportBinding('Workflow Failure: X', 'nessun link alle run', REPO))
      .toEqual({ required: true, runId: null, reason: 'run-originaria-assente' });
    expect(failureReportBinding('CI Failure: X', `**Run:** ${runUrl(36988228462, 'other/repo')}`, REPO))
      .toEqual({ required: true, runId: null, reason: 'run-originaria-repo-diverso' });
  });

  it('`Crawler Failure: Run <slug>` → run del corpus: mai verificabile da qui', () => {
    const body = `**Run:** ${runUrl(36988228462, 'nanakokyobashi-rgb/frontaliere-articles')}`;
    expect(failureReportBinding('Crawler Failure: Run kone', body, REPO))
      .toEqual({ required: true, runId: null, reason: 'crawler-run-cross-repo' });
  });

  it('il corpo dello scanner dei timeout conserva il comportamento di oggi, qualunque sia il titolo', () => {
    for (const title of ['CI Failure: cathedral-seo-gates-check', 'titolo qualunque', undefined]) {
      expect(failureReportBinding(title, BODY_7421_TIMEOUT, REPO))
        .toMatchObject(timeoutReportSourceRun(BODY_7421_TIMEOUT, REPO));
    }
    expect(failureReportBinding('CI Failure: x', BODY_7421_TIMEOUT, 'another/repo'))
      .toMatchObject({ required: true, runId: null, reason: 'run-originaria-repo-diverso' });
  });

  it('issue che non e\' di failure → nessun legame (invariante)', () => {
    for (const title of ['follow-up: qualcosa', 'Validation Failure (dist): post-deploy', 'Conflitto con main: riapplicare la PR #10467 su main']) {
      expect(failureReportBinding(title, `vedi ${runUrl(36841197125)}`, REPO)).toMatchObject({ required: false, runId: null });
    }
  });
});

describe('verifyEvidence: la run citata deve essere successiva alla issue', () => {
  const ev = { pr: 10727, commit: FIX_SHA, run: 36841197125 };
  const deps = (createdAt: unknown) => ({
    currentRunId: 1,
    pr: () => ({ state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: FIX_SHA } }),
    run: () => ({
      status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: RUN_HEAD,
      path: '.github/workflows/cathedral-seo-gates-check.yml', created_at: createdAt,
    }),
    compare: () => 'ahead',
  });

  it('run creata prima dell apertura → ok:false run-<id>-precedente-alla-issue', () => {
    expect(verifyEvidence(ev, { ...deps('2026-10-01T09:12:23Z'), issueCreatedAt: '2026-10-01T09:24:55Z' })).toEqual({
      ok: false, reason: 'run-36841197125-precedente-alla-issue',
    });
  });

  it('run creata dopo l apertura → ok', () => {
    expect(verifyEvidence(ev, { ...deps('2026-10-02T20:06:00Z'), issueCreatedAt: '2026-09-05T00:21:07Z' }))
      .toMatchObject({ ok: true, fixSha: FIX_SHA });
  });

  it('fail-closed: data della run o della issue illeggibile', () => {
    expect(verifyEvidence(ev, { ...deps(undefined), issueCreatedAt: '2026-09-05T00:21:07Z' }).ok).toBe(false);
    expect(verifyEvidence(ev, { ...deps('2026-10-02T20:06:00Z'), issueCreatedAt: null }).ok).toBe(false);
    expect(verifyEvidence(ev, { ...deps('2026-10-02T20:06:00Z'), issueCreatedAt: 'non-una-data' }).ok).toBe(false);
  });

  it('senza issueCreatedAt il controllo non si applica (chiamanti esistenti)', () => {
    expect(verifyEvidence(ev, deps('2020-01-01T00:00:00Z')).ok).toBe(true);
    expect(verifyEvidence(ev, deps(undefined)).ok).toBe(true);
  });
});

// Replay della CLI con un `gh` finto in PATH: le chiamate reali dello script.
describe('CLI: issue di failure (gh finto)', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/ci/route-already-fixed.mjs', import.meta.url));
  const FAKE_GH = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
    "const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));",
    "if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(fx.issue));",
    "else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify(fx.pr));",
    "else if (args[0] === 'api' && args[1].includes('/actions/runs/')) {",
    "  const id = /\\/actions\\/runs\\/(\\d+)/.exec(args[1])?.[1];",
    "  if (!fx.runs[id]) { process.stderr.write('HTTP 404'); process.exit(1); }",
    '  process.stdout.write(JSON.stringify(fx.runs[id]));',
    '}',
    "else if (args[0] === 'api' && args[1].includes('/compare/')) process.stdout.write('ahead\\n');",
    '',
  ].join('\n');

  const RUN_STARTED = '2026-10-01T10:00:00.000Z';
  const outcome = (run: number) => ({
    body: [
      '<!-- FIX_OUTCOME: already-fixed -->',
      `<!-- FIX_EVIDENCE: pr=10727 commit=${FIX_SHA} run=${run} -->`,
      '',
      'La correzione e\' gia\' su main.',
    ].join('\n'),
    createdAt: '2026-10-01T10:07:08Z',
    author: { login: 'frontaliere-automation' },
    authorAssociation: 'CONTRIBUTOR',
  });
  const green = (workflow: string, createdAt: string) => ({
    status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: FIX_SHA,
    path: `.github/workflows/${workflow}`, created_at: createdAt,
  });
  const RUNS = {
    // Le run originarie, fallite.
    33919268604: { status: 'completed', conclusion: 'cancelled', head_branch: 'main', head_sha: 'e'.repeat(40), path: '.github/workflows/cathedral-seo-gates-check.yml', created_at: '2026-09-04T21:03:23Z' },
    36841197066: { status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: FIX_SHA, path: '.github/workflows/cathedral-seo-gates-check.yml', created_at: '2026-10-01T09:12:23Z' },
    37126966010: { status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'c'.repeat(40), path: '.github/workflows/loop-fleet-lifecycle-observer.yml', created_at: '2026-10-03T13:40:15Z' },
    // La prova citata davvero: una run `tests` verde.
    36841197125: green('tests.yml', '2026-10-01T09:12:23Z'),
    // Una run verde del workflow del guasto, dopo e prima dell'apertura.
    36900000001: green('cathedral-seo-gates-check.yml', '2026-10-02T20:06:00Z'),
    36800000001: green('cathedral-seo-gates-check.yml', '2026-09-01T08:00:00Z'),
    37130952348: green('tests.yml', '2026-10-03T14:48:35Z'),
  };

  function runCli({ title, body, createdAt, evidenceRun }: { title: string; body: string; createdAt: string; evidenceRun: number }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'route-already-fixed-binding-'));
    try {
      const gh = path.join(dir, 'gh');
      writeFileSync(gh, FAKE_GH);
      chmodSync(gh, 0o755);
      const log = path.join(dir, 'gh.log');
      writeFileSync(log, '');
      const fixture = path.join(dir, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({
        issue: {
          title, body, createdAt, state: 'OPEN',
          labels: [{ name: 'agent:fix' }, { name: 'agent:triaged' }],
          comments: [outcome(evidenceRun)],
        },
        pr: { state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: FIX_SHA } },
        runs: RUNS,
      }));
      const baselineFile = path.join(dir, 'baseline.json');
      writeFileSync(baselineFile, JSON.stringify({ runStartedAt: RUN_STARTED }));
      const evidenceFile = path.join(dir, 'evidence.json');
      writeFileSync(evidenceFile, JSON.stringify({ status: 'verified-none', reason: null, prNumber: null }));
      const res = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
          FAKE_GH_LOG: log,
          FAKE_GH_FIXTURE: fixture,
          REPO,
          ISSUE: '7421',
          GITHUB_RUN_ID: '36850000000',
          GITHUB_OUTPUT: '',
          IS_GROUP: 'false',
          DAILY_ITEM_ID: '',
          PR_DELIVERY_BASELINE_FILE: baselineFile,
          PR_DELIVERY_EVIDENCE_FILE: evidenceFile,
        },
      });
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
      const mutations = calls.filter((a) => a[0] === 'issue' && (a[1] === 'edit' || a[1] === 'comment' || a[1] === 'close'));
      return { status: res.status, stdout: res.stdout, calls, mutations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Il corpo del reporter cita la run fallita 36841197066 (10-01 09:12Z): la issue
  // si apre subito dopo. La 7421 reale (corpo dello scanner dei timeout) e' del
  // 09-05, dopo la sua run originaria 33919268604.
  const CATHEDRAL = { title: 'CI Failure: cathedral-seo-gates-check', body: BODY_REPORTER_CATHEDRAL, createdAt: '2026-10-01T09:24:55Z' };
  const CATHEDRAL_TIMEOUT = { ...CATHEDRAL, body: BODY_7421_TIMEOUT, createdAt: '2026-09-05T00:21:07Z' };

  it('replay 7421 (corpo del reporter): una run `tests` verde non prova il guasto di cathedral', () => {
    const r = runCli({ ...CATHEDRAL, evidenceRun: 36841197125 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('routed=false');
    expect(r.stdout).toContain(
      'evidenza non verificata (run-36841197125-workflow-diverso:.github/workflows/tests.yml-atteso:.github/workflows/cathedral-seo-gates-check.yml)',
    );
    expect(r.mutations).toEqual([]);
  });

  it('replay 7421: una run verde di cathedral successiva alla issue → instradata', () => {
    const r = runCli({ ...CATHEDRAL, evidenceRun: 36900000001 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('routed=true');
    expect(r.mutations.find((a) => a[1] === 'edit')).toEqual([
      'issue', 'edit', '7421', '--repo', REPO, '--add-label', 'maybe-resolved', '--remove-label', 'agent:fix',
    ]);
    expect(r.mutations.some((a) => a[1] === 'close')).toBe(false);
  });

  it('run verde del workflow giusto ma creata PRIMA della issue → nessuna mutazione', () => {
    const r = runCli({ ...CATHEDRAL, evidenceRun: 36800000001 });
    expect(r.stdout).toContain('routed=false');
    expect(r.stdout).toContain('run-36800000001-precedente-alla-issue');
    expect(r.mutations).toEqual([]);
  });

  it('replay 7421 col corpo reale dello scanner dei timeout: stesso esito di oggi', () => {
    const wrong = runCli({ ...CATHEDRAL_TIMEOUT, evidenceRun: 36841197125 });
    expect(wrong.stdout).toContain('workflow-diverso:.github/workflows/tests.yml');
    expect(wrong.mutations).toEqual([]);
    const right = runCli({ ...CATHEDRAL_TIMEOUT, evidenceRun: 36900000001 });
    expect(right.stdout).toContain('routed=true');
  });

  it('replay 11178 (dopo #10878): run `tests` creata prima della issue → nessuna mutazione', () => {
    const r = runCli({
      title: 'CI Failure: Loop fleet independent lifecycle observer', body: BODY_11178,
      createdAt: '2026-10-03T16:44:31Z', evidenceRun: 37130952348,
    });
    expect(r.stdout).toContain('routed=false');
    expect(r.stdout).toContain('workflow-diverso:.github/workflows/tests.yml-atteso:.github/workflows/loop-fleet-lifecycle-observer.yml');
    expect(r.mutations).toEqual([]);
  });

  it('`Workflow Failure: X` senza run nel corpo → nessuna mutazione e nessuna lettura di run', () => {
    const r = runCli({ title: 'Workflow Failure: X', body: 'Il workflow e\' fallito.', createdAt: '2026-09-05T00:21:07Z', evidenceRun: 36900000001 });
    expect(r.stdout).toContain('workflow originario non verificabile (run-originaria-assente)');
    expect(r.mutations).toEqual([]);
    expect(r.calls.some((a) => a[0] === 'api' && a[1].includes('/actions/runs/'))).toBe(false);
  });

  it('`Crawler Failure: Run kone` → nessuna mutazione (run nel corpus)', () => {
    const r = runCli({
      title: 'Crawler Failure: Run kone',
      body: `**Run:** ${runUrl(36988228462, 'nanakokyobashi-rgb/frontaliere-articles')}`,
      createdAt: '2026-09-05T00:21:07Z', evidenceRun: 36900000001,
    });
    expect(r.stdout).toContain('crawler-run-cross-repo');
    expect(r.mutations).toEqual([]);
  });

  it('issue che non e\' di failure: comportamento di oggi (nessun legame, nessun controllo di data)', () => {
    const r = runCli({
      title: 'Conflitto con main: riapplicare la PR #10467 su main',
      body: `Contesto: ${runUrl(36841197066)}`,
      createdAt: '2026-10-01T09:24:55Z', evidenceRun: 36841197125,
    });
    expect(r.stdout).toContain('routed=true');
    expect(r.calls.some((a) => a[0] === 'api' && a[1].endsWith('/actions/runs/36841197066'))).toBe(false);
  });
});
