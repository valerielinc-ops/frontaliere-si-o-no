import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  coverageReport,
  inventory,
  coverageOf,
  REPORT_ACTION_USES,
} from '../scripts/ci/failure-issue-inventory.mjs';
import {
  CLOSERS,
  findStepRun,
  reproFromRun,
  buildFailureBody,
  closerFor,
} from '../scripts/ci/report-workflow-failure.mjs';

/**
 * Il gate sull'ACCOPPIAMENTO fra chi apre una issue di fallimento e chi la
 * chiude (issue #5437, dimostrato da #5470).
 *
 * ─── Perché serve un test e non una regola scritta ──────────────────────
 *
 * `tests/monitor-issue-dedup.test.ts` copre la metà di apertura: i titoli sono
 * stabili, nessuno chiama `gh issue create` a mano. Non copre — e non
 * pretendeva di coprire — la domanda successiva: *quel titolo, chi lo chiude?*
 * Col dedup sul titolo la risposta «nessuno» significa una issue immortale, e
 * finora quella risposta si poteva dare solo leggendo tre file a mente.
 *
 * È la forma di guasto che il repo ha già visto due volte:
 *   - `alert-pat-down.mjs` (#5432) dichiarava in un commento un «unico punto di
 *     chiusura» che non esisteva. La CI era verde: il contratto non ha forma di
 *     import, e i guard che seguono gli import non lo vedono.
 *   - `rerender-article-*` (#5470) aprivano `<workflow> (<section>) failed`,
 *     fuori da entrambi i chiuditori del repo. Nemmeno il commento sbagliato.
 *
 * Senza questo test, estendere il reporter diagnostico di #5423 agli altri ~95
 * workflow replicherebbe il difetto 95 volte, con body più belli.
 *
 * ─── Cosa verifica ESATTAMENTE ──────────────────────────────────────────
 *
 *   1. Ogni titolo aperto da un ramo `failure()` di un workflow ha un
 *      chiuditore, o è in `KNOWN_UNCOVERED` — che è un BASELINE A SCALARE:
 *      l'uguaglianza è esatta, quindi aggiungerne uno rompe il test e
 *      risolverne uno lo rompe finché non si cancella la riga.
 *   2. Ogni `closed-by` dichiarato adottando la composite action è VERO — non
 *      è una promessa, è la stessa condizione che il chiuditore userà.
 *   3. `title` e `closed-by` restano input OBBLIGATORI dell'action: è ciò che
 *      rende impossibile adottare il reporter senza dichiarare la chiusura.
 *   4. I chiuditori riconosciuti sono esattamente quelli che il reporter
 *      conosce: aggiungerne uno lì obbliga a decidere qui come si verifica.
 *   5. Un titolo `Workflow|Crawler|CI Failure: <nome>` deve nominare il `name:`
 *      del workflow, perché il reconciler fa `gh run list -w <nome>`. Un
 *      mismatch è il caso peggiore: SEMBRA coperto e non chiude niente.
 *   6. Un workflow RIUSABILE che adotta il reporter passa `workflow-file` e
 *      `workflow-name`: dentro un `workflow_call` `github.workflow` e
 *      `GITHUB_WORKFLOW_REF` sono del CHIAMANTE, e senza i due input il body
 *      degrada in silenzio (step non trovato, riproduzione vuota).
 *
 * ─── Cosa NON copre (dichiarato, per non farci affidamento) ─────────────
 *
 *   - Gli opener lato SCRIPT (`createGithubIssue({ title })` dentro
 *     `scripts/**`): titoli computati, spesso da funzioni. Fuori portata di
 *     un'analisi testuale, e leggerli male sarebbe peggio che non leggerli.
 *   - Le issue di CONDIZIONE aperte su un run verde (un monitor che misura uno
 *     stato brutto): il loro ciclo di vita non è «si chiude sul prossimo
 *     verde», quindi giudicarle con questa regola darebbe falsi positivi. La
 *     riga è `isFailureGated`, in failure-issue-inventory.mjs.
 *   - Che il chiuditore FUNZIONI a runtime. Prova che esiste e che il titolo
 *     ricade nel suo pattern; non che il cron giri, né che l'issue si chiuda.
 *   - I titoli irrisolvibili staticamente (assegnati dall'output di un altro
 *     step): non compaiono nell'inventario, quindi non sono né coperti né
 *     segnalati. Sono il punto cieco residuo.
 */

