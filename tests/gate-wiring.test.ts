import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  declaredGates,
  orphanGateFiles,
  unsetTestSwitches,
  listCarriers,
  MANUAL_MARKER,
} from '../scripts/ci/gate-wiring-inventory.mjs';

/**
 * Il gate sull'AGGANCIO dei cancelli: un file che dichiara di bloccare deve
 * essere raggiungibile da qualcosa che gira, oppure dichiararsi manuale.
 *
 * ─── Perché serve un test e non una regola scritta ──────────────────────
 *
 * Un cancello ha due metà — il file che decide e il punto che lo invoca — e la
 * seconda non ha forma di import. `tests/packages-articles-confinement.test.ts`
 * dimostra via AST che nulla sotto `packages/articles` importa fuori, e proprio
 * per questo non vede `SiteShellContract`, che import non è.
 * `tests/failure-issue-closers.test.ts` ha chiuso la stessa classe per la
 * coppia apre-issue / chiude-issue. Questo file chiude la terza: scrive-gate /
 * invoca-gate.
 *
 * Senza, la CI resta verde mentre un cancello non gira. Misurato al momento in
 * cui questo test è nato, su `origin/main`:
 *
 *   - 19 file sotto `scripts/**` che si dichiarano cancello (nome `audit-`,
 *     `validate-`, `verify-`, `-audit`, oppure registrati sotto uno script npm
 *     `audit:`/`validate:`/`lint:`/`gate:`/`check:`) non erano nominati da
 *     nessun workflow, nessuno script npm raggiungibile, nessun altro file
 *     vivo. Sei — l'intero Workstream D sotto `scripts/seo/` — dal primo
 *     commit del repo e mai toccati da allora.
 *   - 7 file di test si spengono su `RUN_DIST_GATES`, che nessun workflow e
 *     nessuno script npm imposta. Girano a ogni `vitest run` e sono sempre
 *     `skip`: verdi perché non asseriscono niente.
 *
 * Il costo non è teorico: il «19 pagine su 22 senza meta description» di una
 * issue era il residuo di un run manuale di uno di questi audit, mai
 * rimisurato. Rimisurato oggi: zero. Un cancello orfano non protegge, e in più
 * produce numeri che poi qualcuno crede.
 *
 * ─── Perché una baseline e non un requisito duro ────────────────────────
 *
 * Rendere rossi 19 file in un colpo è ingestibile, e un gate ingestibile viene
 * disattivato entro una settimana. La baseline è l'inventario di un difetto
 * preesistente, reso visibile perché smetta di crescere.
 *
 * È una LISTA di file, non un conteggio: un ratchet a conteggio assoluto
 * sfarfalla quando il numero oscilla per ragioni legittime (un file rinominato,
 * uno cancellato) e la reazione è allentare la soglia. Con l'uguaglianza esatta
 * su una lista, l'unico modo di far passare il test è togliere una riga.
 *
 * ─── Come si toglie una riga ────────────────────────────────────────────
 *
 *   1. Agganciarlo davvero. Un cancello su `dist/` non può stare in
 *      `tests.yml`: quel workflow ha due job, `typecheck` e `vitest`, e nessuno
 *      dei due costruisce o scarica `dist/`. Il posto è la coda post-build —
 *      il registry `scripts/lib/post-build-tasks.sh` (che
 *      `post-build-matrix-test.yml` sorgente) oppure `post-deploy-validate-dist.yml`.
 *      È questo ostacolo, non la distrazione, che spiega perché la lista è
 *      lunga: chi scriveva il gate lo scriveva come test vitest, scopriva che
 *      lì `dist/` non esiste, e lo lasciava dietro `RUN_DIST_GATES`.
 *   2. Oppure dichiararlo strumento manuale: `@manual-tool` nel file, con una
 *      riga che dice perché (bonifica una tantum, CLI diagnostica, seed). Cinque
 *      file lo portano già.
 *   3. Oppure cancellarlo, se non serve più.
 *
 * In tutti e tre i casi la riga sparisce da `tests/gate-wiring-baseline.json` e
 * il ratchet scende. Aggiungerne una: non farlo — il test è qui per impedirlo.
 *
 * ─── Cosa NON copre (dichiarato, per non farci affidamento) ─────────────
 *
 *   - La raggiungibilità è testuale: il nome dentro un COMMENTO conta come
 *     aggancio. Sovrastimare lascia un buco noto; sottostimare produce falsi
 *     allarmi, e un falso allarme fa disattivare il gate.
 *   - Non prova che l'invocazione venga eseguita: un `if:` sempre falso o uno
 *     step dietro `continue-on-error` risultano agganciati.
 *   - Un cancello con nome neutro e nessuno script npm non viene chiesto.
 *   - Solo `scripts/**`. I cancelli che vivono come test vitest sono coperti
 *     dalla seconda `describe`, non dalla prima.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tests', 'gate-wiring-baseline.json'), 'utf-8'),
) as { orphanGates: string[]; unsetTestSwitches: Record<string, string[]> };

describe('ogni cancello dichiarato è agganciato a qualcosa che gira', () => {
  it('nessun cancello orfano oltre la baseline a scalare', () => {
    const actual = orphanGateFiles(REPO_ROOT);
    const known = new Set(BASELINE.orphanGates);

    const added = actual.filter((f) => !known.has(f));
    expect(
      added,
      'CANCELLO ORFANO NUOVO: questi file si dichiarano cancello e niente li invoca.\n' +
        'Agganciali (per un gate su dist/: scripts/lib/post-build-tasks.sh o\n' +
        'post-deploy-validate-dist.yml — NON tests.yml, che dist/ non ce l\'ha),\n' +
        `oppure marcali "${MANUAL_MARKER}" con la riga che dice perché.\n` +
        'Aggiungerli alla baseline NON è un\'opzione: la baseline può solo scendere.',
    ).toEqual([]);

    const stale = BASELINE.orphanGates.filter((f) => !actual.includes(f));
    expect(
      stale,
      'BASELINE STALE: questi file non sono più orfani (agganciati, marcati manuali\n' +
        'o cancellati). Toglili da tests/gate-wiring-baseline.json — è il ratchet\n' +
        'che scende, ed è voluto che il test fallisca finché non lo fai.',
    ).toEqual([]);
  });

  it('il marker manuale è una via d\'uscita reale, non una parola nel vuoto', () => {
    // Se il marker smettesse di funzionare, la baseline crescerebbe di colpo e
    // qualcuno la allargherebbe invece di indagare. Qui si prova che almeno un
    // file lo porta e che l'inventario lo rispetta.
    const manual = declaredGates(REPO_ROOT).filter((g) => g.manual);
    expect(manual.length).toBeGreaterThan(0);
    const orphans = new Set(orphanGateFiles(REPO_ROOT));
    for (const g of manual) expect(orphans.has(g.file)).toBe(false);
  });

  it('l\'inventario non si assolve da sé', () => {
    // Il modulo è raggiungibile (lo importa questo test): se restasse fra i
    // portatori, i file orfani nominati nel suo docstring risulterebbero
    // agganciati e la lista si svuoterebbe da sola.
    const carriers = listCarriers(REPO_ROOT);
    expect(carriers).not.toContain('scripts/ci/gate-wiring-inventory.mjs');
    expect(carriers).not.toContain('tests/gate-wiring.test.ts');
  });
});

describe('nessun test si spegne su un interruttore che nessuno accende', () => {
  it('gli interruttori mai impostati sono esattamente quelli della baseline', () => {
    const actual = unsetTestSwitches(REPO_ROOT);
    const actualByEnv = new Map(actual.map((s) => [s.env, s.files]));

    const addedEnvs = actual.map((s) => s.env).filter((e) => !(e in BASELINE.unsetTestSwitches));
    expect(
      addedEnvs,
      'INTERRUTTORE NUOVO MAI ACCESO: questi test fanno skip su una variabile che\n' +
        'nessun workflow e nessuno script npm imposta. Sono verdi perché non\n' +
        'asseriscono niente. Impostala nel workflow che può soddisfarne le\n' +
        'precondizioni, o togli lo skip.',
    ).toEqual([]);

    const staleEnvs = Object.keys(BASELINE.unsetTestSwitches).filter((e) => !actualByEnv.has(e));
    expect(
      staleEnvs,
      'BASELINE STALE: questi interruttori ora sono impostati (o non esistono più).\n' +
        'Togli la chiave da tests/gate-wiring-baseline.json.',
    ).toEqual([]);

    for (const [env, files] of Object.entries(BASELINE.unsetTestSwitches)) {
      if (!actualByEnv.has(env)) continue;
      expect(
        actualByEnv.get(env),
        `L'insieme dei test spenti da ${env} è cambiato. Aggiungerne uno non è\n` +
          'un\'opzione: quel test nascerebbe già morto. Toglierne uno → aggiorna la baseline.',
      ).toEqual(files);
    }
  });
});
