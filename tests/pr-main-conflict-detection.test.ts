/**
 * Rilevazione dei conflitti con `main` su OGNI PR aperta (pr-autorebase.mjs).
 *
 * IL BUCO CHE CHIUDE
 * ---------------------------------------------------------------------------
 * `pr-autorebase` ripara solo le PR "near-merge" (un `## LGTM`, oppure le label
 * `collision-risk`/`stale-review`, oppure stuck-red). È giusto che la parte
 * COSTOSA sia gattata così. Ma il risultato era che la classe di PR che sta in
 * volo più a lungo — quelle sotto revisione, con un 🔴 e senza label — non
 * riceveva NESSUN segnale di conflitto: né dal gate, né da `stale-pr-rescuer`,
 * né dal collision detector (che confronta PR con PR, non PR con main).
 *
 * Osservato su #6330: aperta MERGEABLE, 58 commit dopo era in conflitto su
 * cinque file, e chi la seguiva faceva polling di `state` e `reviews` — che
 * restano OPEN e invariati mentre il conflitto nasce.
 *
 * PERCHÉ merge-tree E NON `mergeable`
 * ---------------------------------------------------------------------------
 * `gh pr view --json mergeable` è una cache che GitHub calcola in modo
 * asincrono: risponde `UNKNOWN` proprio nella finestra in cui i conflitti
 * nascono (subito dopo un push su main). Misurato su #6330 mentre il conflitto
 * era REALE e riproducibile in locale: `mergeable=UNKNOWN`,
 * `mergeStateStatus=UNKNOWN`, e `git merge-tree --write-tree` exit 1 con i
 * cinque path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMergeTreeConflicts, decideConflictLabel } from '@/scripts/ci/pr-autorebase.mjs';

const SRC = fs.readFileSync(
  path.join(path.resolve(__dirname, '..'), 'scripts/ci/pr-autorebase.mjs'),
  'utf-8',
);

const oid = (seed: string) => seed.padEnd(40, '0');

describe('parseMergeTreeConflicts', () => {
  it('estrae i path dalle righe di stage, una volta sola per file', () => {
    const out = [
      oid('f1f48db'),
      `100644 ${oid('07652f4')} 1\tcomponents/community/WhatsNewModal.tsx`,
      `100644 ${oid('0d26300')} 2\tcomponents/community/WhatsNewModal.tsx`,
      `100644 ${oid('aaaaaaa')} 3\tcomponents/community/WhatsNewModal.tsx`,
      `100644 ${oid('bbbbbbb')} 1\tservices/locales/it-core.ts`,
      `100644 ${oid('ccccccc')} 2\tservices/locales/it-core.ts`,
      '',
      'CONFLICT (content): Merge conflict in components/community/WhatsNewModal.tsx',
    ].join('\n');
    expect(parseMergeTreeConflicts(out)).toEqual([
      'components/community/WhatsNewModal.tsx',
      'services/locales/it-core.ts',
    ]);
  });

  it('ignora la riga dell’albero e le righe informative', () => {
    // Le righe `CONFLICT (...)` hanno forma libera e sono localizzabili; le
    // righe di stage sono formato di plumbing. Leggere le prime sarebbe un
    // parser che si rompe quando git cambia una frase.
    expect(parseMergeTreeConflicts(`${oid('deadbee')}\nCONFLICT (content): Merge conflict in a/b.ts\n`)).toEqual([]);
  });

  it('un merge pulito non produce path', () => {
    expect(parseMergeTreeConflicts(`${oid('abc1234')}\n`)).toEqual([]);
  });

  it('non si fa ingannare da un path che assomiglia a una riga di stage', () => {
    expect(parseMergeTreeConflicts('100644 nonunoid 1\tsrc/a.ts\n')).toEqual([]);
  });
});

describe('decideConflictLabel', () => {
  it('mette la label solo quando manca', () => {
    expect(decideConflictLabel({ conflicted: true, hasLabel: false })).toBe('add');
    expect(decideConflictLabel({ conflicted: true, hasLabel: true })).toBe('none');
  });

  it('toglie la label appena il conflitto rientra', () => {
    // Una label appesa a una PR già rebasata manda il prossimo agente a cercare
    // un conflitto che non c'è: è il motivo per cui la label è ricalcolata a
    // ogni run mentre il commento è one-shot.
    expect(decideConflictLabel({ conflicted: false, hasLabel: true })).toBe('remove');
    expect(decideConflictLabel({ conflicted: false, hasLabel: false })).toBe('none');
  });
});

describe('la rilevazione gira fuori dal gate near-merge', () => {
  it('reportMainConflict è chiamato PRIMA del return di non-near-merge', () => {
    const detect = SRC.indexOf('reportMainConflict(num, branch, head, labels)');
    const gate = SRC.indexOf('if (!nearMerge) {');
    expect(detect, 'reportMainConflict non è chiamato').toBeGreaterThan(-1);
    expect(gate, 'gate near-merge non trovato').toBeGreaterThan(-1);
    expect(
      detect,
      'La rilevazione è finita DIETRO il gate near-merge: le PR in revisione —\n' +
        'quelle che stanno in volo più a lungo — tornerebbero senza segnale.',
    ).toBeLessThan(gate);
  });

  it('usa un’etichetta dedicata, non stale-review', () => {
    // `stale-review` fa rifare la review a ogni giro dell'autorebase: usarla
    // per un segnale informativo costerebbe una review Claude per ogni PR in
    // conflitto a ogni tick.
    const fn = SRC.slice(SRC.indexOf('function reportMainConflict'), SRC.indexOf('function commentConflictOnce'));
    expect(fn).toContain('MAIN_CONFLICT_LABEL');
    expect(fn).not.toContain("'stale-review'");
  });

  it('non tocca il branch: nessun push, nessun merge, nessun dispatch', () => {
    const fn = SRC.slice(SRC.indexOf('function reportMainConflict'), SRC.indexOf('function commentConflictOnce'));
    for (const forbidden of ['pushBranch', 'dispatchTests', "'merge'", "'push'"]) {
      expect(fn, `reportMainConflict non deve ${forbidden}`).not.toContain(forbidden);
    }
  });
});
