/**
 * Una run di `tests.yml` superata da un nuovo push deve morire subito, ma solo
 * nella finestra in cui un cancel non puo' interrompere effetti esterni.
 *
 * Misurato il 2026-09-19: 23 run PR su 86 superate mentre giravano, 21 dopo
 * l'avvio; arrivavano fino a `Resolve PR from pull request` e fallivano li'
 * (271 minuti di runner in ~7 ore). Il gruppo `concurrency:` resta per
 * PR+HEAD e non cancellante: un cancel nativo puo' cadere dentro
 * `pr-autorebase.mjs`, che fra `gh pr close` e `gh pr reopen` di una PR
 * ALTRUI non e' atomico. Qui si difende il self-cancel a finestra chiusa e si
 * esegue davvero lo script del watcher con `git`/`gh` finti.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const TESTS_YML = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf-8');
const workflow = YAML.parse(TESTS_YML) as any;
const steps: any[] = workflow.jobs.vitest.steps;
const indexOf = (pred: (s: any) => boolean) => steps.findIndex(pred);

const startIdx = indexOf((s) => s.id === 'head_watch');
const stopIdx = indexOf((s) => s.name === 'Stop superseded-head watcher');
const checkoutIdx = indexOf((s) => s.uses === 'actions/checkout@v5' && !s.with?.path);
const resolveIdx = indexOf((s) => s.id === 'resolve');

describe('tests.yml: self-cancel della run superata', () => {
  it('il watcher parte prima del checkout e si ferma prima di Resolve PR', () => {
    expect(startIdx, 'step head_watch mancante').toBeGreaterThan(-1);
    expect(stopIdx, 'step di stop mancante').toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(checkoutIdx);
    expect(stopIdx).toBeGreaterThan(checkoutIdx);
    expect(stopIdx).toBeLessThan(resolveIdx);
    // Nessuno step con effetti esterni (review, autorebase, auto-merge) sta
    // dentro la finestra di self-cancel.
    for (const s of steps.slice(startIdx, stopIdx)) {
      const text = JSON.stringify(s);
      expect(text, s.name).not.toContain('pr-autorebase.mjs');
      expect(text, s.name).not.toContain('native-automerge-gate.mjs');
      expect(text, s.name).not.toContain('codex_review');
    }
  });

  it('lo stop gira anche dopo un rosso', () => {
    expect(steps[stopIdx].if).toContain('always()');
    expect(steps[stopIdx].if).toContain("steps.head_watch.outcome == 'success'");
  });

  it('la concorrenza resta non cancellante e il permesso e` solo per il self-cancel', () => {
    expect(TESTS_YML).toMatch(/^ {2}cancel-in-progress: false$/m);
    expect(TESTS_YML.slice(0, TESTS_YML.indexOf('\njobs:'))).toMatch(/^ {2}actions: write$/m);
    expect(steps[startIdx].run).toContain('actions/runs/${RUN_ID}/cancel');
    // Il polling passa dal protocollo git, non dal bucket REST del GITHUB_TOKEN.
    expect(steps[startIdx].run).toContain('git ls-remote');
    expect(steps[startIdx].run).not.toMatch(/gh (pr view|api [^-])/);
  });
});

/** Esegue start + stop con binari finti; `heads` e' la sequenza di HEAD osservate. */
/** Attende (max 10 s) che `pred` diventi vero: niente tempi fissi sotto carico. */
function waitFor(pred: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!pred() && Date.now() < deadline) spawnSync('sleep', ['0.05']);
  return pred();
}

