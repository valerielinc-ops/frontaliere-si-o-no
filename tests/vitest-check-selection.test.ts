/**
 * latestCompletedVitestConclusion — selezione robusta del verdetto vitest
 * sull'HEAD usata dal gate auto-merge (auto-merge-eval.mjs) e da pr-autorebase.
 *
 * Regressione #2394: un SHA immutabile può portare PIÙ check-run con lo stesso
 * nome `vitest (unit + integration)` (run `pull_request` + workflow_dispatch
 * manuali di tests.yml). Il vecchio `[...][0].conclusion` ne pescava uno per
 * ordine API: un dispatch cancellato (→ `failure`) poteva mascherare il
 * `success` reale → auto-merge bloccato pur coi test verdi. Qui fissiamo che
 * vince l'ultimo COMPLETATO per `completed_at`, ignorando i run in-progress.
 */
import { describe, it, expect } from 'vitest';
import {
  latestCompletedVitestConclusion,
  latestCompletedRunByName,
  latestCompletedConclusionByName,
  vitestVerdictIsTransientCancellation,
  vitestFailureIsNotAttributableToPr,
} from '../scripts/ci/lib/vitestCheck.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

const vitest = (conclusion: string | null, completed_at: string | null, status = 'completed') => ({
  name: VITEST_CHECK_NAME,
  status,
  conclusion,
  completed_at,
});

