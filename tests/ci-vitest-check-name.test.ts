import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { VITEST_CHECK_NAME, VITEST_SHARD_NAME_RE } from '../scripts/ci/lib/constants.mjs';

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
const AUTOREBASE = readFileSync(resolve(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf-8');
const AUTO_MERGE_EVAL = readFileSync(resolve(ROOT, 'scripts/ci/auto-merge-eval.mjs'), 'utf-8');

describe('VITEST_CHECK_NAME (#1602 drift guard)', () => {
  it('matcha byte-per-byte il name: del job vitest in tests.yml', () => {
    // Estrae il `name:` del job `vitest:` (può essere quotato o no).
    const m = TESTS_YML.match(/^\s*vitest:\s*\n\s*name:\s*(.+?)\s*$/m);
    expect(m, 'job `vitest:` con `name:` non trovato in tests.yml').toBeTruthy();
    const jobName = (m![1] || '').replace(/^['"]|['"]$/g, '');
    expect(jobName).toBe(VITEST_CHECK_NAME);
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
 * Contratto single-job post de-sharding (#2882): tests.yml esegue UN solo job
 * `vitest (unit + integration)` — non esiste più un job `vitest-shard:` con
 * matrice. `VITEST_SHARD_NAME_RE` e `vitestVerdictIsTransientCancellation`
 * RESTANO in scripts/ci/lib (dormienti): senza check-run shard l'heal ritorna
 * `false`, che è il comportamento CORRETTO nel nuovo mondo — un vitest=failure
 * sull'HEAD è sempre un fail reale, mai un mascheramento da shard `cancelled`
 * collassato dall'aggregatore. Questo guard fissa il contratto single-job: una
 * futura re-introduzione dello sharding DEVE aggiornare consapevolmente sia
 * tests.yml sia l'heal (la unit `vitest-check-selection.test.ts` copre la funzione).
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
 * Contratto del JOB FUSO: quattro cancelli, un check-run, un lock.
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
 *    run di main in un gruppo globale con `cancel-in-progress: false` li farebbe
 *    sfrattare da run più recenti — cioè distruggerebbe il verdetto di salute di
 *    main che il `concurrency:` top-level protegge (vedi il describe sotto).
 */
describe('job fuso: un check-run, quattro cancelli, un lock', () => {
  const jobsBody = TESTS_YML.slice(TESTS_YML.indexOf('\njobs:'));
  const jobKeys = [...jobsBody.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]);

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
  // UN job solo, di nuovo, ma per una ragione DIVERSA da quella di #6555.
  // Il detector di collisioni e' uscito del tutto da questo workflow il
  // 2026-08-26: e' uno SWEEPER repo-wide (ricalcola le label di tutte le PR
  // aperte da dati vivi) e uno sweeper va su `schedule`, non su
  // `pull_request`. Vive solo in `pr-collision-detector.yml`, cron ogni 30
  // min. Cosi' le PR restano INDIPENDENTI: nessun mutex globale che accodi la
  // suite di una PR dietro quella di tutte le altre, e nessuna ✗ da run
  // sfrattato. `contract` e `typecheck` restano qui e restano bloccanti.
  it('tests.yml ha un job solo, e nessun lock di job', () => {
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
      ['vitest', /npm test --/],
    ] as const) {
      expect(re.test(jobsBody), `famiglia \`${what}\` non trovata nel job fuso`).toBe(true);
    }
  });

  // Il detector NON deve rientrare qui. Se qualcuno lo rimette, si riporta
  // dietro il suo `concurrency` globale — e con esso la serializzazione della
  // suite fra PR — oppure lo lascia senza lock, riaprendo la race sulle label
  // (main-red #1454↔#1459). Il posto giusto e' `pr-collision-detector.yml`.
  it('il detector di collisioni NON vive in tests.yml', () => {
    expect(
      /pr-collision-detector\.mjs/.test(jobsBody),
      'il detector e\' tornato in tests.yml: e\' uno sweeper repo-wide e va su ' +
        'cron in pr-collision-detector.yml, non su un evento per-PR.',
    ).toBe(false);
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
    // Con quattro job paralleli un `contract` rosso non impediva a `vitest` di
    // girare. Con gli step la proprietà si perde a meno di dirla esplicitamente.
    for (const first of [
      'PR-body completeness + multi-issue Closes',
      'tsc --noEmit (baseline + ratchet)',
      'Audit no merge conflict markers',
    ]) {
      const re = new RegExp(`- name: ${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n(?:\\s*#[^\\n]*\\n)*\\s*if:\\s*(.+?)\\s*$`, 'm');
      const m = re.exec(jobsBody);
      expect(m, `step \`${first}\` senza \`if:\``).toBeTruthy();
      expect(m![1], `\`${first}\` non ha \`!cancelled()\`: un cancello rosso a monte lo spegne`)
        .toContain('!cancelled()');
    }
  });
});

/**
 * Il verdetto su main deve poter ARRIVARE IN FONDO.
 *
 * `github.ref` di un push su main è sempre `refs/heads/main`, quindi TUTTI i
 * push su main cadono nello stesso concurrency group. Con
 * `cancel-in-progress: true` ogni merge uccideva il run del merge precedente:
 * la suite dura ~9 min, auto-merge mergia ogni 2-5 min durante uno smaltimento
 * di backlog → 14 run cancellati su 30 (47%) e nessun verdetto proprio nelle
 * finestre in cui una regressione è più probabile.
 *
 * AGENTS.md fa dipendere una regola operativa esplicita da questo segnale
 * («main rosso blocca a cascata, priorità assoluta main verde»): senza verdetto
 * la regola non è applicabile e una regressione su main resta invisibile finché
 * non la eredita per caso una PR.
 *
 * Il contratto fissato qui: newest-wins SOLO dove cancellare non distrugge
 * informazione (PR: l'head vecchio è irrilevante), mai sul push a main.
 * Questo test fallisce se qualcuno rimette `cancel-in-progress: true` secco.
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

  it('cancel-in-progress NON è true incondizionato (ucciderebbe il verdetto su main)', () => {
    const m = concurrencyBlock.match(/cancel-in-progress:\s*(.+?)\s*$/m);
    expect(m, '`cancel-in-progress:` non trovato').toBeTruthy();
    const value = (m![1] || '').replace(/^['"]|['"]$/g, '');
    expect(
      value === 'true',
      'cancel-in-progress: true incondizionato → ogni merge su main cancella il run del merge ' +
        'precedente e main non produce mai un verdetto. Condizionalo sull\'evento ' +
        '(es. `${{ github.event_name != \'push\' }}`).',
    ).toBe(false);
  });

  it('la condizione esclude il push (main) dalla cancellazione', () => {
    const m = concurrencyBlock.match(/cancel-in-progress:\s*(.+?)\s*$/m);
    const value = (m![1] || '').replace(/^['"]|['"]$/g, '');
    // Deve essere un'espressione che nomina l'evento, non un literal.
    expect(
      /\$\{\{.*github\.event_name.*\}\}/.test(value),
      `cancel-in-progress deve dipendere da github.event_name, trovato: ${value}`,
    ).toBe(true);
    // E deve escludere il push: `!= 'push'` (o equivalente esplicito su pull_request).
    expect(
      /github\.event_name\s*!=\s*'push'/.test(value) ||
        /github\.event_name\s*==\s*'pull_request'/.test(value),
      `la condizione deve escludere il push su main dalla cancellazione, trovato: ${value}`,
    ).toBe(true);
  });

  it('tests.yml gira ancora sul push a main (il segnale esiste)', () => {
    // Se qualcuno togliesse il trigger push il test sopra passerebbe a vuoto.
    const onBlock = TESTS_YML.match(/^on:\s*\n((?:[ \t]+.*\n?|\s*#.*\n)*)/m)?.[1] ?? '';
    expect(/push:\s*\n\s*branches:\s*\[?\s*main/.test(onBlock), 'trigger `push: branches: [main]` mancante').toBe(true);
  });
});
