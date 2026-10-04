import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFollowupItems, selectFirstOpenItem } from '../scripts/ci/followup-resolution-match.mjs';
import { ITEM_BLOCKED_REASONS, MAYBE_RESOLVED_RELEASE_MARKER, parseItemMarkers } from '../scripts/ci/lib/followup-item-evidence.mjs';
import { hasLiveReconcileFlag } from '../scripts/ci/reconcile-followups.mjs';
import { bucketVerdictCoverage, isTrustedMarkerAuthor } from '../scripts/ci/followup-drainer.mjs';
import {
  ITEM_BLOCKING_OUTCOMES,
  bucketLabelEditArgs,
  decideAlreadyFixedRouting,
  decideBucketItemRouting,
  isTrustedAuthor,
  outcomeOf,
  parseFixEvidence,
  routedCommentBody,
  routingEditArgs,
  timeoutReportSourceRun,
  verifyEvidence,
  workflowFileFromRunPath,
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

  it('per un timeout richiede che il run verde sia dello stesso workflow originario', () => {
    const timeoutWorkflow = '.github/workflows/assisted-application-portal-e2e.yml';
    expect(verifyEvidence(ev, { ...okDeps(), expectedWorkflowPath: timeoutWorkflow })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('workflow-diverso:.github/workflows/tests.yml'),
    });
    const matchingRun = {
      ...okDeps(),
      expectedWorkflowPath: timeoutWorkflow,
      run: () => ({
        status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: RUN_HEAD,
        path: `${timeoutWorkflow}@refs/heads/main`,
      }),
    };
    expect(verifyEvidence(ev, matchingRun).ok).toBe(true);
  });
});

