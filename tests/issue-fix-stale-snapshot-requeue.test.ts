import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Issue #9285 («CI Failure: Issue fix»): run 36381901150 (#10085) e 36420326517
// (#9876) del 2026-09-28. Un commento legittimo arrivato fra `risk_policy` e lo
// step `issue_snapshot` cambiava il fingerprint: il deny era giusto, l'exit 1 no.
// La run falliva, riapriva #9285 e lasciava `agent:fix` orfana, che il RESCUE
// del drainer ri-accodava addebitando un `fu-attempt` a una run mai partita.

type Step = { id?: string; name?: string; if?: string; run?: string };

const workflowSource = readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');
const workflow = YAML.parse(workflowSource) as { jobs: { fix: { steps: Step[] } } };
const snapshotStep = workflow.jobs.fix.steps.find((step) => step.id === 'issue_snapshot')!;
const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const ISSUE = 10085;
const MARKER = '<!-- ISSUE_FIX_SNAPSHOT_STALE -->';

// Lo stesso programma jq dello step, estratto dal sorgente: il controllo
// positivo prova che il ramo «cambiata» scatta per il fingerprint e non per
// un difetto dell'harness.
const snapshotProgram = /snapshot=\$\(jq -ceS --arg repo "\$REPO" --argjson issue_number "\$ISSUE_NUMBER" '([\s\S]*?)' "\$issue_file"\)/u
  .exec(snapshotStep.run!)?.[1];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/u, 'Z');

const issue = (overrides: Record<string, unknown> = {}) => ({
  number: ISSUE,
  state: 'OPEN',
  title: 'Crawler Failure: Run lwphr',
  body: 'body',
  labels: [{ name: 'agent:fix' }, { name: 'fu-prio:high' }],
  comments: [],
  ...overrides,
});

const staleComments = (count: number, ageHours: number) => Array.from({ length: count }, (_, i) => ({
  id: `IC_stale_${i}`,
  createdAt: hoursAgo(ageHours + i / 10),
  body: `${MARKER}\nri-accodata`,
}));

function fingerprintOf(dir: string, value: Record<string, unknown>) {
  const file = join(dir, 'fingerprint-input.json');
  writeFileSync(file, JSON.stringify(value));
  const jq = spawnSync('jq', ['-ceS', '--arg', 'repo', REPO, '--argjson', 'issue_number', String(ISSUE), snapshotProgram!, file], { encoding: 'utf8' });
  expect(jq.status).toBe(0);
  return createHash('sha256').update(jq.stdout.replace(/\n$/u, '')).digest('hex');
}

function runSnapshot(current: Record<string, unknown>, opts: { expected?: string; fail?: 'comment' | 'edit' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-fix-stale-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'issue.json'), JSON.stringify(current));
  const outputFile = join(dir, 'github-output');
  writeFileSync(outputFile, '');
  const callsFile = join(dir, 'gh-calls');
  writeFileSync(callsFile, '');
  // `gh` come funzione di shell: vince sul PATH, quindi il test non raggiunge
  // mai il gh reale o lo shim del coordinatore. Ogni chiamata e' registrata,
  // col body del commento, per verificare ordine e contenuto delle scritture.
  const fakeGh = [
    'gh() {',
    '  local call="$*"',
    '  printf "%s\\n" "${call//$\'\\n\'/\\\\n}" >> "$RUNNER_TEMP/gh-calls"',
    '  case "$1 $2" in',
    '    "issue view") cat "$RUNNER_TEMP/issue.json" ;;',
    '    "issue comment") [ "${FAKE_GH_FAIL:-}" != comment ] ;;',
    '    "issue edit") [ "${FAKE_GH_FAIL:-}" != edit ] ;;',
    '    *) return 97 ;;',
    '  esac',
    '}',
    '',
  ].join('\n');
  const result = spawnSync('bash', ['-c', fakeGh + snapshotStep.run!], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: outputFile,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '424242',
      REPO,
      ISSUE_NUMBER: String(ISSUE),
      EXPECTED_SNAPSHOT_FINGERPRINT: opts.expected ?? 'b'.repeat(64),
      FAKE_GH_FAIL: opts.fail ?? '',
    },
  });
  const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
  return {
    status: result.status,
    stdout: result.stdout,
    output: readFileSync(outputFile, 'utf8'),
    calls,
    writes: calls.filter((call) => !call.startsWith('issue view')),
    ctxWritten: existsSync(join(dir, 'issue-fix-ctx', 'issue.json')),
    fingerprint: (value: Record<string, unknown>) => fingerprintOf(dir, value),
  };
}

