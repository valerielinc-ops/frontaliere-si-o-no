/**
 * La decisione di cascata su `IT_GENERATION_MAX_TOKENS` vive in un COMMENTO, e
 * un commento non ha nessuno che lo contraddica quando il codice si muove.
 *
 * Questo repo ha gia' pagato quel prezzo: `alert-pat-down.mjs` dichiarava in un
 * commento che un certo workflow era «l'unico punto di chiusura» del suo alert,
 * e quel workflow non esisteva. La CI era verde: nessun guard segue i nomi
 * citati in prosa.
 *
 * La stessa forma era arrivata QUI. Il commento aggiunto dalla PR #6028 diceva
 * che a 8000 restano fuori «Cohere-command-r-08-2024 e command-r7b-12-2024
 * (4096) e Phi-4-mini-reasoning (4000)», e che scendere a 4000 «li farebbe
 * rientrare»:
 *
 *   - `Cohere-command-r-08-2024` NON e' nel roster — tolto da `AI_MODELS` il
 *     2026-07-05 (HTTP 400 `unknown_model`, ritirato live, vedi il commento a
 *     ai-models.mjs riga ~94). Un modello fuori dal roster non puo' rientrare.
 *   - `cohere/command-r-08-2024`, l'omonimo Cohere diretto, e' nella catena, ha
 *     cap 4096 ed E' escluso a 8000 — e il commento non lo nominava.
 *
 * Il conteggio (tre) tornava per caso, ed e' esattamente cosa rende una prosa
 * sbagliata piu' pericolosa di nessuna prosa.
 *
 * Le asserzioni qui sotto legano il commento a cio' che si puo' MISURARE:
 * la catena vera, la tabella dei cap vera, e la costante che il marker
 * `over=` confronta davvero.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_CHAIN } from '../scripts/lib/ai-models.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREATE_ARTICLE = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');
const AI_MODELS_SRC = readFileSync(resolve(ROOT, 'scripts/lib/ai-models.mjs'), 'utf8');

/**
 * Il blocco di commento che PORTA la decisione, cercato per il suo testo e non
 * per la sua posizione — cosi' il test lo trova anche se e' finito staccato
 * dalla costante, che e' proprio com'era arrivato: un `/** ... *\/` penzolante
 * SOTTO la dichiarazione, quindi attaccato al simbolo successivo. Un blocco
 * penzolante e' peggio di uno assente: sembra documentazione della costante e
 * non lo e' per nessuno strumento che segua la sintassi.
 */
function cascadeDoc(): { block: string; attaccatoA: string } {
  const marker = CREATE_ARTICLE.indexOf('Decisione di cascata');
  if (marker === -1) throw new Error('nessun blocco «Decisione di cascata» in create-article.mjs');
  const open = CREATE_ARTICLE.lastIndexOf('/**', marker);
  const close = CREATE_ARTICLE.indexOf('*/', marker);
  if (open === -1 || close === -1) throw new Error('la decisione non e\' dentro un blocco di commento');
  return {
    block: CREATE_ARTICLE.slice(open, close + 2),
    attaccatoA: CREATE_ARTICLE.slice(close + 2).replace(/^\s*/, '').slice(0, 60),
  };
}

const CASCADE_DOC = cascadeDoc().block;

const IT_GENERATION_MAX_TOKENS = Number(
  /const IT_GENERATION_MAX_TOKENS = (\d+);/.exec(CREATE_ARTICLE)?.[1],
);

/** `MODEL_MAX_OUTPUT_TOKENS` non e' esportata: si legge dal sorgente. */
function modelMaxOutputTokens(): Record<string, number> {
  const start = AI_MODELS_SRC.indexOf('const MODEL_MAX_OUTPUT_TOKENS = {');
  expect(start, 'MODEL_MAX_OUTPUT_TOKENS non trovata in ai-models.mjs').toBeGreaterThan(-1);
  const end = AI_MODELS_SRC.indexOf('\n};', start);
  const body = AI_MODELS_SRC.slice(start, end);
  const table: Record<string, number> = {};
  for (const m of body.matchAll(/^\s*'([^']+)':\s*(\d+),/gm)) table[m[1]] = Number(m[2]);
  expect(Object.keys(table).length, 'tabella dei cap di output letta vuota').toBeGreaterThan(3);
  return table;
}

