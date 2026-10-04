import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runResolveByNumber } from '../scripts/ci/resolve-issue-by-number.mjs';

/**
 * Digest needs-human: a liste vuote il workflow esce 0 senza chiudere la issue.
 *
 * Lo step «Surface needs-human PRs and issues» di
 * `.github/workflows/recycle-stale-prs.yml` apre/aggiorna il digest
 * (issue 6458) e scrive nel corpo che va chiuso quando entrambe le liste sono
 * vuote. Fino a questa PR, a liste vuote faceva solo `exit 0`: la chiusura di
 * fatto era il PARENT-CLOSE dei follow-up, tolto dalla PR 11312, e il digest
 * restava aperto con un elenco falso. Qui lo step viene ESEGUITO con un `gh`
 * e un `node` finti in PATH: il `gh` finto applica il `--jq` vero dello step
 * (con `jq`) sui dati di prova, il `node` finto registra le chiamate.
 */

const WORKFLOW_PATH = new URL('../.github/workflows/recycle-stale-prs.yml', import.meta.url);
const TITLE = 'needs-human: PR bloccate in attesa di revisione umana';
const RESOLVER = 'scripts/ci/resolve-issue-by-number.mjs';
const CREATOR = 'scripts/lib/github-issue-creator.mjs';

function stepScript(): string {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const step = workflow.indexOf('- name: Surface needs-human PRs and issues');
  expect(step).toBeGreaterThanOrEqual(0);
  const start = workflow.indexOf('\n        run: |\n', step);
  expect(start).toBeGreaterThan(step);
  const next = workflow.indexOf('\n      - name:', start);
  const body = workflow.slice(start + '\n        run: |\n'.length, next < 0 ? undefined : next);
  return body
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

// `gh` finto: applica il `--jq` dello step con jq reale sul JSON di prova del
// sottocomando, cosi' i filtri (esclusione del digest, titolo esatto) sono
// quelli scritti nel workflow e non una loro imitazione.
const FAKE_GH = `#!/bin/sh
printf 'gh %s\\n' "$*" >>"$FAKE_LOG"
case "$1 $2" in
  "pr list") kind=pr ;;
  "issue list") kind=issue ;;
  api\\ *) kind=api ;;
  *) echo "unexpected gh $*" >&2; exit 97 ;;
esac
if [ "\${FAKE_FAIL:-}" = "$kind" ]; then echo "HTTP 502" >&2; exit 1; fi
case "$kind" in
  pr) data="$FAKE_PRS" ;;
  issue) data="$FAKE_ISSUES" ;;
  api) data="$FAKE_API" ;;
esac
expr=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--jq" ]; then expr="$2"; shift; fi
  shift
done
printf '%s' "$data" | jq -r "$expr"
`;

// Una riga per chiamata: la `--description` del digest contiene a capo.
const FAKE_NODE = `#!/bin/sh
{ printf 'node '; printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >>"$FAKE_LOG"
case "$1" in
  scripts/ci/resolve-issue-by-number.mjs) exit "\${FAKE_RESOLVE_RC:-0}" ;;
esac
exit 0
`;

type Item = { number: number; title: string; updatedAt?: string };
type ApiItem = { number: number; title: string; pull_request?: object };

interface Scenario {
  prs?: Item[];
  issues?: Item[];
  api?: ApiItem[];
  fail?: 'pr' | 'issue' | 'api';
  resolveRc?: number;
}

function runStep(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'needs-human-digest-'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  writeFileSync(join(dir, 'node'), FAKE_NODE);
  chmodSync(join(dir, 'gh'), 0o755);
  chmodSync(join(dir, 'node'), 0o755);
  const stamp = (items: Item[] = []) => items.map((item) => ({ updatedAt: '2026-10-04T00:00:00Z', ...item }));
  const result = spawnSync('bash', ['-c', stepScript()], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      GH_REPO: 'owner/repo',
      RUN_URL: 'https://github.com/owner/repo/actions/runs/1',
      DEDUP_TITLE: TITLE,
      FAKE_LOG: log,
      FAKE_PRS: JSON.stringify(stamp(scenario.prs)),
      FAKE_ISSUES: JSON.stringify(stamp(scenario.issues)),
      FAKE_API: JSON.stringify(scenario.api ?? []),
      FAKE_FAIL: scenario.fail ?? '',
      FAKE_RESOLVE_RC: String(scenario.resolveRc ?? 0),
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls,
    resolves: calls.filter((call) => call.startsWith(`node ${RESOLVER}`)),
    creates: calls.filter((call) => call.startsWith(`node ${CREATOR}`)),
  };
}

const DIGEST: ApiItem = { number: 6458, title: TITLE };
// Stesso prefisso, titolo diverso: il match per prefisso di `--resolve`
// l'avrebbe scelta al posto del digest (e' la piu' recente).
const PREFIX_TWIN: ApiItem = { number: 7001, title: `${TITLE} — 2026-09` };
// Una PR con lo stesso titolo: l'endpoint `issues` elenca anche le PR.
const SAME_TITLE_PR: ApiItem = { number: 7002, title: TITLE, pull_request: {} };

describe('recycle-stale-prs — digest needs-human a liste vuote', () => {
  it('il workflow dichiara la chiave di dedup una volta sola, e la usa anche in apertura', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(workflow).toContain(`DEDUP_TITLE: '${TITLE}'`);
    expect(stepScript()).toContain('--title "$DEDUP_TITLE"');
    expect(stepScript()).not.toContain(`"${TITLE}"`);
  });

  it('liste vuote: chiude il digest per NUMERO e titolo esatto, senza ripubblicarlo', () => {
    const run = runStep({ api: [PREFIX_TWIN, DIGEST, SAME_TITLE_PR] });
    expect(run.status, run.output).toBe(0);
    expect(run.creates).toEqual([]);
    expect(run.resolves).toHaveLength(1);
    expect(run.resolves[0]).toContain('--number 6458');
    expect(run.resolves[0]).toContain(`--expected-title ${TITLE}`);
    expect(run.resolves[0]).not.toContain('7001');
    expect(run.resolves[0]).not.toContain('7002');
  });

  it('il digest che ha ricevuto `needs-human` non si auto-elenca: liste vuote, chiusura', () => {
    const run = runStep({ issues: [{ number: 6458, title: TITLE }], api: [DIGEST] });
    expect(run.status, run.output).toBe(0);
    expect(run.creates).toEqual([]);
    expect(run.resolves).toHaveLength(1);
    expect(run.resolves[0]).toContain('--number 6458');
  });

  it('liste non vuote: pubblica il digest e non chiude niente', () => {
    const run = runStep({
      prs: [{ number: 11398, title: 'fix: qualcosa' }],
      issues: [{ number: 9244, title: 'AdSense Pre-Review Checklist' }],
      api: [DIGEST],
    });
    expect(run.status, run.output).toBe(0);
    expect(run.resolves).toEqual([]);
    expect(run.calls.some((call) => call.startsWith('gh api'))).toBe(false);
    expect(run.creates).toHaveLength(1);
    expect(run.creates[0]).toContain(`--title ${TITLE}`);
    expect(run.creates[0]).toContain('#11398');
    expect(run.creates[0]).toContain('#9244');
  });

  it('solo issue needs-human, nessuna PR: niente chiusura', () => {
    const run = runStep({ issues: [{ number: 9179, title: 'CI Failure (build): Deploy to GitHub Pages' }], api: [DIGEST] });
    expect(run.resolves).toEqual([]);
    expect(run.creates).toHaveLength(1);
  });

  it.each(['pr', 'issue'] as const)('query %s fallita: step rosso, nessuna chiusura ne ripubblicazione', (fail) => {
    const run = runStep({ fail, api: [DIGEST] });
    expect(run.status).not.toBe(0);
    expect(run.resolves).toEqual([]);
    expect(run.creates).toEqual([]);
  });

  it('ricerca del digest fallita: step rosso, nessuna chiusura', () => {
    const run = runStep({ fail: 'api', api: [DIGEST] });
    expect(run.status).not.toBe(0);
    expect(run.resolves).toEqual([]);
  });

  it('nessun digest aperto: niente da chiudere, step verde', () => {
    const run = runStep({ api: [PREFIX_TWIN, SAME_TITLE_PR] });
    expect(run.status, run.output).toBe(0);
    expect(run.resolves).toEqual([]);
    expect(run.creates).toEqual([]);
  });

  it('chiusura non verificata: step rosso', () => {
    const run = runStep({ api: [DIGEST], resolveRc: 1 });
    expect(run.resolves).toHaveLength(1);
    expect(run.status).not.toBe(0);
  });
});

