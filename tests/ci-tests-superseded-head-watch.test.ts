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
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
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
/** Attende (max `deadlineMs`, default 10 s) che `pred` diventi vero: niente tempi fissi sotto carico. */
function waitFor(pred: () => boolean, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  while (!pred() && Date.now() < deadline) spawnSync('sleep', ['0.05']);
  return pred();
}

// Registro dei tmp creati da `simulate()`, popolato PRIMA del proprio try:
// e' la rete di sicurezza dell'afterAll qui sotto, che ripulisce anche un
// `simulate()` interrotto da un `expect` fallito (vedi il test di
// regressione). Senza, un watcher bash resta orfano (ppid 1): misurato il
// 2026-09-20, 3 loop cosi' sono durati 3 giorni e 20 ore, 3,51 milioni di
// invocazioni dello stub `git` ciascuno, poi (stub rimosso da $TMPDIR) verso
// il git vero in loop con token finto.
const tmpRegistry: string[] = [];

/** Pulizia idempotente di un tmp di `simulate()`: stop watcher, kill pid, rm. */
function cleanupSimTmp(tmp: string) {
  const watchDir = join(tmp, 'runner', 'head-watch');
  try {
    if (existsSync(watchDir)) writeFileSync(join(watchDir, 'stop'), '');
  } catch {
    /* best-effort: il tmp puo' essere gia' stato rimosso da un run precedente */
  }
  try {
    const pidFile = join(watchDir, 'pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (err: any) {
          if (err?.code !== 'ESRCH') throw err;
        }
      }
    }
  } catch {
    /* best-effort */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// Rete di sicurezza a livello di modulo: anche se un `simulate()` lancia
// prima del proprio `finally` (bug che questo stesso file corregge) o se il
// `finally` stesso viene saltato per un motivo imprevisto, l'afterAll ripete
// la stessa pulizia idempotente su ogni tmp registrato.
afterAll(() => {
  for (const tmp of tmpRegistry) cleanupSimTmp(tmp);
});

/** Ultimo pid del watcher catturato da `simulate()`, anche se poi lancia. */
let lastWatcherPid: number | undefined;

function simulate(
  heads: string[],
  opts: {
    stopWhen: 'polled' | 'cancelled' | 'immediately';
    intervalS?: string;
    settleMs?: number;
    // Deadline del waitFor interno: di serie 10s, riducibile SOLO per il test
    // di regressione (forza il timeout e quindi l'expect a lanciare presto).
    pollDeadlineMs?: number;
  },
) {
  const tmp = mkdtempSync(join(tmpdir(), 'head-watch-'));
  tmpRegistry.push(tmp);
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
  // Tutto cio' che segue lo spawn dello step di start va in try/finally: uno
  // `expect` fallito qui sotto (es. waitFor scaduto sotto carico) non deve
  // saltare la pulizia del watcher che lo start ha appena messo in
  // background — e' esattamente il bug misurato il 2026-09-20 (3 loop
  // orfani, 3,8 giorni, 3,51M invocazioni git ciascuno).
  try {
    const start = spawnSync('bash', ['-c', steps[startIdx].run], { env, encoding: 'utf-8' });
    expect(start.status, start.stderr).toBe(0);
    const count = () => Number(existsSync(join(tmp, 'count')) ? readFileSync(join(tmp, 'count'), 'utf-8') : 0);
    const watchDir = join(runnerTemp, 'head-watch');
    // realpath e pid vanno letti QUI, prima che il finally possa cancellare
    // la cartella: dopo la pulizia `watchDir` non esiste piu'.
    const expectedWatchDir = waitFor(() => existsSync(watchDir)) ? realpathSync(watchDir) : '';
    const pidFile = join(watchDir, 'pid');
    const watcherPid = waitFor(() => existsSync(pidFile)) ? Number(readFileSync(pidFile, 'utf-8').trim()) : NaN;
    lastWatcherPid = Number.isFinite(watcherPid) ? watcherPid : undefined;
    const pollDeadlineMs = opts.pollDeadlineMs ?? 10_000;
    if (opts.stopWhen === 'polled')
      expect(waitFor(() => count() >= 3, pollDeadlineMs), 'il watcher non ha interrogato la ref').toBe(true);
    if (opts.stopWhen === 'cancelled')
      expect(waitFor(() => existsSync(join(tmp, 'gh-calls')), pollDeadlineMs), 'nessun cancel').toBe(true);
    const stop = spawnSync('bash', ['-c', steps[stopIdx].run], { env, encoding: 'utf-8' });
    expect(stop.status, stop.stderr).toBe(0);
    spawnSync('sleep', [String((opts.settleMs ?? 300) / 1000)]);
    const calls = existsSync(join(tmp, 'gh-calls')) ? readFileSync(join(tmp, 'gh-calls'), 'utf-8') : '';
    const gitCwds = existsSync(join(tmp, 'git-cwd'))
      ? [...new Set(readFileSync(join(tmp, 'git-cwd'), 'utf-8').trim().split('\n'))]
      : [];
    const watchLog = existsSync(join(watchDir, 'watch.log')) ? readFileSync(join(watchDir, 'watch.log'), 'utf-8') : '';
    return { calls, stopOut: stop.stdout, head, gitCwds, runnerTemp, watchLog, expectedWatchDir, watcherPid };
  } finally {
    // Copre sia il percorso felice (lo stop e' gia' girato, questa e' solo
    // pulizia disco) sia quello con `expect` fallito (qui lo stop non e'
    // mai girato: e' questo finally a fermare il watcher e a evitare
    // l'orfano).
    cleanupSimTmp(tmp);
  }
}

describe('tests.yml: watcher eseguito', () => {
  it('HEAD invariata: nessun cancel', () => {
    const { calls } = simulate(['a'.repeat(40)], { stopWhen: 'polled' });
    expect(calls).toBe('');
  });

  it('interroga la ref da RUNNER_TEMP, mai dal workspace (doppio Authorization)', () => {
    // Run 35460312069: dopo il checkout il workspace e' un repo con il suo
    // extraheader, e ogni ls-remote lanciato da li' falliva in silenzio.
    // `expectedWatchDir` e' calcolato dentro simulate() PRIMA che il
    // `finally` rimuova `tmp`: dopo la pulizia il path non esiste piu' e
    // `realpathSync` qui fallirebbe.
    const { gitCwds, expectedWatchDir } = simulate(['a'.repeat(40)], { stopWhen: 'polled' });
    expect(gitCwds.length).toBe(1);
    expect(gitCwds[0]).toBe(expectedWatchDir);
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

  it('regressione: un expect fallito dentro simulate() non lascia il watcher orfano', () => {
    // Prima della fix, `simulate()` lanciava fuori dal try/finally: lo stop
    // (che crea `WATCH_DIR/stop`) non girava mai e il loop bash restava vivo
    // a ppid 1 — il caso misurato il 2026-09-20 (3 loop, 3,8 giorni, 3,51M
    // invocazioni git ciascuno). Forziamo qui lo stesso scenario: un
    // `pollDeadlineMs` di 0 fa scadere il waitFor immediatamente, quindi
    // l'`expect(...).toBe(true)` dentro simulate() lancia PRIMA dello stop.
    lastWatcherPid = undefined;
    expect(() => simulate(['a'.repeat(40)], { stopWhen: 'polled', pollDeadlineMs: 0 })).toThrow();
    expect(lastWatcherPid, 'nessun pid catturato prima del throw').toBeTypeOf('number');
    const pid = lastWatcherPid as number;
    // Il finally di simulate() ha gia' fermato e ucciso il watcher: dopo un
    // breve margine di grazia, il pid non deve piu' esistere.
    const stillAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: any) {
        return err?.code !== 'ESRCH';
      }
    };
    expect(waitFor(() => !stillAlive(), 2_000), `pid ${pid} ancora vivo dopo il throw`).toBe(true);
  });
});
