import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  VITEST_CHECK_NAME,
  VITEST_EXECUTION_JOB_NAME,
  VITEST_SHARD_NAME_RE,
} from '../scripts/ci/lib/constants.mjs';
import { isGraphSourceFile } from '../scripts/ci/lib/related-graph-scope.mjs';

/**
 * Guard per il drift descritto in #1602: il nome del check-run vitest è la
 * source-of-truth in `.github/workflows/tests.yml` (`name:` del job), ma due
 * script CI lo consumano in un filtro `jq` — `auto-merge-eval.mjs` (gate 3:
 * HEAD vitest == success) e `pr-autorebase.mjs` (rileva head orfani a 0 vitest).
 * Se il job viene rinominato senza aggiornare la const, entrambi leggono in
 * silenzio length 0 / conclusion "" → heal ri-dispatcha all'infinito e nessuna
 * PR mergia. Questo test fa fallire la suite (= il gate vitest stesso) prima che
 * il drift raggiunga main, e verifica che gli script usino la const condivisa
 * invece di un literal copy-pasted.
 */

const ROOT = resolve(import.meta.dirname, '..');
const TESTS_YML = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf-8');
const COLLISION_YML = readFileSync(resolve(ROOT, '.github/workflows/pr-collision-detector.yml'), 'utf-8');
const TESTS_CODE = TESTS_YML.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
const AUTOREBASE = readFileSync(resolve(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf-8');
const AUTO_MERGE_EVAL = readFileSync(resolve(ROOT, 'scripts/ci/auto-merge-eval.mjs'), 'utf-8');
const RELATED_RUNNER = readFileSync(resolve(ROOT, 'scripts/ci/run-related-tests.mjs'), 'utf-8');
const RELATED_SCOPE = readFileSync(resolve(ROOT, 'scripts/ci/lib/related-graph-scope.mjs'), 'utf-8');

function assembleDecision(
  input: Record<string, unknown>,
): { required: boolean; reason: string; degraded?: boolean } {
  const probe = [
    "import { shouldAssembleForRelatedTests } from './scripts/ci/dataset-dependent-tests.mjs';",
    'const input = JSON.parse(process.argv[process.argv.length - 1]);',
    'process.stdout.write(JSON.stringify(shouldAssembleForRelatedTests(input)));',
  ].join('\n');
  return JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '-e', probe, JSON.stringify(input)],
    { cwd: ROOT, encoding: 'utf8' },
  ));
}