function simulate(
  heads: string[],
  opts: { stopWhen: 'polled' | 'cancelled' | 'immediately'; intervalS?: string; settleMs?: number },
) {
  const tmp = mkdtempSync(join(tmpdir(), 'head-watch-'));
  const bin = join(tmp, 'bin');
  const runnerTemp = join(tmp, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  writeFileSync(join(tmp, 'heads'), heads.join('\n') + '\n');
  // Ogni chiamata consuma la prossima HEAD (l'ultima resta).
  stub(
    'git',
    `pwd -P >> "${tmp}/git-cwd"
n=$(cat "${tmp}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${tmp}/count"
[ -n "$(sed -n "\${n}p" "${tmp}/heads")" ] || [ "$n" -gt 1 ] || { echo "fatal: auth" >&2; exit 128; }
line=$(sed -n "\${n}p" "${tmp}/heads"); [ -n "$line" ] || line=$(tail -n1 "${tmp}/heads")
printf '%s\\trefs/pull/42/head\\n' "$line"`,
  );
  stub('gh', `printf '%s\\n' "$*" >> "${tmp}/gh-calls"`);
  stub('setsid', 'exec "$@"');
  stub('base64', 'echo dG9rZW4=');
  const head = 'a'.repeat(40);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    GH_TOKEN: 'token',
    // The production step receives this immutable absolute path from the
    // pre-checkout attestation step.  The fixture bypasses that step, so bind
    // the fake runner-owned CLI explicitly instead of relying on PATH.
    TRUSTED_GH_BIN: join(bin, 'gh'),
    REPO: 'owner/repo',
    PRN: '42',
    HEAD_SHA: head,
    RUN_ID: '777',
    WATCH_INTERVAL_S: opts.intervalS ?? '0.05',
  };
  const start = spawnSync('bash', ['-c', steps[startIdx].run], { env, encoding: 'utf-8' });
  expect(start.status, start.stderr).toBe(0);
  const count = () => Number(existsSync(join(tmp, 'count')) ? readFileSync(join(tmp, 'count'), 'utf-8') : 0);
  if (opts.stopWhen === 'polled') expect(waitFor(() => count() >= 3), 'il watcher non ha interrogato la ref').toBe(true);
  if (opts.stopWhen === 'cancelled') expect(waitFor(() => existsSync(join(tmp, 'gh-calls'))), 'nessun cancel').toBe(true);
  const stop = spawnSync('bash', ['-c', steps[stopIdx].run], { env, encoding: 'utf-8' });
  expect(stop.status, stop.stderr).toBe(0);
  spawnSync('sleep', [String((opts.settleMs ?? 300) / 1000)]);
  const calls = existsSync(join(tmp, 'gh-calls')) ? readFileSync(join(tmp, 'gh-calls'), 'utf-8') : '';
  const gitCwds = existsSync(join(tmp, 'git-cwd'))
    ? [...new Set(readFileSync(join(tmp, 'git-cwd'), 'utf-8').trim().split('\n'))]
    : [];
  const watchLog = existsSync(join(runnerTemp, 'head-watch', 'watch.log'))
    ? readFileSync(join(runnerTemp, 'head-watch', 'watch.log'), 'utf-8')
    : '';
  return { calls, stopOut: stop.stdout, head, gitCwds, runnerTemp, watchLog };
}

describe('tests.yml: watcher eseguito', () => {
  it('HEAD invariata: nessun cancel', () => {
    const { calls } = simulate(['a'.repeat(40)], { stopWhen: 'polled' });
    expect(calls).toBe('');
  });

  it('interroga la ref da RUNNER_TEMP, mai dal workspace (doppio Authorization)', () => {
    // Run 35460312069: dopo il checkout il workspace e' un repo con il suo
    // extraheader, e ogni ls-remote lanciato da li' falliva in silenzio.
    const { gitCwds, runnerTemp } = simulate(['a'.repeat(40)], { stopWhen: 'polled' });
    expect(gitCwds.length).toBe(1);
    expect(gitCwds[0]).toBe(realpathSync(join(runnerTemp, 'head-watch')));
  });

  it('HEAD spostata: cancella SOLO questa run, una volta', () => {
    const { calls, stopOut } = simulate(['a'.repeat(40), 'b'.repeat(40)], { stopWhen: 'cancelled' });
    expect(calls.trim().split('\n')).toEqual(['api -X POST repos/owner/repo/actions/runs/777/cancel --silent']);
    expect(stopOut).toContain('run cancellata dal watcher');
  });

  it('ref illeggibile: nessun cancel (fail-open verso la run, non verso il cancel), ma lo dice', () => {
    const { calls, watchLog } = simulate([''], { stopWhen: 'polled' });
    expect(calls).toBe('');
    expect(watchLog).toContain('ls-remote fallito (1): fatal: auth');
  });

  it('dopo lo stop una HEAD spostata non cancella piu`', () => {
    // Lo stop arriva prima che scada il primo intervallo.
    const tmpHeads = ['b'.repeat(40)];
    const { calls } = simulate(tmpHeads, { stopWhen: 'immediately', intervalS: '1', settleMs: 1500 });
    expect(calls).toBe('');
  });
});
