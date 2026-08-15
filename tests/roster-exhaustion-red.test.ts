/**
 * ── QUANDO «DIFFERISCI» E' UNA DIAGNOSI SBAGLIATA (sito) ────────────────────
 *
 * Gemello di `generator/tests/roster-exhaustion-red.test.mjs` del corpus
 * (nanakokyobashi-rgb/frontaliere-articles#313 / #348), portato qui come issue
 * #359. Il modulo sotto test, `scripts/lib/exhaustion-disposition.mjs`, e'
 * BYTE-IDENTICO al gemello: non ha import, quindi il porting non ha richiesto
 * un solo adattamento. Cio' che cambia fra i due lati e' il CABLAGGIO, ed e'
 * per questo che la seconda meta' di questo file esegue il `catch` vero.
 *
 * ── IL DIFETTO ──────────────────────────────────────────────────────────────
 *
 * `callLLM()` lancia `ALL_MODELS_EXHAUSTED` ogni volta che la catena si svuota,
 * QUALUNQUE sia la ragione, e `isQuotaExhaustedError()` si fida di
 * `err.transientExhaustion` — che `classifyExhaustionCause()` calcola come
 * `transient >= persistent`, un voto di MAGGIORANZA col PAREGGIO che va al
 * transitorio. Accanto a quel calcolo c'e' pero' un invariante dichiarato piu'
 * forte del voto: la classe input-cap resta PERSISTENTE apposta, perche' un
 * prompt piu' grande di ogni cap dichiarato non diventa piu' piccolo alla
 * finestra di quota successiva.
 *
 * Niente teneva insieme le due cose, e il voto ha vinto. Sulla run 31817957722
 * del 2026-08-14: transient=53, persistent=53, ambiguo=1, di cui 38 rifiuti su
 * input cap → 53>=53 → differimento → exit 0 → run VERDE, e il messaggio
 * stampato («quota giornaliera») era falso: i modelli non venivano chiamati,
 * venivano SALTATI dal pre-flight. 60+ run `success` di fila senza un articolo.
 *
 * ── PERCHE' IL SITO E' IL POSTO GIUSTO PER QUESTO TEST ──────────────────────
 *
 * `publish-journalist-articles.yml` importa questo stesso `create-article.mjs`
 * e gira ogni 15 minuti: il gemello vivo non e' una copia dormiente.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_ROSTER_CANNOT_SERVE_PROMPT,
  EXIT_NO_ARTICLE_DECLARED,
  QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE,
  isInputCapDeferralVeto,
  inputCapVetoSummary,
  isLegitimateQuotaDeferral,
  quotaDeferralShare,
} from '../scripts/lib/exhaustion-disposition.mjs';
import { classifyExhaustionCause, isQuotaExhaustedError } from '../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

/**
 * ── PERCHE' ESISTONO DUE COSTRUTTORI DI FIXTURE ─────────────────────────────
 *
 * `cascata()` prende i tre numeri e serve alle unit del modulo: li' il
 * breakdown E' l'input, e fabbricarlo a mano e' corretto.
 *
 * `cascataReale()` invece parte dai MESSAGGI e li fa passare per
 * `classifyExhaustionCause()` vero. Serve a tutto cio' che pretende di
 * descrivere una run: un breakdown scritto a mano congela la classificazione
 * del giorno in cui e' stato scritto, e questa e' esattamente la trappola in
 * cui la prima versione di questo file e' caduta. Citava la run 31823202761
 * come «53 transitori su 106, il 50,0% esatto, quindi rossa» — numeri veri il
 * 2026-08-14 e gia' superati: `transientRe` ha nel frattempo imparato
 * `timed out` (la fix e' su main, e il suo commento cita proprio quella run),
 * quindi la riga ambigua di Haiku oggi conta come transitoria e il rapporto e'
 * 54/106 = 50,9% → differimento LEGITTIMO. Il test restava verde perche' non
 * chiedeva niente al classificatore.
 */
const REASON_QUOTA = 'gemini-2.0-flash: daily limit reached (429)';
const REASON_INPUT_CAP = 'phi-4-mini: request exceeds max input cap for this model';
const REASON_NO_KEY = 'mistral-large: no API key configured';
const REASON_TIMEOUT_CLI = 'claude-cli/haiku: claude CLI timed out after 120000ms';

