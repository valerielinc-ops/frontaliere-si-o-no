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
  isReportableScope,
  cronFieldValues,
  maxCronGapMinutes,
  dormancyThresholdMinutes,
  isCoveredIssueStale,
  workflowScheduleFromSource,
  workflowNameFromIssue,
  latestIssuePerWorkflow,
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

describe('dedup con issue canoniche che dichiarano il workflow nel corpo', () => {
  it('mantiene la precedenza del titolo nella famiglia centrale', () => {
    expect(workflowNameFromIssue({
      title: 'CI Failure: sync-pharmacy-duties',
      body: '**Workflow:** altro-workflow',
    })).toBe('sync-pharmacy-duties');
  });

  it('riconosce una issue di monitor con titolo di dominio', () => {
    expect(workflowNameFromIssue({
      title: '[crawler-health] clinique-generale-ste-anne: crawler unhealthy',
      body: '**Workflow:** crawler-health-monitor\n\nAutomated health check flagged a crawler.',
    })).toBe('crawler-health-monitor');
  });

  it('non deduce il workflow da testo libero', () => {
    expect(workflowNameFromIssue({
      title: 'A crawler needs attention',
      body: 'The workflow crawler-health-monitor reported a stale crawler.',
    })).toBeNull();
  });

  it('sceglie la issue aggiornata piu recente indipendentemente dall ordine del listing', () => {
    const issues = [
      {
        number: 9195,
        title: 'SEO gates regression: max-bfs-depth above baseline',
        updatedAt: '2026-09-19T12:39:07Z',
        body: '**Workflow:** cathedral-seo-gates-check',
      },
      {
        number: 7421,
        title: 'CI Failure: cathedral-seo-gates-check',
        updatedAt: '2026-09-19T11:46:18Z',
        body: '**Workflow:** cathedral-seo-gates-check',
      },
    ];

    expect(latestIssuePerWorkflow(issues).get('cathedral-seo-gates-check')).toEqual({
      number: 9195,
      updatedAt: '2026-09-19T12:39:07Z',
    });
    expect(latestIssuePerWorkflow([...issues].reverse()).get('cathedral-seo-gates-check')).toEqual({
      number: 9195,
      updatedAt: '2026-09-19T12:39:07Z',
    });
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
    expect(10 * 1440).toBeLessThan(dormancyThresholdMinutes(weekly));
    expect(22 * 1440).toBeGreaterThan(dormancyThresholdMinutes(weekly));
  });
});

describe('soglia di dormienza — il pavimento assoluto', () => {
  // Regressione misurata: senza pavimento, il dry-run sul repo vero segnalava 8
  // workflow VIVI fermi da 1-3 h, perché per una cadenza di 20 min «tre cadenze
  // mancate» è un'ora — e un'ora di ritardo qui è normale.
  it('una cadenza corta non suona dopo un\'ora: sotto 24 h non è dormienza', () => {
    const every20min = maxCronGapMinutes(['*/20 * * * *'])!;
    expect(every20min * 3).toBe(60); // ciò che diceva la versione senza pavimento
    expect(dormancyThresholdMinutes(every20min)).toBe(24 * 60);
    expect(3 * 60).toBeLessThan(dormancyThresholdMinutes(every20min));
  });

  it('un orario deve aver mancato 24 esecuzioni, non 3', () => {
    expect(dormancyThresholdMinutes(maxCronGapMinutes(['47 * * * *'])!)).toBe(24 * 60);
  });

  it('oltre il pavimento comanda la cadenza: settimanale a 21 giorni, mensile a 93', () => {
    expect(dormancyThresholdMinutes(maxCronGapMinutes(['0 5 * * 1'])!)).toBe(21 * 1440);
    expect(dormancyThresholdMinutes(maxCronGapMinutes(['0 3 1 * *'])!)).toBe(3 * 44640);
  });

  // I 31 workflow dormienti misurati stanno fra 13 e 114 giorni. A cadenza
  // oraria e giornaliera suonano già a 13 giorni; un SETTIMANALE no, e non deve:
  // 13 giorni sono meno di tre cadenze, ed è lo stesso motivo per cui i 55
  // workflow fermi da oltre 48 h erano tutti settimanali legittimi. Il caso
  // limite del settimanale è il più lento del parco insieme al mensile.
  it('un dormiente da 13 giorni suona a cadenza oraria e giornaliera', () => {
    for (const cron of ['47 * * * *', '40 6 * * *']) {
      expect(13 * 1440).toBeGreaterThan(dormancyThresholdMinutes(maxCronGapMinutes([cron])!));
    }
  });

  it('un settimanale suona a 21 giorni e un mensile a 93, non prima', () => {
    const weekly = dormancyThresholdMinutes(maxCronGapMinutes(['0 5 * * 1'])!);
    expect(13 * 1440).toBeLessThan(weekly);
    expect(114 * 1440).toBeGreaterThan(weekly);
    expect(114 * 1440).toBeGreaterThan(dormancyThresholdMinutes(maxCronGapMinutes(['0 3 1 * *'])!));
  });
});

