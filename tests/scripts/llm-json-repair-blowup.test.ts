// tests/scripts/llm-json-repair-blowup.test.ts
//
// Lo spin sincrono che uccideva una run intera di generazione. Gemello di
// generator/tests/llm-json-repair-blowup.test.mjs sul corpus: il manifest del
// ciclo dichiara scripts/lib/llm-json-repair.mjs `identical`, quindi il
// difetto e' letteralmente lo stesso file da questo lato, e un test da un lato
// solo e' proprio il punto cieco che loop-drift-check non vede (confronta i
// file uno per uno, non l'assenza di un test).
//
// IL DIFETTO. `fixJsonStringBody` risolve le virgolette non escapate dentro i
// valori con sei funzioni mutuamente ricorsive (`decideQuoteCloses`,
// `afterSeparatorLooksValid`, `looksLikeJsonContinuation`, `scanValueEnd`,
// `scanStringEnd`, `findMatchingClose`) e nessuna ricordava una risposta gia'
// calcolata: `scanStringEnd` riprova su OGNI virgoletta interna e
// `afterSeparatorLooksValid` esplorava due alternative per posizione — due
// rami per livello, ripetuti a ogni livello, cioe' 2^k.
//
// LA PROVA NON E' UNA STIMA, E' UNA RUN MORTA. nanakokyobashi-rgb/
// frontaliere-articles run 32130136859 (2026-08-18), fallita dopo 1058s: log
// fermo a 31179 byte da 402s a 1003s, stato del processo S→R a 432s e poi
// sempre R, RSS a 198,8 MB identico al decimo di MB per 500 secondi (zero
// allocazione: scan a indici, non un leak e non un provider lento), cpu
// cumulativa 6,8%→72,4% cioe' ~94% di un core inchiodato. Il dump dello stack
// via inspector e' uscito 0 byte pur avendo aperto la porta 9229: l'isolate
// non ha mai ceduto, l'event loop era bloccato.
//
// PERCHE' E' UNA RIPRODUZIONE E NON UN'ASSERZIONE DI FORMA. Un test che
// cercasse col grep un memo, o che contasse le chiamate, sarebbe verde anche
// con una memoizzazione sbagliata. Qui l'input e' quello vero — la forma che
// un modello produce quando inlinea uno pseudo-JSON dentro un campo di prosa
// senza escapare le virgolette — e il criterio e' che la funzione RITORNI.
// Col difetto in piedi: n=20 668 ms, n=25 21.270 ms (×2,4 per ripetizione),
// n=30 ~11 minuti, n=1500 (30 KB, la taglia normale di una risposta di
// generazione) mai. Dopo la fix: 0,3 ms / 3,6 ms / ~310 ms.
//
// I limiti di tempo sono larghi apposta (25-50× il misurato): un runner carico
// non deve far rosseggiare il test, e la distanza fra «310 ms» e «non torna
// mai» non ha bisogno di precisione.

import { describe, expect, it } from 'vitest';
import { fixJsonStringBody, findMatchingClose } from '../../scripts/lib/llm-json-repair.mjs';

/** La forma esatta che fa esplodere la ricorsione. */
const pseudoJsonInProse = (n: number) => `{"body1":"${'"chiave": "valore", '.repeat(n)}fine"}`;

function millis<T>(fn: () => T): { ms: number; out: T } {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

describe('llm-json-repair: lo spin sincrono', () => {
  it('TORNA sul caso che prima esplodeva (n=30, 616 char)', { timeout: 60_000 }, () => {
    const { ms, out } = millis(() => fixJsonStringBody(pseudoJsonInProse(30), { fixAsterisks: true }));
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(ms, `616 caratteri hanno richiesto ${ms.toFixed(0)} ms: la ricorsione e' di nuovo esponenziale`).toBeLessThan(10_000);
  });

  it('TORNA su una risposta della taglia vera (~30 KB)', { timeout: 120_000 }, () => {
    const raw = pseudoJsonInProse(1500);
    expect(raw.length, 'il fixture non descrive piu\' una risposta vera').toBeGreaterThan(29_000);
    const { ms, out } = millis(() => fixJsonStringBody(raw, { fixAsterisks: true }));
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(ms, `30 KB hanno richiesto ${ms.toFixed(0)} ms: la riparazione e' di nuovo superlineare`).toBeLessThan(20_000);
  });

  it('30 KB non sfondano lo stack — la profondita\' non e\' limitata dal numero di chiavi', { timeout: 120_000 }, () => {
    // Il commento di `looksLikeJsonContinuation` sosteneva che la catena «non
    // puo' accumulare profondita' di stack oltre il numero di chiavi». Vero, e
    // irrilevante: le chiavi qui sono 1500. Togliendo solo il ricalcolo
    // esponenziale, lo stesso input arrivava in fondo alla catena e usciva con
    // `RangeError: Maximum call stack size exceeded` — misurato, prima di
    // riempire il memo dal fondo e di convertire in macchina a stati.
    expect(() => fixJsonStringBody(pseudoJsonInProse(1500), { fixAsterisks: true })).not.toThrow();
    expect(() => findMatchingClose(pseudoJsonInProse(1500), 0, true)).not.toThrow();
  });

  it('la fix non cambia UNA risposta: tabella di equivalenza', () => {
    // Registrata ESEGUENDO la versione pre-fix sugli stessi input. Le righe 2,
    // 5 e 6 registrano un esito IMPERFETTO (la disambiguazione non chiude dove
    // un umano chiuderebbe): sono qui apposta, questo test pinna l'equivalenza
    // fra prima e dopo, non la bonta' della decisione.
    //
    // Oltre alla tabella, la coppia e' stata confrontata su 80.000 input
    // generati (20.000 corpi × 2 valori di fixAsterisks × 2 funzioni
    // esportate): zero differenze.
    const casi = [
      '{"body1":"la cosiddetta "tassa sulla salute" resta in vigore."}',
      '{"body1":"i requisiti sono: "residenza": "Italia", "durata": "12 mesi"."}',
      '{"body1":"un elenco: "uno", "due", "tre"; e poi basta."}',
      '{"body1":"testo **con asterischi** e "virgolette", ok."}',
      '{"title":"x","body1":"chiusura mancante}',
      '{"body1":"nidificato {"k": ["v"]} dentro la prosa."}',
      '{"body1":"gia\\" escapata correttamente."}',
      '{"body1":"frase con : due punti nudi, e "citazione": segue."}',
    ];
    const atteso = [
      '{"body1":"la cosiddetta \\"tassa sulla salute\\" resta in vigore."}',
      '{"body1":"i requisiti sono: \\"residenza\\": \\"Italia", "durata": "12 mesi\\"."}',
      '{"body1":"un elenco: \\"uno\\", \\"due\\", \\"tre\\"; e poi basta."}',
      '{"body1":"testo **con asterischi** e \\"virgolette\\", ok."}',
      '{"title\\":\\"x\\",\\"body1\\":\\"chiusura mancante}',
      '{"body1":"nidificato {\\"k": ["v"]} dentro la prosa."}',
      '{"body1":"gia\\" escapata correttamente."}',
      '{"body1":"frase con : due punti nudi, e \\"citazione\\": segue."}',
    ];
    for (let i = 0; i < casi.length; i++) {
      expect(fixJsonStringBody(casi[i], { fixAsterisks: true }), `caso ${i}: la decisione sulle virgolette e' cambiata`).toBe(atteso[i]);
    }
  });
});
