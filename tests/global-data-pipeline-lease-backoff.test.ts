/**
 * Il lease globale non deve coprire il SONNO del backoff di push-retry.
 *
 * Difetto misurato (corpus issue #1573): l'acquisizione sta fuori dal loop e
 * copriva ogni tentativo *e ogni sonno*. Con `MAX_PUSH_ATTEMPTS=14` e
 * `delay = attempt*5 + RANDOM%20` l'esaustione dorme ~10 minuti tenendo il
 * mutex globale; sommato a `translate-pending` (350 minuti di budget, quattro
 * acquisizioni dello stesso lease) e agli scrittori del sito che non passano dal
 * lease e vincono le ref race, l'hold non e' limitato dalla pazienza di nessuno.
 * Il gruppo 08 ha perso l'attesa piena di 60 minuti DUE volte e ha buttato 27
 * crawl su 27 riusciti (run 35404434208).
 *
 * Restringere il lock e' sicuro per una PROPRIETA' del codice: il loop rifa'
 * `git_fetch_retry` e ricostruisce l'albero da `read-tree "$remote_sha"` — la
 * testa remota CORRENTE — all'inizio di ogni tentativo. I test qui pinnano il
 * COMPORTAMENTO (chi tiene il lease durante il sonno, e la direzione del
 * fail-safe), non i minuti persi dal gruppo 08.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = fs.readFileSync('scripts/lib/git-commit-data.sh', 'utf8');

/** Estrae una funzione shell dal sorgente reale, per esercitarla isolata. */
function extractFn(name: string): string {
  const start = SCRIPT.indexOf(`${name}() {`);
  expect(start, `funzione ${name} assente`).toBeGreaterThan(-1);
  const end = SCRIPT.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return SCRIPT.slice(start, end + 3);
}

/**
 * Esegue le due funzioni con un `node` STUB: lo stub registra le azioni chieste
 * al lease e decide se riuscire, cosi' il test osserva il comportamento vero
 * dello shell senza toccare Firestore.
 */
