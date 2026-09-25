import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decideAlreadyFixedRouting,
  parseFixEvidence,
  routedCommentBody,
  routingEditArgs,
  verifyEvidence,
} from '../scripts/ci/route-already-fixed.mjs';
import { validateWorkflowText } from '../scripts/ci/validate-modified-workflows.mjs';

const workflow = readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');

const RUN_STARTED = '2026-09-24T16:55:31Z';
const FIX_SHA = '899f710d2530cfab789828e6935b015165e024d7';
const RUN_HEAD = 'a'.repeat(40);

// Forma reale del commento #8061 (run 36030725501), con il marker strutturato
// che il prompt ora richiede.
const alreadyFixedBody = (evidence = `<!-- FIX_EVIDENCE: pr=9215 commit=${FIX_SHA} run=35435111061 -->`) => [
  '<!-- FIX_OUTCOME: already-fixed -->',
  evidence,
  '',
  'Verifica completata sul checkout corrente: il comportamento richiesto è già presente.',
].join('\n');

const comment = (body: string, createdAt = '2026-09-24T17:07:07Z', login = 'frontaliere-automation', assoc = 'CONTRIBUTOR') => ({
  body, createdAt, author: { login }, authorAssociation: assoc,
});

const base = (comments: unknown[]) => ({
  comments: comments as never,
  runStartedAt: RUN_STARTED,
  deliveryStatus: 'verified-none',
});

describe('parseFixEvidence', () => {
  it('legge pr, commit e run dal marker', () => {
    expect(parseFixEvidence(alreadyFixedBody())).toEqual({
      status: 'ok', evidence: { pr: 9215, commit: FIX_SHA, run: 35435111061 },
    });
    expect(parseFixEvidence('<!-- FIX_EVIDENCE: pr=#12 run=7 -->')).toEqual({
      status: 'ok', evidence: { pr: 12, commit: null, run: 7 },
    });
  });

  it('marker assente = missing (comportamento attuale)', () => {
    expect(parseFixEvidence('<!-- FIX_OUTCOME: already-fixed -->\nprosa con PR #9215 e run 35435111061')).toEqual({ status: 'missing' });
  });

  it.each([
    ['run mancante', '<!-- FIX_EVIDENCE: pr=12 -->'],
    ['pr e commit mancanti', '<!-- FIX_EVIDENCE: run=7 -->'],
    ['placeholder', '<!-- FIX_EVIDENCE: pr=<N> commit=<sha> run=<id> -->'],
    ['chiave ignota', '<!-- FIX_EVIDENCE: pr=12 run=7 note=ok -->'],
    ['chiave duplicata', '<!-- FIX_EVIDENCE: pr=12 pr=13 run=7 -->'],
    ['sha non hex', '<!-- FIX_EVIDENCE: commit=zzzzzzz run=7 -->'],
  ])('non valido: %s', (_name, body) => {
    expect(parseFixEvidence(body).status).not.toBe('ok');
  });
});

describe('decideAlreadyFixedRouting (classificazione dell esito)', () => {
  it('already-fixed con evidenza strutturata in questa run → verify', () => {
    expect(decideAlreadyFixedRouting(base([comment(alreadyFixedBody())]))).toEqual({
      action: 'verify', evidence: { pr: 9215, commit: FIX_SHA, run: 35435111061 },
    });
  });

  it('already-fixed senza evidenza → none (agent:fix resta come oggi)', () => {
    const d = decideAlreadyFixedRouting(base([comment('<!-- FIX_OUTCOME: already-fixed -->\nprosa')]));
    expect(d).toEqual({ action: 'none', reason: 'evidenza-strutturata-assente' });
  });

  it('esiti diversi da already-fixed → none', () => {
    for (const code of ['pr-created', 'no-root-cause', 'blocked-secrets']) {
      const d = decideAlreadyFixedRouting(base([comment(`<!-- FIX_OUTCOME: ${code} -->\n<!-- FIX_EVIDENCE: pr=1 run=2 -->`)]));
      expect(d.action).toBe('none');
    }
  });

  it('conta solo l ULTIMO FIX_OUTCOME della run corrente', () => {
    const older = comment(alreadyFixedBody(), '2026-09-20T10:00:00Z');
    expect(decideAlreadyFixedRouting(base([older])).action).toBe('none');
    const superseded = [
      comment(alreadyFixedBody(), '2026-09-24T17:00:00Z'),
      comment('<!-- FIX_OUTCOME: no-root-cause -->', '2026-09-24T17:05:00Z'),
    ];
    expect(decideAlreadyFixedRouting(base(superseded))).toEqual({ action: 'none', reason: 'outcome=no-root-cause' });
  });

  it('fail-closed su delivery non verified-none, gruppo, baseline o autore', () => {
    const c = [comment(alreadyFixedBody())];
    expect(decideAlreadyFixedRouting({ ...base(c), deliveryStatus: 'verified-delivery' }).action).toBe('none');
    expect(decideAlreadyFixedRouting({ ...base(c), deliveryStatus: null }).action).toBe('none');
    expect(decideAlreadyFixedRouting({ ...base(c), isGroup: true }).action).toBe('none');
    expect(decideAlreadyFixedRouting({ ...base(c), runStartedAt: null }).action).toBe('none');
    expect(decideAlreadyFixedRouting({ ...base(c), runStartedAt: 'non-una-data' }).action).toBe('none');
    expect(decideAlreadyFixedRouting(base([comment(alreadyFixedBody(), undefined, 'drive-by', 'NONE')])).action).toBe('none');
    expect(decideAlreadyFixedRouting(base([comment(alreadyFixedBody(), undefined, 'valerielinc-ops', 'OWNER')])).action).toBe('verify');
  });

  it('riconosce il bot anche nella forma REST con suffisso [bot]', () => {
    const c = [comment(alreadyFixedBody(), undefined, 'frontaliere-automation[bot]', 'NONE')];
    expect(decideAlreadyFixedRouting(base(c)).action).toBe('verify');
  });

  it('confronta i tempi come istanti: baseline canonico `.000Z` e createdAt al secondo', () => {
    // `pr-delivery-evidence.mjs` canonicalizza runStartedAt con toISOString().
    const started = '2026-09-24T16:55:31.000Z';
    const sameSecond = [comment(alreadyFixedBody(), '2026-09-24T16:55:31Z')];
    expect(decideAlreadyFixedRouting({ ...base(sameSecond), runStartedAt: started }).action).toBe('verify');
    const before = [comment(alreadyFixedBody(), '2026-09-24T16:55:30Z')];
    expect(decideAlreadyFixedRouting({ ...base(before), runStartedAt: started })).toEqual({
      action: 'none', reason: 'nessun-FIX_OUTCOME-in-questa-run',
    });
  });
});

