import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AI_MODELS,
  DEFAULT_MODELS_PREFER,
  applyModelsPrefer,
  getPreferredModel,
  isPerRunCallCapReached,
  recordModelFailure,
  recordModelSuccess,
  resetState,
} from '../../scripts/lib/ai-models.mjs';

/**
 * `opts.prefer` — la preferenza per-chiamata che sopravvive al sort per
 * punteggio (riconciliazione sito/corpus, corpus#402 + corpus#379).
 *
 * PERCHE' ANCHE QUI, se il consumatore e' il corpus. `scripts/lib/ai-models.mjs`
 * e' `mode: identical` nel manifest del ciclo, e NESSUN mirror copre quel file
 * in nessuna delle due direzioni: `loop-drift-check` gira una volta al giorno e
 * apre una issue, non porta il codice. Un gate che vive solo di la' lascia
 * questa meta' senza rete fino al prossimo drift check.
 *
 * Le due proprieta' bloccate qui sono quelle che, se si invertono, tornano a
 * rompere due gate GIA' esistenti di questo repo:
 *
 *   - `ai-models-competing-tiers.test.ts` pretende che un tier-0 normale batta
 *     un tier appena promosso in parita' a 0. Un `DEFAULT_MODELS_PREFER` non
 *     vuoto lo viola: con lo score store irraggiungibile tutti i punteggi
 *     valgono 0, la parita' e' universale e il default dirotta OGNI chiamata di
 *     OGNI processo sul modello a pagamento.
 *   - `relocalize-traffic-priority.test.ts` pretende che `AI_MODELS_PREFER` in
 *     `translate-pending.yml` sia efficace — e lo e' solo DOPO il sort. Ma quel
 *     gate legge lo YAML, non l'ordine: se la preferenza tornasse prima del
 *     sort, il workflow perderebbe Haiku con il suo gate ancora verde. Questo
 *     test e' la meta' che manca.
 */