describe('resolve-issue-by-number — esito della CLI', () => {
  const argv = ['--number', '6458', '--expected-title', TITLE, '--workflow', 'Recycle stale PRs'];
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('passa numero e titolo atteso a resolveGithubIssueByNumber', () => {
    const resolve = vi.fn(() => ({ number: 6458, persisted: true }));
    expect(runResolveByNumber(argv, resolve)).toBe(0);
    expect(resolve).toHaveBeenCalledWith(6458, expect.objectContaining({ expectedTitle: TITLE, workflow: 'Recycle stale PRs' }));
  });

  it.each([
    ['gia chiusa', 0, { number: 6458, persisted: false, skipped: 'not-open' }],
    ['titolo cambiato', 0, { number: 6458, persisted: false, skipped: 'title-changed' }],
    ['reporting disattivato', 0, null],
    ['illeggibile', 1, { number: 6458, persisted: false, skipped: 'unreadable' }],
  ])('%s → exit %s', (_label, code, outcome) => {
    const spy = quiet();
    expect(runResolveByNumber(argv, () => outcome)).toBe(code);
    spy.mockRestore();
  });

  it('chiusura rifiutata (throw) → exit 1', () => {
    const spy = quiet();
    expect(runResolveByNumber(argv, () => { throw new Error('close rejected'); })).toBe(1);
    spy.mockRestore();
  });

  it.each([
    [['--expected-title', TITLE]],
    [['--number', '0', '--expected-title', TITLE]],
    [['--number', '12abc', '--expected-title', TITLE]],
    [['--number', '6458']],
  ])('argomenti inutilizzabili %j → exit 1 senza chiamare il resolver', (args) => {
    const spy = quiet();
    const resolve = vi.fn();
    expect(runResolveByNumber(args, resolve)).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