/** Costruisce la cascata dai MESSAGGI, passando per il classificatore vero. */
function cascataReale(reasons: string[], { capCount = 0, est = 9740, best = 8000 } = {}) {
  const e: any = new Error(`All AI models failed. Chain: [...] | ${reasons.length} errors`);
  e.code = 'ALL_MODELS_EXHAUSTED';
  e.exhaustionBreakdown = classifyExhaustionCause(reasons);
  e.transientExhaustion = e.exhaustionBreakdown.transient > 0
    && e.exhaustionBreakdown.transient >= e.exhaustionBreakdown.persistent;
  e.inputCapReport = capCount > 0
    ? { count: capCount, maxSkippedReqLimit: best, minSkippedReqLimit: 3000, estimatedRequestTokens: est }
    : null;
  return e;
}

const ripeti = (s: string, n: number) => Array.from({ length: n }, () => s);

/** Un errore della forma che `callLLM` produce davvero su ALL_MODELS_EXHAUSTED. */
function cascata({
  transient = 0,
  persistent = 0,
  total = undefined as number | undefined,
  capCount = 0,
  est = 9740,
  best = 8000,
} = {}) {
  const e: any = new Error('All AI models failed. Chain: [...]');
  e.code = 'ALL_MODELS_EXHAUSTED';
  e.exhaustionBreakdown = {
    transient,
    persistent,
    total: total ?? transient + persistent,
  };
  e.transientExhaustion = transient > 0 && transient >= persistent;
  e.inputCapReport = capCount > 0
    ? { count: capCount, maxSkippedReqLimit: best, minSkippedReqLimit: 3000, estimatedRequestTokens: est }
    : null;
  return e;
}

describe('isInputCapDeferralVeto — il pareggio non differisce piu\'', () => {
  it('veta la run 31817957722 esatta: 53/53 con 38 rifiuti su taglia', () => {
    // Il caso reale, coi numeri riclassificati nell'intestazione del modulo.
    expect(isInputCapDeferralVeto(cascata({ transient: 53, persistent: 53, total: 107, capCount: 38 }))).toBe(true);
  });

  it('NON veta quando il transitorio supera STRETTAMENTE il persistente', () => {
    // L'inversione e' minima apposta: solo il pareggio cambia lato.
    expect(isInputCapDeferralVeto(cascata({ transient: 54, persistent: 53, capCount: 38 }))).toBe(false);
  });

  it('NON veta una cascata senza un solo rifiuto su taglia', () => {
    // Il comportamento su una notte di quota vera deve restare identico a prima:
    // quelle ragioni si curano da sole a mezzanotte UTC.
    expect(isInputCapDeferralVeto(cascata({ transient: 53, persistent: 53, capCount: 0 }))).toBe(false);
    expect(isInputCapDeferralVeto(cascata({ transient: 100, persistent: 0, capCount: 0 }))).toBe(false);
  });

  it('ignora ogni errore che non sia una cascata svuotata', () => {
    expect(isInputCapDeferralVeto(new Error('timeout'))).toBe(false);
    expect(isInputCapDeferralVeto(null)).toBe(false);
    expect(isInputCapDeferralVeto(undefined)).toBe(false);
    expect(isInputCapDeferralVeto('ALL_MODELS_EXHAUSTED')).toBe(false);
  });

  it('inputCapVetoSummary dice DI QUANTO tagliare', () => {
    // Il numero azionabile non deve dipendere da chi legge la prosa.
    const s = inputCapVetoSummary(cascata({ transient: 53, persistent: 53, capCount: 38, est: 9740, best: 8000 }));
    expect(s).toEqual({ estimatedRequestTokens: 9740, maxSkippedReqLimit: 8000, over: 1740, refusals: 38 });
  });
});

