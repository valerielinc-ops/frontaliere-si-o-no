/**
 * Il gate dell'osservatore esterno del deploy.
 *
 * ─── Il guasto che questo file esiste per rendere impossibile ────────────
 *
 * 2026-09-19 20:54Z → 2026-09-20 07:14Z: `Deploy to GitHub Pages` rosso su
 * `main` per 10 ore e 24 minuti, 78 run consecutive, zero allarmi. Il ciclo di
 * merge mergiava, la produzione non riceveva niente. Scoperto per caso da un
 * `gh run list`. Stesso gate, stesso danno il 2026-09-16.
 *
 * I fixture di questo file NON sono inventati: sono le risposte reali della
 * Jobs API e di `gh run list` di quelle ore, salvate in
 * `tests/fixtures/deploy-failure-alarm/`. È l'unico modo per provare che
 * l'osservatore avrebbe suonato — «zero allarmi oggi» non prova niente, serve
 * il replay del giorno in cui l'allarme serviva.
 *
 * ─── Le due domande che decidono se questo allarme vale qualcosa ─────────
 *
 *   1. Un `failure` vero suona, e dice QUALE job e QUALE step. Nel caso reale
 *      il rosso era in `approve production promotion`, un job di ~20 secondi
 *      che gira PRIMA del build: un allarme che guardasse la durata della
 *      build o i suoi step non l'avrebbe visto.
 *   2. Un `cancelled` NON suona. Su questo workflow le cancellazioni da
 *      concorrenza newest-wins sono la maggioranza schiacciante (38 su 40 nel
 *      listing del 2026-09-20) e hanno ZERO job avviati. Un allarme che le
 *      contasse sparerebbe decine di volte al giorno e verrebbe ignorato
 *      entro un giorno — cioè sarebbe di nuovo silenzio, con più rumore.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  alarmVerdict,
  firstFailure,
  consecutiveFailureStreak,
  buildAlarmDescription,
} from '../scripts/ci/report-deploy-run-failure.mjs';
import { coverageOf, parseWorkflow, observedWorkflowNames, isFailureGated } from '../scripts/ci/failure-issue-inventory.mjs';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'deploy-failure-alarm');
const WF_PATH = path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'deploy-failure-alarm.yml');
const WF_RAW = fs.readFileSync(WF_PATH, 'utf8');
const WF = parse(WF_RAW) as any;

const OBSERVED = 'Deploy to GitHub Pages';
const ALARM_TITLE = `Workflow Failure: ${OBSERVED}`;

const readFixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

/** Jobs API della run 35469667575 — la PRIMA della serie rossa del 19/09. */
const JOBS_FAILURE = readFixture('jobs-35469667575-failure.json');
/** Jobs API della run 35522399104 — cancellata dalla concorrenza, zero job. */
const JOBS_CANCELLED = readFixture('jobs-35522399104-cancelled.json');
/** `gh run list` su `main` nella finestra dell'incidente. */
const RUN_LIST = readFixture('run-list-2026-09-19-incident.json');

describe('il verdetto: cosa è un allarme e cosa è rumore', () => {
  it('un `failure` suona', () => {
    expect(alarmVerdict({ conclusion: 'failure' })).toBe('report');
  });

  it('anche `timed_out` e `startup_failure` suonano', () => {
    // Un deploy che sfonda il timeout o che non riesce nemmeno a partire è
    // indistinguibile, dal lato della produzione, da uno che fallisce.
    expect(alarmVerdict({ conclusion: 'timed_out' })).toBe('report');
    expect(alarmVerdict({ conclusion: 'startup_failure' })).toBe('report');
  });

  it('un `cancelled` NON suona — è il vincolo numero uno', () => {
    expect(alarmVerdict({ conclusion: 'cancelled' })).toBe('ignore');
  });

  it('un `success` chiude invece di aprire', () => {
    expect(alarmVerdict({ conclusion: 'success' })).toBe('resolve');
  });

  it('una conclusion sconosciuta o assente tace, non indovina', () => {
    // Il bias è verso il silenzio: su questo workflow un falso allarme
    // significa decine di issue al giorno, cioè un canale che nessuno legge.
    for (const c of [undefined, null, '', 'skipped', 'neutral', 'action_required', 'qualcosa_di_nuovo']) {
      expect(alarmVerdict({ conclusion: c as string })).toBe('ignore');
    }
  });
});

describe('replay del 2026-09-19 — la run che nessuno ha visto', () => {
  it('attribuisce il rosso al job e allo step giusti', () => {
    expect(firstFailure(JOBS_FAILURE)).toEqual({
      job: 'approve production promotion',
      step: 'Verify required reviewers and environment attestation',
      stepNumber: 3,
    });
  });

  it('il job che ospita TUTTI i reporter del deploy era `skipped`: ecco perché nessuno ha suonato', () => {
    // Questa asserzione non misura il codice nuovo: fissa la CAUSA. Ogni
    // reporter `if: failure()` di `deploy.yml` è uno step dentro
    // `build-locale`, e uno step di un job saltato non viene mai valutato.
    // Finché questa riga resta vera, un reporter interno non può bastare.
    const byName = Object.fromEntries(
      (JOBS_FAILURE.jobs as Array<{ name: string; conclusion: string }>).map((j) => [j.name, j.conclusion]),
    );
    expect(byName['build-locale']).toBe('skipped');
    expect(byName['prep']).toBe('skipped');
    expect(byName['approve production promotion']).toBe('failure');
  });

  it('una cancellazione da concorrenza non ha job da attribuire, e non ne inventa', () => {
    expect(JOBS_CANCELLED.total).toBe(0);
    expect(firstFailure(JOBS_CANCELLED)).toBeNull();
  });
});