function runHarness(body: string, { releaseExit = 0, acquireExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-backoff-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'actions.log');
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash\n`
      + `# $1 e' il path dello script del lease; $2 l'azione; poi i flag.\n`
      + `printf '%s\\n' "\${*:2}" >> "${log}"\n`
      + `case "$2" in\n`
      + `  release) exit ${releaseExit} ;;\n`
      + `  acquire) exit ${acquireExit} ;;\n`
      + `esac\n`
      + `exit 0\n`,
    { mode: 0o755 },
  );
  // Il lease script non viene eseguito davvero (node e' stubbato), ma il path
  // deve esistere perche' le funzioni lo risolvono da BASH_SOURCE.
  fs.writeFileSync(path.join(dir, 'global-data-pipeline-lease.mjs'), '// stub\n');
  const lib = path.join(dir, 'lib.sh');
  fs.writeFileSync(
    lib,
    `${extractFn('global_data_pipeline_lease_release_for_backoff')}\n`
      + `${extractFn('global_data_pipeline_lease_resume_after_backoff')}\n`,
  );
  const out = execFileSync('bash', ['-c', `source "${lib}"\n${body}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATA_PIPELINE_LEASE: '1' },
    cwd: dir,
  });
  const actions = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { stdout: out, actions };
}

describe('global data-pipeline lease durante il backoff', () => {
  it('rilascia il lease prima del sonno, quindi un altro writer puo prenderlo', () => {
    const { stdout, actions } = runHarness(
      'GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=1\n'
      + 'global_data_pipeline_lease_release_for_backoff\n'
      + 'echo "held=$GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED"\n',
    );
    expect(actions).toEqual(['release']);
    // È l'asserzione che conta: durante il sonno questo writer NON risulta
    // detentore, quindi il documento è libero per un secondo writer.
    expect(stdout).toContain('held=0');
  });

  it('riprende il lease dopo il sonno con l attesa breve dedicata', () => {
    const { stdout, actions } = runHarness(
      'GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=0\n'
      + 'global_data_pipeline_lease_resume_after_backoff\n'
      + 'echo "held=$GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED"\n',
    );
    // `--resume-wait`: aveva già il turno e l'ha ceduto solo per il sonno, quindi
    // non rientra in coda per l'ora intera.
    expect(actions).toEqual(['acquire --resume-wait']);
    expect(stdout).toContain('held=1');
  });

  it('se la RIPRESA fallisce propaga l uscita 44 e NON si procede senza lease', () => {
    // Bug reale trovato dalla review su #9190: `lease_status=$?` dopo il `fi`
    // cattura lo stato del comando composto `if` — 0 quando nessun ramo esegue —
    // non l'uscita di node. La funzione rendeva 0 con il flag a 0, quindi i
    // chiamanti (`|| return $?`, `|| exit $?`) proseguivano e potevano fare
    // reset/push SENZA il lease globale: l'inverso della garanzia che questa
    // modifica esiste per dare. Il test cattura il codice di uscita, che e' il
    // solo modo di distinguere le due forme.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-resume-fail-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nexit 44\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'global-data-pipeline-lease.mjs'), '// stub\n');
    const lib = path.join(dir, 'lib.sh');
    fs.writeFileSync(lib, `${extractFn('global_data_pipeline_lease_resume_after_backoff')}\n`);
    const res = require('node:child_process').spawnSync('bash', ['-c',
      `source "${lib}"\n`
      + 'GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=0\n'
      + 'global_data_pipeline_lease_resume_after_backoff\n'
      + 'echo "rc=$?"\n'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATA_PIPELINE_LEASE: '1' }, cwd: dir });
    fs.rmSync(dir, { recursive: true, force: true });
    // Il codice del lease-busy deve arrivare al chiamante, non diventare 0.
    expect(res.stdout).toContain('rc=44');
    expect(res.stdout).not.toContain('rc=0');
  });

  it('FAIL-SAFE: se il rilascio fallisce il lease resta TENUTO, non creduto libero', () => {
    // La direzione del fail-safe è il punto: un lease creduto libero mentre è
    // tenuto è peggio della congestione che stiamo riparando. Il comportamento
    // accettabile è quello di oggi — tenerlo fino al TTL.
    const { stdout, actions } = runHarness(
      'GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=1\n'
      + 'global_data_pipeline_lease_release_for_backoff || true\n'
      + 'echo "held=$GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED"\n'
      + 'global_data_pipeline_lease_resume_after_backoff || true\n'
      + 'echo "after_resume=$GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED"\n',
      { releaseExit: 1 },
    );
    expect(stdout).toContain('held=1');
    // E non si ri-acquisisce ciò che non è stato ceduto: una sola azione.
    expect(actions).toEqual(['release']);
    expect(stdout).toContain('after_resume=1');
  });

  it('senza DATA_PIPELINE_LEASE=1 le due funzioni sono no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-noop-'));
    const lib = path.join(dir, 'lib.sh');
    fs.writeFileSync(
      lib,
      `${extractFn('global_data_pipeline_lease_release_for_backoff')}\n`
        + `${extractFn('global_data_pipeline_lease_resume_after_backoff')}\n`,
    );
    const out = execFileSync('bash', ['-c',
      `source "${lib}"\n`
      + 'global_data_pipeline_lease_release_for_backoff && echo rel-ok\n'
      + 'global_data_pipeline_lease_resume_after_backoff && echo res-ok\n'],
    { encoding: 'utf8', env: { ...process.env, DATA_PIPELINE_LEASE: '0' } });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(out).toContain('rel-ok');
    expect(out).toContain('res-ok');
  });

  it('ENTRAMBI i backoff cedono il lease: anche quello di translate-pending', () => {
    // Sweepare solo il percorso grouped-isolated avrebbe lasciato in piedi il
    // detentore vero: `translate-pending` usa il ramo sequenziale (`--slice-only`,
    // quattro volte in un job da 350 minuti) ed è quello che nella finestra
    // 23:23-01:25 ha bloccato 19 gruppi.
    const sites = [...SCRIPT.matchAll(/global_data_pipeline_lease_release_for_backoff \|\| true\n\s*sleep "\$\{?[A-Za-z_]+\}?"\n\s*global_data_pipeline_lease_resume_after_backoff/g)];
    expect(sites.length, 'entrambi i siti di backoff devono cedere il lease').toBe(2);
    // E nessun `sleep "$delay"`/`"$DELAY"` di push-retry resta senza rilascio.
    const bare = [...SCRIPT.matchAll(/Push rejected[\s\S]{0,400}?sleep "\$\{?[A-Za-z_]+\}?"/g)];
    for (const m of bare) {
      expect(m[0]).toContain('global_data_pipeline_lease_release_for_backoff');
    }
  });

  it('la prosa che dichiarava l invariante opposto e stata aggiornata', () => {
    // AGENTS.md §8: il commento diceva «the lease covers every retry and every
    // remote push» — un'asserzione che questo diff rende falsa.
    expect(SCRIPT).not.toContain('the lease covers every retry and every remote push');
    expect(SCRIPT).toContain('Il mutex globale NON copre il sonno');
  });
});