const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows');
const ACTION_YML = path.resolve(__dirname, '..', '.github', 'actions', 'report-failure', 'action.yml');

/**
 * BASELINE A SCALARE — i titoli di fallimento che oggi NON hanno chiuditore.
 *
 * Non è un'assoluzione: è l'inventario di un difetto preesistente, reso
 * visibile perché smetta di crescere. Ogni riga è una issue che, al primo
 * fallimento reale, resta aperta per sempre.
 *
 * Per toglierne una: aggiungi la metà di chiusura (uno step `if: success()` che
 * invoca `github-issue-creator.mjs --resolve` con il TITOLO IDENTICO — modello
 * `rpm-canary.yml:150-158`), poi cancella la riga da qui. Il test fallisce
 * finché non la cancelli, ed è voluto.
 *
 * Per aggiungerne una: non farlo. Il test è qui esattamente per impedirlo.
 */
// 2026-08-13 (#5437 cluster `igiene-ciclo`): tutte e 10 le righe che stavano
// qui sono state risolte nella stessa PR — la classe pericola (nessun
// chiuditore, quindi immortale al primo fallimento reale) è stata azzerata,
// non ridotta. Ognuna ha ricevuto il "sibling-resolve-step" prescritto sopra
// (uno step gemello `--resolve` con titolo identico), tranne
// `crawler-health-monitor.yml` che aveva già un closer FUNZIONANTE — una `gh
// issue close` diretta — ma invisibile a questo inventario perché non passa
// da `github-issue-creator.mjs`: convertito alla stessa forma canonica per
// diventare visibile, non per cambiarne il comportamento. Se questa lista
// torna a crescere, la riga aggiunta prende esattamente lo stesso trattamento
// invece di sedimentare qui.
const KNOWN_UNCOVERED: string[] = [];

/**
 * BASELINE A SCALARE — titoli che MATCHANO `TITLE_RE` ma nominano qualcosa che
 * non è il `name:` del loro workflow.
 *
 * È il caso peggiore della famiglia, perché a occhio sembra coperto: il titolo
 * ha il prefisso giusto, quindi `close-recovered-failure-issues.mjs` lo PRENDE
 * in carico — poi fa `gh run list -w "<nome del titolo>"`, non trova nessun
 * run, e per bias conservativo lascia la issue aperta. Per sempre, in silenzio.
 *
 * Il docstring di quel reconciler dichiarava UN solo caso noto
 * (`persist-job-stats`). Erano tre — misurati, non stimati, da
 * `node scripts/ci/failure-issue-inventory.mjs --json`.
 *
 * **Ora sono ZERO**, e la lista è vuota per un motivo che va detto: rinominare
 * un titolo ORFANA qualunque issue già aperta con quello vecchio, perché il
 * dedup è sul titolo. La finestra si apre solo quando non ce n'è nessuna
 * aperta, ed è stata verificata subito prima del rename con
 *
 *     gh issue list --state open --search 'in:title "<vecchio titolo>"'
 *
 * — vuota per tutti e tre. I titoli sono stati passati a
 * `${{ github.workflow }}` invece che al `name:` copiato a mano: così un futuro
 * rename del workflow non può più farli divergere in silenzio.
 *
 * Per aggiungerne uno: non farlo. Se un titolo `… Failure: <nome>` deve dire
 * qualcosa di diverso dal `name:`, allora non è quel prefisso che gli serve —
 * usa un titolo custom e uno step gemello `--resolve`.
 */
const KNOWN_TITLE_NAME_MISMATCH: string[] = [];

const key = (r: { file: string; title: string }) => `${r.file}\t${r.title}`;

