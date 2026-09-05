/**
 * `fixQueueDepth()` — il cap delle run `issue-fix` in volo non può superare la
 * profondità che la coda di `issue-fix.yml` ha davvero.
 *
 * ## Il difetto che questo file impedisce di ricreare
 *
 * `issue-fix.yml` ha `concurrency: { group: issue-fix, cancel-in-progress:
 * false }`. Il gruppo è COSTANTE, quindi GitHub tiene una sola run pending per
 * gruppo e ogni nuova pending SFRATTA (`cancelled`) la precedente: la
 * profondità è 1, non N. L'header di quel workflow lo dice già per esteso, e
 * indica il drainer come l'unico posto che può garantire l'invariante «una sola
 * pending alla volta».
 *
 * Il 2026-09-04 alle 09:05Z il cap del drainer è passato da 1 a 3 (#7300). Da
 * quel momento il drain promuove fino a 3 `agent:fix` nello stesso tick: la
 * prima parte, le altre muoiono `cancelled` prima di eseguire un solo step.
 * Una run sfrattata non posa nessun commento `FIX_OUTCOME`, e siccome
 * `on: issues:[labeled]` è one-shot l'evento è consumato e niente ri-arma la
 * issue: il RESCUE la ritrova `agent:fix` orfana e le addebita un `fu-attempt`.
 * Tre giri così e la issue è `fu-parked` + `fu-attempt:3`, senza che un solo
 * tentativo sia mai avvenuto — e da lì non esce, perché il `verdict-exit`
 * cerca un verdetto che non è mai stato scritto e l'age-out chiede 10 giorni di
 * età più 7 di quiete.
 *
 * Misurato sul sito il 2026-09-05:
 *  - run `issue-fix` 09-03 (cap 1): 195 totali, 31 `cancelled`, 55 success;
 *  - run `issue-fix` 09-04 (cap 3): 1704 totali, 823 `cancelled`, 36 success;
 *  - 88 delle 167 issue `fu-parked` aperte senza NESSUN `FIX_OUTCOME`; di
 *    quelle, 84 parcheggiate il 09-04 e 4 il 09-05, con 276 label
 *    `fu-attempt:*` applicate. Il backlog è cresciuto di 82 issue nette in 15
 *    giorni: quelle 88 lo spiegano per intero.
 *
 * L'osservatore è qui e non in una soglia: finché `issue-fix.yml` serializza su
 * un gruppo costante, alzare il numero nel drainer non può più creare
 * promozioni che nascono morte. E il caso `group` per-issue documenta la via
 * d'uscita vera, che è nel workflow, non nel cap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixQueueDepth } from '../scripts/ci/followup-drainer.mjs';

const WF = fileURLToPath(new URL('../.github/workflows/issue-fix.yml', import.meta.url));

describe('fixQueueDepth: la profondità dichiarata dal workflow', () => {
  it('gruppo COSTANTE → 1: una sola pending, ogni altra la sfratterebbe', () => {
    expect(fixQueueDepth('on:\n  issues:\n\nconcurrency:\n  group: issue-fix\n  cancel-in-progress: false\n\njobs:\n  fix:\n')).toBe(1);
  });

  it('gruppo PER-ISSUE → nessuna serializzazione: il cap torna a valere per intero', () => {
    // È così che si alza davvero la parallelizzazione: nel workflow, non nel cap.
    const y = 'concurrency:\n  group: issue-fix-${{ github.event.issue.number }}\n  cancel-in-progress: false\n';
    expect(fixQueueDepth(y)).toBe(Number.POSITIVE_INFINITY);
  });

  it('nessun blocco `concurrency:` → nessuna coda da rispettare', () => {
    expect(fixQueueDepth('on:\n  issues:\n\njobs:\n  fix:\n')).toBe(Number.POSITIVE_INFINITY);
  });

  it('`concurrency:` presente ma gruppo illeggibile → 1, il verso sicuro', () => {
    // Mai indovinare al rialzo: una promozione di troppo costa un `fu-attempt`
    // su una run che non è mai partita, e tre di quelle parcheggiano la issue.
    expect(fixQueueDepth('concurrency: ${{ fromJSON(inputs.cfg) }}\n')).toBe(1);
    expect(fixQueueDepth('')).toBe(Number.POSITIVE_INFINITY);
  });

  it('il workflow REALE di questo repo vale 1: è il vincolo che il cap deve rispettare', () => {
    // Il test non finge il file: legge quello che gira in produzione. Se un
    // domani il gruppo diventa per-issue, questa riga cade ed è il segnale che
    // il cap del drainer può salire.
    expect(fixQueueDepth(readFileSync(WF, 'utf8'))).toBe(1);
  });
});