describe('«da quante run consecutive», non «il deploy è rosso»', () => {
  it('conta la serie reale dell incidente ancorandola alla run osservata', () => {
    // 35496347548 = l'ultima rossa della serie (07:14Z). Nel listing salvato
    // ci sono 29 rosse consecutive prima di uscire dalla finestra letta.
    const { streak, saturated } = consecutiveFailureStreak(RUN_LIST, { fromRunId: 35496347548 });
    expect(streak).toBe(29);
    // La serie copre tutto lo storico letto senza un verde: il numero è un
    // limite inferiore (quella vera era 78) e il body lo deve dire.
    expect(saturated).toBe(true);
  });

  it('le cancellazioni sono TRASPARENTI: non contano e non interrompono', () => {
    // Nel listing reale le righe 0-4 sono cinque cancellazioni consecutive, e
    // la 5 è il verde della ripresa. Partendo dalla più recente la camminata
    // attraversa tutte e cinque senza contarle e si ferma sul verde: zero.
    // Senza la trasparenza si fermerebbe sulla prima cancellazione (stesso
    // risultato per caso qui) oppure — ed è il difetto vero — le conterebbe
    // come guasti, aprendo un allarme dove non c'è niente.
    expect(RUN_LIST.slice(0, 5).every((r: { conclusion: string }) => r.conclusion === 'cancelled')).toBe(true);
    expect(consecutiveFailureStreak(RUN_LIST)).toEqual({ streak: 0, saturated: false });

    // E in mezzo a una serie rossa non la spezzano: righe reali, ricomposte.
    const cancelledThenFailures = [RUN_LIST[0], ...RUN_LIST.slice(6)];
    expect(consecutiveFailureStreak(cancelledThenFailures).streak).toBe(29);
  });

  it('un verde chiude la serie', () => {
    const green = RUN_LIST[5] as { databaseId: number; conclusion: string };
    expect(green.conclusion).toBe('success'); // il deploy ripreso alle 07:18Z
    expect(consecutiveFailureStreak(RUN_LIST, { fromRunId: green.databaseId }))
      .toEqual({ streak: 0, saturated: false });
  });

  it('sulla finestra reale: 29 allarmi, 5 silenzi, 1 chiusura — nessun altro esito', () => {
    // La risposta diretta alla domanda «un cancelled genera allarme?», data
    // sui dati veri di quelle ore invece che su un esempio costruito.
    const verdicts = RUN_LIST.reduce((acc: Record<string, number>, r: { conclusion: string }) => {
      const v = alarmVerdict(r);
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});
    expect(verdicts).toEqual({ report: 29, ignore: 5, resolve: 1 });
  });

  it('un id fuori dalla finestra non azzera il conteggio: riparte dalla più recente', () => {
    const { streak } = consecutiveFailureStreak(RUN_LIST, { fromRunId: 1 });
    expect(streak).toBe(0); // la più recente è verde, quindi zero — non un crash
  });
});

