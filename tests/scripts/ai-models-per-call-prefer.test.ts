import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('opts.prefer whitespace-only degrada al default MA lo segnala (#6018)', () => {
    // Prima della fix, `.trim()` sulla condizione di warn azzerava anche il
    // segnale: un input malformato ("   ") si comportava da "nessuna
    // preferenza" senza lasciare traccia — indistinguibile da un chiamante
    // che semplicemente non passa `prefer`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(applyModelsPrefer(['a', 'b'], '   ')).toEqual(['a', 'b']);
      const detti = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(detti).toContain('non ha voci utilizzabili');
    } finally {
      warn.mockRestore();
    }
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

  /**
   * Cosa questi test possono e NON possono dimostrare, detto prima.
   *
   * `_claudeCliCallsThisRun` e' privato del modulo e cresce solo dentro
   * `callLLM`, dopo un tentativo vero verso il provider. Da fuori il contatore
   * resta 0, e a contatore 0 `isPerRunCallCapReached` torna `false` per OGNI
   * valore del cap. Quindi un test che si limita ad asserire `false` passerebbe
   * anche contro `() => false`: non e' un osservatore, e' una decorazione.
   *
   * Cio' che invece si osserva da fuori e' il WARN, che e' la novita' vera di
   * corpus#423. E' su quello che stanno le asserzioni che discriminano.
   */

  async function freshModule() {
    // Il flag del warn-once e' di modulo e `resetState()` NON lo azzera (vedi
    // il residuo in fondo), quindi senza un'istanza nuova il secondo test del
    // file troverebbe il warn gia' speso e verde per il motivo sbagliato.
    vi.resetModules();
    return import('../../scripts/lib/ai-models.mjs');
  }

  it('a contatore 0 la guardia e inerte per qualunque cap — e per questo si puo interrogare prima del prompt', () => {
    // Asserzione di UNIFORMITA', non di semantica: e' la proprieta' che rende
    // sicuro chiamarla mentre si costruisce il prompt. Che `0` valga
    // «illimitato» lo dimostra il test dopo, non questo.
    for (const cap of [undefined, '0', '1', '40', 'spento']) {
      if (cap === undefined) delete process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN;
      else process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = cap;
      expect(isPerRunCallCapReached(HAIKU)).toBe(false);
      expect(isPerRunCallCapReached(RIVALE)).toBe(false);
    }
  });

  it('CLAUDE_CLI_MAX_CALLS_PER_RUN=0 NON e un kill switch: 0 = illimitato, e lo dice nel log', async () => {
    // LA TRAPPOLA, SCRITTA COME TEST.
    //
    // La lettura naturale di «cap = 0» su un modello a pagamento e' «zero
    // chiamate». La semantica reale e' l opposto esatto: cap disattivato. Chi
    // la usa per spegnere Haiku in fretta toglie l unico tetto che c era, e non
    // se ne accorge — il comportamento e' identico a quello nominale finche' la
    // run non supera le 40 chiamate.
    //
    // La convenzione NON e' stata invertita: e' condivisa col gemello
    // `mode: identical` del corpus e con gli altri cap del file. Il warn e' la
    // traccia che distingue «l ho voluto» da «pensavo di aver spento», ed e'
    // l unico effetto di `0` visibile da fuori: qui casca un `0 = spento`
    // introdotto per svista su UN SOLO lato.
    const mod = await freshModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '0';
      expect(mod.isPerRunCallCapReached(HAIKU)).toBe(false);
      const detti = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(detti).toContain('ILLIMITATE');
      expect(warn).toHaveBeenCalledTimes(1);

      // Warn-ONCE: la guardia viene interrogata a ogni prompt, e una riga per
      // chiamata renderebbe il log illeggibile proprio nella run che sta
      // sforando.
      mod.isPerRunCallCapReached(HAIKU);
      mod.isPerRunCallCapReached(HAIKU);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('un valore malformato non spegne il cap e non emette il warn dell illimitato', async () => {
    // `spento` non e' un intero >= 0: si torna al default 40, che NON e'
    // illimitato — quindi la riga di log non deve comparire. E' la meta' che
    // impedisce al warn di diventare rumore su ogni typo.
    const mod = await freshModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = 'spento';
      expect(mod.isPerRunCallCapReached(HAIKU)).toBe(false);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('ILLIMITATE');
    } finally {
      warn.mockRestore();
    }
  });

  it('la leva che spegne DAVVERO claude-cli e AI_MODELS_PREFER vuota, non il cap', () => {
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '0';
    process.env.AI_MODELS_PREFER = '';
    expect(applyModelsPrefer(['a', 'b'], [HAIKU])).toEqual(['a', 'b']);
  });
});