describe('latestCompletedVitestConclusion (#2394 stale-check-run guard)', () => {
  it('scenario #2394: dispatch cancellato (failure, più vecchio) + success (più recente) → success', () => {
    const runs = [
      vitest('failure', '2026-06-17T07:59:55Z'), // workflow_dispatch cancellato
      vitest('success', '2026-06-17T08:07:03Z'), // pull_request verde, più recente
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('ordine API inverso non cambia il verdetto (invariante all’ordine)', () => {
    const runs = [
      vitest('success', '2026-06-17T08:07:03Z'),
      vitest('failure', '2026-06-17T07:59:55Z'),
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('regressione reale: success (vecchio) + failure (più recente) → failure (blocca)', () => {
    const runs = [
      vitest('success', '2026-06-17T08:00:00Z'),
      vitest('failure', '2026-06-17T08:30:00Z'),
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('failure');
  });

  it('un run in-progress (senza completed_at) NON blocca: vince l’ultimo completato', () => {
    const runs = [
      vitest('success', '2026-06-17T08:07:03Z'),
      vitest(null, null, 'in_progress'), // dispatch manuale appeso
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('nessun vitest concluso (solo pending) → "" (gate attende, invariante #1454)', () => {
    expect(latestCompletedVitestConclusion([vitest(null, null, 'queued')])).toBe('');
  });

  it('nessun check-run vitest presente → ""', () => {
    const runs = [{ name: 'lighthouse', status: 'completed', conclusion: 'success', completed_at: '2026-06-17T08:00:00Z' }];
    expect(latestCompletedVitestConclusion(runs)).toBe('');
  });

  it('ignora check-run con altro nome anche se più recenti', () => {
    const runs = [
      vitest('success', '2026-06-17T08:00:00Z'),
      { name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-06-17T09:00:00Z' },
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('input non-array → "" (difensivo, niente throw)', () => {
    expect(latestCompletedVitestConclusion(undefined as unknown as [])).toBe('');
    expect(latestCompletedVitestConclusion(null as unknown as [])).toBe('');
  });
});

/**
 * vitestVerdictIsTransientCancellation (#2438): l'aggregatore `vitest (unit +
 * integration)` collassa OGNI shard non-`success` (incluso `cancelled` da
 * concurrency) in un unico `failure`. Il helper riapre gli shard per distinguere
 * una cancellazione transient (sicura da ri-dispatchare / heal) da un test rotto
 * reale (NON ri-eseguire). Una PR LGTM+behind=0 con questo `failure` transient
 * altrimenti resta ferma: pr-autorebase la skippava, auto-merge esige `success`.
 */
const agg = (conclusion: string | null, completed_at: string | null, status = 'completed') => ({
  name: VITEST_CHECK_NAME,
  status,
  conclusion,
  completed_at,
});
const shard = (n: number, conclusion: string | null, status = 'completed') => ({
  name: `vitest shard ${n}/4`,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-06-17T08:00:00Z' : null,
});
const cancelledRun = [
  agg('failure', '2026-06-17T08:05:00Z'),
  shard(1, 'cancelled'),
  shard(2, 'cancelled'),
  shard(3, 'success'),
  shard(4, 'cancelled'),
];

describe('vitestVerdictIsTransientCancellation (#2438 cancelled→failure heal)', () => {
  it('aggregatore failure + shard cancelled (nessun fail reale) → true (heal)', () => {
    expect(vitestVerdictIsTransientCancellation(cancelledRun)).toBe(true);
  });

  it('tutti gli shard cancellati → true', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'cancelled'),
        shard(2, 'cancelled'),
        shard(3, 'cancelled'),
        shard(4, 'cancelled'),
      ]),
    ).toBe(true);
  });

  it('un shard FAILURE reale (+ altri cancelled) → false (NON ri-eseguire, AGENTS #5)', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'failure'),
        shard(2, 'cancelled'),
        shard(3, 'success'),
        shard(4, 'cancelled'),
      ]),
    ).toBe(false);
  });

  it('uno shard timed_out → false (fail reale, non transient)', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'timed_out'),
        shard(2, 'cancelled'),
        shard(3, 'cancelled'),
        shard(4, 'cancelled'),
      ]),
    ).toBe(false);
  });

  it('nessuno shard cancelled (failure aggregato senza cancellazioni) → false', () => {
    // Difensivo: aggregatore failure ma shard tutti success (es. aggregatore
    // rosso per ragione propria) → niente cancellazione da sanare.
    expect(
      vitestVerdictIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'success'),
        shard(2, 'success'),
        shard(3, 'success'),
        shard(4, 'success'),
      ]),
    ).toBe(false);
  });

  it('run fresco pendente (shard in_progress) → false (attende, non ri-dispatcha)', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        ...cancelledRun,
        shard(1, null, 'in_progress'),
      ]),
    ).toBe(false);
  });

  it('aggregatore in_progress sopra agli shard cancellati → false (run fresco pendente)', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        ...cancelledRun,
        agg(null, null, 'queued'),
      ]),
    ).toBe(false);
  });

  it('ultimo aggregatore COMPLETATO è success (run fresco già verde) → false', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        ...cancelledRun,
        agg('success', '2026-06-17T08:20:00Z'),
        shard(1, 'success'),
        shard(2, 'success'),
        shard(3, 'success'),
        shard(4, 'success'),
      ]),
    ).toBe(false);
  });

  it('aggregatore failure ma NESSUN check-run shard presente → false', () => {
    expect(
      vitestVerdictIsTransientCancellation([agg('failure', '2026-06-17T08:05:00Z')]),
    ).toBe(false);
  });

  it('nessun check-run vitest del tutto → false', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        { name: 'lighthouse', status: 'completed', conclusion: 'success', completed_at: '2026-06-17T08:00:00Z' },
      ]),
    ).toBe(false);
  });

  it('input non-array → false (difensivo, niente throw)', () => {
    expect(vitestVerdictIsTransientCancellation(undefined as unknown as [])).toBe(false);
    expect(vitestVerdictIsTransientCancellation(null as unknown as [])).toBe(false);
  });
});