describe('isLegitimateQuotaDeferral — il denominatore include gli ambigui', () => {
  it('la run 31823202761 col classificatore di OGGI e\' un differimento legittimo', () => {
    // Il caso storico, ricostruito dai messaggi e classificato dal codice VERO.
    // Il 2026-08-14 la riga di Haiku cadeva nel secchio ambiguo e il rapporto
    // era 53/106 = 50,0% → rosso. Poi `transientRe` ha imparato `timed out`
    // (fix su main), quella riga e' diventata transitoria, e oggi il rapporto
    // e' 54/106 = 50,9% → VERDE. Il test lo dice invece di fingere il contrario:
    // e' il classificatore la fonte di verita', non un numero copiato.
    const e = cascataReale([
      ...ripeti(REASON_QUOTA, 53),
      ...ripeti(REASON_INPUT_CAP, 38),
      ...ripeti(REASON_NO_KEY, 12),
      REASON_TIMEOUT_CLI,
      ...ripeti('openrouter/x: HTTP 404 model not found', 2),
    ], { capCount: 38 });
    expect(e.exhaustionBreakdown.total).toBe(106);
    expect(e.exhaustionBreakdown.transient).toBe(54);
    expect(quotaDeferralShare(e).ambiguous).toBe(0);
    expect(isLegitimateQuotaDeferral(e)).toBe(true);
    // Ma il VETO scatta lo stesso, ed e' la ragione per cui #359 non dipende
    // da questa soglia: 54 non supera strettamente 52? Lo supera — quindi qui
    // il veto NON scatta e la run resta un differimento. E' il caso in cui la
    // seconda meta' della fix non ha niente da dire, e va bene cosi'.
    expect(isInputCapDeferralVeto(e)).toBe(false);
  });

  it('rifiuta una cascata in cui la quota NON e\' la causa dominante', () => {
    // Il caso che il gate esiste per prendere, coi messaggi veri: meta' roster
    // fuori quota, l'altra meta' con un prompt sopra il cap e chiavi assenti.
    // Nessuna finestra di quota ripara quella meta'.
    const e = cascataReale([
      ...ripeti(REASON_QUOTA, 40),
      ...ripeti(REASON_INPUT_CAP, 38),
      ...ripeti(REASON_NO_KEY, 12),
    ]);
    expect(e.exhaustionBreakdown).toEqual({ transient: 40, persistent: 50, total: 90 });
    expect(isLegitimateQuotaDeferral(e)).toBe(false);
    expect(quotaDeferralShare(e).share).toBeCloseTo(0.4444, 3);
  });

  it('accetta una notte di quota vera (ogni modello dice «daily limit»)', () => {
    expect(isLegitimateQuotaDeferral(cascata({ transient: 104, persistent: 0, total: 104 }))).toBe(true);
  });

  it('la maggioranza e\' STRETTA: 50% non basta, 50,1% si\'', () => {
    expect(QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE).toBe(0.5);
    expect(isLegitimateQuotaDeferral(cascata({ transient: 500, persistent: 500, total: 1000 }))).toBe(false);
    expect(isLegitimateQuotaDeferral(cascata({ transient: 501, persistent: 499, total: 1000 }))).toBe(true);
  });

  it('senza denominatore non afferma niente', () => {
    // L'affermazione non dimostrata vale «rosso»: e' la direzione in cui
    // l'errore costa meno.
    expect(isLegitimateQuotaDeferral(cascata({ transient: 0, persistent: 0, total: 0 }))).toBe(false);
  });
});

/**
 * ── IL CABLAGGIO, ESEGUITO ──────────────────────────────────────────────────
 *
 * I predicati sopra sono inerti finche' qualcuno non li chiama nell'ordine
 * giusto, e l'ordine E' la fix: il veto deve venire PRIMA del differimento,
 * perche' e' il solo ordine in cui puo' impedirlo. Un test che si limitasse a
 * `grep` proverebbe che il file CONTIENE quelle parole, non che decidono.
 *
 * Quindi il ramo `catch` viene ritagliato dal file che gira e ESEGUITO, con i
 * predicati VERI e un `process.exit` che cattura il codice invece di uscire.
 */