describe('il testo dell allarme', () => {
  const body = buildAlarmDescription({
    workflowName: OBSERVED,
    runUrl: 'https://github.com/o/r/actions/runs/35469667575',
    runId: '35469667575',
    conclusion: 'failure',
    failure: firstFailure(JOBS_FAILURE),
    streak: 29,
    streakSaturated: true,
  });

  it('nomina il job e lo step, non «il deploy è rosso»', () => {
    expect(body).toContain('approve production promotion');
    expect(body).toContain('Verify required reviewers and environment attestation');
  });

  it('dice da quante run dura, e che il numero è un minimo quando lo è', () => {
    expect(body).toMatch(/almeno 29/);
  });

  it('non cita mai un path di workflow: azzererebbe il fixer autonomo', () => {
    // `check-workflows-scope.mjs` Mode 1 termina `issue-fix` a zero token su
    // una issue che nomina `.github/workflows/**`. Un allarme che lo facesse
    // sarebbe leggibile da un umano e invisibile all'automazione.
    expect(body).not.toMatch(/\.github\/workflows\//);
    expect(body).not.toMatch(/[\w-]+\.ya?ml\b/);
  });

  it('degrada invece di mentire quando la Jobs API non ha attribuito niente', () => {
    const degraded = buildAlarmDescription({
      workflowName: OBSERVED,
      runUrl: 'https://example.invalid/run',
      runId: '1',
      conclusion: 'failure',
      failure: null,
      streak: 1,
      streakSaturated: false,
    });
    expect(degraded).toMatch(/nessun job con esito/);
    expect(degraded).not.toMatch(/undefined|null/);
  });
});

describe('il workflow osservatore: forma pinnata', () => {
  it('osserva il deploy con una `workflows:` esplicita e non vuota', () => {
    // `workflow_run` senza `workflows:` non è un trigger non filtrato: è un
    // FILE INVALIDO, e ha già ucciso in silenzio ogni trigger di un altro
    // workflow per 2,5 giorni (#6656).
    expect(Array.isArray(WF.on.workflow_run.workflows)).toBe(true);
    expect(WF.on.workflow_run.workflows).toContain(OBSERVED);
    expect(WF.on.workflow_run.types).toEqual(['completed']);
  });

  it('non fa partire un runner sulle cancellazioni', () => {
    const cond = String(WF.jobs.alarm.if);
    // La forma `!= 'success'` farebbe partire un job per ognuna delle ~90
    // cancellazioni quotidiane. Le conclusion di guasto vanno ELENCATE.
    expect(cond).not.toMatch(/!=\s*'success'/);
    expect(cond).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(cond).toContain("github.event.workflow_run.conclusion == 'timed_out'");
    expect(cond).toContain("github.event.workflow_run.conclusion == 'startup_failure'");
    expect(cond).not.toMatch(/cancelled/);
  });

  it('chiede `actions: read`, altrimenti la Jobs API degrada il body in silenzio', () => {
    // Un blocco `permissions:` esplicito azzera gli scope non elencati: senza
    // questa riga la risposta è 403, lo step fallito non viene identificato e
    // l'allarme torna a dire solo «è rosso».
    expect(WF.permissions.actions).toBe('read');
    expect(WF.permissions.issues).toBe('write');
  });

  it('NON è un gate: nessun permesso di scrittura oltre le issue, nessun trigger su PR', () => {
    // Il proprietario non vuole approvazioni umane sul deploy, e questo file
    // non deve poter diventare il posto da cui reintrodurle.
    expect(Object.keys(WF.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(WF.permissions.contents).toBe('read');
    expect(WF.permissions.deployments).toBeUndefined();
    expect(WF.permissions['pull-requests']).toBeUndefined();
    for (const job of Object.values(WF.jobs) as Array<{ needs?: unknown; environment?: unknown }>) {
      expect(job.needs).toBeUndefined();
      expect(job.environment).toBeUndefined();
    }
  });

  it('non collassa due allarmi ravvicinati in uno', () => {
    expect(WF.concurrency['cancel-in-progress']).toBe(false);
  });

  it('usa una coda distinta per ogni run osservata', () => {
    expect(String(WF.concurrency.group)).toContain('github.event.workflow_run.id');
    expect(String(WF.concurrency.group)).toContain('github.run_id');
  });

  it('apre e chiude lo STESSO titolo — il dedup e la chiusura sono la stessa chiave', () => {
    const opener = WF_RAW.match(/--title "([^"]+)"[\s\S]{0,400}?--priority/);
    const resolver = WF_RAW.match(/--resolve[\s\S]{0,200}?--title "([^"]+)"/);
    expect(opener?.[1]).toBe(ALARM_TITLE);
    expect(resolver?.[1]).toBe(ALARM_TITLE);
  });

  it('il titolo è stabile: nessun run id o sha nei primi 60 caratteri', () => {
    expect(ALARM_TITLE.slice(0, 60)).not.toMatch(/\d{5,}|\$\{\{/);
  });

  it('il job di chiusura scatta solo sul verde', () => {
    expect(String(WF.jobs.resolve.if)).toBe("github.event.workflow_run.conclusion == 'success'");
  });
});

describe('accoppiamento con il canale d allarme esistente', () => {
  it('il titolo nomina il workflow OSSERVATO, che è ciò che il reconciler cerca', () => {
    expect(observedWorkflowNames(WF_RAW)).toContain(OBSERVED);
  });

  it('l opener è visibile al gate di accoppiamento e risulta coperto', () => {
    // Se questa riga si rompe, l'inventario non vede più questo opener e il
    // gate smette di verificare che qualcuno chiuda la sua issue — cioè torna
    // possibile una issue immortale, che è il difetto che
    // `failure-issue-closers.test.ts` esiste per impedire.
    const record = parseWorkflow(WF_RAW, 'deploy-failure-alarm.yml');
    const opener = record.openers.find((o: { title: string }) => o.title === ALARM_TITLE);
    expect(opener, 'l opener deve comparire nell inventario').toBeDefined();
    expect(opener!.failureGated, 'deve essere riconosciuto come failure-gated').toBe(true);
    expect(coverageOf(opener!, record)).toEqual({ by: 'close-recovered-failure-issues' });
  });

  it('riconosce un `if:` failure-gated anche scritto su più righe', () => {
    // La lettura inline vedeva `>-` come la condizione, cioè nessuna: ogni
    // opener con un `if:` multi-riga usciva dall'inventario in silenzio.
    expect(isFailureGated("      - name: x\n        if: >-\n          github.event.workflow_run.conclusion == 'failure'\n        run: y")).toBe(true);
    expect(isFailureGated('      - name: x\n        if: >-\n          always()\n        run: y')).toBe(false);
  });
});