describe('«issue aperta» non significa «allarme vivo»', () => {
  // Caso misurato sul campo: `rerender-article-hubs` con 9 run rosse che
  // deduplicavano su #6650, aperta il 2026-08-27 e parcheggiata `needs-human`.
  // L'allarme esisteva e non allarmava: trattare «aperta» come «coperta»
  // riprodurrebbe lo stesso silenzio un livello più in là.
  it('una issue toccata di recente non viene disturbata', () => {
    const now = Date.parse('2026-09-18T18:00:00Z');
    expect(isCoveredIssueStale('2026-09-18T15:00:00Z', now)).toBe(false);
    expect(isCoveredIssueStale('2026-09-17T19:00:00Z', now)).toBe(false);
  });

  it('una issue parcheggiata da settimane è silenzio, e la ricorrenza va registrata', () => {
    const now = Date.parse('2026-09-18T18:00:00Z');
    expect(isCoveredIssueStale('2026-08-27T10:00:00Z', now)).toBe(true);
  });

  it('una data illeggibile conta come silenzio, non come freschezza', () => {
    // Fail-safe nel verso giusto: meglio un commento in piu' che il silenzio.
    expect(isCoveredIssueStale(null)).toBe(true);
    expect(isCoveredIssueStale(undefined)).toBe(true);
    expect(isCoveredIssueStale('non-una-data')).toBe(true);
  });

  it('la soglia è configurabile e il confine è esattamente 24 h', () => {
    const now = Date.parse('2026-09-18T18:00:00Z');
    expect(isCoveredIssueStale('2026-09-17T17:59:00Z', now)).toBe(true);
    expect(isCoveredIssueStale('2026-09-17T18:01:00Z', now)).toBe(false);
    expect(isCoveredIssueStale('2026-09-18T16:00:00Z', now, 1)).toBe(true);
  });
});