describe('il catch di primo livello sceglie il codice di uscita giusto', () => {
  const inizio = '  if (isInputCapDeferralVeto(e)) {';
  const fine = '  // Content/quality rejection that bubbled all the way up';
  const a = SRC.indexOf(inizio);
  const b = SRC.indexOf(fine, a);

  it('le ancore del ritaglio esistono ancora', () => {
    expect(a, `ancora iniziale non trovata: ${inizio}`).not.toBe(-1);
    expect(b, `ancora finale non trovata: ${fine}`).not.toBe(-1);
    expect(b - a).toBeGreaterThan(400);
  });

  /** Esegue il ramo vero e restituisce il codice di uscita scelto. */
  function decidi(e: unknown) {
    const blocco = SRC.slice(a, b);
    const note: string[] = [];
    const righe: string[] = [];
    const fn = new Function(
      'e', 'isInputCapDeferralVeto', 'inputCapVetoSummary', 'isQuotaExhaustedError',
      'isLegitimateQuotaDeferral', 'quotaDeferralShare', 'EXIT_ROSTER_CANNOT_SERVE_PROMPT',
      'finalizeRunReport', 'RUN_REPORT', 'process', 'console',
      `${blocco}\nreturn { exit: null, stato: null };`,
    );
    let stato: string | null = null;
    const sentinella = {} as any;
    let exit: number | null = null;
    try {
      return fn(
        e, isInputCapDeferralVeto, inputCapVetoSummary,
        // Il predicato a monte VERO, non una riproduzione: e' il suo secondo
        // ramo — quello che matcha sul messaggio — ad aver prodotto il caso
        // rosso di troppo, e una riproduzione scritta a mano non lo avrebbe.
        isQuotaExhaustedError,
        isLegitimateQuotaDeferral, quotaDeferralShare, EXIT_ROSTER_CANNOT_SERVE_PROMPT,
        (s: string) => { stato = s; },
        { notes: note },
        { exit: (c: number) => { exit = c; throw sentinella; } },
        { error: (m: string) => righe.push(String(m)) },
      );
    } catch (err) {
      if (err !== sentinella) throw err;
      return { exit, stato, righe };
    }
  }

  it('input cap in pareggio → exit 3, NON un differimento', () => {
    // Il caso che ha prodotto le dieci ore di verde. `transientExhaustion` e'
    // true qui: senza il veto questo ramo uscirebbe 0.
    const e = cascata({ transient: 53, persistent: 53, total: 107, capCount: 38 });
    expect(e.transientExhaustion, 'il fixture non riproduce il difetto').toBe(true);
    const out: any = decidi(e);
    expect(out.exit).toBe(EXIT_ROSTER_CANNOT_SERVE_PROMPT);
    expect(out.stato).toBe('error');
    expect(out.righe.join('\n')).toMatch(/roster-cannot-serve-prompt: est=9740 best_cap=8000 over=1740 refusals=38/);
  });

  it('quota vera → exit 0, esattamente come prima della fix', () => {
    // Il non-obiettivo che conta: la notte di quota vera resta VERDE. Il gemello
    // del corpus esce 4 qui, perche' li' lo step del workflow assorbe il 4;
    // questo repo fa `exit "$rc"` verbatim e un 4 renderebbe rossa ogni notte.
    const out: any = decidi(cascata({ transient: 104, persistent: 0, total: 104 }));
    expect(out.exit).toBe(0);
    expect(out.stato).toBe('deferred');
    expect(out.righe.join('\n')).toMatch(/104\/104 = 100\.0%/);
  });

  it('roster meta\' giu\' senza rifiuti su taglia → exit 1', () => {
    // La seconda meta' della fix: nessun rifiuto su taglia, quindi il veto non
    // scatta, ma la quota non e' la causa dominante e «riprovo al prossimo run»
    // resta una descrizione falsa. Fixture dai MESSAGGI, classificata dal
    // codice vero — vedi il commento su cascataReale().
    const e = cascataReale([
      ...ripeti(REASON_QUOTA, 40),
      ...ripeti(REASON_INPUT_CAP, 38),
      ...ripeti(REASON_NO_KEY, 12),
    ]);
    // `transientExhaustion` e' false qui (40 < 50), quindi il ramo a monte non
    // scatterebbe: lo forziamo per misurare il ramo che ci interessa.
    e.transientExhaustion = true;
    const out: any = decidi(e);
    expect(out.exit).toBe(1);
    expect(out.stato).toBe('error');
    expect(out.righe.join('\n')).toMatch(/roster-down-not-deferrable: transient=40 persistent=50 ambiguous=0 total=90/);
  });

  // ── IL CASO CHE LA PRIMA VERSIONE DI QUESTA PR RENDEVA ROSSO ────────────
  //
  // `isQuotaExhaustedError` ha un secondo ramo che matcha sul MESSAGGIO, per
  // gli errori GREZZI di un singolo provider — quelli che
  // `dedicated-crawler-common.mjs` gli passa cosi' come sono. Non hanno `code`
  // ne' `exhaustionBreakdown`, quindi `total` e' 0 e
  // `isLegitimateQuotaDeferral` risponde `false` per costruzione: la risposta
  // giusta a «e' dimostrato?», quella sbagliata a «va reso rosso?».
  //
  // Senza il gate sul `code` questi uscivano 1 dove oggi escono 0, su un job
  // che gira ogni 15 minuti.
  describe('un errore grezzo che parla di quota resta un differimento', () => {
    it.each([
      'Gemini: You exceeded your current quota, please check your plan and billing details',
      'daily limit reached for this API key',
      'openrouter: free-models-per-day exhausted',
    ])('«%s» → exit 0', (messaggio) => {
      const grezzo = new Error(messaggio);
      const out: any = decidi(grezzo);
      expect(out.exit, 'un errore grezzo di quota non deve diventare rosso').toBe(0);
      expect(out.stato).toBe('deferred');
    });

    it('non stampa una percentuale che non ha misurato', () => {
      // «0/0 = 0.0%» sembra una misura e non lo e'.
      const out: any = decidi(new Error('daily limit reached for this API key'));
      expect(out.righe.join('\n')).not.toMatch(/0\/0/);
      expect(out.righe.join('\n')).toMatch(/quota giornaliera/);
    });
  });

  it('quota schiacciante CON qualche rifiuto su taglia resta un differimento', () => {
    // Il veto non e' «un rifiuto su taglia e si grida»: chiede che il
    // transitorio NON superi strettamente il persistente. Con 90 contro 10 la
    // notte di quota e' reale e i 5 rifiuti su taglia sono rumore — differire e'
    // la descrizione giusta, e resta exit 0.
    const out: any = decidi(cascata({ transient: 90, persistent: 10, total: 100, capCount: 5 }));
    expect(out.exit).toBe(0);
    expect(out.stato).toBe('deferred');
  });

  it('l\'ORDINE dei due rami e\' osservabile: 3 e non 1', () => {
    // Quando il veto scatta, il pareggio rende `isLegitimateQuotaDeferral`
    // falso per costruzione (share = 0,5 esatto), quindi il ramo quota
    // uscirebbe comunque non-zero. Cio' che l'ordine decide e' QUALE non-zero:
    // il 3 nomina la causa azionabile e quanti token togliere, l'1 e' generico.
    // Se il veto girasse dopo il ramo quota, questo caso uscirebbe 1 e
    // l'operatore perderebbe l'unica riga che dice cosa fare.
    const out: any = decidi(cascata({ transient: 53, persistent: 53, total: 106, capCount: 38 }));
    expect(out.exit).toBe(EXIT_ROSTER_CANNOT_SERVE_PROMPT);
    expect(out.righe.join('\n')).toMatch(/roster-cannot-serve-prompt/);
    expect(out.righe.join('\n')).not.toMatch(/roster-down-not-deferrable/);
  });
});

