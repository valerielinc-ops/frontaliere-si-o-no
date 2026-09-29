import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Issue #9285 («CI Failure: Issue fix»): run 36286839919 e 36286841846 del
// 2026-09-27. Nel clone blobless l'agente aveva scritto oggetti locali che
// puntavano a oggetti mai scaricati; il `git fetch origin main` del diff gate
// moriva con `could not finish pack-objects to repack local links` (exit 128)
// e il lavoro dell'agente non arrivava al checkpoint. Il ripiego e' il commit
// dell'evento, non il ref locale `origin/main` che l'agente puo' riscrivere.

type Step = { id?: string; env?: Record<string, string>; run?: string };

const workflow = YAML.parse(
  readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8'),
) as { jobs: { fix: { steps: Step[] } } };
const diffGate = workflow.jobs.fix.steps.find((step) => step.id === 'diff_gate')!;
const EVENT_SHA = 'c'.repeat(40);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function runGate(opts: { fetch?: 'ok' | 'fail'; catFile?: 'ok' | 'fail'; eventSha?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-fix-diff-gate-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'git-calls'), '');
  // `git` come funzione di shell: vince sul PATH e non tocca il repo reale.
  // Diff vuoto → lo step esce prima del classificatore node.
  const fakeGit = [
    'git() {',
    '  printf "%s\\n" "$*" >> "$RUNNER_TEMP/git-calls"',
    '  case "$1" in',
    '    fetch) [ "$FAKE_FETCH" = ok ] ;;',
    '    cat-file) [ "$FAKE_CAT_FILE" = ok ] ;;',
    '    diff|ls-files) : ;;',
    '    *) return 97 ;;',
    '  esac',
    '}',
    '',
  ].join('\n');
  const result = spawnSync('bash', ['-c', fakeGit + diffGate.run!], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: dir,
      REPO: 'valerielinc-ops/frontaliere-si-o-no',
      VISION_APPROVED: 'false',
      EVENT_SHA: opts.eventSha ?? EVENT_SHA,
      FAKE_FETCH: opts.fetch ?? 'ok',
      FAKE_CAT_FILE: opts.catFile ?? 'ok',
    },
  });
  const calls = readFileSync(join(dir, 'git-calls'), 'utf8').split('\n').filter(Boolean);
  return { status: result.status, stdout: result.stdout, calls };
}

describe('issue-fix: diff gate F1/F7 con fetch di origin/main fallito', () => {
  it('passa il commit dell\'evento allo step', () => {
    expect(diffGate.env?.EVENT_SHA).toBe('${{ github.sha }}');
  });

  it('con il fetch riuscito classifica contro origin/main, come prima', () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.calls).toContain('diff --name-only origin/main');
    expect(result.stdout).not.toContain('::warning::');
  });

  it('con il fetch fallito ripiega sul commit dell\'evento, non sul ref locale', () => {
    const result = runGate({ fetch: 'fail' });
    expect(result.status).toBe(0);
    expect(result.calls).toContain(`cat-file -e ${EVENT_SHA}^{tree}`);
    expect(result.calls).toContain(`diff --name-only ${EVENT_SHA}`);
    expect(result.calls).not.toContain('diff --name-only origin/main');
    expect(result.stdout).toContain(`::warning::F1/F7 diff gate: fetch di origin/main fallito; classifico contro il commit dell'evento ${EVENT_SHA}.`);
  });

  it('commit dell\'evento non leggibile → deny', () => {
    const result = runGate({ fetch: 'fail', catFile: 'fail' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('::error::F1/F7 diff gate: fetch di origin/main fallito e commit dell\'evento non leggibile');
    expect(result.calls.some((call) => call.startsWith('diff '))).toBe(false);
  });

  it('commit dell\'evento non canonico → deny senza leggerlo', () => {
    const result = runGate({ fetch: 'fail', eventSha: 'origin/main' });
    expect(result.status).not.toBe(0);
    expect(result.calls.some((call) => call.startsWith('cat-file'))).toBe(false);
    expect(result.calls.some((call) => call.startsWith('diff '))).toBe(false);
  });
});
