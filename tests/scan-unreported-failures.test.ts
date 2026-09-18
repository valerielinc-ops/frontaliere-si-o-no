/**
 * Guard sulla rete di sicurezza globale per i workflow rossi e dormienti.
 *
 * Perché serve. Il meccanismo che questo test copre è l'unico che vede i 158
 * file di workflow su 283 che NON hanno uno step `if: failure()`, più le due
 * classi che nessuno step interno potrà mai vedere (startup failure con zero
 * job, workflow che ha smesso di girare). Se si rompe in silenzio si torna
 * esattamente al punto di partenza — `audit-parser-quality` rosso per 438 h
 * senza che nessuno lo sappia — e il modo in cui si rompe in silenzio è sempre
 * lo stesso: il titolo esce dalla famiglia che il chiuditore centrale
 * riconosce, oppure il filtro comincia a scartare quello che doveva tenere.
 *
 * Il caso più importante è il PRIMO: l'accoppiamento apertura/chiusura non ha
 * forma di import, quindi nessun guard che segue gli import lo vede e la CI
 * resta verde mentre le issue diventano immortali. È già successo due volte in
 * questo repo (#5432, #5470), ed è la ragione per cui
 * `tests/failure-issue-closers.test.ts` esiste. Qui si pinna la stessa
 * proprietà per l'opener CENTRALE, che quel test non può vedere perché non è
 * uno step in un YAML.
 */