describe('opts.prefer — preferenza per-chiamata dopo il sort per punteggio', () => {
  const HAIKU = AI_MODELS.CLAUDE_CLI_HAIKU;
  const RIVALE = AI_MODELS.MISTRAL_SMALL;
  const ENV_KEYS = [
    'AI_MODELS_PREFER',
    'AI_MODELS_FORCE_CHAIN',
    'MISTRAL_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ENABLE_HAIKU_ARTICLE_FALLBACK',
    'CLAUDE_CLI_MAX_CALLS_PER_RUN',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  const CHAIN = [RIVALE, HAIKU];

  /** Riproduce il divario del ledger reale: haiku affondato, il rivale in cima. */
  function seminaIlDivario() {
    for (let i = 0; i < 40; i++) recordModelFailure(HAIKU, { nonRetryable: true });
    for (let i = 0; i < 200; i++) recordModelSuccess(RIVALE);
  }

  beforeEach(() => {
    resetState();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.AI_MODELS_PREFER;
    delete process.env.AI_MODELS_FORCE_CHAIN;
    delete process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN;
    // Entrambi disponibili, altrimenti si misura la disponibilita' e non l'ordine.
    process.env.MISTRAL_API_KEY = 'test-key';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = 'true';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetState();
  });

  it('il default e vuoto: nessuna preferenza spedita a ogni processo', () => {
    expect(DEFAULT_MODELS_PREFER).toEqual([]);
  });

  it('senza preferenza esplicita vince il punteggio, non l id preferito', () => {
    seminaIlDivario();
    expect(getPreferredModel({ chain: CHAIN })).toBe(RIVALE);
  });

  it('opts.prefer porta primo un modello affondato nel punteggio', () => {
    seminaIlDivario();
    expect(getPreferredModel({ chain: CHAIN, prefer: [HAIKU] })).toBe(HAIKU);
  });

  it('AI_MODELS_PREFER resta efficace dopo il sort (translate-pending.yml)', () => {
    process.env.AI_MODELS_PREFER = HAIKU;
    seminaIlDivario();
    expect(getPreferredModel({ chain: CHAIN })).toBe(HAIKU);
  });

  it('AI_MODELS_PREFER="" resta la leva di rollback istantaneo', () => {
    process.env.AI_MODELS_PREFER = '';
    seminaIlDivario();
    expect(getPreferredModel({ chain: CHAIN })).toBe(RIVALE);
  });

  it('riordina e non tronca: il fallback resta intero dietro il preferito', () => {
    expect(applyModelsPrefer(['a', 'b', 'c', HAIKU, 'd'], [HAIKU]))
      .toEqual([HAIKU, 'a', 'b', 'c', 'd']);
  });

  it('opts.prefer vince sulla variabile d ambiente', () => {
    process.env.AI_MODELS_PREFER = 'c';
    expect(applyModelsPrefer(['a', 'b', 'c'], ['b'])).toEqual(['b', 'a', 'c']);
  });

  it('AI_MODELS_PREFER="" spegne ANCHE il prefer per-chiamata (il percorso di produzione)', () => {
    // PERCHE' IL TEST «resta la leva di rollback istantaneo» QUI SOPRA NON BASTAVA.
    //
    // Quello chiama getPreferredModel({ chain: CHAIN }) SENZA `prefer`, cioe'
    // esercita il ramo env-only. In produzione quel ramo non viene mai preso:
    // il generatore passa `prefer` su ENTRAMBE le chiamate che generano il
    // corpo dell articolo. Un verde su un ramo che nessuno percorre e' piu'
    // pericoloso di un test assente, perche' fa credere coperta la leva di
    // spesa su un modello a pagamento.
    //
    // Misurato su questo file PRIMA della fix, con AI_MODELS_PREFER="":
    //   applyModelsPrefer(['a','b'], ['claude-cli/haiku'])
    //     -> ['claude-cli/haiku','a','b']
    // cioe' la leva documentata come «rollback istantaneo» non fermava nulla.
    process.env.AI_MODELS_PREFER = '';
    seminaIlDivario();

    expect(applyModelsPrefer(['a', 'b'], [HAIKU])).toEqual(['a', 'b']);

    // E lo stesso attraverso la funzione che rispecchia l ordine reale di
    // callLLM (morbida -> sort -> dura), con il divario di punteggio vero.
    expect(getPreferredModel({ chain: CHAIN, prefer: [HAIKU] })).toBe(RIVALE);

    // Anche in forma CSV, che e' l altra forma accettata da opts.prefer.
    expect(getPreferredModel({ chain: CHAIN, prefer: HAIKU })).toBe(RIVALE);
  });

  it('la leva vuota non e «env batte per-call»: un valore NON vuoto perde ancora', () => {
    // Il contro-verso, che tiene onesta l inversione: solo la stringa VUOTA —
    // un atto deliberato — vince sul per-call. Un AI_MODELS_PREFER valorizzato
    // resta l opt-in di processo, meno specifico della preferenza per-chiamata,
    // esattamente come prima. Senza questa riga la fix del rollback potrebbe
    // degenerare in «l ambiente comanda sempre», che romperebbe la ragione
    // stessa per cui opts.prefer esiste.
    process.env.AI_MODELS_PREFER = RIVALE;
    seminaIlDivario();
    expect(getPreferredModel({ chain: CHAIN, prefer: [HAIKU] })).toBe(HAIKU);
  });
});

describe('cap di chiamate per-run — la domanda che la guardia del prompt deve poter fare', () => {
  const HAIKU = AI_MODELS.CLAUDE_CLI_HAIKU;
  const RIVALE = AI_MODELS.MISTRAL_SMALL;
  const ENV_KEYS = [
    'AI_MODELS_PREFER',
    'AI_MODELS_FORCE_CHAIN',
    'MISTRAL_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ENABLE_HAIKU_ARTICLE_FALLBACK',
    'CLAUDE_CLI_MAX_CALLS_PER_RUN',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetState();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.AI_MODELS_PREFER;
    delete process.env.AI_MODELS_FORCE_CHAIN;
    delete process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN;
    process.env.MISTRAL_API_KEY = 'test-key';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = 'true';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetState();
  });

  it('e interrogabile PRIMA di costruire il prompt, e riguarda solo claude-cli', () => {
    // A inizio run nessuna chiamata e' stata spesa: il cap non e' raggiunto.
    expect(isPerRunCallCapReached(HAIKU)).toBe(false);
    // E per un provider senza cap per-run la risposta e' sempre false, anche
    // con la variabile impostata: il cap e' di claude-cli, non globale.
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '1';
    expect(isPerRunCallCapReached(RIVALE)).toBe(false);
  });

  it('CLAUDE_CLI_MAX_CALLS_PER_RUN=0 NON e un kill switch: 0 = illimitato', () => {
    // LA TRAPPOLA, SCRITTA COME TEST.
    //
    // La lettura naturale di «cap = 0» su un modello a pagamento e' «zero
    // chiamate». La semantica reale e' l opposto esatto: cap disattivato. Chi
    // la usa per spegnere Haiku in fretta toglie l unico tetto che c era, e non
    // se ne accorge — il comportamento e' identico a quello nominale finche' la
    // run non supera le 40 chiamate. Da questa PR c e' un warn-once che lo dice.
    //
    // La convenzione NON e' stata invertita: e' condivisa col gemello
    // `mode: identical` del corpus e con gli altri cap del file. Questa riga
    // impedisce a un futuro «sistemiamo 0 = spento» di passare per una svista
    // su UN SOLO lato.
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '0';
    expect(isPerRunCallCapReached(HAIKU)).toBe(false);

    // La leva che spegne davvero e' un altra, ed e' quella sopra.
    process.env.AI_MODELS_PREFER = '';
    expect(applyModelsPrefer(['a', 'b'], [HAIKU])).toEqual(['a', 'b']);
  });

  it('un valore malformato non spegne il cap: si torna al default', () => {
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = 'spento';
    expect(isPerRunCallCapReached(HAIKU)).toBe(false); // default 40, 0 chiamate spese
  });
});