describe('apertura e chiusura delle issue di fallimento sono accoppiate (#5437)', () => {
  it('ogni issue aperta su failure() ha qualcuno che la chiude', () => {
    const uncovered = coverageReport(WORKFLOWS_DIR)
      .filter((r) => !r.closedBy)
      .map(key)
      .sort();
    // Se questa lista CRESCE: un workflow apre una issue che nessun chiuditore
    // riconosce. Col dedup sul titolo resterà aperta per sempre — aggiungi la
    // metà di chiusura invece di allungare KNOWN_UNCOVERED.
    // Se questa lista si ACCORCIA: bene, cancella la riga corrispondente.
    expect(uncovered).toEqual([...KNOWN_UNCOVERED].sort());
  });

  it('nessun titolo `… Failure: <nome>` nomina un workflow che `gh run list -w` non risolve', () => {
    const mismatched = coverageReport(WORKFLOWS_DIR)
      .filter((r) => r.detail)
      .map(key)
      .sort();
    expect(mismatched).toEqual([...KNOWN_TITLE_NAME_MISMATCH].sort());
  });

  it('ogni `closed-by` dichiarato adottando il reporter diagnostico è vero', () => {
    const offenders: string[] = [];
    for (const rec of inventory(WORKFLOWS_DIR)) {
      for (const op of rec.openers) {
        if (op.via !== 'action') continue;
        if (!op.closedBy) {
          offenders.push(`${rec.file}:${op.line} — nessun \`closed-by\` dichiarato`);
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(CLOSERS, op.closedBy)) {
          offenders.push(`${rec.file}:${op.line} — \`closed-by: ${op.closedBy}\` non è un chiuditore esistente`);
          continue;
        }
        const actual = coverageOf(op, rec);
        if (!actual) {
          offenders.push(`${rec.file}:${op.line} — dichiara \`${op.closedBy}\` ma nessun chiuditore copre "${op.title}"`);
        } else if (actual.by !== op.closedBy) {
          offenders.push(`${rec.file}:${op.line} — dichiara \`${op.closedBy}\` ma a chiudere sarebbe \`${actual.by}\``);
        } else if (actual.detail) {
          offenders.push(`${rec.file}:${op.line} — \`${op.closedBy}\` non chiuderà: ${actual.detail}`);
        }
      }
    }
    // Una dichiarazione falsa è peggio dell'assenza: il body della issue dice a
    // chi la legge che qualcuno la chiuderà, e nessuno lo farà.
    expect(offenders).toEqual([]);
  });

  it('la composite action non può essere adottata senza dichiarare titolo e chiusura', () => {
    const src = fs.readFileSync(ACTION_YML, 'utf-8');
    // Rendere opzionale uno di questi due input riaprirebbe esattamente il buco
    // che #5470 ha dimostrato: un reporter montato senza la sua metà.
    for (const input of ['title', 'closed-by']) {
      // Il blocco dell'input va da `^  <nome>:` alla riga successiva rientrata
      // di 2 spazi: `indexOf('\n  ')` non basta, perché fa match anche su una
      // continuazione rientrata di 4 e troncherebbe il blocco alla prima riga.
      const block = src.match(new RegExp(`^ {2}${input}:\\r?\\n((?:(?: {3,}.*)?\\r?\\n)*)`, 'm'));
      expect(block?.[1], `input \`${input}\` non trovato in report-failure/action.yml`).toBeTruthy();
      expect(block?.[1], `input \`${input}\` di report-failure/action.yml`).toMatch(/required:\s*true/);
    }
  });

  it('i chiuditori riconosciuti sono esattamente quelli che il reporter conosce', () => {
    // Aggiungere un chiuditore in report-workflow-failure.mjs senza decidere qui
    // COME si verifica lascerebbe passare un `closed-by` non verificato.
    expect(Object.keys(CLOSERS).sort()).toEqual([
      'close-recovered-failure-issues',
      'report-validate-dist-failure',
      'sibling-resolve-step',
    ]);
  });

  it('il reporter diagnostico è adottato solo dove la chiusura esiste già', () => {
    const adopted = coverageReport(WORKFLOWS_DIR).filter((r) => r.via === 'action');
    // Il rollout va per FAMIGLIE misurate, una per PR, e ogni famiglia dichiara
    // qui il suo criterio — altrimenti «adottiamo il prossimo» diventa una lista
    // della spesa e i 105 titoli restanti arrivano tutti insieme in una PR
    // irrivedibile.
    //
    // PRIMA famiglia: i workflow le cui issue il fixer autonomo ha davvero preso
    // in carico — misurato su `gh issue list --label agent:fix`, dove
    // `Workflow Failure: <questi quattro>` è la testa della distribuzione.
    //
    // SECONDA famiglia: gli opener di `priority:urgent`. Misurato con
    //   gh issue list --state all --limit 1000 --search "created:>=<oggi-30gg>" \
    //     --json number,title,createdAt,labels
    // e attribuito ai titoli dell'inventario: 97 issue urgent in 30 giorni, di
    // cui 81 (84%) da cinque titoli, tutti nella catena di deploy. Restano fuori,
    // e non per dimenticanza:
    //   - `Validation Failure (dist):` e `CI Failure (build):` — già diagnostici,
    //     è il reporter di #5423 ad aprirli;
    //   - i due di `deploy.yml` (42 issue, il volume più alto in assoluto) — i
    //     loro step NON sono `if: failure()` ma `steps.<x>.outcome == 'failure'`
    //     dentro un job che resta VERDE per scelta (`continue-on-error`), quindi
    //     la jobs API non ha nessuno step con `conclusion: failure` da nominare;
    //     e i loro body sono già i più diagnostici del repo, riscritti a mano
    //     dopo che #5224/#5225/#5227 furono attribuite alle deploy key sbagliate.
    //     Adottarli sarebbe una REGRESSIONE, non un'estensione.
    // Restano i due opener urgent col body povero: 22 issue in 30 giorni.
    const EXPECTED: Record<string, string> = {
      // prima famiglia
      'audit-parser-quality.yml': 'close-recovered-failure-issues',
      'generate-article.yml': 'close-recovered-failure-issues',
      'traffic-scheduler.yml': 'close-recovered-failure-issues',
      'translate-pending.yml': 'close-recovered-failure-issues',
      // seconda famiglia — entrambi con titolo custom fuori da TITLE_RE, quindi
      // la loro metà di chiusura è lo step gemello nello STESSO file. Il gate
      // sopra («ogni `closed-by` dichiarato è vero») è ciò che verifica che quel
      // gemello esista davvero e col titolo identico, carattere per carattere.
      'deploy-publish.yml': 'sibling-resolve-step',
      'post-deploy-validate-live.yml': 'sibling-resolve-step',
    };
    expect(adopted.map((r) => r.file).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const r of adopted) expect(r.closedBy).toBe(EXPECTED[r.file]);
  });

  it('un workflow riusabile che adotta il reporter passa `workflow-file` e `workflow-name`', () => {
    // Dentro un `workflow_call`, `github.workflow` e `GITHUB_WORKFLOW_REF` sono
    // quelli del CHIAMANTE. Senza i due input il reporter cerca lo step fallito
    // nel file sbagliato e non lo trova mai: la sezione «Riproduzione locale»
    // esce vuota e il body si intesta col nome di un workflow che non è quello
    // caduto — degrado SILENZIOSO dietro una CI verde, la stessa forma di
    // guasto che questo file esiste per intercettare.
    const offenders: string[] = [];
    for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const src = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8');
      if (!src.includes(REPORT_ACTION_USES)) continue;
      // `workflow_call:` a due spazi = una chiave di `on:`, non una parola in un
      // commento: è la sola forma che rende il workflow davvero chiamabile.
      if (!/^ {2}workflow_call:/m.test(src)) continue;
      for (const input of ['workflow-file', 'workflow-name']) {
        if (!new RegExp(`^\\s+${input}:\\s*\\S`, 'm').test(src)) {
          offenders.push(`${file} — adotta il reporter ma non passa \`${input}\``);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("l'inventario vede la composite action, non solo le invocazioni shell", () => {
    // Se questo confronto va a zero, l'action è stata rinominata o il parser non
    // la riconosce più: il gate sopra passerebbe misurando il vuoto.
    const src = fs.readFileSync(path.join(WORKFLOWS_DIR, 'audit-parser-quality.yml'), 'utf-8');
    expect(src).toContain(REPORT_ACTION_USES);
    expect(coverageReport(WORKFLOWS_DIR).filter((r) => r.via === 'action').length).toBeGreaterThan(0);
  });
});

/**
 * Le funzioni pure del reporter estratto. Restano fuori dal ciclo `gh`: qui si
 * verifica ciò che il body PROMETTE al fixer, non la rete.
 */
describe('report-workflow-failure: cosa finisce nel body (#5437)', () => {
  const WF = [
    'jobs:',
    '  x:',
    '    steps:',
    '      - name: Run parser quality audit (strict)',
    '        run: node scripts/audit-parser-quality.mjs --strict',
    '      - name: Rerender ${{ matrix.section }} hubs',
    '        env:',
    '          A: b',
    '        run: |',
    '          npm run audit:all',
    '          node scripts/rerender-article-hubs.mjs --section x',
    '      - name: Report failure',
    '        run: echo no',
    '',
  ].join('\n');

  it('trova il `run:` dello step fallito, anche con il nome interpolato', () => {
    expect(findStepRun(WF, 'Run parser quality audit (strict)')?.run)
      .toBe('node scripts/audit-parser-quality.mjs --strict');
    // Il nome dello step di una matrice non è mai uguale al letterale nel file:
    // confrontarlo per uguaglianza renderebbe introvabile ogni step di matrice.
    expect(findStepRun(WF, 'Rerender frontaliere hubs')?.run)
      .toContain('node scripts/rerender-article-hubs.mjs --section x');
    expect(findStepRun(WF, 'Uno step che non esiste')).toBeNull();
  });

  it('risolve gli `npm run` attraverso package.json, come fa il reporter dist', () => {
    const step = findStepRun(WF, 'Rerender frontaliere hubs')!;
    const repro = reproFromRun(step.run, { 'audit:all': 'node scripts/audit-all.mjs' });
    expect(repro.commands[0]).toContain('npm run audit:all');
    expect(repro.commands[0]).toContain('scripts/audit-all.mjs');
    // `## Suggested action` è ciò che il fixer estrae: i path devono venire da
    // package.json, non da una mappa hardcoded che invecchia in silenzio.
    expect(repro.paths).toContain('scripts/audit-all.mjs');
    expect(repro.paths).toContain('scripts/rerender-article-hubs.mjs');
  });

  it('il body non cita mai un path .github/workflows/** (il fixer morirebbe a zero token)', () => {
    const body = buildFailureBody({
      repo: 'o/r', runId: '1', workflowName: 'W', jobName: 'j',
      failedStep: { name: 'S' },
      excerpt: 'Uses: o/r/.github/workflows/reusable.yml@refs/heads/main\n##[error]boom',
      repro: { commands: [], paths: ['scripts/x.mjs'] },
      closer: closerFor('close-recovered-failure-issues', { title: 'Workflow Failure: W', workflowName: 'W' }),
    });
    // scripts/ci/check-workflows-scope.mjs Mode 1 termina issue-fix.yml PRIMA di
    // Claude quando il body cita quei path — e i log dei job li contengono davvero.
    expect(body).not.toMatch(/\.github\/workflows\//);
    expect(body).toContain('«workflow reusable.yml»');
    expect(body).toContain('## Suggested action');
    expect(body).toContain('scripts/x.mjs');
  });

  it('un accoppiamento rotto si vede NEL body, non solo nei log del run', () => {
    const body = buildFailureBody({
      repo: 'o/r', runId: '1', workflowName: 'W', jobName: 'j',
      repro: { commands: [], paths: [] },
      closer: closerFor('close-recovered-failure-issues', { title: 'W (x) failed', workflowName: 'W' }),
    });
    // Chi legge la issue deve sapere che nessuno la chiuderà: un warning nei log
    // di un run rosso non lo legge nessuno, il body sì.
    expect(body).toContain('accoppiamento rotto');
    expect(body).toContain('#5437');
  });

  it('senza log e senza diag file il body lo DICE, invece di far credere che il log fosse vuoto', () => {
    const body = buildFailureBody({
      repo: 'o/r', runId: '1', workflowName: 'W', jobName: 'j',
      repro: { commands: [], paths: [] },
      closer: closerFor('close-recovered-failure-issues', { title: 'Workflow Failure: W', workflowName: 'W' }),
    });
    expect(body).toContain('nessun estratto disponibile');
    expect(Object.keys(CLOSERS)).toContain('sibling-resolve-step');
  });
});