/**
 * Topologia CORRENTE (job singolo, post de-sharding #2882): `tests.yml` non ha
 * più la matrice `vitest shard i/4`, quindi una cancellazione da concurrency non
 * viene collassata in `failure` — atterra come `cancelled` DIRETTAMENTE sul
 * check-run `vitest (unit + integration)`.
 *
 * Prima del 2026-08-05 nessun ramo copriva quel verdetto: il helper esigeva
 * `failure` + shard (che non esistono più → sempre `false`, ramo inerte) e
 * `vitestFailureIsNotAttributableToPr` esige anch'esso `failure`. Un head con
 * ultimo verdetto `cancelled` e nessun run in volo era quindi nello stesso stato
 * ASSORBENTE delle 8 PR: auto-merge esige `success`, pr-review-loop gira solo su
 * tests verdi (⇒ niente review, niente LGTM, niente label), pr-autorebase senza
 * label/LGTM/stuck-red skippa.
 *
 * Un `cancelled` è sicuro da ri-eseguire per costruzione: il run non ha prodotto
 * NESSUN verdetto sul codice, quindi il re-run non può mascherare un test rotto
 * (AGENTS #5 resta rispettato — non si ri-esegue mai un `failure` reale).
 */
describe('vitestVerdictIsTransientCancellation — topologia a job singolo (cancelled diretto)', () => {
  it('ultimo verdetto `cancelled`, nessuno shard, nessun run in volo → true (heal)', () => {
    expect(vitestVerdictIsTransientCancellation([agg('cancelled', '2026-08-05T07:26:00Z')])).toBe(true);
  });

  it('`cancelled` seguito da un `success` più recente → false (già sanato da sé)', () => {
    // Caso reale osservato su #5070/#5072 il 2026-08-05: il rollup mostrava
    // ancora il `cancelled` delle 07:26 accanto al `success` delle 07:36. Vince
    // il più recente per `completed_at`, non l'ordine API (#2394).
    expect(
      vitestVerdictIsTransientCancellation([
        agg('cancelled', '2026-08-05T07:26:00Z'),
        agg('success', '2026-08-05T07:36:32Z'),
      ]),
    ).toBe(false);
  });

  it('`success` più VECCHIO di un `cancelled` → true (il verdetto valido è il cancelled)', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        agg('success', '2026-08-05T07:10:00Z'),
        agg('cancelled', '2026-08-05T07:36:00Z'),
      ]),
    ).toBe(true);
  });

  it('`cancelled` ma un run fresco è già in volo → false (si risolve da sé, niente CI sprecata)', () => {
    expect(
      vitestVerdictIsTransientCancellation([
        agg('cancelled', '2026-08-05T07:26:00Z'),
        agg(null, null, 'in_progress'),
      ]),
    ).toBe(false);
  });

  it('`failure` senza shard resta NON sanabile → false (è il ramo di vitestFailureIsNotAttributableToPr)', () => {
    // Guardia di non-sovrapposizione: i due predicati si escludono sul valore di
    // `conclusion`. Un `failure` ha prodotto un verdetto sul codice e va trattato
    // come reale finché non c'è prova positiva del contrario (AGENTS #5).
    expect(vitestVerdictIsTransientCancellation([agg('failure', '2026-08-05T07:26:00Z')])).toBe(false);
  });

  it('`timed_out` / `action_required` → false (verdetti reali, non cancellazioni)', () => {
    expect(vitestVerdictIsTransientCancellation([agg('timed_out', '2026-08-05T07:26:00Z')])).toBe(false);
    expect(vitestVerdictIsTransientCancellation([agg('action_required', '2026-08-05T07:26:00Z')])).toBe(false);
  });
});

/**
 * vitestFailureIsNotAttributableToPr — l'escape hatch dello stato ASSORBENTE
 * misurato il 2026-08-05 su 8 PR (#5019 #5067 #5068 #5070 #5072 #5073 #5074
 * #5085), tutte con `vitest (unit + integration)` come UNICO check rosso.
 *
 * `tests.yml` gira sul MERGE REF, quindi il verdetto include il codice di main:
 * main rosso 2026-08-02T09:14Z→2026-08-04T13:37Z ⇒ ogni PR testata in quella
 * finestra ha ereditato il rosso. Da lì non si esce: pr-review-loop richiede
 * `tests` success (niente review ⇒ niente LGTM ⇒ niente label), stale-pr-rescuer
 * richiede tests success o una review 🔴, pr-autorebase richiede LGTM/label.
 * Questa funzione è l'unico arco uscente, e deve restare STRETTA: si ri-testa
 * solo con prova positiva che il rosso non è della PR.
 */
