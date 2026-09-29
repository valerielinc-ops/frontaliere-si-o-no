import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Issue #9285 («CI Failure: Issue fix»): run 36305990899 e 36305918927. La issue
// #10017 e' stata chiusa NOT_PLANNED 67s prima dello step `issue_snapshot`, il
// jq pretendeva `.state == "OPEN"` e il job usciva 5 con «issue snapshot non
// verificabile». Una issue chiusa e' «niente da fare», non un guasto.

type Step = { id?: string; name?: string; if?: string; run?: string };

const workflowSource = readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');
const workflow = YAML.parse(workflowSource) as { jobs: { fix: { steps: Step[] } } };
const steps = workflow.jobs.fix.steps;
const snapshotIndex = steps.findIndex((step) => step.id === 'issue_snapshot');
const snapshotStep = steps[snapshotIndex];
const VERIFIED = "steps.issue_snapshot.outputs.verified == 'true'";
const FINGERPRINT = 'a'.repeat(64);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function runSnapshot(issue: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-fix-snapshot-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'issue.json'), JSON.stringify(issue));
  const outputFile = join(dir, 'github-output');
  writeFileSync(outputFile, '');
  // `gh` come funzione di shell, non come binario nel PATH: una funzione vince
  // sempre sulla risoluzione del PATH, quindi il test non puo' mai raggiungere
  // il gh reale (o uno shim che l'ambiente locale antepone al PATH).
  const fakeGh = 'gh() { cat "$RUNNER_TEMP/issue.json"; }\n';
  const result = spawnSync('bash', ['-c', fakeGh + snapshotStep.run!], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: outputFile,
      REPO: 'valerielinc-ops/frontaliere-si-o-no',
      ISSUE_NUMBER: '10017',
      EXPECTED_SNAPSHOT_FINGERPRINT: FINGERPRINT,
    },
  });
  return { status: result.status, stdout: result.stdout, output: readFileSync(outputFile, 'utf8') };
}

const issue = (overrides: Record<string, unknown> = {}) => ({
  number: 10017,
  state: 'OPEN',
  title: 'follow-up',
  body: 'body',
  labels: [{ name: 'agent:fix' }],
  comments: [],
  ...overrides,
});

describe('issue-fix: issue chiusa fra label e snapshot', () => {
  it('chiude verde con closed=true e verified=false quando la issue e\' chiusa', () => {
    const result = runSnapshot(issue({ state: 'CLOSED' }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice::issue #10017 chiusa prima dello snapshot: niente da fare');
    expect(result.output).toContain('closed=true');
    expect(result.output).toContain('verified=false');
    expect(result.output).not.toContain('verified=true');
  });

  it('resta fail-closed se il numero non combacia, anche con stato chiuso', () => {
    const result = runSnapshot(issue({ number: 10018, state: 'CLOSED' }));
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('closed=true');
  });

  it('non concede capability su una issue aperta con fingerprint diverso', () => {
    // Il ri-accodamento che segue e' coperto da issue-fix-stale-snapshot-requeue.test.ts.
    const result = runSnapshot(issue());
    expect(result.output).toContain('verified=false');
    expect(result.output).not.toContain('verified=true');
    expect(result.output).not.toContain('closed=true');
  });

  it('resta fail-closed su uno stato non stringa', () => {
    const result = runSnapshot(issue({ state: null }));
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it('non lascia girare nessuno step dopo lo snapshot senza verified=true', () => {
    // Ogni step successivo deve citare il gate, oppure dipendere solo dagli
    // output di uno step gated (uno step saltato ha output vuoti).
    const gatedIds = new Set<string>(['issue_snapshot']);
    const ungated: string[] = [];
    for (const step of steps.slice(snapshotIndex + 1)) {
      const condition = step.if ?? '';
      const direct = condition.includes(VERIFIED);
      const referenced = [...condition.matchAll(/steps\.([a-z_]+)\.outputs\.[a-z_]+ == 'true'/gu)].map((m) => m[1]);
      const derived = referenced.length > 0 && referenced.every((id) => gatedIds.has(id));
      if (!direct && !derived) ungated.push(step.name ?? step.id ?? '?');
      if (step.id) gatedIds.add(step.id);
    }
    expect(ungated).toEqual([]);
  });
});