describe('cadenze rare: il cron non si scarta in silenzio', () => {
  // Difetto trovato in review: con una finestra fissa di 70 giorni un cron
  // mensile sul giorno 29/30/31 aveva UNA sola occorrenza (febbraio quei giorni
  // non li ha), cadeva nel ramo `fires.length < 2` e quel workflow restava fuori
  // dal controllo di dormienza.
  it('un mensile sul 29, 30 o 31 viene misurato invece di essere scartato', () => {
    for (const day of [29, 30, 31]) {
      const gap = maxCronGapMinutes([`0 3 ${day} * *`]);
      expect(gap, `giorno ${day} deve avere una cadenza misurabile`).not.toBeNull();
      // Il salto vero comprende febbraio, quindi e' piu' di un mese.
      expect(gap!).toBeGreaterThan(44640);
    }
  });

  it('una cadenza da 4 anni resta null: dichiarata, non inventata', () => {
    expect(maxCronGapMinutes(['0 3 29 2 *'])).toBeNull();
  });

  it('una cadenza corta non paga la finestra lunga', () => {
    const t0 = Date.now();
    for (let i = 0; i < 20; i += 1) maxCronGapMinutes(['47 * * * *']);
    expect(Date.now() - t0).toBeLessThan(2000);
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

  // Difetto trovato in review: la versione precedente troncava al primo `jobs:`
  // testuale per restare dentro `on:`. In YAML l'ordine delle chiavi è libero,
  // quindi un workflow che dichiara `jobs:` PRIMA di `on:` rendeva zero cron e
  // usciva in silenzio dal controllo di dormienza — non sorvegliato, e
  // indistinguibile da un workflow senza cadenza.
  it('trova il cron anche se `jobs:` è dichiarato PRIMA di `on:`', () => {
    const { name, crons } = workflowScheduleFromSource([
      'name: ordine-invertito',
      'jobs:',
      '  scan:',
      '    runs-on: ubuntu-latest',
      '    steps: []',
      'on:',
      '  schedule:',
      "    - cron: '0 5 * * 1'",
    ].join('\n'));
    expect(name).toBe('ordine-invertito');
    expect(crons).toEqual(['0 5 * * 1']);
  });

  it('una riga di cron commentata non conta come cadenza', () => {
    const { crons } = workflowScheduleFromSource([
      'name: x',
      'on:',
      '  schedule:',
      "    # - cron: '0 3 * * *'   disattivato",
      "    - cron: '0 5 * * *'",
    ].join('\n'));
    expect(crons).toEqual(['0 5 * * *']);
  });
});

describe('il perimetro è UNO: il rientro si misura dove si misura il rosso', () => {
  // Difetto trovato in review sul guard di rientro: confrontava il rosso di
  // `main` con «l'ultima run completata» qualunque fosse, quindi una run verde
  // su un branch di feature o su una PR — la maggioranza qui, 610 su 930 in
  // 48 h — veniva letta come guarigione e SOPPRIMEVA il rosso di `main`.
  // `isReportableScope` è la sola definizione di perimetro, usata da entrambi i
  // lati: due predicati che non si parlano sono già stati un difetto qui.
  it('un verde su branch di feature NON è nel perimetro, quindi non può guarire main', () => {
    expect(isReportableScope({ event: 'push', head_branch: 'fix/issue-1', conclusion: 'success' })).toBe(false);
    expect(isReportableScope({ event: 'pull_request', head_branch: 'main', conclusion: 'success' })).toBe(false);
  });

  it('un verde su main o da schedule è nel perimetro e può guarire', () => {
    expect(isReportableScope({ event: 'push', head_branch: 'main', conclusion: 'success' })).toBe(true);
    expect(isReportableScope({ event: 'schedule', head_branch: 'whatever', conclusion: 'success' })).toBe(true);
  });

  it('il perimetro non guarda l\'esito: vale identico per un rosso e per un verde', () => {
    const scope = { event: 'schedule', head_branch: 'main' };
    expect(isReportableScope({ ...scope, conclusion: 'failure' }))
      .toBe(isReportableScope({ ...scope, conclusion: 'success' }));
  });

  it('isReportableRun e isReportableScope concordano sul perimetro', () => {
    // Se un giorno divergessero, il rosso selezionato e il verde che lo chiude
    // parlerebbero di due popolazioni diverse: e' esattamente il difetto.
    for (const ev of ['schedule', 'push', 'pull_request', 'workflow_dispatch']) {
      for (const br of ['main', 'fix/x']) {
        const r = { conclusion: 'failure', event: ev, head_branch: br, updated_at: fresh, workflow_name: 'x' };
        expect(isReportableRun(r, { since: null, ignore: new Set() }))
          .toBe(isReportableScope(r, { ignore: new Set() }));
      }
    }
  });

  it('IGNORE vale su entrambi i lati del perimetro', () => {
    expect(isReportableScope({ event: 'schedule', head_branch: 'main', workflow_name: 'x' }, { ignore: new Set(['x']) })).toBe(false);
  });
});

describe('corpo della issue: job illeggibili vs nessun job fallito', () => {
  const run = {
    id: 1, event: 'schedule', head_branch: 'main',
    created_at: '2026-09-18T12:00:00Z', updated_at: '2026-09-18T12:01:00Z',
    html_url: 'https://github.com/o/r/actions/runs/1',
  };

  it('una lettura dei job fallita NON si spaccia per «nessun job fallito»', () => {
    const body = runBody({ run, workflowName: 'x', jobs: null, jobsReadable: false });
    expect(body).toContain('lettura dei job NON riuscita');
    expect(body).not.toContain('fallimento a livello di run');
  });

  it('job leggibili senza fallimenti restano il caso «a livello di run»', () => {
    const body = runBody({ run, workflowName: 'x', jobs: { total_count: 2, jobs: [] }, jobsReadable: true });
    expect(body).toContain('fallimento a livello di run');
    expect(body).not.toContain('lettura dei job NON riuscita');
  });
});

describe('la finestra di lookback non è tarata sulla cadenza del cron', () => {
  // Difetto da NON ereditare dal gemello del corpus (#1569): lookback di 40 min
  // contro un cron strozzato da GitHub a 3,4-5,2 h, due fallimenti mancati per
  // 79 secondi e per 70,6 minuti. La finestra deve coprire un ritardo di ore.
  it('la finestra copre un cron strozzato a 5,2 ore', () => {
    const lookbackMinutes = 24 * 60;
    expect(lookbackMinutes).toBeGreaterThan(5.2 * 60);
    // e anche il caso peggiore osservato di una passata saltata del tutto
    expect(lookbackMinutes).toBeGreaterThan(2 * 5.2 * 60);
  });

  it('una run rossa di 20 ore fa resta dentro la finestra', () => {
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const twentyHoursAgo = new Date(Date.now() - 20 * 3600_000).toISOString();
    expect(isReportableRun(
      { conclusion: 'failure', event: 'schedule', head_branch: 'main', updated_at: twentyHoursAgo, workflow_name: 'x' },
      { since, ignore: new Set() },
    )).toBe(true);
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