describe('verifyEvidence', () => {
  const okDeps = () => ({
    currentRunId: 36030725501,
    pr: () => ({ state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: FIX_SHA } }),
    run: () => ({ status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: RUN_HEAD, path: '.github/workflows/tests.yml' }),
    compare: () => 'ahead',
  });
  const ev = { pr: 9215, commit: FIX_SHA, run: 35435111061 };

  it('PR mergiata + fix su main + run verde che la contiene → ok', () => {
    expect(verifyEvidence(ev, okDeps())).toEqual({ ok: true, fixSha: FIX_SHA, runHeadSha: RUN_HEAD });
    expect(verifyEvidence({ ...ev, commit: null }, okDeps())).toMatchObject({ ok: true, fixSha: FIX_SHA });
  });

  it.each([
    ['PR aperta', { pr: () => ({ state: 'OPEN', baseRefName: 'main', mergeCommit: null }) }],
    ['fix non su main', { compare: () => 'diverged' }],
    ['run rossa', { run: () => ({ status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: RUN_HEAD, path: 'x' }) }],
    ['run su un branch', { run: () => ({ status: 'completed', conclusion: 'success', head_branch: 'fix/issue-1', head_sha: RUN_HEAD, path: 'x' }) }],
    ['run del fixer', { run: () => ({ status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: RUN_HEAD, path: '.github/workflows/issue-fix.yml' }) }],
    ['lookup non disponibile', { run: () => { throw new Error('HTTP 502'); } }],
    ['run citata = questa run', { currentRunId: 35435111061 }],
  ])('fail-closed: %s', (_name, override) => {
    expect(verifyEvidence(ev, { ...okDeps(), ...override }).ok).toBe(false);
  });

  it('run verde precedente alla fix → non la contiene', () => {
    const deps = { ...okDeps(), compare: (_b: string, head: string) => (head === 'main' ? 'ahead' : 'behind') };
    expect(verifyEvidence(ev, deps)).toMatchObject({ ok: false });
  });
});

describe('mutazione', () => {
  it('toglie solo il routing presente e aggiunge maybe-resolved', () => {
    expect(routingEditArgs(['bug', 'agent:fix', 'agent:triaged'])).toEqual(['--add-label', 'maybe-resolved', '--remove-label', 'agent:fix']);
    expect(routingEditArgs(['agent:fix-queued', 'agent:fix'])).toEqual([
      '--add-label', 'maybe-resolved', '--remove-label', 'agent:fix', '--remove-label', 'agent:fix-queued',
    ]);
  });

  it('il commento porta il marker verificabile e non chiude', () => {
    const body = routedCommentBody({ pr: 9215, commit: null, run: 35435111061 }, { fixSha: FIX_SHA, runHeadSha: RUN_HEAD });
    expect(body.split('\n')[0]).toBe(`<!-- ALREADY_FIXED_ROUTED: pr=9215 commit=${FIX_SHA} run=35435111061 -->`);
    expect(body).toContain('**Non chiudo**');
  });
});