import { describe, it, expect } from 'vitest';
import {
  isReportableRun,
  cronFieldValues,
  maxCronGapMinutes,
  workflowScheduleFromSource,
  runBody,
  dormantBody,
} from '../scripts/ci/scan-unreported-failures.mjs';
import { TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';

const NOW = Date.now();
const since = new Date(NOW - 75 * 60_000).toISOString();
const fresh = new Date(NOW - 5 * 60_000).toISOString();

function run(over: Record<string, unknown> = {}) {
  return {
    conclusion: 'failure',
    event: 'schedule',
    head_branch: 'main',
    updated_at: fresh,
    created_at: fresh,
    workflow_name: 'sync-pharmacy-duties',
    ...over,
  };
}

describe('accoppiamento con chi CHIUDE', () => {
  // Se questo test diventa rosso NON si cambia il titolo per farlo passare: si
  // verifica che `close-recovered-failure-issues.mjs` sappia ancora chiudere la
  // famiglia. Un titolo fuori dal suo `TITLE_RE` non viene chiuso da nessuno.
  it('il titolo aperto dallo scanner ricade nella famiglia del chiuditore centrale', () => {
    for (const name of ['sync-pharmacy-duties', 'Audit Parser Quality', 'Translation Scheduler v2 (shadow)']) {
      const m = TITLE_RE.exec(`CI Failure: ${name}`);
      expect(m, `"CI Failure: ${name}" deve essere chiudibile`).not.toBeNull();
      // Il nome catturato è quello che il chiuditore ri-risolve con
      // `gh run list -w <nome>`: deve tornare identico, non troncato.
      expect(m![1]).toBe(name);
    }
  });

  it('lo stesso vale per il titolo della modalità dormienti', () => {
    const m = TITLE_RE.exec('CI Failure: seo-serp-autopilot');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('seo-serp-autopilot');
  });
});

describe('isReportableRun — cosa suona l\'allarme', () => {
  it('una run schedulata fallita su main è segnalabile', () => {
    expect(isReportableRun(run(), { since, ignore: new Set() })).toBe(true);
  });

  // Il requisito duro: 1.083 run `cancelled` nella finestra 48 h misurata. Un
  // `|| cancelled()` le avrebbe trasformate tutte in allarmi. La supersessione
  // di un concurrency group NON è un guasto, e il timeout vero ha già il suo
  // proprietario in scan-job-timeouts.mjs.
  it('cancelled NON suona l\'allarme', () => {
    expect(isReportableRun(run({ conclusion: 'cancelled' }), { since, ignore: new Set() })).toBe(false);
  });

  it('nemmeno success, skipped o una run ancora in corso', () => {
    for (const conclusion of ['success', 'skipped', 'neutral', 'timed_out', null]) {
      expect(isReportableRun(run({ conclusion }), { since, ignore: new Set() })).toBe(false);
    }
  });

  it('le run di pull_request restano al ciclo di review della PR', () => {
    for (const event of ['pull_request', 'pull_request_review', 'pull_request_target']) {
      expect(isReportableRun(run({ event }), { since, ignore: new Set() })).toBe(false);
    }
  });

  // `tests.yml` è il caso misurato: 59 run rosse non-PR in 48 h, 52 su branch di
  // feature del fleet di agenti e 7 su main. Le 7 sono guasti di questo repo.
  it('un push su un branch di feature non è un guasto del repo, su main sì', () => {
    expect(isReportableRun(run({ event: 'push', head_branch: 'fix/issue-8412' }), { since, ignore: new Set() })).toBe(false);
    expect(isReportableRun(run({ event: 'push', head_branch: 'main' }), { since, ignore: new Set() })).toBe(true);
  });

  it('una run schedulata è segnalabile anche fuori da main (il cron gira dove gira)', () => {
    expect(isReportableRun(run({ event: 'schedule', head_branch: 'release' }), { since, ignore: new Set() })).toBe(true);
  });

  it('fuori dalla finestra di lookback non si riapre la stessa condizione', () => {
    expect(isReportableRun(run({ updated_at: new Date(NOW - 10 * 3600_000).toISOString() }), { since, ignore: new Set() })).toBe(false);
  });

  it('IGNORE_WORKFLOWS esclude per nome', () => {
    expect(isReportableRun(run(), { since, ignore: new Set(['sync-pharmacy-duties']) })).toBe(false);
  });
});

describe('startup failure con ZERO job', () => {
  // Run 35343423193 di sync-pharmacy-duties, 2026-09-18T12:12:13Z:
  // `conclusion: failure`, `jobs.total_count: 0`, nessun check-run. Nessuno step
  // `if: failure()` poteva partire, quindi è il caso che giustifica per intero
  // una scansione centrale.
  const zeroJobRun = {
    id: 35343423193,
    event: 'schedule',
    head_branch: 'main',
    created_at: '2026-09-18T12:12:13Z',
    updated_at: '2026-09-18T12:12:20Z',
    html_url: 'https://github.com/o/r/actions/runs/35343423193',
  };

  it('resta segnalabile: il filtro non richiede job falliti', () => {
    expect(isReportableRun({ ...zeroJobRun, conclusion: 'failure', workflow_name: 'x' }, { since: null, ignore: new Set() })).toBe(true);
  });

  it('il corpo lo NOMINA invece di dire "nessun job fallito"', () => {
    const body = runBody({ run: zeroJobRun, workflowName: 'sync-pharmacy-duties', jobs: { total_count: 0, jobs: [] } });
    expect(body).toContain('Startup failure: zero job');
    expect(body).toContain('jobs.total_count: 0');
    expect(body).toContain(zeroJobRun.html_url);
  });

  it('con job falliti riporta job e step, non il ramo startup', () => {
    const body = runBody({
      run: zeroJobRun,
      workflowName: 'audit-parser-quality',
      jobs: {
        total_count: 2,
        jobs: [
          { name: 'audit', conclusion: 'failure', html_url: 'https://x/1', steps: [{ name: 'Run audit', conclusion: 'failure' }] },
          { name: 'ok', conclusion: 'success', html_url: 'https://x/2', steps: [] },
        ],
      },
    });
    expect(body).not.toContain('Startup failure');
    expect(body).toContain('`audit`');
    expect(body).toContain('Run audit');
    expect(body).not.toContain('`ok`');
  });
});

describe('cadenza dichiarata dal cron', () => {
  it('un campo illeggibile rende null e non "ogni minuto"', () => {
    // null è load-bearing: un campo che non si sa leggere non deve diventare né
    // «gira sempre» né «non gira mai», o si apre una issue su una cadenza
    // inventata. Chi chiama salta il workflow e lo dice.
    expect(cronFieldValues('nonsense', 0, 59)).toBeNull();
    expect(cronFieldValues('99', 0, 59)).toBeNull();
    expect(maxCronGapMinutes(['not a cron'])).toBeNull();
    expect(maxCronGapMinutes([])).toBeNull();
  });

  it('liste, range e step si espandono', () => {
    expect([...cronFieldValues('*/15', 0, 59)!]).toEqual([0, 15, 30, 45]);
    expect([...cronFieldValues('1,3', 0, 59)!]).toEqual([1, 3]);
    expect([...cronFieldValues('2-5', 0, 59)!]).toEqual([2, 3, 4, 5]);
  });

  it('misura l\'intervallo massimo fra due esecuzioni', () => {
    expect(maxCronGapMinutes(['17 * * * *'])).toBe(60); // orario
    expect(maxCronGapMinutes(['9,39 * * * *'])).toBe(30); // ogni 30 min
    expect(maxCronGapMinutes(['40 6 * * *'])).toBe(1440); // giornaliero
    expect(maxCronGapMinutes(['0 6,18 * * *'])).toBe(720); // due volte al giorno
    expect(maxCronGapMinutes(['0 */6 * * *'])).toBe(360); // ogni 6 ore
    expect(maxCronGapMinutes(['0 5 * * 1'])).toBe(10080); // settimanale
    expect(maxCronGapMinutes(['0 5 * * MON'])).toBe(10080); // nome del giorno
    expect(maxCronGapMinutes(['0 3 1 * *'])).toBe(44640); // mensile: 31 giorni
  });

  it('l\'unione di piu\' cron stringe l\'intervallo, non lo allarga', () => {
    expect(maxCronGapMinutes(['0 6 * * *', '0 18 * * *'])).toBe(720);
  });

  // Il moltiplicatore di grazia è 3 perché il cron di GitHub salta e ritarda.
  // Il fatto che conta: i 55 workflow con ultima run oltre 48 h misurati il
  // 2026-09-18 erano TUTTI settimanali e legittimi, e non devono suonare.
  it('un settimanale legittimo fermo da 10 giorni resta sotto la soglia di grazia', () => {
    const weekly = maxCronGapMinutes(['0 5 * * 1'])!;
    expect(10 * 1440).toBeLessThan(weekly * 3);
    expect(22 * 1440).toBeGreaterThan(weekly * 3);
  });

  it('un orario fermo da 4 ore invece la supera', () => {
    expect(4 * 60).toBeGreaterThan(maxCronGapMinutes(['47 * * * *'])! * 3);
  });
});

describe('lettura del cron dal file di workflow', () => {
  it('prende name e cron dichiarati, ignorando i commenti', () => {
    const { name, crons } = workflowScheduleFromSource([
      'name: my-workflow # con commento',
      'on:',
      '  schedule:',
      "    - cron: '47 * * * *'",
      "    - cron: '52 5 * * *' # giornaliero",
      'jobs:',
      '  scan:',
      '    steps: []',
    ].join('\n'));
    expect(name).toBe('my-workflow');
    expect(crons).toEqual(['47 * * * *', '52 5 * * *']);
  });

  it('un workflow senza schedule non ha cron', () => {
    expect(workflowScheduleFromSource('name: x\non:\n  workflow_dispatch:\njobs: {}').crons).toEqual([]);
  });
});

describe('corpo della issue di dormienza', () => {
  it('dice perché nessun failure() poteva accorgersene', () => {
    const body = dormantBody({
      workflowName: 'seo-serp-autopilot',
      crons: ['0 5 * * 1'],
      gapMinutes: 10080,
      lastRunAt: '2026-08-01T05:00:00Z',
      thresholdHours: 504,
    });
    expect(body).toContain('ha smesso di girare');
    expect(body).toContain('0 5 * * 1');
    expect(body).toContain('2026-08-01T05:00:00Z');
    expect(body).toContain('non FALLISCE');
  });

  it('dichiara l\'assenza di run invece di lasciare un campo vuoto', () => {
    const body = dormantBody({
      workflowName: 'x', crons: ['0 5 * * 1'], gapMinutes: 10080, lastRunAt: null, thresholdHours: 504,
    });
    expect(body).toContain('nessuna run registrata');
  });
});
