import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AI_MODELS,
  DEFAULT_MODELS_PREFER,
  applyModelsPrefer,
  getPreferredModel,
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
});