describe('tests.yml dataset assembly predicate (#B4)', () => {
  it('falls back to executing the assembly when classification is unresolved', () => {
    for (const input of [
      {
        eventName: 'pull_request',
        changedPaths: ['README.md'],
        changedStatus: 'complete',
        selectedTests: ['tests/not-classifiable.test.ts'],
        // Omitted on purpose: an unresolvable classifier result is not safe to
        // interpret as "independent".
      },
      {
        eventName: 'pull_request',
        changedPaths: ['README.md'],
        changedStatus: 'partial',
        selectedTests: [],
        unreadableCount: 0,
      },
      {
        eventName: 'push',
        changedPaths: ['README.md'],
        changedStatus: 'complete',
        selectedTests: [],
        unreadableCount: 0,
      },
      {
        eventName: 'pull_request',
        changedPaths: ['scripts/assemble-jobs-dataset.mjs'],
        changedStatus: 'complete',
        selectedTests: [],
        unreadableCount: 0,
      },
    ]) {
      expect(assembleDecision(input).required).toBe(true);
    }
  });

  it('uses the existing dataset partition for known related tests', () => {
    // The partition guard itself inspects sources but does not read the
    // assembled dataset; use a real reader to pin the required branch.
    expect(assembleDecision({
      eventName: 'pull_request',
      changedPaths: ['README.md'],
      changedStatus: 'complete',
      selectedTests: ['tests/job-locale-completeness.test.ts'],
      unreadableCount: 0,
    }).required).toBe(true);

    expect(assembleDecision({
      eventName: 'pull_request',
      changedPaths: ['README.md'],
      changedStatus: 'complete',
      selectedTests: ['tests/ci-vitest-check-name.test.ts'],
      unreadableCount: 0,
    }).required).toBe(false);
  });

  it('keeps the full history with blob filtering and gates both assemble steps', () => {
    const checkoutStart = TESTS_YML.indexOf('- uses: actions/checkout@v5');
    const setupStart = TESTS_YML.indexOf('- name: Setup Node.js', checkoutStart);
    const checkout = TESTS_YML.slice(checkoutStart, setupStart);
    const cacheStart = TESTS_YML.indexOf('- name: Cache assemble-jobs output');
    const assembleStart = TESTS_YML.indexOf('- name: Assemble + migrate');
    const relatedStart = TESTS_YML.indexOf('- name: vitest related (PR diff)', assembleStart);
    const cache = TESTS_YML.slice(cacheStart, assembleStart);
    const assemble = TESTS_YML.slice(assembleStart, relatedStart);

    expect(checkout).toContain('fetch-depth: 0');
    expect(checkout).toContain('filter: blob:none');
    expect(cache).toContain("steps.assemble.outputs.required == 'true'");
    expect(assemble).toContain("steps.assemble.outputs.required == 'true'");
    expect(TESTS_YML).toContain('node scripts/ci/run-related-tests.mjs --select-only');
  });

  /**
   * L'invariante che rende lo skip REALE invece che teorico.
   *
   * `shouldAssembleForRelatedTests()` risponde `required: true` appena
   * `unreadableCount > 0`, e `unreadable` si riempie con i file che `git
   * ls-files` elenca (l'INDEX, quindi completo anche sotto sparse) ma che il
   * working tree non sa aprire. Il job `vitest:` fa un checkout sparse con
   * allowlist non-cone: se quell'allowlist smettesse di materializzare anche
   * UN SOLO file selezionato da `isGraphSourceFile()`, il predicato
   * risponderebbe `required: true` su OGNI PR e l'ottimizzazione
   * diventerebbe un no-op permanente — silenzioso, perche' nel log un
   * `required: true` degradato e' identico a uno legittimo (per questo il
   * runner ora emette anche un `::warning::`, vedi `decision.degraded`).
   *
   * Misurato oggi: 5'429 file tracciati nel grafo, 0 non coperti. Il
   * confronto usa `git sparse-checkout check-rules`, cioe' il valutatore di
   * git stesso: replicare a mano la semantica dei pattern non-cone (con le
   * negazioni e i glob a stella sulle directory) sarebbe un secondo parser
   * che diverge in silenzio da quello che il checkout esegue davvero.
   */
  it('lo sparse-checkout del job vitest materializza tutto il grafo related (unreadableCount == 0)', () => {
    const doc = YAML.parse(TESTS_YML, { logLevel: 'silent' }) as any;
    const checkout = (doc?.jobs?.vitest?.steps ?? []).find(
      (step: any) => typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    );
    expect(checkout, 'il job vitest ha perso il passo di checkout').toBeTruthy();
    expect(checkout.with['sparse-checkout-cone-mode']).toBe(false);
    const rules = String(checkout.with['sparse-checkout']);

    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean)
      .map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''))
      .filter(isGraphSourceFile);
    expect(tracked.length).toBeGreaterThan(1000);

    const rulesFile = join(mkdtempSync(join(tmpdir(), 'sparse-rules-')), 'rules');
    writeFileSync(rulesFile, rules.endsWith('\n') ? rules : `${rules}\n`);
    const included = new Set(execFileSync(
      'git',
      ['sparse-checkout', 'check-rules', '--no-cone', '--rules-file', rulesFile],
      { cwd: ROOT, input: `${tracked.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ).split('\n').filter(Boolean));

    const missing = tracked.filter((file) => !included.has(file));
    expect(
      missing.slice(0, 20),
      `${missing.length} file del grafo related non sono nell'allowlist sparse del job vitest: ` +
        'il runner li conterebbe come `unreadable` e `Assemble + migrate` non verrebbe ' +
        'saltato su NESSUNA PR. Aggiungili all\'allowlist, oppure restringi ' +
        '`isGraphSourceFile()` se davvero non servono al grafo.',
    ).toEqual([]);
  });

  it('marca come `degraded` i rami fail-safe, cosi un no-op permanente e visibile', () => {
    // Un `required: true` che dice «questo diff usa il dataset» e' la feature
    // che lavora; uno che dice «non ho potuto guardare» e' lo skip spento.
    // Senza il discriminante i due sono indistinguibili nel log.
    expect(assembleDecision({
      eventName: 'pull_request',
      changedPaths: ['README.md'],
      changedStatus: 'complete',
      selectedTests: [],
      unreadableCount: 3,
    })).toMatchObject({ required: true, degraded: true });

    expect(assembleDecision({
      eventName: 'pull_request',
      changedPaths: ['README.md'],
      changedStatus: 'partial',
      selectedTests: [],
      unreadableCount: 0,
    })).toMatchObject({ required: true, degraded: true });

    // Una richiesta legittima NON e' degradata: il warning deve restare raro.
    expect(assembleDecision({
      eventName: 'pull_request',
      changedPaths: ['data/jobs/by-crawler/x.json'],
      changedStatus: 'complete',
      selectedTests: [],
      unreadableCount: 0,
    }).degraded).toBeUndefined();

    expect(RELATED_RUNNER).toContain('::warning::');
    expect(RELATED_RUNNER).toContain('decision.degraded');
  });
});

