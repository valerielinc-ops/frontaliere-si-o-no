/**
 * ── IL «FLOOR» CHE FACEVA DA SOFFITTO ───────────────────────────────────────
 *
 * Difetto misurato il 2026-08-18 (run 32161215947): il timeout del CLI valeva
 *
 *     min( max(opts.timeout, CLAUDE_CLI_MIN_TIMEOUT_MS), remaining )
 *
 * e con `opts.timeout` = 90s per la generazione articolo il `max` dava sempre
 * il minimo (120s), mentre `remaining` era 600-1000s. Il log lo diceva a
 * chiare lettere e nessuno lo leggeva come un bug:
 *
 *     ⏳ [claude-cli/haiku] in-flight 60s (hard cap 1020s)   → ucciso a 120s
 *
 * 900s di allowance inutilizzata, e tre chiamate su tre troncate MENTRE
 * emettevano (123-175 eventi, fino a 84 KB di stdout, ferme dopo `assistant`).
 *
 * Questo test NON fissa i numeri: sono una taratura e cambieranno. Fissa
 * l'ORDINE fra loro, cioe' le due proprieta' la cui violazione ha prodotto il
 * difetto — che il tempo concesso possa SUPERARE il minimo quando c'e'
 * allowance, e che resti comunque limitato dall'allowance stessa.
 *
 * Estratto dal sorgente e non importato, per lo stesso vincolo documentato in
 * claude-cli-timeout-storm-threshold.test.mjs: sono costanti di modulo non
 * esportate, e farle scattare davvero vorrebbe dire spawnare `claude` e
 * aspettare minuti per tentativo.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Gemello di generator/tests/claude-cli-timeout-allowance.test.mjs del corpus.
// `node:assert` e non `expect` di proposito: tiene i due file uguali riga per
// riga a meno degli import, cosi' una divergenza fra i due lati si vede a
// colpo d'occhio — `scripts/lib/ai-models.mjs` e' `mode: identical` nel
// manifest del ciclo e nessun mirror copre `generator/`.
const SRC = readFileSync(new URL('../../scripts/lib/ai-models.mjs', import.meta.url), 'utf-8');

/** Legge una costante numerica di modulo, accettando sia `120_000` sia `1 / 3`. */
function costante(nome) {
  const m = SRC.match(new RegExp(`const ${nome} = ([^;]+);`));
  assert.ok(m, `costante ${nome} non trovata — aggiornare questo test`);
  // eslint-disable-next-line no-new-func
  const v = Function(`"use strict"; return (${m[1]});`)();
  assert.ok(Number.isFinite(v), `${nome} non e' un numero finito: ${m[1]}`);
  return v;
}

const MIN = () => costante('CLAUDE_CLI_MIN_TIMEOUT_MS');
const MAX = () => costante('CLAUDE_CLI_MAX_TIMEOUT_MS');
const SHARE = () => costante('CLAUDE_CLI_ALLOWANCE_SHARE');
const SOGLIA = () => costante('CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD');