/** Replica di `getApiModelId()`, coi prefissi letti dal suo stesso sorgente. */
function apiModelId(model: string): string {
  const fn = AI_MODELS_SRC.slice(AI_MODELS_SRC.indexOf('function getApiModelId('));
  const prefixes = [...fn.slice(0, fn.indexOf('\n}')).matchAll(/model\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
  const hit = prefixes.find((p) => model.startsWith(p));
  return hit ? model.slice(hit.length) : model;
}

/** I membri della catena che il pre-flight salta per cap di OUTPUT, a un dato maxTokens. */
function excludedAt(maxTokens: number): { model: string; cap: number }[] {
  const table = modelMaxOutputTokens();
  return DEFAULT_CHAIN
    .map((model: string) => ({ model, cap: table[apiModelId(model)] }))
    // `if (modelLimit && o.maxTokens > modelLimit)` — stessa forma del guard.
    .filter((r: { model: string; cap: number }) => r.cap && maxTokens > r.cap);
}

/** Le righe `*   <id>   <cap>` dell'elenco dentro il commento. */
function tabellaDelCommento(): { model: string; cap: number }[] {
  return [...CASCADE_DOC.matchAll(/^\s*\*\s{2,}([A-Za-z0-9._/-]+)\s+(\d{3,6})\s*$/gm)]
    .map((m) => ({ model: m[1], cap: Number(m[2]) }));
}

describe('decisione di cascata su IT_GENERATION_MAX_TOKENS', () => {
  test('il commento e\' ATTACCATO alla costante che documenta', () => {
    expect(
      cascadeDoc().attaccatoA,
      'il blocco «Decisione di cascata» non precede `const IT_GENERATION_MAX_TOKENS`. Un JSDoc '
        + 'penzolante — che e\' com\'era arrivato, SOTTO la dichiarazione — documenta il simbolo '
        + 'successivo, non la costante, e nessuno strumento che segua la sintassi lo collega a lei.',
    ).toMatch(/^const IT_GENERATION_MAX_TOKENS\b/);
  });

  test('i modelli elencati nel commento sono ESATTAMENTE quelli che il guard esclude oggi', () => {
    const misurato = excludedAt(IT_GENERATION_MAX_TOKENS);
    const dichiarato = tabellaDelCommento();

    expect(
      dichiarato.length,
      'il commento non elenca nessun modello in forma leggibile (righe `*   <id>   <cap>`): '
        + 'una prosa che nomina i modelli in mezzo al periodo non e\' verificabile, e per questo '
        + 'nomino\' un modello ritirato senza che nulla lo notasse.',
    ).toBeGreaterThan(0);

    expect(
      dichiarato.map((r) => r.model).sort(),
      `il commento su IT_GENERATION_MAX_TOKENS=${IT_GENERATION_MAX_TOKENS} elenca modelli diversi da `
        + 'quelli che il pre-flight salta davvero. Misurati su DEFAULT_CHAIN x MODEL_MAX_OUTPUT_TOKENS: '
        + misurato.map((r) => `${r.model} (${r.cap})`).join(', '),
    ).toEqual(misurato.map((r) => r.model).sort());

    const capMisurati = new Map(misurato.map((r) => [r.model, r.cap]));
    for (const riga of dichiarato) {
      expect(riga.cap, `cap sbagliato nel commento per ${riga.model}`).toBe(capMisurati.get(riga.model));
    }
  });

  test('ogni modello nominato dal commento o e\' nella catena, o e\' dichiarato fuori dal roster', () => {
    const inChain = new Set<string>(DEFAULT_CHAIN);
    const tabella = new Set(tabellaDelCommento().map((r) => r.model));
    // Id plausibili citati in prosa: contengono un trattino e una cifra o uno slash.
    const citati = [...CASCADE_DOC.matchAll(/`?\b([A-Za-z][A-Za-z0-9.]*(?:[/-][A-Za-z0-9.]+){2,})`?/g)]
      .map((m) => m[1])
      .filter((id) => !id.includes('.mjs') && !id.includes('.ts') && !tabella.has(id));

    const tabellaCap = modelMaxOutputTokens();
    for (const id of new Set(citati)) {
      // Solo gli id che la tabella dei cap conosce sono nomi di modello.
      if (!(id in tabellaCap)) continue;
      if (inChain.has(id)) continue;
      expect(
        CASCADE_DOC,
        `il commento nomina il modello \`${id}\`, che NON e' in DEFAULT_CHAIN, senza dire che e' `
          + 'fuori dal roster. E\' la classe alert-pat-down: un nome citato in prosa che non esiste piu\'.',
      ).toMatch(/tolto da `AI_MODELS`|fuori dal roster/);
    }
  });

  test('`over=1` e\' attribuito alla costante contro cui e\' davvero misurato', () => {
    // Nel codice: `_promptTokenTarget` cade su PROMPT_TOKEN_BUDGET quando la
    // flotta non ha ancora dettato un budget, e `over` confronta con QUELLO.
    expect(
      CREATE_ARTICLE,
      'il fallback di _promptTokenTarget non e\' piu\' PROMPT_TOKEN_BUDGET: aggiornare il commento e questo test',
    ).toMatch(/_promptTokenTarget[\s\S]{0,400}?:\s*PROMPT_TOKEN_BUDGET;/);
    expect(CREATE_ARTICLE).toMatch(/over=\$\{_promptOverBudget \? 1 : 0\}/);

    const periodi = CASCADE_DOC.split(/(?<=\.)\s/).filter((p) => p.includes('over=1'));
    expect(periodi.length, 'il commento non parla piu\' di `over=1`: aggiornare questo test').toBeGreaterThan(0);
    for (const p of periodi) {
      expect(
        p.replace(/\s+/g, ' '),
        '`over=1` si misura contro PROMPT_TOKEN_BUDGET (8000), non contro PROMPT_TOKEN_CEILING: '
          + 'il tetto non e\' superato da nessun ramo, quindi attribuirgli `over=1` inverte la lettura.',
      ).toContain('PROMPT_TOKEN_BUDGET');
    }
  });

  test('il retry di parse-error non ripete il numero della costante', () => {
    // Se questo ramo torna a un letterale, la decisione documentata sopra
    // diventa falsa nel momento stesso in cui la costante scende: il retry
    // continuerebbe a chiedere 8000 e a farsi saltare i tre modelli.
    const m = /const retryTokens = isTruncation \? (\d+) : ([A-Za-z0-9_]+);/.exec(CREATE_ARTICLE);
    expect(m, 'riga `retryTokens` non trovata — aggiornare questo test').not.toBeNull();
    expect(
      m?.[2],
      'il ramo non-troncamento del retry ha di nuovo un budget letterale: la costante esiste proprio '
        + 'perche\' le chiamate di generazione IT non possano divergere fra loro.',
    ).toBe('IT_GENERATION_MAX_TOKENS');
  });

  test('i simboli citati dal commento esistono davvero', () => {
    const citatiCreateArticle = ['PROMPT_TOKEN_BUDGET', 'PROMPT_TOKEN_CEILING', 'CREATE_ARTICLE_MIN_IT_WORDS'];
    const citatiAiModels = [
      'MODEL_MAX_OUTPUT_TOKENS',
      'DEFAULT_CHAIN',
      'AI_MODELS',
      'DEFAULT_REQUEST_TOKENS_BY_PROVIDER',
      'getDeclaredRequestTokenLimit',
    ];
    for (const sym of citatiCreateArticle) {
      if (!CASCADE_DOC.includes(sym)) continue;
      expect(CREATE_ARTICLE, `il commento cita \`${sym}\`, che create-article.mjs non dichiara`)
        .toMatch(new RegExp(`(const|let|function)\\s+${sym}\\b`));
    }
    for (const sym of citatiAiModels) {
      if (!CASCADE_DOC.includes(sym)) continue;
      expect(AI_MODELS_SRC, `il commento cita \`${sym}\`, che ai-models.mjs non dichiara`)
        .toMatch(new RegExp(`(const|function)\\s+${sym}\\b`));
    }
    // Il file citato per il fixture della misura deve esistere.
    if (CASCADE_DOC.includes('tests/news-prompt-token-budget.test.ts')) {
      expect(() => readFileSync(resolve(ROOT, 'tests/news-prompt-token-budget.test.ts'), 'utf8')).not.toThrow();
    }
    if (CASCADE_DOC.includes('tests/create-article-cascade-decision.test.ts')) {
      expect(() => readFileSync(resolve(ROOT, 'tests/create-article-cascade-decision.test.ts'), 'utf8')).not.toThrow();
    }
  });
});