describe('vitestFailureIsNotAttributableToPr (stato assorbente stuck-red)', () => {
  const FAILED_AT = '2026-08-04T12:10:35Z'; // vitest reale di PR #5085
  const NOW = Date.parse('2026-08-05T06:30:00Z');
  const redHead = [vitest('failure', FAILED_AT)];
  const mainRun = (conclusion: string, updated_at: string) => ({ conclusion, updated_at });

  it('main tornato VERDE dopo il test della PR → rescue red-main', () => {
    // main green run reale: 2026-08-04T18:02Z (commit 3641631c), dopo le 12:10Z.
    expect(
      vitestFailureIsNotAttributableToPr({
        checkRuns: redHead,
        mainTestsRuns: [mainRun('success', '2026-08-04T18:02:25Z'), mainRun('failure', '2026-08-04T13:37:59Z')],
        nowMs: NOW,
      }),
    ).toEqual({ rescue: true, reason: 'red-main' });
  });

  it('main verde solo PRIMA del test della PR → nessun rescue (il rosso è suo)', () => {
    expect(
      vitestFailureIsNotAttributableToPr({
        checkRuns: [vitest('failure', '2026-08-05T06:00:00Z')],
        mainTestsRuns: [mainRun('success', '2026-08-04T18:02:25Z')],
        nowMs: NOW,
      }),
    ).toEqual({ rescue: false, reason: '' });
  });

  it('main rosso anche dopo → nessun rescue (rebasare non farebbe ereditare nulla di buono)', () => {
    expect(
      vitestFailureIsNotAttributableToPr({
        checkRuns: redHead,
        mainTestsRuns: [mainRun('failure', '2026-08-04T19:00:00Z'), mainRun('cancelled', '2026-08-04T20:00:00Z')],
        nowMs: NOW,
        staleHours: 0,
      }),
    ).toEqual({ rescue: false, reason: '' });
  });

  it('backstop stale: rosso >24h con main sempre verde → rescue stale (caso INFRA #5019)', () => {
    // #5019 è morta il 2026-08-01T08:17Z su `RPC failed; curl 56` + runner
    // shutdown durante il CHECKOUT (zero test eseguiti) mentre main era VERDE:
    // `red-main` non la copre, il backstop sì.
    expect(
      vitestFailureIsNotAttributableToPr({
        checkRuns: [vitest('failure', '2026-08-01T08:17:38Z')],
        mainTestsRuns: [mainRun('success', '2026-07-31T01:52:46Z')],
        nowMs: NOW,
      }),
    ).toEqual({ rescue: true, reason: 'stale' });
  });

  it('rosso FRESCO (<24h) e main mai tornato verde dopo → nessun rescue', () => {
    expect(
      vitestFailureIsNotAttributableToPr({
        checkRuns: [vitest('failure', '2026-08-05T05:00:00Z')],
        mainTestsRuns: [mainRun('success', '2026-08-04T18:02:25Z')],
        nowMs: NOW,
      }),
    ).toEqual({ rescue: false, reason: '' });
  });

  it('run vitest già in volo sull\'head → nessun rescue (si risolve da sé)', () => {
    expect(
      vitestFailureIsNotAttributableToPr({
        checkRuns: [vitest('failure', FAILED_AT), vitest(null, null, 'in_progress')],
        mainTestsRuns: [mainRun('success', '2026-08-04T18:02:25Z')],
        nowMs: NOW,
      }),
    ).toEqual({ rescue: false, reason: '' });
  });

  it('vitest VERDE sull\'head → nessun rescue', () => {
    expect(
      vitestFailureIsNotAttributableToPr({
        checkRuns: [vitest('success', FAILED_AT)],
        mainTestsRuns: [mainRun('success', '2026-08-04T18:02:25Z')],
        nowMs: NOW,
      }),
    ).toEqual({ rescue: false, reason: '' });
  });

  it('input assenti/non-array → nessun rescue (difensivo, niente throw)', () => {
    expect(vitestFailureIsNotAttributableToPr()).toEqual({ rescue: false, reason: '' });
    expect(
      vitestFailureIsNotAttributableToPr({ checkRuns: redHead, mainTestsRuns: null, staleHours: 0 }),
    ).toEqual({ rescue: false, reason: '' });
  });
});

