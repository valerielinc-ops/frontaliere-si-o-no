import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { VITEST_CHECK_NAME, VITEST_SHARD_NAME_RE } from '../scripts/ci/lib/constants.mjs';

/**
 * Guard S#5552 — il SECONDO capo del legame "nome del check", quello che oggi
 * non copre nessuno.
 *
 * `tests/ci-vitest-check-name.test.ts` copre già il legame
 * `VITEST_CHECK_NAME` ↔ `name:` del JOB `vitest:` in `tests.yml`. Ma l'intera
 * catena dell'auto-merge dipende da un SECONDO nome, che è una stringa diversa
 * in un punto diverso del file:
 *
 *     .github/workflows/auto-merge-on-lgtm.yml
 *       on: workflow_run: workflows: ['tests']   ← il NOME DEL WORKFLOW
 *
 * GitHub risolve `workflow_run.workflows` per **nome** (il `name:` top-level del
 * workflow target), non per path. Un nome che non corrisponde a nessun workflow
 * **non è un errore**: il trigger semplicemente non scatta mai — nessun run
 * fallito, nessun log, niente da guardare. Rinominare `name: tests` in
 * `tests.yml` spegne quindi in silenzio due cose insieme:
 *
 *   - `auto-merge-on-lgtm.yml` perde il trigger `workflow_run`, cioè METÀ dei
 *     due ordini di arrivo previsti dal suo header: il caso "LGTM arriva prima
 *     che vitest sia verde" non viene più ri-valutato → la PR resta ferma;
 *   - `pr-review-loop.yml` perde il proprio trigger → il reviewer non parte →
 *     nessun `## LGTM` → l'auto-merge non ha nemmeno l'ALTRO trigger.
 *
 * Non c'è nessuno strato sotto a cui appoggiarsi: su `main` non esiste branch
 * protection (l'API `branches/main/protection` torna 404 su entrambi i repo),
 * quindi questi trigger sono davvero l'unico cancello.
 *
 * È la stessa forma di difetto già vista con `SiteShellContract` e con
 * `alert-pat-down.mjs`: un contratto che **non ha forma di import** non è
 * coperto dai guard che seguono gli import, e passa con la CI verde.
 *
 * Il test è statico e generale — risolve OGNI `workflow_run.workflows` di OGNI
 * workflow contro i `name:` realmente presenti, non solo i due consumer noti.
 * Misurato all'introduzione: 199 workflow, 11 riferimenti, 0 irrisolti.
 *
 * Vincoli d'ambiente: nessun import di build-plugin e nessuna lettura sotto
 * `data/` o `public/` — legge solo `.github/workflows/`, quindi ha lo stesso
 * esito in worktree sparse e in CI.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Workflow {
  /** basename del file, es. `auto-merge-on-lgtm.yml` */
  file: string;
  /** `name:` top-level, cioè la stringa con cui `workflow_run` lo risolve */
  name: string | undefined;
  /** i `name:` dei job (quelli che diventano check-run) */
  jobNames: string[];
  /** i nomi elencati in `on: workflow_run: workflows:` */
  workflowRunTargets: string[];
}

