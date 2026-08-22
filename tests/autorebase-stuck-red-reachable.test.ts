// Un `vitest` rosso EREDITATO da main non è un verdetto sulla PR, e il solo
// rimedio è `merge origin/main` + ri-test — AGENTS.md lo dice da sempre («main
// rosso blocca a cascata: ogni branch lo eredita finché non fa merge
// origin/main»). `pr-autorebase` ha il meccanismo che lo applica (la classe
// STUCK-RED, con `vitestFailureIsNotAttributableToPr` a dare la prova positiva),
// ma fino al 2026-08-22 lo teneva dietro due gate che lo rendevano
// irraggiungibile proprio per le PR che ne avevano bisogno:
//
//   1. `if (!nearMerge && ...)` — `stale-pr-rescuer` etichetta `stale-review`
//      una PR ferma >2h e le promette nel commento che «pr-autorebase ora la
//      considera near-merge e la rebasa». Quella label la rendeva near-merge, e
//      near-merge escludeva lo stuck-red: il segnale di stallo disattivava il
//      rimedio allo stallo.
//   2. il `return` di `skip-idle` del ramo `needs-human`, che viene PRIMA:
//      l'impronta che decide «lo stato è cambiato?» è fatta di soli fatti
//      interni alla PR (additions/deletions/changedFiles/vitest/review), quindi
//      è cieca alla base. Quando il rosso viene da main, nessuno dei cinque si
//      muove, e il vitest non torna verde da sé perché il check è pinnato
//      all'ultimo run sull'head. Stato assorbente.
//
// Misurato: #6253/#6254/#6255, tre PR con diff disgiunti rosse sullo stesso test
// estraneo, tutte `needs-human`, ferme ~12h con main già riparato da 12h. Un
// `update-branch` a mano le ha portate verdi e il ciclo le ha mergiate da solo
// in ~2 minuti.
//
// Questi test pinnano l'ORDINE, non l'esito: è l'ordine che era sbagliato, e un
// refactor che rimetta il calcolo dopo un gate riporta il difetto con la CI
// verde.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const script = readFileSync(resolve('scripts/ci/pr-autorebase.mjs'), 'utf8');

const body = (() => {
  const start = script.indexOf('async function processPR(pr) {');
  expect(start, 'processPR non trovata in pr-autorebase.mjs').toBeGreaterThan(-1);
  return script.slice(start, script.indexOf('\n}\n', start));
})();

const at = (needle: string) => body.indexOf(needle);

describe('pr-autorebase: lo stuck-red rescue è raggiungibile', () => {
  it('calcola stuckRedReason PRIMA del gate needs-human', () => {
    const calc = at('stuckRedReason = stuckRedRescueReason(head)');
    const gate = at("labels.includes('needs-human')");
    expect(calc, 'il calcolo dello stuck-red è sparito').toBeGreaterThan(-1);
    expect(gate, 'il gate needs-human è sparito').toBeGreaterThan(-1);
    expect(
      calc,
      'stuckRedReason è calcolato DOPO il gate needs-human: quel ramo fa `return` '
      + 'su skip-idle, quindi il rescue non viene mai valutato per una PR needs-human',
    ).toBeLessThan(gate);
  });

  it('non condiziona il calcolo a !nearMerge', () => {
    // La forma esatta che il difetto aveva. Vale qualunque ordine degli operandi.
    expect(body).not.toMatch(/if\s*\(\s*!nearMerge\s*&&[^)]*behind/);
    expect(body).not.toMatch(/if\s*\([^)]*behind[^)]*&&\s*!nearMerge\s*\)/);
  });

  it('lo stuck-red batte lo skip-idle del ramo needs-human', () => {
    // Senza `&& !stuckRedReason` il `return` vince e il rescue resta morto.
    expect(body).toMatch(/action === 'skip-idle'\s*&&\s*!stuckRedReason/);
  });

  it('resta ONE-SHOT: il marker spegne il rescue al giro dopo', () => {
    // È questo a preservare la frugalità che il gate needs-human protegge —
    // al massimo UNA vitest per PR, non una per tick del cron */30.
    const calc = at('stuckRedReason = stuckRedRescueReason(head)');
    const guard = body.indexOf('hasCommentMarker(num, STUCK_RED_MARKER)', calc);
    expect(guard, 'il guard one-shot non segue più il calcolo').toBeGreaterThan(calc);
    expect(body.slice(guard, guard + 200)).toContain("stuckRedReason = ''");
  });

  it('esige ancora la prova positiva: solo se la PR è behind main', () => {
    // Se è già allineata a main non c'è nulla di nuovo da ereditare e il rosso
    // è suo: il rescue non deve regalare una re-run a chi ha un fail reale.
    const calc = at('stuckRedReason = stuckRedRescueReason(head)');
    expect(body.slice(Math.max(0, calc - 200), calc)).toMatch(/behindOf\(\)\s*>\s*0/);
  });
});