describe('il timeout del CLI claude cresce dentro l\'allowance residua', () => {
  it('il tetto sta SOPRA il minimo — altrimenti il minimo torna a fare da soffitto', () => {
    assert.ok(
      MIN() < MAX(),
      `minimo ${MIN()}ms e tetto ${MAX()}ms: se il tetto non e' sopra il minimo, la quota ` +
      'dell\'allowance non puo\' mai alzare nulla e siamo tornati al difetto del 18-08',
    );
  });

  // Misura, non taratura: 120_000ms e' il punto in cui le chiamate MORIVANO
  // nella run 32161215947 — tre su tre troncate mentre emettevano ancora.
  // Non e' il vecchio valore della costante ripetuto qui per inerzia: e' il
  // dato osservato che rende quel valore inadeguato, e resta vero anche se la
  // costante cambia ancora. Il confronto e' quindi un ORDINE fra il floor e
  // una durata misurata, non un pin sul numero corrente.
  //
  // Serve perche' le altre asserzioni non lo coprono: una prova di mutazione
  // (2026-08-18) ha rimesso il floor a 120_000 e le altre 11 sono restate
  // tutte verdi, perche' 120s < tetto e la formula della quota non cambia.
  // Senza questa riga la meta' «alza il floor» del lavoro non ha presidio.
  const MORTE_OSSERVATA_MS = 120_000;

  // Margine di sicurezza esplicito: un confronto stretto (`MIN() > MORTE_OSSERVATA_MS`)
  // passerebbe anche con un floor ritarato a 120_001ms, verde pur restando a un
  // millisecondo dal comportamento quasi-originale. 30s tengono la taratura onesta
  // senza pinnare il numero corrente (margine attuale MIN-MORTE_OSSERVATA_MS = 60s).
  const MARGINE_SICUREZZA_MS = 30_000;

  it('il minimo sta SOPRA la durata a cui le chiamate morivano davvero, con margine', () => {
    assert.ok(
      MIN() >= MORTE_OSSERVATA_MS + MARGINE_SICUREZZA_MS,
      `minimo ${MIN()}ms: non basta stare sotto il tetto, deve stare SOPRA i ` +
      `${MORTE_OSSERVATA_MS}ms a cui la run 32161215947 troncava chiamate ancora vive, ` +
      `con almeno ${MARGINE_SICUREZZA_MS / 1000}s di margine. Un floor appena sopra la ` +
      'soglia osservata (es. 120_001ms) tornerebbe a fare da soffitto in pratica pur ' +
      'passando un confronto stretto: il margine e\' cio\' che lo impedisce.',
    );
  });

  it('la quota concessa e\' una frazione propria dell\'allowance, non tutta', () => {
    const s = SHARE();
    assert.ok(
      s > 0 && s < 1,
      `quota ${s}: a >=1 una sola chiamata si prende l'intera sezione e non resta ` +
      'niente alla cascata dei modelli successivi',
    );
  });

  /**
   * Riproduce la formula di _callClaudeCli. Tenuta qui e non importata per lo
   * stesso motivo delle costanti; le due asserzioni di forma piu' sotto sono
   * cio' che impedisce a questa copia di divergere in silenzio dal sorgente.
   */
  function concesso(remainingMs) {
    const quota = Math.min(Math.floor(remainingMs * SHARE()), MAX());
    return Math.max(15_000, Math.min(Math.max(MIN(), quota), remainingMs));
  }

  /** Spesa di `n` timeout consecutivi a partire da un'allowance data. */
  function tempesta(allowanceMs, n) {
    let rimasto = allowanceMs;
    let speso = 0;
    for (let i = 0; i < n; i++) {
      const t = concesso(rimasto);
      speso += t;
      rimasto -= t;
    }
    return speso;
  }

  it('una tempesta non sfonda l\'allowance oltre il «last try» da 15s gia\' previsto', () => {
    // La clamp finale a `remaining` e' cio' che tiene la tempesta dentro il
    // budget di sezione: il kill duro del workflow non deve mai essere quello
    // che raccoglie i cocci.
    //
    // L'UNICO sforamento ammesso e' il pavimento da 15s — «a near-expired
    // deadline still gets one honest last try», vedi _callLocal — che concede
    // 15s anche a deadline gia' scaduta. E' preesistente e identico nel codice
    // vecchio (con il fisso a 120s la stessa simulazione sfora dello stesso
    // identico margine), quindi qui e' dichiarato, non subito: una tempesta
    // puo' eccedere al massimo di 15s per ogni tentativo oltre l'esaurimento.
    //
    // Se un giorno quel pavimento sparisse, questo test va reso `<= allowance`
    // secco — non allentato.
    const LAST_TRY_MS = 15_000;
    const tolleranza = LAST_TRY_MS * (SOGLIA() - 1);
    // Serie di allowance osservata nei run 32147257594 e 32161215947, piu' i
    // casi degeneri sotto il minimo.
    for (const s of [30, 60, 136, 200, 302, 392, 496, 630, 685, 758, 900, 1020, 2400]) {
      const speso = tempesta(s * 1000, SOGLIA());
      assert.ok(
        speso <= s * 1000 + tolleranza,
        `allowance ${s}s: una tempesta da ${SOGLIA()} timeout ne spenderebbe ` +
        `${(speso / 1000).toFixed(0)}s, cioe' ${((speso - s * 1000) / 1000).toFixed(0)}s oltre ` +
        `l'allowance — piu' dei ${tolleranza / 1000}s del «last try»`,
      );
    }
  });

  it('quando l\'allowance e\' ampia la tempesta lascia budget alla cascata', () => {
    // Nel regime in cui comanda la quota (allowance grande) il consumo e'
    // geometrico e deve restare lontano dal 100%, altrimenti il breaker
    // protegge una sezione che non ha piu' tempo per il fallback.
    //
    // Sotto, invece, comanda il MINIMO e la tempesta puo' legittimamente
    // consumare tutta l'allowance — esattamente come faceva il vecchio fisso a
    // 120s su una sezione da 360s. Li' la garanzia che resta e' quella del
    // test sopra: non sfondare. Per questo la soglia e' verificata sul regime
    // ampio e non su tutti, che sarebbe un'asserzione falsa.
    const ampia = MIN() * SOGLIA() * 3;
    const speso = tempesta(ampia, SOGLIA());
    const frazione = speso / ampia;
    assert.ok(
      frazione < 0.75,
      `con quota ${SHARE()} e soglia ${SOGLIA()}, su un'allowance ampia (${ampia / 1000}s) ` +
      `una tempesta spende il ${(frazione * 100).toFixed(1)}%: sopra il 75% non resta ` +
      'sezione utile per i modelli dopo claude-cli',
    );
  });

  it('il tempo concesso puo\' SUPERARE il minimo: e\' la riga che il difetto non aveva', () => {
    // La forma che conta: `Math.max(baseTimeoutMs, quota)`. Prima qui c'era un
    // `Math.min(baseTimeoutMs, remaining)` e basta, che non poteva mai superare
    // il minimo. Se questa riga torna a essere un solo `min`, il difetto e'
    // rientrato con la CI verde.
    assert.ok(
      /Math\.max\(\s*baseTimeoutMs\s*,\s*quota\s*\)/.test(SRC),
      'in _callClaudeCli il timeout non prende piu\' il massimo fra il minimo e la quota ' +
      'dell\'allowance: e\' esattamente la forma il cui difetto ha troncato 3 chiamate su 3 ' +
      'nel run 32161215947',
    );
    assert.ok(
      /remaining \* CLAUDE_CLI_ALLOWANCE_SHARE/.test(SRC),
      'la quota non e\' piu\' derivata da `remaining`: un valore fisso spreca quando ' +
      'l\'allowance e\' grande e sfonda quando e\' piccola',
    );
  });

  it('resta comunque limitato dall\'allowance: la tempesta non puo\' sfondare la sezione', () => {
    // La clamp finale a `remaining` e' cio' che rende il bound vero PER
    // COSTRUZIONE, cioe' indipendente da come vengono tarati minimo e soglia.
    assert.ok(
      /Math\.min\(Math\.max\(baseTimeoutMs, quota\), remaining\)/.test(SRC),
      'sparita la clamp finale a `remaining`: senza quella, alzare il minimo o la soglia ' +
      'del breaker puo\' far durare una tempesta piu\' del budget di sezione, ed e\' il kill ' +
      'duro del workflow a raccogliere i cocci',
    );
  });

  it('il backstop _hardCallCapMs e\' dimensionato sul TETTO, non sul minimo', () => {
    // Se resta sul minimo, il cap duro scatta prima del timeout che deve fare
    // da backstop su ogni chiamata che usa la quota — il fallimento che il
    // commento «otherwise the cap would fire before their own timeout ever
    // could» esiste per prevenire.
    assert.ok(
      /provider === PROVIDER\.CLAUDE_CLI\) base = Math\.max\(base, CLAUDE_CLI_MAX_TIMEOUT_MS\)/.test(SRC),
      '_hardCallCapMs dimensiona il cap del CLI sul minimo invece che sul tetto: una ' +
      'chiamata che usa la quota verrebbe abbattuta dal backstop prima del suo timeout',
    );
  });
});

