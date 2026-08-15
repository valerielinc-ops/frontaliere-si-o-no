/**
 * ── IL SILENZIO CHE NON SI POTEVA DIAGNOSTICARE (gemello di corpus #370) ────
 *
 * `scripts/lib/ai-models.mjs` e' `mode: identical` nel manifest del ciclo.
 *
 * `claude-cli/haiku` e' l'unico membro del roster senza cap di input dichiarato
 * (`DEFAULT_REQUEST_TOKENS_BY_PROVIDER` copre GITHUB, GROQ, NVIDIA, CEREBRAS,
 * COHERE — non `claude_cli`), cioe' l'unico che puo' servire un prompt che tutti
 * gli altri rifiutano per dimensione. Il 2026-08-14, con il prompt a 10.066
 * token e 41 modelli saltati dal pre-flight, era letteralmente l'unica strada
 * rimasta verso un articolo.
 *
 * E' fallito 10 volte su 10, sempre a 120000 ms esatti, con questo messaggio:
 *
 *     ❌ [claude-cli/haiku] Failed: claude CLI timed out after 120000ms
 *
 * Nient'altro. Lo stderr era vuoto (il ramo che lo allega e' condizionale, e non
 * ha allegato niente) e lo stdout veniva **buttato via**. Da quel messaggio non
 * si puo' dire se il processo stesse generando lentamente o se non avesse mai
 * scritto un byte — e le due cose vogliono rimedi opposti:
 *
 *   - generazione lenta      → il floor di 120s e' stretto, va alzato
 *   - zero byte              → il problema e' a monte (auth, rete, avvio) e
 *                              alzare il timeout moltiplica solo il tempo perso
 *
 * Che la seconda sia l'ipotesi giusta e' gia' misurato: in locale, con gli
 * STESSI flag (`-p … --model haiku --output-format json --tools ""
 * --permission-mode bypassPermissions --safe-mode`) e un prompt da 10.211 token
 * stimati, una chiamata sana costa **24 secondi** — exit 0, 1.925 token di
 * output. Ma «misurato in locale» non e' «misurato in CI», ed e' il messaggio di
 * errore a dover portare la prova.
 *
 * PERCHE' IL CAMPO C'E' SEMPRE, ANCHE A ZERO. Un campo che compare solo quando
 * c'e' qualcosa costringe chi legge il prossimo incidente a distinguere «non e'
 * arrivato niente» da «la diagnostica non era ancora stata aggiunta». E' la
 * stessa classe di ambiguita' che questo messaggio aveva gia'.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');

// Ponte verso lo stile del sito: le asserzioni restano identiche al gemello del
// corpus (`generator/tests/claude-cli-timeout-diagnosticabile.test.mjs`), che
// gira su node:test, cosi' i due file restano diffabili quando il manifest
// segnala drift su ai-models.mjs.
const assert = {
  equal: (a, b, m) => expect(a, m).toBe(b),
  notEqual: (a, b, m) => expect(a, m).not.toBe(b),
  ok: (a, m) => expect(a, m).toBeTruthy(),
};

/**
 * Il ramo di timeout di `_runClaudeCliProcess`, ritagliato dal sorgente.
 *
 * Estratto e non importato: `_runClaudeCliProcess` non e' esportata e farla
 * scattare per davvero vorrebbe dire spawnare `claude` e aspettare due minuti.
 * Il ritaglio fallisce rumorosamente se le ancore spariscono, quindi non puo'
 * passare a vuoto su una stringa vuota.
 */
function ramoTimeout() {
  const a = SRC.indexOf('const timer = setTimeout(() => {');
  assert.notEqual(a, -1, 'ancora iniziale non trovata — aggiornare questo test');
  const b = SRC.indexOf('}, timeoutMs);', a);
  assert.notEqual(b, -1, 'ancora finale non trovata — aggiornare questo test');
  const blocco = SRC.slice(a, b);
  assert.ok(blocco.length > 200, `ritaglio troppo corto (${blocco.length}) — ancore sbagliate`);
  return blocco;
}

describe('il timeout del CLI claude riporta cosa aveva scritto il processo', () => {
  it('lo stdout non viene piu\' buttato', () => {
    const blocco = ramoTimeout();
    assert.ok(
      /stdout/.test(blocco),
      'il ramo di timeout non nomina stdout: il prossimo incidente sara' + '\' cieco come questo',
    );
  });

  it('il conteggio dei byte c\'e\' SEMPRE, anche quando sono zero', () => {
    const blocco = ramoTimeout();
    // `stdout.length` incondizionato, non dentro un ternario che lo omette.
    assert.ok(
      /stdout\.length/.test(blocco),
      'manca il conteggio dei byte di stdout',
    );
    // Il messaggio deve dire esplicitamente il caso «niente»: e' quello che
    // distingue «non ha scritto» da «non lo stiamo guardando».
    assert.ok(
      /nessun byte/.test(blocco),
      'manca la dicitura esplicita per il caso a zero byte',
    );
  });

  it('lo stderr resta allegato — la meta\' che gia\' c\'era non si perde', () => {
    const blocco = ramoTimeout();
    assert.ok(/stderr/.test(blocco), 'lo stderr non e\' piu\' allegato');
  });

  it('gli estratti sono troncati: un log non deve poter esplodere', () => {
    const blocco = ramoTimeout();
    const slices = [...blocco.matchAll(/\.slice\(0,\s*(\d+)\)/g)].map((m) => Number(m[1]));
    assert.ok(slices.length >= 2, `attesi almeno due troncamenti, trovati ${slices.length}`);
    for (const n of slices) {
      assert.ok(n <= 500, `troncamento troppo generoso: ${n}`);
    }
  });

  it('il messaggio continua a dire il timeout in ms — e\' cio\' su cui si grep-a', () => {
    const blocco = ramoTimeout();
    assert.ok(
      /timed out after \$\{timeoutMs\}ms/.test(blocco),
      'la forma del messaggio e\' cambiata: le ricerche sui log storici smettono di matchare',
    );
  });
});