describe('VITEST_CHECK_NAME (#1602 drift guard)', () => {
  it('matcha byte-per-byte il name: del job required in tests.yml', () => {
    // Estrae il `name:` del job `vitest:` (può essere quotato o no).
    const m = TESTS_YML.match(/^[ \t]*vitest:\s*\n\s*name:\s*(.+?)\s*$/m);
    expect(m, 'job `vitest:` con `name:` non trovato in tests.yml').toBeTruthy();
    const jobName = (m![1] || '').replace(/^['"]|['"]$/g, '');
    expect(jobName).toBe(VITEST_CHECK_NAME);
  });

  it('il check required è il job che esegue il percorso pesante', () => {
    const m = TESTS_YML.match(/^\s*vitest:\s*\n\s*name:\s*(.+?)\s*$/m);
    expect(m, 'job `vitest:` con `name:` non trovato in tests.yml').toBeTruthy();
    const jobName = (m![1] || '').replace(/^['"]|['"]$/g, '');
    expect(jobName).toBe(VITEST_EXECUTION_JOB_NAME);
  });

  it('è il valore atteso (cattura un rename involontario della const stessa)', () => {
    expect(VITEST_CHECK_NAME).toBe('vitest (unit + integration)');
  });

  it('entrambi gli script importano la const invece di un literal nel filtro jq', () => {
    for (const [name, src] of [
      ['pr-autorebase.mjs', AUTOREBASE],
      ['auto-merge-eval.mjs', AUTO_MERGE_EVAL],
    ] as const) {
      // Tollerante ai co-import dallo STESSO modulo (es. auto-merge-eval.mjs
      // importa anche REDFLAG_IMPORTANT_RE): l'intento è "VITEST_CHECK_NAME viene
      // da constants.mjs", non "è l'UNICO named import". Un match esatto sulla
      // riga rompeva legittimamente all'aggiunta di un secondo import condiviso.
      expect(
        /import\s*\{[^}]*\bVITEST_CHECK_NAME\b[^}]*\}\s*from\s*'\.\/lib\/constants\.mjs'/.test(src),
        `${name} non importa VITEST_CHECK_NAME da './lib/constants.mjs'`,
      ).toBe(true);
      // Nessun literal hardcoded dentro un `select(.name == "...")` (eseguibile).
      expect(
        src.includes('select(.name == "vitest (unit + integration)")'),
        `${name} usa ancora il literal hardcoded in jq invece della const`,
      ).toBe(false);
    }
  });

  // Generalizzazione (feedback backlog-agent #3): non solo i 2 consumer noti —
  // NESSUN nuovo script sotto scripts/ci/ deve reintrodurre il literal. Coglie
  // un futuro helper che copia-incolla "vitest (unit + integration)" invece di
  // importare la const, all'author-time invece che in una follow-up issue.
  it('nessuno script in scripts/ci/ hardcoda il literal vitest check-name (oltre constants.mjs)', () => {
    const CI_DIR = resolve(ROOT, 'scripts/ci');
    // Comment-aware: il literal nei docstring/commenti (es. che DESCRIVONO il
    // check name) è legittimo — solo l'uso ESEGUIBILE è drift. Salta le righe
    // che sono commenti (`//`, `*`, `/*`).
    const isCommentLine = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
    const offenders: string[] = [];
    for (const entry of readdirSync(CI_DIR, { recursive: true, encoding: 'utf-8' })) {
      if (!entry.endsWith('.mjs')) continue;
      if (entry.replace(/\\/g, '/').endsWith('lib/constants.mjs')) continue; // la source-of-truth
      const src = readFileSync(resolve(CI_DIR, entry), 'utf-8');
      const hit = src.split('\n').some((l) => l.includes('vitest (unit + integration)') && !isCommentLine(l));
      if (hit) offenders.push(entry);
    }
    expect(offenders, `script con literal hardcoded ESEGUIBILE (devono importare VITEST_CHECK_NAME): ${offenders.join(', ')}`)
      .toEqual([]);
  });
});

/**
 * Contratto single-job post de-sharding (#2882): il percorso pesante di
 * tests.yml esegue UN solo job required che contiene anche l’esecuzione —
 * non esiste più un job `vitest-shard:` con matrice. Il vecchio companion body-only aveva
 * un check distinto e non contiene la suite. `VITEST_SHARD_NAME_RE` e
 * `vitestVerdictIsTransientCancellation` RESTANO in scripts/ci/lib (dormienti):
 * senza check-run shard l'heal ritorna `false`, che è il comportamento CORRETTO
 * nel nuovo mondo — un vitest=failure sull'HEAD è sempre un fail reale, mai un
 * mascheramento da shard `cancelled` collassato dall'aggregatore. Questo guard
 * fissa il contratto single-job del percorso pesante: una futura re-introduzione
 * dello sharding DEVE aggiornare consapevolmente sia tests.yml sia l'heal (la
 * unit `vitest-check-selection.test.ts` copre la funzione).
 */
describe('vitest single-job contract (#2882 de-sharding)', () => {
  it('tests.yml ha il job `vitest:` e NESSUN job `vitest-shard:`', () => {
    expect(/^[ \t]*vitest:[ \t]*$/m.test(TESTS_YML), 'job `vitest:` mancante in tests.yml').toBe(true);
    expect(
      /^[ \t]*vitest-shard:[ \t]*$/m.test(TESTS_YML),
      'job `vitest-shard:` ancora presente — de-sharding incompleto (aggiorna anche l’heal in vitestCheck.mjs)',
    ).toBe(false);
  });

  it('VITEST_SHARD_NAME_RE resta sano: matcha un nome shard ma NON l’aggregatore', () => {
    // Dormiente ma non rotto: se lo sharding torna deve ancora distinguere i due.
    expect(VITEST_SHARD_NAME_RE.test('vitest shard 1/4')).toBe(true);
    expect(VITEST_SHARD_NAME_RE.test(VITEST_CHECK_NAME)).toBe(false);
  });
});

/**
 * Contratto del JOB FUSO: quattro cancelli nel job pesante, un check-run
 * required e nessun companion body-only. Le asserzioni verificano il
 * percorso pesante.
 *
 * `collision`, `contract`, `typecheck` e `vitest` erano quattro job. Ora sono
 * quattro famiglie di step in un job solo, e due invarianti nate da incidenti
 * reali sopravvivono solo se restano scritte qui.
 *
 * 1. IL LOCK DELLE LABEL. Il job `collision` portava un `concurrency:` proprio,
 *    gruppo `pr-collision-detector`, condiviso con lo scan periodico di
 *    `pr-collision-detector.yml`: senza, due scan concorrenti si pestano sulla
 *    label `collision-risk` — la race che ha prodotto il main-red #1454↔#1459.
 *    Le concurrency di GitHub Actions esistono solo a livello job/workflow, mai
 *    a livello step, quindi l'unico posto dove quel lock può vivere adesso è
 *    l'intero job fuso. Toglierlo «per throughput» riapre la race su dato di
 *    produzione, e non lo direbbe nessun altro segnale.
 *
 * 2. IL LOCK NON DEVE MORDERE SU MAIN. Su `push` non c'è nessuna label da
 *    contendere (gli step di collision sono `pull_request`-only) e accodare i
 *    run di main in un gruppo globale con cancellazione attiva li farebbe
 *    sfrattare da run più recenti — cioè distruggerebbe il verdetto di salute
 *    di main che il `concurrency:` top-level protegge (vedi il describe sotto).
 */
describe('job fuso: un check-run pesante, quattro cancelli, un lock', () => {
  const jobsBody = TESTS_YML.slice(TESTS_YML.indexOf('\njobs:'));
  const jobKeys = [...jobsBody.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]);
  const vitestStart = jobsBody.indexOf('\n  vitest:\n');
  const vitestTail = jobsBody.slice(vitestStart + 1);
  const nextJob = vitestTail.slice(1).search(/^ {2}[A-Za-z0-9_-]+:$/m);
  const vitestBody = nextJob === -1 ? vitestTail : vitestTail.slice(0, nextJob + 1);

  // DUE job, e la seconda meta' e' tornata fuori DELIBERATAMENTE il 2026-08-26.
  // `collision` porta un lock `concurrency` GLOBALE — il detector scrive la
  // label `collision-risk` su TUTTE le PR aperte, non solo sulla propria — e le
  // concurrency di GitHub esistono solo a livello job/workflow, mai di step.
  // Tenerlo sul job fuso metteva quindi in fila la suite da ~18 minuti di OGNI
  // PR dietro ogni altra PR aperta e dietro lo scan cron, con
  // `cancel-in-progress: false`: GitHub tiene 1 running + 1 pending, la terza
  // veniva sfrattata a `cancelled`, nessun `success`, auto-merge fermo. Ora il
  // lock copre solo i sei step di chiamate API che lo richiedono davvero.
  // `contract` e `typecheck` restano nel job che produce il check-run gating.
  // UN job pesante, di nuovo, ma per una ragione DIVERSA da quella di #6555;
  // nessun companion metadata produce un secondo check.
  // Il detector di collisioni e' uscito del tutto da questo workflow il
  // 2026-08-26: e' uno SWEEPER repo-wide (ricalcola le label di tutte le PR
  // aperte da dati vivi) e uno sweeper va su `schedule`, non su
  // `pull_request`. Vive solo in `pr-collision-detector.yml`, cron ogni 30
  // min. Cosi' le PR restano INDIPENDENTI: nessun mutex globale che accodi la
  // suite di una PR dietro quella di tutte le altre, e nessuna ✗ da run
  // sfrattato. `contract` e `typecheck` restano qui e restano bloccanti.
  it('tests.yml ha un solo job required e nessun lock di job', () => {
    expect(jobKeys).toEqual(['vitest']);
    expect(
      /^ {4}concurrency:/m.test(jobsBody),
      'un `concurrency:` di JOB e\' tornato in tests.yml: un gruppo globale ' +
        'qui accoda la suite da ~18 min di ogni PR dietro quella di tutte le ' +
        'altre (1 running + 1 pending, la terza sfrattata a `cancelled`), ed e\' ' +
        'la causa meccanica del «sopra ~5 PR aperte i merge rallentano».',
    ).toBe(false);
  });

  it('i cancelli che DEVONO essere bloccanti girano in quel job', () => {
    for (const [what, re] of [
      ['contract', /PR-body completeness \+ multi-issue Closes/],
      ['source guards', /check-sibling-patterns\.mjs/],
      ['typecheck', /npm run typecheck:gate/],
      ['vitest related', /run-related-tests\.mjs/],
    ] as const) {
      expect(re.test(vitestBody), `famiglia \`${what}\` non trovata nel job pesante`).toBe(true);
    }
  });

  // Il detector NON deve rientrare qui. Se qualcuno lo rimette, si riporta
  // dietro il suo `concurrency` globale — e con esso la serializzazione della
  // suite fra PR — oppure lo lascia senza lock, riaprendo la race sulle label
  // (main-red #1454↔#1459). Il posto giusto e' `pr-collision-detector.yml`.
  it('il detector di collisioni NON vive in tests.yml', () => {
    expect(
      /pr-collision-detector\.mjs/.test(vitestBody),
      'il detector e\' tornato in tests.yml: e\' uno sweeper repo-wide e va su ' +
        'cron in pr-collision-detector.yml, non su un evento per-PR.',
    ).toBe(false);
  });

  it('il detector non può cancellare run tests tramite concurrency condivisa', () => {
    // Il detector è uno sweeper repo-wide: deve partire solo da schedule/dispatch.
    // Se torna su pull_request e condivide il lock `pr-collision-detector`, una
    // run del detector può sfrattare il test della PR (incidente run 32965583372).
    expect(COLLISION_YML).not.toMatch(/^\s+pull_request:/m);
    expect(COLLISION_YML).toMatch(/concurrency:\s*\n\s+group:\s*pr-collision-detector/);
    expect(COLLISION_YML).toMatch(/cancel-in-progress:\s*false/);
    expect(TESTS_CODE).not.toContain('pr-collision-detector');
  });

  it('limita i worker del related run per evitare oversubscription', () => {
    const vitestRuns = [...TESTS_YML.matchAll(/- name: vitest related \([^\n]+\)[\s\S]*?(?=\n      - name:|\n      #|$)/g)].map(
      (match) => match[0],
    );
    expect(vitestRuns).toHaveLength(1);
    for (const run of vitestRuns) {
      expect(run).toContain('VITEST_MAX_WORKERS: 1');
      expect(run).toContain('VITEST_POOL: forks');
    }
    expect(TESTS_YML).toContain('node_modules/.vite-related');
  });

  it('include tutti i root applicativi nel grafo related', () => {
    // La selezione dei file del grafo vive in `lib/related-graph-scope.mjs`:
    // il runner e il guard dello sparse-checkout qui sotto devono leggerla
    // dalla STESSA sede, o il guard certifica un insieme che il runner non usa.
    expect(RELATED_RUNNER).toContain('isGraphSourceFile');
    expect(RELATED_SCOPE).toContain('GRAPH_PROJECT_RE');
    expect(RELATED_RUNNER).toContain('!alwaysExcludedTests.has(file)');
    expect(RELATED_SCOPE).toContain("file.startsWith('.github/')");
    expect(RELATED_SCOPE).toContain("!file.includes('/')");
    expect(RELATED_RUNNER).toContain('file !== \'scripts/ci/run-related-tests.mjs\'');
    expect(RELATED_RUNNER).toContain('sourceRe.test(file)');
    expect(RELATED_RUNNER).not.toContain('implicitTestDependencyRe');
    expect(RELATED_RUNNER).toContain('No static related edge found');
    expect(RELATED_RUNNER).toContain('const visited = new Set()');
    expect(RELATED_RUNNER).toContain('function stripComments');
    expect(RELATED_RUNNER).toContain('CHANGED_PATHS_STATUS_FILE');
    expect(RELATED_RUNNER).toContain("changedStatus !== 'complete'");
    expect(RELATED_RUNNER).toContain('listCorpusWideTests');
    expect(RELATED_RUNNER).toContain('VITEST_SKIP_CORPUS_WIDE');
  });

  it('tests.yml conserva allow-list sparse e fail-safe del corpus', () => {
    expect(TESTS_YML).toContain('sparse-checkout: |');
    expect(TESTS_YML).toContain('sparse-checkout-cone-mode: false');
    expect(TESTS_YML).toContain('!/public/images/');
    expect(TESTS_YML).toContain('changed-paths-status.txt');
    expect(TESTS_YML).toContain('partial > changed-paths-status.txt');
    expect(TESTS_YML).toContain('frontaliere-articles');
    expect(TESTS_YML).toContain('/REVIEW.md');
    expect(TESTS_YML).toContain('/AGENTS.md');
    expect(TESTS_YML).toContain('/firestore.rules');
    expect(TESTS_YML).toContain('/docs/preferred-sources-checklist.md');
    expect(TESTS_YML).toContain('/packages/articles/content/blog-body/*/assistente-ai-frontalieri.ts');
    expect(TESTS_YML).toContain('hard repository-tool budget');
  });

  it('materializza gli artifact del diff anche nel workflow_dispatch manuale', () => {
    const collector = TESTS_YML.match(/- name: Collect changed paths[\s\S]*?(?=\n      - name:)/)?.[0] || '';
    expect(collector).toContain("github.event_name == 'workflow_dispatch'");
    expect(collector).toContain(': > changed-paths.txt');
    expect(collector).toContain('changed-paths-status.txt');
  });

  it('usa un bundle deterministico e non scarica il diff completo nelle review incrementali', () => {
    expect(TESTS_YML).toContain('review-bundle.md');
    const prefetch = YAML.parse(TESTS_YML).jobs.vitest.steps.find((step: any) => step.id === 'prefetch');
    expect(prefetch.env.INCREMENTAL_BASE).toBe('${{ steps.tier.outputs.incremental_base }}');
    expect(prefetch.run).toContain('node scripts/ci/prefetch-review-diff.mjs || exit 1');
    expect(prefetch.run).not.toContain('gh pr diff');
    expect(TESTS_YML).toContain('review-code-files.txt');
    expect(TESTS_YML).toContain('delta-files.txt');
    expect(TESTS_YML).toContain('set_tier incremental-high claude-opus-5 35');
    expect(TESTS_YML).toContain('set_tier incremental claude-opus-5 35');
    expect(TESTS_YML).toContain('Read `REVIEW.md` first');
  });

  it('abilita e persiste la Node compile cache del job comune', () => {
    expect(TESTS_YML).toContain('NODE_COMPILE_CACHE: node_modules/.cache/node-compile');
    expect(TESTS_YML).toContain('node_modules/.cache/node-compile');
  });

  // Il lock non e' piu' CONDIZIONALE, e' CIRCOSCRITTO: sta su un job che
  // esiste solo su `pull_request`. La proprieta' da difendere e' sempre la
  // stessa — i run di `push` su main non devono accodarsi in un gruppo globale
  // con `cancel-in-progress: false`, o si distrugge il verdetto di salute di
  // main (14 run su 30 cancellati, 47%) — ma ora la ottiene il `if:` del job
  // invece di un'espressione dentro `group:`. Piu' semplice e piu' difficile da
  // rompere: se il job non parte, non c'e' nessun gruppo da contendere.


  // Fondere i job fonde anche gli AMBIENTI, e questo è costato un giro di CI.
  // `scripts/load-rc-env.mjs` scrive ~92 variabili di Remote Config su
  // `$GITHUB_ENV`, che vale per TUTTI gli step successivi dello stesso job —
  // non solo per quello che l'ha eseguito. Finché `collision` era un job a sé
  // vitest non vedeva mai quell'ambiente; nel job fuso lo vedeva, e 14 test su
  // 11 file sono andati rossi (run 32937626053): tutti quelli che asseriscono
  // un comportamento a ambiente pulito — «rejects when no email provider
  // configured», «is a no-op when POSTHOG_EMAIL_EXPERIMENT is unset» (nel log
  // la RC caricava `POSTHOG_EMAIL_EXPERIMENT: 1`), «an empty environment mints
  // the pre-#5685 code». Il rimedio è l'ORDINE, quindi va difeso l'ordine.
  // Invariante RAFFORZATA il 2026-08-26. Prima si difendeva un ORDINE («la
  // famiglia collision per ultima»), cioe' una convenzione che il prossimo
  // edit poteva rompere in silenzio. Ora `load-rc-env.mjs` non sta piu' in
  // questo workflow affatto: l'inquinamento di `$GITHUB_ENV` — ~92 variabili
  // di Remote Config visibili a OGNI step successivo dello stesso job, che
  // avevano reso rossi 14 test su 11 file (run 32937626053, tutti quelli che
  // asseriscono un comportamento a ambiente PULITO) — e' impossibile per
  // costruzione, non per ordinamento.
  it('nessun segreto di Remote Config viene caricato in questo workflow', () => {
    expect(
      /load-rc-env\.mjs/.test(TESTS_YML),
      'load-rc-env.mjs e\' tornato in tests.yml: scrive ~92 variabili su ' +
        '$GITHUB_ENV, visibili a ogni step successivo dello stesso job, e ' +
        'vitest ha test che asseriscono un ambiente PULITO.',
    ).toBe(false);
  });

  it('ogni famiglia sopravvive al rosso di un’altra (`!cancelled()`)', () => {
    // Le famiglie indipendenti sono orchestrate da due step: il primo attende
    // i source guard, il secondo raccoglie i gate detached. Entrambi devono
    // partire anche se un gate precedente ha fallito; il body contract resta
    // invece una precondizione esplicita per non eseguire codice dopo un body
    // PR non valido.
    for (const first of [
      'Run source guards in parallel',
      'Start independent source gates',
    ]) {
      const step = (YAML.parse(TESTS_YML) as any).jobs.vitest.steps.find(
        (candidate: any) => candidate?.name === first,
      );
      expect(step, `step \`${first}\` senza \`if:\``).toBeTruthy();
      expect(step.if, `\`${first}\` non ha \`!cancelled()\`: un cancello rosso a monte lo spegne`)
        .toContain('!cancelled()');
    }
  });
});

/**
 * Il verdetto su main deve poter ARRIVARE IN FONDO.
 *
 * I push diretti su main e le merge queue devono attraversare lo stesso gate
 * blocking della PR: il verde deve restare una prova anche fuori dal percorso
 * pull request. Le PR usano invece newest-wins perché l'head precedente
 * diventa irrilevante quando arriva un nuovo commit.
 *
 * AGENTS.md fa dipendere una regola operativa esplicita da questo segnale
 * («main rosso blocca a cascata, priorità assoluta main verde»): senza verdetto
 * la regola non è applicabile e una regressione su main resta invisibile finché
 * non la eredita per caso una PR.
 *
 * Il contratto fissato qui: tests.yml valida PR, push diretti su main e merge
 * queue. Questo test fallisce se uno dei trigger viene rimosso senza aggiornare
 * esplicitamente il comportamento atteso.
 */
describe('main health-signal contract (verdetto non cancellabile)', () => {
  const concurrencyBlock = (() => {
    // Blocco `concurrency:` top-level (non indentato) fino alla prossima chiave
    // top-level. Evita di matchare un eventuale `concurrency:` di job.
    const m = TESTS_YML.match(/^concurrency:\s*\n((?:[ \t]+.*\n?)*)/m);
    return m ? m[1] : '';
  })();

  it('il blocco concurrency top-level esiste ed è parsabile', () => {
    expect(concurrencyBlock, 'blocco `concurrency:` top-level non trovato in tests.yml').not.toBe('');
    expect(concurrencyBlock).toMatch(/cancel-in-progress:/);
  });

  it('cancel-in-progress è newest-wins solo per PR e dispatch manuali', () => {
    const m = concurrencyBlock.match(/cancel-in-progress:\s*(.+?)\s*$/m);
    expect(m, '`cancel-in-progress:` non trovato').toBeTruthy();
    const value = (m![1] || '').replace(/^['"]|['"]$/g, '');
    expect(value).toMatch(/github\.event_name\s*==\s*'pull_request'/);
    expect(value).toMatch(/github\.event_name\s*==\s*'workflow_dispatch'/);
    expect(value).not.toMatch(/github\.event_name\s*==\s*'push'/);
    expect(value).not.toMatch(/github\.event_name\s*==\s*'merge_group'/);
  });

  it('lancia la suite sui push diretti a main', () => {
    const onBlock = TESTS_YML.match(/^on:\s*\n((?:[ \t]+.*\n?|\s*#.*\n)*)/m)?.[1] ?? '';
    expect(/push:\s*\n\s*branches:\s*\[?\s*main/.test(onBlock), 'tests.yml deve avere un trigger push su main').toBe(true);
  });

  it('mantiene i trigger PR, push main e merge queue', () => {
    expect(TESTS_YML).toMatch(/^\s+pull_request:\s*$/m);
    expect(TESTS_YML).toMatch(/^\s+merge_group:\s*$/m);
  });

  it('prepara il diff per merge_group prima del related runner', () => {
    const start = TESTS_YML.indexOf('- name: Collect changed paths');
    const end = TESTS_YML.indexOf('\n      - name:', start + 1);
    const collectStep = TESTS_YML.slice(start, end < 0 ? undefined : end);
    expect(collectStep).toContain("github.event_name == 'merge_group'");
    expect(collectStep).toContain('MERGE_GROUP_BASE_SHA');
    expect(collectStep).toContain('github.event.merge_group.base_sha');
    expect(collectStep).toContain('compare_base="$BEFORE_SHA"');
    expect(collectStep).toContain('compare_base="$MERGE_GROUP_BASE_SHA"');
    const branchStart = collectStep.indexOf('elif [ "$GITHUB_EVENT_NAME" = "merge_group" ]; then');
    const branchEnd = collectStep.indexOf('\n          else', branchStart);
    const missingMergeGroupBase = collectStep.slice(branchStart, branchEnd < 0 ? undefined : branchEnd);
    expect(missingMergeGroupBase).toContain(': > changed-paths.txt');
    expect(missingMergeGroupBase).toMatch(/printf '%s\\n' error > changed-paths-status\.txt/);
  });

  it('il gate Number gira su ogni percorso che può portare codice su main', () => {
    const start = TESTS_YML.indexOf('- name: Run source guards in parallel');
    const end = TESTS_YML.indexOf('\n      - name:', start + 1);
    const step = TESTS_YML.slice(start, end < 0 ? undefined : end);
    expect(start, 'source guard orchestrator non trovato').toBeGreaterThanOrEqual(0);
    expect(step).toContain('check-number-env-fallback.mjs');
    expect(step).toContain("github.event_name == 'push'");
    expect(step).toContain("github.event_name == 'merge_group'");
    expect(step).toContain("github.event_name == 'pull_request'");
    expect(step).toContain('continue-on-error: true');
  });
});