describe('issue-fix: snapshot cambiata fra risk_policy e fix', () => {
  it('estrae dallo step il programma jq del fingerprint', () => {
    expect(snapshotProgram).toBeTruthy();
    expect(snapshotProgram).toContain('error("issue snapshot non verificabile")');
  });

  it('controllo positivo: fingerprint identico → verified=true, nessuna scrittura', () => {
    const current = issue();
    const probe = runSnapshot(current);
    const result = runSnapshot(current, { expected: probe.fingerprint(current) });
    expect(result.status).toBe(0);
    expect(result.output).toContain('verified=true');
    expect(result.output).not.toContain('stale=true');
    expect(result.writes).toEqual([]);
    expect(result.ctxWritten).toBe(true);
  });

  it('ri-accoda con marker e senza fu-attempt, esce verde senza capability', () => {
    const before = issue();
    const after = issue({ comments: [{ id: 'IC_new', createdAt: hoursAgo(0), body: '🔁 Recurrence on workflow run.' }] });
    const probe = runSnapshot(before);
    const result = runSnapshot(after, { expected: probe.fingerprint(before) });

    expect(result.status).toBe(0);
    expect(result.output).toContain('stale=true');
    expect(result.output).toContain('verified=false');
    expect(result.output).not.toContain('verified=true');
    expect(result.ctxWritten).toBe(false);
    expect(result.stdout).toContain(`::notice::issue snapshot cambiata dopo risk_policy: nessuna capability remota; #${ISSUE} ri-accodata`);

    expect(result.writes).toHaveLength(2);
    const [comment, edit] = result.writes;
    expect(comment).toMatch(/^issue comment 10085 --repo valerielinc-ops\/frontaliere-si-o-no --body /u);
    expect(comment).toContain(MARKER);
    expect(comment).toContain('https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/424242');
    expect(edit).toBe('issue edit 10085 --repo valerielinc-ops/frontaliere-si-o-no --add-label agent:fix-queued --remove-label agent:fix');
    expect(result.writes.join('\n')).not.toMatch(/fu-attempt/u);
  });

  it('non ri-accoda se agent:fix e\' gia\' stata tolta da un altro attore', () => {
    const result = runSnapshot(issue({ labels: [{ name: 'automation-deferred' }] }));
    expect(result.status).toBe(0);
    expect(result.output).toContain('stale=true');
    expect(result.output).toContain('verified=false');
    expect(result.writes).toEqual([]);
  });

  it('sotto il tetto (2 marker nelle 24h) ri-accoda ancora', () => {
    const result = runSnapshot(issue({ comments: staleComments(2, 1) }));
    expect(result.status).toBe(0);
    expect(result.output).toContain('stale=true');
    expect(result.writes).toHaveLength(2);
  });

  it('al tetto (3 marker nelle 24h) torna un errore visibile, senza scritture', () => {
    const result = runSnapshot(issue({ comments: staleComments(3, 1) }));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('::error::issue snapshot cambiata o non coerente, già ri-accodata 3 volte in 24h');
    expect(result.output).toBe('');
    expect(result.writes).toEqual([]);
  });

  it('i marker piu\' vecchi di 24h non contano per il tetto', () => {
    const result = runSnapshot(issue({ comments: staleComments(3, 30) }));
    expect(result.status).toBe(0);
    expect(result.writes).toHaveLength(2);
  });

  it('marker non postato → errore, nessuna label toccata', () => {
    const result = runSnapshot(issue(), { fail: 'comment' });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toMatch(/^issue comment /u);
  });

  it('label non spostata → errore, niente verified', () => {
    const result = runSnapshot(issue(), { fail: 'edit' });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });
});