describe('il modulo e\' cablato davvero, e resta il gemello del corpus', () => {
  it('create-article.mjs importa la disposizione invece di riscriverla', () => {
    expect(SRC).toMatch(/from '\.\/lib\/exhaustion-disposition\.mjs'/);
  });

  it('EXIT_NO_ARTICLE_DECLARED e\' spedito ma NON cablato, ed e\' deliberato', () => {
    // Il modulo arriva intero perche' resti byte-identico al gemello e
    // promuovibile a `identical` nel manifest. Cablare il 4 richiede pero' il
    // contratto nello step di generate-article.yml, che qui non c'e': lo step
    // fa `exit "$rc"` e assorbe solo 124/137. E' lavoro concatenato, e questo
    // test e' cio' che impedisce di cablarlo per distrazione.
    expect(EXIT_NO_ARTICLE_DECLARED).toBe(4);
    // Nominato nei commenti (e' li' che la scelta e' spiegata), ma mai
    // importato ne' usato come valore.
    const importBlock = SRC.slice(
      SRC.indexOf("import {\n  EXIT_ROSTER_CANNOT_SERVE_PROMPT"),
      SRC.indexOf("} from './lib/exhaustion-disposition.mjs';"),
    );
    expect(importBlock).not.toMatch(/EXIT_NO_ARTICLE_DECLARED/);
    expect(SRC).not.toMatch(/process\.exit\(EXIT_NO_ARTICLE_DECLARED\)/);
  });
});