/**
 * La generalizzazione a un check-run name arbitrario (corpus #242/#252).
 *
 * PERCHE' STA QUI, e non solo sul corpus. `scripts/ci/lib/vitestCheck.mjs` e'
 * `mode: identical` in `scripts/ci/loop-sync-manifest.json`: la sorgente di
 * verita' e' QUESTO repo, e il mirror copia il sito sul corpus. La
 * generalizzazione era nata di la' per far gattare l'auto-merge sul check
 * `test` di `generator-ci.yml` — che qui non esiste — ma il file su cui era
 * scritta e' dichiarato uguale ai due lati: al mirror successivo sarebbe stata
 * cancellata, senza errori e senza segnale, e `auto-merge-eval.mjs` del corpus
 * (che importa `latestCompletedConclusionByName`) sarebbe rimasto senza il suo
 * import.
 *
 * Il consumer resta di la' (il gate `generator-ci` dipende da
 * `GENERATOR_CI_TRIGGER_PATHS`, che include `package.json` — qui verrebbe
 * attivato di continuo per attendere un check-run che non esiste). Il
 * MECCANISMO sta qui, e non deve ripetere il bug del `[0]` arbitrario che
 * questo modulo esiste per chiudere.
 */
describe('latestCompletedRunByName / latestCompletedConclusionByName (#242)', () => {
  const named = (name: string, conclusion: string | null, completed_at: string | null, status = 'completed') => ({
    name,
    status,
    conclusion,
    completed_at,
  });

  it('stessa selezione del gemello vitest: ultimo COMPLETATO, non `[0]`', () => {
    const runs = [
      named('test', 'failure', '2026-08-10T07:59:55Z'), // dispatch stantio, PRIMO per ordine API
      named('test', 'success', '2026-08-10T08:07:03Z'), // il verdetto vero
    ];
    expect(latestCompletedConclusionByName(runs, 'test')).toBe('success');
    expect(latestCompletedRunByName(runs, 'test')?.completed_at).toBe('2026-08-10T08:07:03Z');
  });

  it('filtra per nome: un altro check-run non contamina il verdetto', () => {
    const runs = [
      named('test', 'success', '2026-08-10T08:00:00Z'),
      named('lint', 'failure', '2026-08-10T09:00:00Z'),
    ];
    expect(latestCompletedConclusionByName(runs, 'test')).toBe('success');
    expect(latestCompletedConclusionByName(runs, 'lint')).toBe('failure');
  });

  it('nessun run concluso → `\'\'`, che il gate legge come "in attesa" (invariante #1454)', () => {
    expect(latestCompletedConclusionByName([named('test', null, null, 'in_progress')], 'test')).toBe('');
    expect(latestCompletedConclusionByName([], 'test')).toBe('');
    expect(latestCompletedRunByName([], 'test')).toBeNull();
  });

  it('input non-array → null/`\'\'`, mai un throw dentro il gate di merge', () => {
    expect(latestCompletedRunByName(undefined, 'test')).toBeNull();
    expect(latestCompletedConclusionByName(null, 'test')).toBe('');
  });

  it('il gemello vitest e\' ora un caso particolare di questa funzione', () => {
    // La prova che la generalizzazione non ha biforcato la selezione: se
    // `latestCompletedVitestRun` smettesse di delegare, questa uguaglianza
    // resterebbe vera solo per caso.
    const runs = [
      vitest('failure', '2026-06-17T07:59:55Z'),
      vitest('success', '2026-06-17T08:07:03Z'),
    ];
    expect(latestCompletedConclusionByName(runs, VITEST_CHECK_NAME)).toBe(
      latestCompletedVitestConclusion(runs),
    );
  });
});