const WORKFLOWS: Workflow[] = readdirSync(WORKFLOWS_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((file) => {
    const doc: unknown = YAML.parse(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf-8'));
    if (!isRecord(doc)) return { file, name: undefined, jobNames: [], workflowRunTargets: [] };

    // `on:` è una chiave scomoda: in YAML 1.1 sarebbe il booleano `true`, in
    // YAML 1.2 (quello che usa il parser) resta la stringa 'on'. Accettiamo
    // entrambe le letture invece di dipendere dalla versione dello schema.
    const onSection = Object.entries(doc).find(([k]) => k === 'on' || k === 'true')?.[1];
    const workflowRun = isRecord(onSection) ? onSection.workflow_run : undefined;
    const targets =
      isRecord(workflowRun) && Array.isArray(workflowRun.workflows)
        ? workflowRun.workflows.filter((t): t is string => typeof t === 'string')
        : [];

    const jobNames = isRecord(doc.jobs)
      ? Object.values(doc.jobs)
          .filter(isRecord)
          .map((j) => j.name)
          .filter((n): n is string => typeof n === 'string')
      : [];

    return {
      file,
      name: typeof doc.name === 'string' ? doc.name : undefined,
      jobNames,
      workflowRunTargets: targets,
    };
  });

/** name: top-level → file che lo dichiara (più d'uno = ambiguità, vedi sotto). */
const BY_NAME = new Map<string, string[]>();
for (const wf of WORKFLOWS) {
  if (wf.name === undefined) continue;
  const list = BY_NAME.get(wf.name) ?? [];
  list.push(wf.file);
  BY_NAME.set(wf.name, list);
}

const ALL_REFS = WORKFLOWS.flatMap((wf) =>
  wf.workflowRunTargets.map((target) => ({ from: wf.file, target })),
);

/** Suggerimento "volevi dire?" per chi ha appena rinominato un workflow. */
const nearestNames = (target: string, limit = 3): string[] => {
  const score = (candidate: string): number => {
    const a = target.toLowerCase();
    const b = candidate.toLowerCase();
    if (b.includes(a) || a.includes(b)) return 1000;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
  };
  return [...BY_NAME.keys()]
    .map((n) => ({ n, s: score(n) }))
    .filter(({ s }) => s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map(({ n }) => n);
};

/**
 * Un job "è" il check vitest se il suo `name:` è `VITEST_CHECK_NAME` (topologia
 * a job singolo, quella odierna dal de-sharding #2882) OPPURE se è la FORMA
 * GENERATA di uno shard: `name: vitest shard ${{ matrix.shard }}/4` produce i
 * check-run `vitest shard 1/4`, … Confrontare con la stringa esatta fallirebbe
 * su una re-introduzione legittima dello sharding, quindi si espande il
 * placeholder e si confronta con `VITEST_SHARD_NAME_RE` — la stessa const che
 * `vitestCheck.mjs` usa per riaprire gli shard sottostanti.
 */
const isVitestJobName = (jobName: string): boolean => {
  if (jobName === VITEST_CHECK_NAME) return true;
  const expanded = jobName.replace(/\$\{\{[^}]*\}\}/g, '1');
  return VITEST_SHARD_NAME_RE.test(expanded);
};

describe('workflow_run: i target si risolvono a un workflow che esiste (S#5552)', () => {
  it('il corpus di workflow è stato letto davvero (anti-vacuità)', () => {
    // Senza questo, ogni assert sotto passerebbe a vuoto se la directory
    // cambiasse path o il parser smettesse di estrarre i trigger.
    expect(
      WORKFLOWS.length,
      `nessun workflow letto da ${WORKFLOWS_DIR} — il guard sarebbe vacuo`,
    ).toBeGreaterThan(0);
    expect(
      ALL_REFS.length,
      'nessun `on: workflow_run: workflows:` estratto da nessun workflow: o il parsing è ' +
        'rotto, o il repo non usa più workflow_run. Nel secondo caso questo guard va rimosso ' +
        'consapevolmente, non lasciato passare a vuoto.',
    ).toBeGreaterThan(0);
  });

  it('ogni nome citato in workflow_run.workflows è il `name:` di un workflow reale', () => {
    const unresolved = ALL_REFS.filter((r) => !BY_NAME.has(r.target));
    const detail = unresolved
      .map(
        (r) =>
          `  - ${r.from} → ${JSON.stringify(r.target)} (nomi più simili: ` +
          `${nearestNames(r.target).map((n) => JSON.stringify(n)).join(', ') || 'nessuno'})`,
      )
      .join('\n');
    expect(
      unresolved,
      'Un `workflow_run` punta a un nome di workflow che non esiste.\n' +
        'GitHub risolve questo campo per NOME (il `name:` top-level del target), non per path, ' +
        'e un nome sconosciuto NON è un errore: il trigger non scatta mai, in silenzio — nessun ' +
        'run, nessun log, niente da guardare.\n' +
        'Se hai appena rinominato un workflow, aggiorna i suoi consumer qui sotto ' +
        '(il `name:` top-level è la stringa che conta, non il filename):\n' +
        detail,
    ).toEqual([]);
  });

  it('nessun nome citato è dichiarato da due workflow diversi (ambiguità di risoluzione)', () => {
    const ambiguous = [...new Set(ALL_REFS.map((r) => r.target))]
      .map((target) => ({ target, files: BY_NAME.get(target) ?? [] }))
      .filter((e) => e.files.length > 1);
    expect(
      ambiguous,
      'Due workflow diversi dichiarano lo stesso `name:`, e qualcuno lo usa come target di ' +
        '`workflow_run`: quale dei due faccia scattare il trigger non è determinato dal repo. ' +
        'Rinomina uno dei due.\n' +
        ambiguous.map((e) => `  - ${JSON.stringify(e.target)} ← ${e.files.join(', ')}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * La catena completa che porta al merge, in un unico assert per consumer:
 *
 *   auto-merge-on-lgtm.yml  --workflow_run.workflows-->  <workflow>
 *                                                          └── job `name:` == VITEST_CHECK_NAME
 *                                                                 └── check-run su cui
 *                                                                     auto-merge-eval.mjs decide
 *
 * Il test sopra prova che il target ESISTE; questo prova che è il target
 * GIUSTO. Sono difetti diversi: puntare a un workflow reale ma sbagliato (o
 * spostare il job vitest in un altro file) lascia il trigger acceso e il gate
 * cieco, che è la modalità di guasto peggiore delle due.
 */
describe('la catena auto-merge → tests → check vitest è intatta (S#5552)', () => {
  const CONSUMERS = [
    {
      file: 'auto-merge-on-lgtm.yml',
      why:
        'senza il verdetto di vitest questo workflow perde il trigger che copre l\'ordine ' +
        '"LGTM arriva prima che vitest sia verde": la PR non viene mai ri-valutata e resta ' +
        'ferma con la review positiva già postata',
    },
    {
      file: 'pr-review-loop.yml',
      why:
        'senza questo trigger il reviewer non parte, quindi non viene mai postato nessun ' +
        '`## LGTM` — e l\'auto-merge perde anche il suo secondo trigger',
    },
  ];

  for (const { file, why } of CONSUMERS) {
    it(`${file} triggera sul workflow che porta il job "${VITEST_CHECK_NAME}"`, () => {
      const wf = WORKFLOWS.find((w) => w.file === file);
      expect(wf, `${file} non trovato in .github/workflows/ — guard vacuo`).toBeTruthy();

      expect(
        wf!.workflowRunTargets.length,
        `${file} non ha più un trigger \`on: workflow_run: workflows: [...]\`.\n` +
          `Effetto: ${why}.\n` +
          'Se la rimozione è voluta, aggiorna questo guard nello stesso commit — non lasciarlo ' +
          'passare a vuoto.',
      ).toBeGreaterThan(0);

      const carriers = wf!.workflowRunTargets
        .flatMap((t) => BY_NAME.get(t) ?? [])
        .map((f) => WORKFLOWS.find((w) => w.file === f)!)
        .filter((w) => w.jobNames.some(isVitestJobName));

      expect(
        carriers.length,
        `${file} deve triggerare sul workflow che definisce il job "${VITEST_CHECK_NAME}" ` +
          '(il check-run su cui `scripts/ci/auto-merge-eval.mjs` decide il merge — non c\'è ' +
          'branch protection su main, quindi è davvero l\'unico cancello).\n' +
          `Target dichiarati: ${JSON.stringify(wf!.workflowRunTargets)}. ` +
          'Nessuno di questi definisce un job con quel nome.\n' +
          `Effetto: ${why}.\n` +
          'Da controllare, in quest\'ordine: (1) il `name:` top-level di .github/workflows/tests.yml, ' +
          '(2) il `name:` del job `vitest:` dentro quel file, (3) `VITEST_CHECK_NAME` in ' +
          'scripts/ci/lib/constants.mjs (guard dedicato: tests/ci-vitest-check-name.test.ts).',
      ).toBeGreaterThan(0);
    });
  }
});