/**
 * ── STESSO DIFETTO, GEMELLO NON TOCCATO ─────────────────────────────────────
 *
 * La review di #451 su questo stesso file ha trovato lo stesso pattern in
 * `_callLocal`: `Math.max(opts.timeout || 0, getLocalLlmTimeoutMs())` seguito
 * da un `Math.min(timeout, remaining)` che clampa solo verso il basso — il
 * floor CPU-inference non cresceva mai dentro l'allowance residua, esattamente
 * come CLAUDE_CLI_MIN_TIMEOUT_MS prima del fix sopra. Stessa forma applicata
 * qui: `_callLocal` prende una quota di `remaining`, e `_hardCallCapMs`
 * dimensiona il backstop LOCAL sul tetto e non piu' sul floor.
 */
const LOCAL_MAX = () => costante('LOCAL_LLM_MAX_TIMEOUT_MS');
const LOCAL_SHARE = () => costante('LOCAL_LLM_ALLOWANCE_SHARE');

describe('il timeout locale cresce dentro l\'allowance residua (stesso pattern di _callClaudeCli)', () => {
  it('il tetto locale sta SOPRA il floor di default (1_500_000ms) — altrimenti il floor torna a fare da soffitto', () => {
    assert.ok(
      LOCAL_MAX() > 1_500_000,
      `tetto locale ${LOCAL_MAX()}ms non sopra il floor di default 1500000ms: la quota ` +
      'non potrebbe mai alzare nulla e siamo tornati al difetto gemello di quello del CLI',
    );
  });

  it('la quota locale e\' una frazione propria dell\'allowance, non tutta', () => {
    const s = LOCAL_SHARE();
    assert.ok(s > 0 && s < 1, `quota locale ${s}: a >=1 una sola chiamata si prende l'intera sezione`);
  });

  it('_callLocal usa Math.max(baseTimeoutMs, quota): la riga che il difetto gemello non aveva', () => {
    assert.ok(
      /Math\.max\(\s*baseTimeoutMs\s*,\s*quota\s*\)/.test(SRC.slice(SRC.indexOf('async function _callLocal'), SRC.indexOf('async function _callLocal') + 2000)),
      'in _callLocal il timeout non prende piu\' il massimo fra baseTimeoutMs e la quota ' +
      'dell\'allowance: e\' esattamente la forma il cui difetto gemello (floor come tetto) ' +
      'la review di #451 ha trovato non toccata',
    );
    assert.ok(
      /remaining \* LOCAL_LLM_ALLOWANCE_SHARE/.test(SRC),
      'la quota locale non e\' piu\' derivata da `remaining`: un valore fisso spreca quando ' +
      'l\'allowance e\' grande e sfonda quando e\' piccola',
    );
  });

  it('il backstop _hardCallCapMs per LOCAL e\' dimensionato sul TETTO, non sul floor', () => {
    assert.ok(
      /provider === PROVIDER\.LOCAL\) base = Math\.max\(base, LOCAL_LLM_MAX_TIMEOUT_MS\)/.test(SRC),
      '_hardCallCapMs dimensiona il cap locale sul floor invece che sul tetto: una chiamata ' +
      'che usa la quota verrebbe abbattuta dal backstop prima del suo timeout',
    );
  });
});