// Replay end-to-end della CLI con un `gh` finto in PATH: la METRICA della
// scheda #9742 («una run `already-fixed` con evidenza non lascia `agent:fix` e
// produce un marker verificabile») misurata sulle chiamate reali dello script.
describe('CLI end-to-end (gh finto)', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/ci/route-already-fixed.mjs', import.meta.url));
  const FAKE_GH = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
    "const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));",
    "if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(fx.issue));",
    "else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify(fx.pr));",
    "else if (args[0] === 'api' && args[1].includes('/actions/runs/')) process.stdout.write(JSON.stringify(fx.run));",
    "else if (args[0] === 'api' && args[1].includes('/compare/')) process.stdout.write(fx.compare + '\\n');",
    '',
  ].join('\n');

  function runCli(issueComments: unknown[], delivery: unknown = { status: 'verified-none', reason: null, prNumber: null }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'route-already-fixed-'));
    try {
      const gh = path.join(dir, 'gh');
      writeFileSync(gh, FAKE_GH);
      chmodSync(gh, 0o755);
      const log = path.join(dir, 'gh.log');
      writeFileSync(log, '');
      const fixture = path.join(dir, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({
        issue: { state: 'OPEN', labels: [{ name: 'follow-up' }, { name: 'agent:fix' }, { name: 'agent:triaged' }], comments: issueComments },
        pr: { state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: FIX_SHA } },
        run: { status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: RUN_HEAD, path: '.github/workflows/tests.yml' },
        compare: 'ahead',
      }));
      const baselineFile = path.join(dir, 'baseline.json');
      writeFileSync(baselineFile, JSON.stringify({ runStartedAt: '2026-09-24T16:55:31.000Z' }));
      const evidenceFile = path.join(dir, 'evidence.json');
      writeFileSync(evidenceFile, JSON.stringify(delivery));
      const res = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
          FAKE_GH_LOG: log,
          FAKE_GH_FIXTURE: fixture,
          REPO: 'valerielinc-ops/frontaliere-si-o-no',
          ISSUE: '8061',
          GITHUB_RUN_ID: '36030725501',
          GITHUB_OUTPUT: '',
          IS_GROUP: 'false',
          PR_DELIVERY_BASELINE_FILE: baselineFile,
          PR_DELIVERY_EVIDENCE_FILE: evidenceFile,
        },
      });
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
      return { status: res.status, stdout: res.stdout, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('already-fixed con evidenza verificata → toglie agent:fix, aggiunge maybe-resolved, posta il marker', () => {
    const { status, stdout, calls } = runCli([comment(alreadyFixedBody())]);
    expect(status).toBe(0);
    expect(stdout).toContain('routed=true');
    const edit = calls.find((a) => a[0] === 'issue' && a[1] === 'edit');
    expect(edit).toEqual([
      'issue', 'edit', '8061', '--repo', 'valerielinc-ops/frontaliere-si-o-no',
      '--add-label', 'maybe-resolved', '--remove-label', 'agent:fix',
    ]);
    const posted = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(posted?.[posted.indexOf('--body') + 1].split('\n')[0])
      .toBe(`<!-- ALREADY_FIXED_ROUTED: pr=9215 commit=${FIX_SHA} run=35435111061 -->`);
    expect(calls.some((a) => a[0] === 'issue' && a[1] === 'close')).toBe(false);
  });

  it.each([
    ['evidenza assente', [comment('<!-- FIX_OUTCOME: already-fixed -->\nprosa con PR #9215')], undefined],
    ['delivery illeggibile', [comment(alreadyFixedBody())], { status: 'boh' }],
    ['PR consegnata in questa run', [comment(alreadyFixedBody())], { status: 'verified-delivery', reason: null, prNumber: 9999 }],
  ])('fail-closed senza mutazioni: %s', (_name, comments, delivery) => {
    const { status, stdout, calls } = runCli(comments, delivery);
    expect(status).toBe(0);
    expect(stdout).toContain('routed=false');
    expect(calls.filter((a) => a[0] === 'issue' && (a[1] === 'edit' || a[1] === 'comment'))).toEqual([]);
  });
});

describe('cablaggio in issue-fix.yml', () => {
  const stepStart = workflow.indexOf('- name: Route already-fixed to verification (zero-Claude)');
  const classify = workflow.indexOf('- name: Classify outcome (work-done, not CLI exit)');
  const backstop = workflow.indexOf('- name: Emit FIX_OUTCOME telemetry (deterministic backstop)');

  it('lo step esiste fra backstop e classificatore, continue-on-error, mai per i gruppi', () => {
    expect(stepStart).toBeGreaterThan(backstop);
    expect(classify).toBeGreaterThan(stepStart);
    const step = workflow.slice(stepStart, classify);
    expect(step).toMatch(/if: always\(\) && steps\.issue_snapshot\.outputs\.verified == 'true'/);
    expect(step).toContain("steps.group.outputs.is_group != 'true'");
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('scripts/ci/route-already-fixed.mjs');
  });

  it('il prompt chiede il marker FIX_EVIDENCE con già-risolto', () => {
    expect(workflow).toContain('<!-- FIX_EVIDENCE: pr=<N> commit=<sha> run=<id> -->');
  });

  it('il prompt resta entro il limite del validatore dei workflow', () => {
    // Senza margine GitHub rifiuta il workflow intero: zero job, nessun fixer.
    expect(validateWorkflowText('.github/workflows/issue-fix.yml', workflow)).toEqual([]);
  });
});
