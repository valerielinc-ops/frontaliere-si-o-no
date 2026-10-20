import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildConflictHandoffIssue } from '../scripts/ci/pr-autorebase.mjs';

// Hand-off di #10095 il 27-09: la riapplicazione #10145 dichiarava
// `Supersedes #10095` e `Closes #10140` ma non `Closes #10082`, che #10095
// chiudeva; e #10095 restava aperta perché il bridge del fixer Codex rifiuta
// `gh pr close`. Al merge #10082 sarebbe rimasta aperta, e dopo 24 h il recycle
// avrebbe chiuso #10095 rimettendo in coda proprio #10082.

const HEAD = 'a'.repeat(40);
const handoff = (closes: number[] | null, lgtm = false) => buildConflictHandoffIssue({
  num: 10095,
  branch: 'fix/issue-10082',
  head: HEAD,
  files: ['tests/crawler-slice-integrity.test.ts'],
  lgtm,
  closes,
});
const step3 = (body: string) => body.split('\n').find((line) => line.startsWith('3. '))!;

describe('issue di hand-off: le issue chiuse dalla PR di origine passano alla PR nuova', () => {
  it('elenca le issue che #N chiude e chiede un Closes per ciascuna', () => {
    const line = step3(handoff([10082, 10083]).body);
    expect(line).toContain('La PR #10095 chiude #10082, #10083');
    expect(line).toContain('`Closes #<n>` per ciascuna, uno per riga');
  });

  it('senza issue chiuse da #N non aggiunge nulla', () => {
    expect(step3(handoff([]).body)).toBe(
      '3. Apri la PR con `Supersedes #10095` e `Closes` di questa issue, poi chiudi #10095 con un commento che rimanda alla nuova PR.',
    );
  });

  it('con elenco illeggibile chiede di ricavarlo dal body di #N', () => {
    expect(step3(handoff(null).body)).toContain('i `Closes #<n>` del body di #10095');
  });

  it.each([[[10082]], [[]], [null]])('nessuna keyword di chiusura adiacente a #N (closes=%j)', (closes) => {
    for (const lgtm of [true, false]) {
      expect(handoff(closes as number[] | null, lgtm).body)
        .not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#10095\b/i);
    }
  });

  it('handOffConflictToFixer passa closingIssuesReferences della PR di origine', () => {
    const source = readFileSync('scripts/ci/pr-autorebase.mjs', 'utf8');
    const fn = source.slice(source.indexOf('function handOffConflictToFixer('), source.indexOf('function prClosingIssueNumbers('));
    expect(fn).toContain('closes: prClosingIssueNumbers(num)');
    expect(source).toContain("'--json', 'closingIssuesReferences'");
  });
});

type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> };
const workflow = YAML.parse(readFileSync('.github/workflows/issue-fix.yml', 'utf8')) as { jobs: { fix: { steps: Step[] } } };
const steps = workflow.jobs.fix.steps;
const CLOSE_STEP = 'Close the PR a conflict hand-off supersedes (zero-Claude)';
const closeIndex = steps.findIndex((step) => step.name === CLOSE_STEP);
const closeStep = steps[closeIndex];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function runCloseStep({
  title = handoff([10082]).title,
  delivery = { status: 'verified-delivery', prNumber: 10145 } as Record<string, unknown> | null,
  newPrBody = 'Supersedes #10095\nCloses #10140\nCloses #10082',
  originState = 'OPEN',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-fix-handoff-close-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'issue.json'), JSON.stringify({ title }));
  const evidence = join(dir, 'evidence.json');
  if (delivery) writeFileSync(evidence, JSON.stringify(delivery));
  writeFileSync(join(dir, 'new-pr-body.txt'), newPrBody);
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  // `gh` come funzione di shell: vince sul PATH, quindi il test non raggiunge
  // mai il gh reale né lo shim del coordinatore.
  const fakeGh = [
    'gh() {',
    '  printf "%s\\n" "$*" >> "$GH_LOG"',
    '  case "$*" in',
    '    "pr view 10145 "*"--json body"*) cat "$FAKE_DIR/new-pr-body.txt" ;;',
    '    "pr view 10095 "*"--json state"*) printf "%s\\n" "$ORIGIN_STATE" ;;',
    '    "pr close "*) return 0 ;;',
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
  ].join('\n');
  const result = spawnSync('bash', ['-c', fakeGh + closeStep.run!], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GH_LOG: log,
      FAKE_DIR: dir,
      ORIGIN_STATE: originState,
      REPO: 'valerielinc-ops/frontaliere-si-o-no',
      ISSUE: '10140',
      SNAPSHOT: join(dir, 'issue.json'),
      PR_DELIVERY_EVIDENCE_FILE: delivery ? evidence : '',
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, stdout: result.stdout, calls, closed: calls.filter((c) => c.startsWith('pr close ')) };
}

describe('issue-fix: il workflow chiude la PR che l\'hand-off sostituisce', () => {
  it('lo step esiste, dopo la provenance, ed è best-effort', () => {
    expect(closeIndex).toBeGreaterThan(steps.findIndex((step) => step.name === 'Mark autonomous PR provenance (zero-Claude)'));
    expect(closeStep.if).toContain("steps.issue_snapshot.outputs.verified == 'true'");
    expect((closeStep as Record<string, unknown>)['continue-on-error']).toBe(true);
  });

  it.each([true, false])('chiude #N dopo una delivery verificata con Supersedes #N (lgtm=%s)', (lgtm) => {
    const result = runCloseStep({ title: handoff([10082], lgtm).title });
    expect(result.status).toBe(0);
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0]).toMatch(/^pr close 10095 --repo valerielinc-ops\/frontaliere-si-o-no --comment Sostituita dalla PR #10145/);
  });

  it.each([
    ['issue che non è un hand-off', { title: 'follow-up(daily:2026-09-27): 1 item — x' }],
    ['delivery non verificata', { delivery: { status: 'no-delivery', prNumber: null } }],
    ['evidenza assente', { delivery: null }],
    ['PR nuova senza Supersedes #N', { newPrBody: 'Closes #10140' }],
    ['Supersedes di un altro numero', { newPrBody: 'Supersedes #100950' }],
    ['PR di origine già chiusa', { originState: 'CLOSED' }],
    ['PR di origine già mergiata', { originState: 'MERGED' }],
  ])('non chiude nulla con %s', (_label, overrides) => {
    const result = runCloseStep(overrides as Parameters<typeof runCloseStep>[0]);
    expect(result.status).toBe(0);
    expect(result.closed).toEqual([]);
  });
});