describe('timeout issue workflow binding', () => {
  const body = [
    '**Workflow:** Assisted application portal e2e',
    '',
    '**Run:** https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/36893541451',
    '',
    'Rilevato da `scripts/ci/scan-job-timeouts.mjs`.',
  ].join('\n');

  it('estrae il run sorgente dai report del timeout e riconosce i report ordinari', () => {
    expect(timeoutReportSourceRun(body, 'valerielinc-ops/frontaliere-si-o-no')).toEqual({
      required: true, runId: 36893541451,
    });
    expect(timeoutReportSourceRun(body, 'another/repo')).toEqual({
      required: true, runId: null, reason: 'run-originaria-repo-diverso',
    });
    expect(timeoutReportSourceRun('ordinary bug report', 'valerielinc-ops/frontaliere-si-o-no')).toEqual({
      required: false, runId: null,
    });
    expect(workflowFileFromRunPath('.github/workflows/tests.yml@refs/heads/main'))
      .toBe('.github/workflows/tests.yml');
    expect(workflowFileFromRunPath('../tests.yml')).toBeNull();
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
    // Il file di `--body-file` sparisce a fine script: nel log entra il contenuto.
    "const bf = args.indexOf('--body-file');",
    "const logged = bf === -1 ? args : args.map((a, i) => (i === bf + 1 ? fs.readFileSync(a, 'utf8') : a));",
    "fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(logged) + '\\n');",
    "const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));",
    // La rilettura prima della scrittura chiede titolo, corpo, stato e label;
    // dopo l'edit label il fixture simula lo stato autorevole successivo.
    "const reread = args[0] === 'issue' && args[1] === 'view' && !args[args.indexOf('--json') + 1].includes('comments');",
    "if (reread && fx.issueReread) process.stdout.write(JSON.stringify(fx.issueReread));",
    "else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(fx.issue));",
    "else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify(fx.pr));",
    "else if (args[0] === 'api' && args[1].includes('/actions/runs/')) { const id = /\\/actions\\/runs\\/(\\d+)/.exec(args[1])?.[1]; process.stdout.write(JSON.stringify(fx.runs?.[id] || fx.run)); }",
    "else if (args[0] === 'api' && args[1].includes('/compare/')) process.stdout.write(fx.compare + '\\n');",
    "else if (args[0] === 'issue' && args[1] === 'edit') { if (process.env.FAKE_GH_LABEL_EDIT_FAIL === '1' && !args.includes('--body-file')) process.exit(1); if (args.includes('--body-file')) fx.issue.body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'); for (let i = 0; i < args.length; i++) { if (args[i] === '--remove-label') fx.issue.labels = fx.issue.labels.filter((label) => label.name !== args[i + 1]); if (args[i] === '--add-label' && !fx.issue.labels.some((label) => label.name === args[i + 1])) fx.issue.labels.push({ name: args[i + 1] }); } fs.writeFileSync(process.env.FAKE_GH_FIXTURE, JSON.stringify(fx)); }",
    '',
  ].join('\n');

  function runCli(
    issueComments: unknown[],
    delivery: unknown = { status: 'verified-none', reason: null, prNumber: null },
    issueBody = '',
    bucket: { title?: string; labels?: string[]; itemId?: string; reread?: unknown; prFiles?: string[]; failLabelEdit?: boolean } = {},
  ) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'route-already-fixed-'));
    try {
      const gh = path.join(dir, 'gh');
      writeFileSync(gh, FAKE_GH);
      chmodSync(gh, 0o755);
      const log = path.join(dir, 'gh.log');
      writeFileSync(log, '');
      const fixture = path.join(dir, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({
        issue: {
          state: 'OPEN',
          body: issueBody,
          ...(bucket.title ? { title: bucket.title } : {}),
          labels: (bucket.labels ?? ['follow-up', 'agent:fix', 'agent:triaged']).map((name) => ({ name })),
          comments: issueComments,
        },
        ...(bucket.reread ? { issueReread: bucket.reread } : {}),
        pr: {
          state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: FIX_SHA },
          files: (bucket.prFiles ?? []).map((file) => ({ path: file })),
        },
        run: { status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: RUN_HEAD, path: '.github/workflows/tests.yml' },
        runs: {
          '36893541451': {
            status: 'completed', conclusion: 'cancelled', head_branch: 'test-portal', head_sha: FIX_SHA,
            path: '.github/workflows/assisted-application-portal-e2e.yml@refs/pull/1/merge',
          },
        },
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
          FAKE_GH_LABEL_EDIT_FAIL: bucket.failLabelEdit ? '1' : '0',
          REPO: 'valerielinc-ops/frontaliere-si-o-no',
          ISSUE: '8061',
          GITHUB_RUN_ID: '36030725501',
          GITHUB_OUTPUT: '',
          IS_GROUP: 'false',
          DAILY_ITEM_ID: bucket.itemId ?? '',
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

  it('un run tests verde non vale come prova per una issue di timeout E2E portal', () => {
    const issueBody = [
      '**Workflow:** Assisted application portal e2e',
      '',
      '**Run:** https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/36893541451',
      '',
      'Rilevato da `scripts/ci/scan-job-timeouts.mjs`.',
    ].join('\n');
    const { status, stdout, calls } = runCli([comment(alreadyFixedBody())], undefined, issueBody);
    expect(status).toBe(0);
    expect(stdout).toContain('workflow-diverso:.github/workflows/tests.yml');
    expect(stdout).toContain('routed=false');
    expect(calls.some((a) => a[0] === 'issue' && (a[1] === 'edit' || a[1] === 'comment'))).toBe(false);
    expect(calls.some((a) => a[0] === 'api' && a[1].endsWith('/actions/runs/36893541451'))).toBe(true);
  });

  // Bucket giornalieri: lo step lavora sull'ITEM selezionato, non sull'intera issue.
  // Titolo di fallimento se questi casi tornano rossi: «Bucket follow-up: lo stesso
  // item riceve più di un `already-fixed` senza uscire dalla selezione».
  describe('bucket giornaliero: grana item (gh finto)', () => {
    const DAY = '2026-10-03';
    const FIRST = `FU-${DAY}-001`;
    const SECOND = `FU-${DAY}-002`;
    const TARGET = 'scripts/lib/ipersonal-spec-runtime.mjs';
    const REPO = 'valerielinc-ops/frontaliere-si-o-no';
    const item = (id: string, state: string, extra: string[] = []) => [
      `### ${id} — residuo ${id.slice(-3)}`,
      `- State: ${state}`,
      '- Sources: PR #10673; PR body `## Non implementato (ancora)`',
      `- Target repository: ${REPO}`,
      `- Target file: \`${TARGET}\``,
      '- Suggested action: estendere `assertCompleteIpersonalSnapshot()` e coprirlo in `tests/ipersonal-spec-runtime.test.ts`.',
      '- Acceptance token: `assertCompleteIpersonalSnapshot()`',
      ...extra,
      '',
    ].join('\n');
    const bucketBody = (...items: string[]) => [
      '## Batch',
      `- Daily key: ${DAY} (Europe/Zurich)`,
      '- State: sealed',
      `- Target repository: ${REPO}`,
      '',
      '## Item',
      '',
      ...items,
    ].join('\n');
    const title = (count: number) => `follow-up(daily:${DAY}): ${count} items — ${REPO}`;
    const QUEUED = ['follow-up', 'agent:fix', 'agent:fix-queued', 'maybe-resolved'];
    const stateOf = (body: string, id: string) => parseFollowupItems(body).find((entry) => entry.id === id)?.state;
    const doneCount = (body: string) => parseFollowupItems(body).filter((entry) => entry.state === 'done').length;
    const edits = (calls: string[][]) => calls.filter((a) => a[0] === 'issue' && a[1] === 'edit');
    const writtenBody = (calls: string[][]) => {
      const call = edits(calls).find((a) => a.includes('--body-file'));
      return call ? call[call.indexOf('--body-file') + 1] : null;
    };
    const labelArgs = (calls: string[][]) => edits(calls).find((a) => !a.includes('--body-file'))?.slice(5) ?? [];
    const postedComments = (calls: string[][]) => calls
      .filter((a) => a[0] === 'issue' && a[1] === 'comment')
      .map((a) => a[a.indexOf('--body') + 1]);
    const trusted = (body: string) => [{ body, author: { login: 'frontaliere-automation' }, authorAssociation: 'NONE' }];
    const priorAttempt = (login = 'frontaliere-automation', assoc = 'NONE') => comment(
      `<!-- FU_ITEM_ATTEMPT: item=${FIRST} outcome=already-fixed run=36000000001 -->`,
      '2026-09-24T10:00:00Z', login, assoc,
    );

    it('due item, evidenza verificata sul Target file → primo `blocked`, coda conservata, il fixer passa al secondo', () => {
      const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
      const { stdout, calls } = runCli([comment(alreadyFixedBody())], undefined, body, {
        title: title(2), labels: QUEUED, itemId: FIRST, prFiles: [TARGET, 'README.md'],
      });
      expect(stdout).toContain('routed=true');
      const next = writtenBody(calls) as string;
      expect(stateOf(next, FIRST)).toBe('blocked');
      expect(stateOf(next, SECOND)).toBe('open');
      expect(selectFirstOpenItem(next)?.id).toBe(SECOND);
      expect(doneCount(next)).toBe(0);
      // Restano item aperti: niente `maybe-resolved` (quello residuo va via) e la
      // coda non viene tolta.
      expect(labelArgs(calls)).toEqual(['--remove-label', 'agent:fix', '--remove-label', 'maybe-resolved']);
      const posted = postedComments(calls);
      expect(posted).toHaveLength(1);
      expect(posted[0].split('\n')[0]).toBe(`<!-- ALREADY_FIXED_ROUTED: pr=9215 commit=${FIX_SHA} run=35435111061 -->`);
      expect(posted[0]).toContain(MAYBE_RESOLVED_RELEASE_MARKER);
      expect(posted[0]).toContain('in attesa di verifica esplicita: la terna prova che la PR esiste, non che l\'item sia risolto');
      const markers = parseItemMarkers(trusted(posted[0]), { isTrusted: isTrustedAuthor });
      expect(markers).toEqual([
        { type: 'attempt', item: FIRST, outcome: 'already-fixed', run: 36030725501, createdAt: null },
        { type: 'evidence', item: FIRST, pr: 9215, commit: FIX_SHA, run: 35435111061, link: 'target-file', createdAt: null },
        { type: 'blocked', item: FIRST, reason: 'awaiting-verification', createdAt: null },
      ]);
      expect(calls.some((a) => a[0] === 'issue' && a[1] === 'close')).toBe(false);
    });

    it('rimozione label fallita → posta solo i marker dell’item e conserva il flag precedente', () => {
      const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
      const priorFlag = comment('<!-- reconcile-bot:flag -->\n🤖 **Reconcile (auto)**');
      const { calls } = runCli([priorFlag, comment(alreadyFixedBody())], undefined, body, {
        title: title(2), labels: QUEUED, itemId: FIRST, prFiles: [TARGET], failLabelEdit: true,
      });
      const posted = postedComments(calls);
      expect(posted).toHaveLength(1);
      expect(posted[0]).not.toContain(MAYBE_RESOLVED_RELEASE_MARKER);
      expect(hasLiveReconcileFlag([
        priorFlag,
        { body: posted[0], author: { login: 'frontaliere-automation' }, authorAssociation: 'NONE' },
      ], { isTrusted: () => true })).toBe(true);
    });

    it('label rimossa concorrente → non la attribuisce al route step e non firma il rilascio', () => {
      const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
      const priorFlag = comment('<!-- reconcile-bot:flag -->\n🤖 **Reconcile (auto)**');
      const fresh = {
        state: 'OPEN', title: title(2), body,
        labels: [{ name: 'follow-up' }, { name: 'agent:fix-queued' }],
      };
      const { calls } = runCli([priorFlag, comment(alreadyFixedBody())], undefined, body, {
        title: title(2), labels: QUEUED, itemId: FIRST, prFiles: [TARGET], reread: fresh,
      });
      const posted = postedComments(calls);
      expect(posted).toHaveLength(1);
      expect(posted[0]).not.toContain(MAYBE_RESOLVED_RELEASE_MARKER);
      expect(labelArgs(calls)).toEqual(['--remove-label', 'agent:fix']);
      expect(hasLiveReconcileFlag([
        priorFlag,
        { body: posted[0], author: { login: 'frontaliere-automation' }, authorAssociation: 'NONE' },
      ], { isTrusted: () => true })).toBe(true);
    });

    it('senza coda e senza veti la coda viene riaggiunta; con un veto no', () => {
      expect(bucketLabelEditArgs(['follow-up', 'agent:fix'], { openRemaining: true }))
        .toEqual(['--remove-label', 'agent:fix', '--add-label', 'agent:fix-queued']);
      for (const veto of ['needs-human', 'automation-deferred', 'fu-parked', 'decomposed:1']) {
        expect(bucketLabelEditArgs(['agent:fix', veto], { openRemaining: true })).toEqual(['--remove-label', 'agent:fix']);
      }
    });

    it('unico item aperto → `blocked`, `maybe-resolved` aggiunta, nessuna coda', () => {
      const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'done'));
      const { calls } = runCli([comment(alreadyFixedBody())], undefined, body, {
        title: title(2), labels: ['follow-up', 'agent:fix', 'agent:fix-queued'], itemId: FIRST, prFiles: ['tests/ipersonal-spec-runtime.test.ts'],
      });
      const next = writtenBody(calls) as string;
      expect(stateOf(next, FIRST)).toBe('blocked');
      expect(selectFirstOpenItem(next)).toBeNull();
      expect(doneCount(next)).toBe(doneCount(body));
      expect(labelArgs(calls)).toEqual([
        '--remove-label', 'agent:fix', '--add-label', 'maybe-resolved', '--remove-label', 'agent:fix-queued',
      ]);
    });

    it('la PR di evidenza è una delle Sources dell item → link=source-pr', () => {
      const body = bucketBody(item(FIRST, 'open'));
      const evidence = `<!-- FIX_EVIDENCE: pr=10673 commit=${FIX_SHA} run=35435111061 -->`;
      const { calls } = runCli([comment(alreadyFixedBody(evidence))], undefined, body, {
        title: title(1), itemId: FIRST, prFiles: ['docs/altro.md'],
      });
      expect(stateOf(writtenBody(calls) as string, FIRST)).toBe('blocked');
      expect(postedComments(calls)[0]).toContain(`<!-- FU_ITEM_EVIDENCE: item=${FIRST} pr=10673 commit=${FIX_SHA} run=35435111061 link=source-pr -->`);
    });

    it('terna verificata ma senza legame con l item → solo FU_ITEM_ATTEMPT; alla seconda `blocked` non verificato', () => {
      const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
      const opts = { title: title(2), labels: QUEUED, itemId: FIRST, prFiles: ['scripts/altro.mjs'] };
      const first = runCli([comment(alreadyFixedBody())], undefined, body, opts);
      expect(first.stdout).toContain('routed=false');
      expect(edits(first.calls)).toEqual([]);
      expect(postedComments(first.calls)).toHaveLength(1);
      expect(parseItemMarkers(trusted(postedComments(first.calls)[0]), { isTrusted: isTrustedAuthor })).toEqual([
        { type: 'attempt', item: FIRST, outcome: 'already-fixed', run: 36030725501, createdAt: null },
      ]);

      const second = runCli([priorAttempt(), comment(alreadyFixedBody())], undefined, body, opts);
      const next = writtenBody(second.calls) as string;
      expect(stateOf(next, FIRST)).toBe('blocked');
      expect(doneCount(next)).toBe(0);
      const posted = postedComments(second.calls)[0];
      expect(posted).toContain(`<!-- FU_ITEM_BLOCKED: item=${FIRST} reason=already-fixed-unverified -->`);
      expect(posted).not.toContain('FU_ITEM_EVIDENCE');
      expect(posted).not.toContain('ALREADY_FIXED_ROUTED');
      expect(second.calls.some((a) => a[0] === 'issue' && a[1] === 'close')).toBe(false);
    });

    it('un marker di tentativo scritto da un autore non fidato non fa scattare il blocco', () => {
      const body = bucketBody(item(FIRST, 'open'));
      const { calls } = runCli([priorAttempt('drive-by', 'NONE'), comment(alreadyFixedBody())], undefined, body, {
        title: title(1), itemId: FIRST, prFiles: ['scripts/altro.mjs'],
      });
      expect(edits(calls)).toEqual([]);
    });

    it.each(['overlap-skip', 'skip-duplicate-diagnosis', 'revenue-tracker-manual', 'pr-created'])(
      'un esito fuori da ITEM_BLOCKING_OUTCOMES (%s) lascia solo il tentativo', (outcome) => {
        const body = bucketBody(item(FIRST, 'open'));
        const { calls } = runCli([comment(`<!-- FIX_OUTCOME: ${outcome} -->`)], undefined, body, { title: title(1), itemId: FIRST });
        expect(edits(calls)).toEqual([]);
        expect(postedComments(calls)[0]).toContain(`<!-- FU_ITEM_ATTEMPT: item=${FIRST} outcome=${outcome} run=36030725501 -->`);
        expect(postedComments(calls)[0]).not.toContain('FU_ITEM_BLOCKED');
      },
    );

    // FU-09b. Titolo di fallimento se questi casi tornano rossi: «Follow-up: un
    // item senza causa sospende l'intero bucket giornaliero». Forma di 9609: il
    // fixer conclude `no-root-cause` su UN item e prima l'intero bucket finiva
    // `automation-deferred`, con gli item successivi mai raggiunti.
    describe('verdetto non ritentabile sull item (no-root-cause, blocked-admin-settings)', () => {
      it('ITEM_BLOCKING_OUTCOMES è un sottoinsieme dei motivi del marker FU_ITEM_BLOCKED', () => {
        expect(ITEM_BLOCKING_OUTCOMES).toEqual(['no-root-cause', 'blocked-admin-settings']);
        for (const outcome of ITEM_BLOCKING_OUTCOMES) expect(ITEM_BLOCKED_REASONS).toContain(outcome);
      });

      it.each(ITEM_BLOCKING_OUTCOMES)('%s sul primo item → primo `blocked`, marker, coda conservata, selettore sul secondo', (outcome) => {
        const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
        const { stdout, calls } = runCli([comment(`<!-- FIX_OUTCOME: ${outcome} -->\nRoot cause non determinata.`)], undefined, body, {
          title: title(2), labels: ['follow-up', 'agent:fix', 'agent:fix-queued'], itemId: FIRST,
        });
        expect(stdout).toContain('routed=true');
        const next = writtenBody(calls) as string;
        expect(stateOf(next, FIRST)).toBe('blocked');
        expect(stateOf(next, SECOND)).toBe('open');
        expect(selectFirstOpenItem(next)?.id).toBe(SECOND);
        expect(doneCount(next)).toBe(0);
        // La coda resta: si toglie solo il trigger `agent:fix` della run finita.
        expect(labelArgs(calls)).toEqual(['--remove-label', 'agent:fix']);
        const posted = postedComments(calls);
        expect(posted).toHaveLength(1);
        expect(parseItemMarkers(trusted(posted[0]), { isTrusted: isTrustedAuthor })).toEqual([
          { type: 'attempt', item: FIRST, outcome, run: 36030725501, createdAt: null },
          { type: 'blocked', item: FIRST, reason: outcome, createdAt: null },
        ]);
        expect(posted[0]).toContain('il bucket **non** viene differito');
        expect(outcomeOf(posted[0])).toBeNull();
        expect(calls.some((a) => a[0] === 'issue' && a[1] === 'close')).toBe(false);
      });

      it('senza coda e senza veti la coda viene riaggiunta', () => {
        const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
        const { calls } = runCli([comment('<!-- FIX_OUTCOME: no-root-cause -->')], undefined, body, {
          title: title(2), labels: ['follow-up', 'agent:fix'], itemId: FIRST,
        });
        expect(stateOf(writtenBody(calls) as string, FIRST)).toBe('blocked');
        expect(labelArgs(calls)).toEqual(['--remove-label', 'agent:fix', '--add-label', 'agent:fix-queued']);
      });

      it('i veti non si allentano: `automation-deferred` già presente toglie la coda come prima', () => {
        const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
        const { calls } = runCli([comment('<!-- FIX_OUTCOME: no-root-cause -->')], undefined, body, {
          title: title(2), labels: ['follow-up', 'agent:fix', 'agent:fix-queued', 'automation-deferred'], itemId: FIRST,
        });
        expect(stateOf(writtenBody(calls) as string, FIRST)).toBe('blocked');
        const args = labelArgs(calls);
        expect(args).toEqual(['--remove-label', 'agent:fix', '--remove-label', 'agent:fix-queued']);
        expect(args).not.toContain('automation-deferred');
      });

      it.each([
        ['PR consegnata in questa run', { status: 'verified-delivery', reason: null, prNumber: 9999 }],
        ['delivery illeggibile', { status: 'boh' }],
      ])('fail-closed: %s → solo il tentativo, item invariato', (_name, delivery) => {
        const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
        const { stdout, calls } = runCli([comment('<!-- FIX_OUTCOME: no-root-cause -->')], delivery, body, {
          title: title(2), labels: QUEUED, itemId: FIRST,
        });
        expect(stdout).toContain('routed=false');
        expect(edits(calls)).toEqual([]);
        const posted = postedComments(calls);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toContain(`<!-- FU_ITEM_ATTEMPT: item=${FIRST} outcome=no-root-cause run=36030725501 -->`);
        expect(posted[0]).not.toContain('FU_ITEM_BLOCKED');
      });

      it('issue non bucket: `no-root-cause` non muta niente (comportamento invariato)', () => {
        const { stdout, calls } = runCli([comment('<!-- FIX_OUTCOME: no-root-cause -->')]);
        expect(stdout).toContain('routed=false');
        expect(calls.filter((a) => a[0] === 'issue' && (a[1] === 'edit' || a[1] === 'comment'))).toEqual([]);
      });

      it('il drainer legge il marker: il verdetto del bucket risulta coperto e non ferma la issue', () => {
        const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
        const { calls } = runCli([comment('<!-- FIX_OUTCOME: no-root-cause -->')], undefined, body, {
          title: title(2), labels: QUEUED, itemId: FIRST,
        });
        const next = writtenBody(calls) as string;
        const thread = [
          comment('<!-- FIX_OUTCOME: no-root-cause -->', '2026-09-30T11:52:16Z', 'frontaliere-automation', 'NONE'),
          comment(postedComments(calls)[0], '2026-09-30T11:58:02Z', 'github-actions', 'NONE'),
        ];
        const options = { isDailyBucket: true, hasOpenItem: selectFirstOpenItem(next) !== null, isTrusted: isTrustedMarkerAuthor };
        expect(bucketVerdictCoverage(thread, options)).toEqual({
          outcome: 'no-root-cause', covered: true, marker: { type: 'blocked', item: FIRST },
        });
        // Senza il marker dell'item il verdetto vale per l'intera issue: è il prima.
        expect(bucketVerdictCoverage(thread.slice(0, 1), options).covered).toBe(false);
      });
    });

    it.each([
      ['ID assente', '', bucketBody(item(FIRST, 'open'))],
      ['ID non nel corpo', `FU-${DAY}-009`, bucketBody(item(FIRST, 'open'))],
      ['item già done', FIRST, bucketBody(item(FIRST, 'done'), item(SECOND, 'open'))],
      ['item già blocked', FIRST, bucketBody(item(FIRST, 'blocked'), item(SECOND, 'open'))],
    ])('nessuna mutazione: %s', (_name, itemId, body) => {
      const { stdout, calls } = runCli([comment(alreadyFixedBody())], undefined, body, {
        title: title(2), labels: QUEUED, itemId, prFiles: [TARGET],
      });
      expect(stdout).toContain('routed=false');
      expect(edits(calls)).toEqual([]);
      expect(postedComments(calls)).toEqual([]);
    });

    it('corpo cambiato fra lettura e scrittura → nessuna scrittura del corpo né delle label', () => {
      const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'open'));
      const { stdout, calls } = runCli([comment(alreadyFixedBody())], undefined, body, {
        title: title(2),
        labels: QUEUED,
        itemId: FIRST,
        prFiles: [TARGET],
        reread: { state: 'OPEN', title: title(2), body: `${body}\n${item(`FU-${DAY}-003`, 'open')}` },
      });
      expect(stdout).toContain('routed=false');
      expect(edits(calls)).toEqual([]);
      expect(postedComments(calls).join('\n')).not.toContain('FU_ITEM_BLOCKED');
    });

    it('la riga METRICA dell item entra nel commento con «da rimisurare», senza poter iniettare marker', () => {
      const metric = '- METRICA: `jq length data/x.json` oggi 31, atteso 0 <!-- FU_ITEM_BLOCKED: item=FU-2026-10-03-002 reason=no-root-cause -->';
      const body = bucketBody(item(FIRST, 'open', [metric]));
      const { calls } = runCli([comment(alreadyFixedBody())], undefined, body, { title: title(1), itemId: FIRST, prFiles: [TARGET] });
      const posted = postedComments(calls)[0];
      expect(posted).toContain('METRICA dell\'item, da rimisurare: `jq length data/x.json` oggi 31, atteso 0');
      const blocked = parseItemMarkers(trusted(posted), { isTrusted: isTrustedAuthor }).filter((m) => m.type === 'blocked');
      expect(blocked.map((m) => m.item)).toEqual([FIRST]);
    });

    it('delimitatori annidati nella METRICA non ricompongono un marker nel commento del bot', () => {
      const metric = '- METRICA: conteggio <!<!---- FU_ITEM_BLOCKED: item=FU-2026-10-03-002 reason=no-root-cause ---->> <!<!---- FIX_OUTCOME: no-root-cause ---->>';
      const body = bucketBody(item(FIRST, 'open', [metric]));
      const { calls } = runCli([comment(alreadyFixedBody())], undefined, body, { title: title(1), itemId: FIRST, prFiles: [TARGET] });
      const posted = postedComments(calls)[0];
      expect(posted).toContain('METRICA dell\'item, da rimisurare: conteggio');
      const blocked = parseItemMarkers(trusted(posted), { isTrusted: isTrustedAuthor }).filter((m) => m.type === 'blocked');
      expect(blocked).toEqual([{ type: 'blocked', item: FIRST, reason: 'awaiting-verification', createdAt: null }]);
      expect(outcomeOf(posted)).toBeNull();
    });

    it('un esito che il marker di tentativo non sa serializzare non muta niente e non fa cadere lo step', () => {
      const body = bucketBody(item(FIRST, 'open'));
      const { status, stdout, calls } = runCli([comment('<!-- FIX_OUTCOME: 9-lives -->')], undefined, body, { title: title(1), itemId: FIRST });
      expect(status).toBe(0);
      expect(stdout).toContain('marker-non-componibile');
      expect(stdout).not.toContain('errore inatteso');
      expect(edits(calls)).toEqual([]);
      expect(postedComments(calls)).toEqual([]);
    });

    it('un titolo daily non interpretabile non riceve `maybe-resolved` sull intera issue', () => {
      const body = bucketBody(item(FIRST, 'open'));
      const { stdout, calls } = runCli([comment(alreadyFixedBody())], undefined, body, {
        title: `follow-up(daily:${DAY}) senza conteggio`, labels: QUEUED, itemId: FIRST, prFiles: [TARGET],
      });
      expect(stdout).toContain('routed=false');
      expect(stdout).toContain('titolo-daily-non-interpretabile');
      expect(edits(calls)).toEqual([]);
      expect(postedComments(calls)).toEqual([]);
    });

    it('nessun percorso scrive `done`: ogni decisione che blocca scrive solo `blocked`', () => {
      const body = bucketBody(item(FIRST, 'open'), item(SECOND, 'in-progress'));
      for (const itemId of [FIRST, SECOND]) {
        for (const outcome of ['already-fixed', 'no-root-cause', 'pr-created']) {
          for (const verified of [true, false]) {
            for (const link of ['target-file', 'source-pr', 'none'] as const) {
              for (const priorAlreadyFixedAttempts of [0, 1]) {
                const d = decideBucketItemRouting({
                  body, itemId, outcome, deliveryStatus: 'verified-none', verified, link, priorAlreadyFixedAttempts,
                });
                if (d.action !== 'block') continue;
                expect(stateOf(d.nextBody, itemId)).toBe('blocked');
                expect(doneCount(d.nextBody)).toBe(0);
                expect(ITEM_BLOCKED_REASONS).toContain(d.blockedReason);
              }
            }
          }
        }
      }
    });

    it('una PR consegnata in questa run non blocca l item anche al secondo already-fixed', () => {
      const body = bucketBody(item(FIRST, 'open'));
      expect(decideBucketItemRouting({
        body, itemId: FIRST, outcome: 'already-fixed', deliveryStatus: 'verified-delivery', verified: false, link: 'none', priorAlreadyFixedAttempts: 1,
      }).action).toBe('attempt');
    });
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

  it('lo step riceve l item selezionato del bucket giornaliero', () => {
    const step = workflow.slice(stepStart, classify);
    expect(step).toContain('DAILY_ITEM_ID: ${{ steps.tier.outputs.selected_item_id }}');
  });

  it('no-root-cause: la issue singola si differisce, il daily bucket no (FU-09b)', () => {
    const line = workflow.split('\n').find((l) => l.includes('Se la root cause non è determinabile con confidenza')) ?? '';
    const single = line.indexOf('Issue non daily:');
    const bucket = line.indexOf('Daily bucket:');
    expect(single).toBeGreaterThan(-1);
    expect(bucket).toBeGreaterThan(single);
    // La regola delle issue singole resta intera.
    const singleRule = line.slice(single, bucket);
    expect(singleRule).toContain('<!-- AUTOMATION_DEFERRED: technical -->');
    expect(singleRule).toContain('applica `automation-deferred`');
    expect(singleRule).toContain('rimuovi il routing `agent:fix*`');
    // Il marker del verdetto vale per entrambe, prima della biforcazione.
    expect(line.slice(0, single)).toContain('<!-- FIX_OUTCOME: no-root-cause -->');
    const bucketRule = line.slice(bucket);
    expect(bucketRule).toMatch(/solo per l'item/u);
    expect(bucketRule).toMatch(/niente deferral, routing intatto/u);
    expect(bucketRule).not.toContain('automation-deferred');
  });

  it('il prompt chiede il marker FIX_EVIDENCE con già-risolto', () => {
    expect(workflow).toContain('<!-- FIX_EVIDENCE: pr=<N> commit=<sha> run=<id> -->');
  });

  it('il prompt resta entro il limite del validatore dei workflow', () => {
    // Senza margine GitHub rifiuta il workflow intero: zero job, nessun fixer.
    expect(validateWorkflowText('.github/workflows/issue-fix.yml', workflow)).toEqual([]);
  });
});
