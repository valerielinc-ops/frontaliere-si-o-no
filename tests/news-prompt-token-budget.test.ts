/**
 * Il lock sul budget del prompt di `scripts/create-article.mjs`.
 *
 * Gemello ADATTATO di `generator/tests/news-prompt-token-budget.test.mjs` del
 * corpus (nanakokyobashi-rgb/frontaliere-articles). I due `create-article.mjs`
 * sono `mode: adapted` nel manifest del ciclo: diversi per costruzione, e
 * nessun mirror copre `generator/` in nessuna direzione — quindi questo file e'
 * un porting, non una copia, e i numeri qui sotto sono misurati SU QUESTO LATO.
 *
 * PERCHE' ESISTE.
 * Il 2026-08-14 sul corpus `create-article.mjs` e' uscito **verde** (`success`)
 * senza scrivere un articolo per 60+ run consecutive, dalle 06:06Z alle 16:30Z:
 * ogni modello veniva saltato dal pre-flight di `callLLM` con «request ~9740
 * tokens exceeds 8000-token input cap». Ogni riga di log nominava un MODELLO,
 * nessuna nominava il PROMPT — ed e' per questo che il difetto e' sopravvissuto
 * undici ore. Il gemello vivo di questo lato e' importato da
 * `publish-journalist-articles.yml`, che gira ogni 15 minuti.
 *
 * PERCHE' E' SCRITTO PER ESTRAZIONE E NON PER REPLICA.
 * Il difetto originale e' nato esattamente da una misura parziale: un commento
 * onesto e riproducibile che pero' pesava UN SOLO RAMO. Un test che
 * ricostruisse il prompt a mano ripeterebbe lo stesso errore in forma nuova —
 * misurerebbe la propria copia, non il prompt che parte davvero. Qui il blocco
 * di assemblaggio viene ESTRATTO dal sorgente di `create-article.mjs` e
 * valutato con le sole dipendenze iniettate; importare il modulo non e'
 * praticabile perche' a module-scope legge registro, dati e chiavi.
 * La stima usa `estimateRequestTokens` REALE, importata da `ai-models.mjs`:
 * e' la funzione che decide davvero se un modello viene saltato.
 *
 * Se un anchor scivola il test FALLISCE rumorosamente (test 0): non puo'
 * passare a vuoto misurando una stringa mutilata.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRequestTokens } from '../scripts/lib/ai-models.mjs';
import { AI_SEARCH_PROMPT_BLOCK_IT } from '../scripts/lib/ai-search-template.mjs';
import { JSON_QUOTE_SAFETY_RULE_IT } from '../scripts/lib/llm-json-repair.mjs';
import { buildSourceContract } from '../scripts/lib/article-factuality-gates.mjs';
import { buildWinnerFingerprintMessage, isFrontalieriDomainTerm } from '../scripts/lib/article-topic-selector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.join(HERE, '..', 'scripts', 'create-article.mjs');
const AI_MODELS_SRC = path.join(HERE, '..', 'scripts', 'lib', 'ai-models.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Ritaglia un blocco fra due anchor, fallendo forte se una non c'e' piu'. */
function cut(
  startAnchor: string,
  endAnchor: string,
  { includeEnd = true, from = src }: { includeEnd?: boolean; from?: string } = {},
): string {
  const a = from.indexOf(startAnchor);
  expect(a, `anchor iniziale non trovata — aggiornare questo test: ${startAnchor}`).not.toBe(-1);
  const b = from.indexOf(endAnchor, a + startAnchor.length);
  expect(b, `anchor finale non trovata — aggiornare questo test: ${endAnchor}`).not.toBe(-1);
  return from.slice(a, includeEnd ? b + endAnchor.length : b);
}

/** Ritaglia una dichiarazione top-level fino alla sua chiusura in colonna 0. */
function cutDecl(startAnchor: string, { from = src }: { from?: string } = {}): string {
  const a = from.indexOf(startAnchor);
  expect(a, `dichiarazione non trovata — aggiornare questo test: ${startAnchor}`).not.toBe(-1);
  const rel = from.slice(a).indexOf('\n}\n');
  expect(rel, `chiusura non trovata per: ${startAnchor}`).not.toBe(-1);
  return from.slice(a, a + rel + 3);
}

// ── Le costanti del budget, lette dal sorgente ────────────────────────────
function numericConst(name: string): number {
  const m = src.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
  expect(
    m,
    `costante \`${name}\` non trovata in create-article.mjs: il budget e' tornato a essere un letterale sparso`,
  ).toBeTruthy();
  return Number(m![1]);
}
const PROMPT_TOKEN_BUDGET = numericConst('PROMPT_TOKEN_BUDGET');
const PROMPT_TOKEN_CEILING = numericConst('PROMPT_TOKEN_CEILING');
const IT_GENERATION_MAX_TOKENS = numericConst('IT_GENERATION_MAX_TOKENS');

// ── I pezzi di create-article.mjs che il prompt usa ───────────────────────
//
// DIFFERENZA STRUTTURALE COL CORPUS, la prima delle tre: li' il brief dei fatti
// di dominio e' una FUNZIONE section-aware (`evergreenFactsBriefFor`) con un
// tetto in caratteri (`MAX_DOMAIN_FACTS_CHARS`), perche' il brief svizzero e'
// il doppio di quello frontaliere. Qui e' una singola costante
// `EVERGREEN_FACTS_BRIEF` usata da entrambe le sezioni, quindi il tetto in
// caratteri non ha niente da troncare e la sezione svizzera non ha il costo in
// piu' che sul corpus ha reso necessario quel presidio.
const EVERGREEN_FACTS_BRIEF: string = new Function(
  `${cut('const EVERGREEN_FACTS_BRIEF = `', '`;\n')}\nreturn EVERGREEN_FACTS_BRIEF;`,
)();

const buildArticleJsonSchema = new Function(
  `${cutDecl('function buildArticleJsonSchema(')}\nreturn buildArticleJsonSchema;`,
)();
const CATEGORIES = new Function(`${cut('const CATEGORIES = [', '];')}\nreturn CATEGORIES;`)();
const AVAILABLE_IMAGES = new Function(`${cut('const PLACES_IMAGES =', '\n];')}\nreturn PLACES_IMAGES;`)();

// ── Il blocco di assemblaggio del prompt, verbatim da callGemini ──────────
//
// Dall'inizio della gestione del budget fino a subito prima della chiamata:
// include quindi anche il pre-flight `[prompt-budget]`, cosi' che il marker che
// un watchdog leggera' sia pinnato dal suo output reale e non da un grep.
const PROMPT_BLOCK_START = 'const generationAttempt = Number(sourceContext?._generationAttempt || 1);';
const PROMPT_BLOCK_END = '\n  let itRaw;';
const promptBlock = cut(PROMPT_BLOCK_START, PROMPT_BLOCK_END, { includeEnd: false });

const DEPS = [
  'pageContent', 'url', 'sourceContext', 'existingIds',
  'CREATE_ARTICLE_MIN_IT_WORDS', 'IS_FRONTALIERE', 'SECTION_NAME',
  'AI_SEARCH_PROMPT_BLOCK_IT', 'JSON_QUOTE_SAFETY_RULE_IT',
  'buildSourceContract', 'EVERGREEN_FACTS_BRIEF', 'buildArticleJsonSchema',
  'lastSourcePublishedAt', '_winnerFingerprintMessage',
  'AI_MODELS', 'GH_MODEL_HEAVY', 'CATEGORIES', 'AVAILABLE_IMAGES',
  'estimateRequestTokens', 'PROMPT_TOKEN_BUDGET', 'PROMPT_TOKEN_CEILING',
  'IT_GENERATION_MAX_TOKENS',
];

// `_clampRemediation` e `_clampSourceBody` sono dichiarazioni di modulo che il
// blocco estratto chiama (la scala di riduzione le usa per accorciare rimedio e
// fonte). Non sono esportate, quindi vengono ritagliate dal sorgente come si fa
// gia' per `buildArticleJsonSchema`: iniettarne una copia scritta a mano qui
// misurerebbe la copia, non il codice che gira.
const clampDecl = `${cutDecl('function _clampRemediation(')}\n${cutDecl('function _clampSourceBody(')}`;

type Assembled = {
  llmMessages: Array<{ role: string; content: string }>;
  articleSchema: { schema?: unknown };
  estTokens: number;
  overBudget: boolean;
  prompt: string;
  branch: string;
  shrink: number;
  target: number;
};

const assemblePrompt = new Function(
  '__d',
  `const { ${DEPS.join(', ')} } = __d;\n${clampDecl}\n${promptBlock}\n`
  + 'return { llmMessages, articleSchema, estTokens: _promptEstTokens, overBudget: _promptOverBudget,'
  + ' prompt, branch: isSyntheticSource ? "evergreen" : "news", shrink: _promptShrinkStep, target: _promptTokenTarget };',
) as (deps: Record<string, unknown>) => Assembled;

// ── Fixture: il CASO PEGGIORE REALE, non uno comodo ───────────────────────
//
// Ogni scelta qui e' verso l'alto, perche' un budget si prova sul massimo:
//   - la fonte supera MAX_SOURCE_CHARS, quindi il troncamento e' saturo;
//   - gli id sono i piu' lunghi che il corpus produca e sono tanti quanti il
//     prompt ne mandi al massimo (MAX_IDS_TO_SEND);
//   - le headline correlate sono al massimo che il selettore passa.
// Il corpus di id e' sintetico e DETERMINISTICO di proposito: leggerlo dal
// registro reale legherebbe il lock alla crescita del corpus e lo farebbe
// sfarfallare da solo, che e' l'anti-pattern del ratchet a conteggio assoluto.
const LONG_ID = `affitti-svizzera-mercato-immobiliare-canton-san-gallo-guida-completa-inquilini-disdetta-2026${'-x'.repeat(6)}`;
const existingIds = Array.from({ length: 4000 }, (_, i) => `${LONG_ID.slice(0, 99)}-${String(i).padStart(4, '0')}`);

const NEWS_PARAGRAPH = `Il Consiglio di Stato del Canton Ticino ha approvato il 12 marzo 2026 il messaggio numero 8412 che rivede il regolamento sull'imposta alla fonte per i lavoratori frontalieri. La misura, entrata in vigore il 1 aprile 2026, modifica le aliquote applicate ai redditi superiori a CHF 120'000 annui e introduce un nuovo obbligo di notifica trimestrale a carico dei datori di lavoro con piu' di 50 dipendenti frontalieri. Secondo i dati della Divisione delle contribuzioni sono 78'420 i lavoratori interessati, con un gettito stimato in CHF 1,24 miliardi per il 2026. Il direttore del Dipartimento delle finanze ha dichiarato che il nuovo assetto garantisce maggiore equita' fra i contribuenti residenti e non residenti. L'Associazione industrie ticinesi ha criticato l'onere amministrativo, quantificato in 14 ore mensili per azienda. Il termine per il referendum scade il 30 giugno 2026. `;
// L'estrazione della pagina taglia a 8000 char; il prompt ritronca a MAX_SOURCE_CHARS.
const NEWS_PAGE_CONTENT = NEWS_PARAGRAPH.repeat(11).slice(0, 8000);

// ── Il messaggio di winner-fingerprint: c'E' in produzione, e non e' nella scala
//
// E' l'unico dep che in produzione viene da un file sotto `data/`
// (`data/article-performance.json`, committato e checkoutato dai workflow), ed
// e' iniettato come terzo messaggio di sistema FUORI dalla scala di riduzione:
// la scala non puo' toglierlo, quindi pesa sempre.
//
// Un fixture con `null` qui e' il punto cieco del worktree sparse: `data/` non
// e' materializzato, il prompt sembra piu' leggero di quello che parte, e il
// tetto viene tarato basso. Misurato: col messaggio a null il caso peggiore
// dava 10275, col messaggio reale (499 char) 10417 — cioe' il tetto sarebbe
// nato gia' sfondato in produzione, e la riga [prompt-budget-ceiling] avrebbe
// segnalato una regressione su codice non modificato.
//
// Costruito col builder REALE (`buildWinnerFingerprintMessage`) su un payload
// di caso peggiore, non con una stringa scritta a mano: il builder non mette un
// cap sulla lunghezza degli elenchi, quindi il massimo lo detta il file. Il
// payload qui ha i 15 slot di `topKeywords` che il file porta gia' oggi, ma
// tutti occupati da termini che superano `isFrontalieriDomainTerm` — oggi ne
// passa 1 su 15, e quel rapporto puo' solo salire. Risultato 678 char contro i
// 499 di oggi: margine strutturale, non inventato.
const WINNER_FINGERPRINT_KEYWORDS = [
  'frontalieri', 'imposta alla fonte', 'permesso G', 'tassazione', 'naspi',
  'assegni familiari', 'disoccupazione', 'cassa malati', 'contributi avs',
  'busta paga', 'telelavoro', 'ristorno', 'ticino', 'salario minimo', 'imponibile',
];
const WINNER_FINGERPRINT_MESSAGE: string = buildWinnerFingerprintMessage({
  winnerFingerprint: {
    topClusters: ['pratico', 'novita', 'fiscale', 'lavoro', 'mobilita'],
    topAngles: ['come funziona', 'confronto pratico', 'guida completa', 'esempio concreto', 'quando conviene'],
    topKeywords: WINNER_FINGERPRINT_KEYWORDS,
    averageWordCount: 1482,
    topQuestionPatterns: ['cosa', 'dove', 'chi', 'quando'],
  },
});

// ── La data della fonte: RELATIVA, perche' il prompt la usa per un ramo
//
// `AGENTS.md` vieta le date assolute nei fixture, e qui non sarebbe inerte:
// `buildSourceContract` aggiunge il blocco «FONTE NON RECENTE» oltre 30 giorni
// (misurato: +111 token) confrontando con `new Date()` reale. Con una data
// assoluta il peso del prompt dipenderebbe da quando gira il test. Fissata a
// 160 giorni indietro: sempre oltre la soglia, quindi il ramo esercitato e' il
// piu' pesante e resta lo stesso a ogni esecuzione.
const SOURCE_AGE_DAYS = 160;
const SOURCE_PUBLISHED_AT = new Date(Date.now() - SOURCE_AGE_DAYS * 86_400_000).toISOString();

const BASE_DEPS = {
  existingIds,
  CREATE_ARTICLE_MIN_IT_WORDS: 900,
  AI_SEARCH_PROMPT_BLOCK_IT,
  JSON_QUOTE_SAFETY_RULE_IT,
  buildSourceContract,
  EVERGREEN_FACTS_BRIEF,
  buildArticleJsonSchema,
  CATEGORIES,
  AVAILABLE_IMAGES,
  estimateRequestTokens,
  PROMPT_TOKEN_BUDGET,
  PROMPT_TOKEN_CEILING,
  IT_GENERATION_MAX_TOKENS,
  _winnerFingerprintMessage: WINNER_FINGERPRINT_MESSAGE,
  AI_MODELS: { GEMINI_FLASH: 'gemini-2.5-flash' },
  GH_MODEL_HEAVY: 'gpt-4o',
  lastSourcePublishedAt: SOURCE_PUBLISHED_AT,
};

/** Assembla catturando stderr: il blocco logga, e il log e' parte del contratto. */
function assemble(overrides: Record<string, unknown>): Assembled & { logged: string[] } {
  const logged: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    return { ...assemblePrompt({ ...BASE_DEPS, ...overrides }), logged };
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
}

/** Il ramo NEWS: fonte reale scrapata. */
function newsPrompt(
  extra: Record<string, unknown> = {},
  section = 'frontaliere',
  depOverrides: Record<string, unknown> = {},
) {
  return assemble({
    pageContent: NEWS_PAGE_CONTENT,
    url: 'https://www.tio.ch/ticino/economia/1812345/imposta-fonte-frontalieri-nuove-aliquote',
    IS_FRONTALIERE: section === 'frontaliere',
    SECTION_NAME: section,
    sourceContext: {
      headline: 'Imposta alla fonte, il Ticino rivede le aliquote per i frontalieri sopra i 120mila franchi',
      relatedHeadlines: [
        { source: 'CdT', headline: 'Frontalieri, il nuovo accordo fiscale entra nel vivo' },
        { source: 'RSI', headline: 'Imposta alla fonte: cosa cambia per 78mila lavoratori' },
        { source: 'laRegione', headline: 'Aziende ticinesi contro il nuovo obbligo di notifica trimestrale' },
        { source: 'Ticinonline', headline: 'Notifica trimestrale, le imprese chiedono una proroga al Cantone' },
      ],
      _generationAttempt: 1,
      _generationAttemptMax: 6,
      _minItalianWords: 900,
      _primaryLocale: 'it',
      ...extra,
    },
    ...depOverrides,
  });
}

/** Il ramo EVERGREEN: `pageContent` sintetica costruita da create-article.mjs. */
function evergreenPrompt(section = 'frontaliere', extra: Record<string, unknown> = {}) {
  const keyword = 'frontaliere farmacista ticino stipendio requisiti';
  return assemble({
    pageContent: `[ARTICOLO EVERGREEN SEO]\nKeyword target: ${keyword}\nAngolo editoriale: guida pratica passo passo\n\nGenera un articolo approfondito e pratico ottimizzato per questa keyword long-tail. Usa solo fatti verificati e stabili sul dominio frontalieri Ticino-Italia. Se servono esempi, presentali come scenari ipotetici, senza nomi, aziende, citta' o importi specifici inventati.\n\n${EVERGREEN_FACTS_BRIEF}\n\n⚠️ I FATTI VERIFICATI qui sopra DEVONO corrispondere ESATTAMENTE (lo stesso ground truth e' usato dal fact-checker, che blocca l'articolo se diverghi).`,
    url: `evergreen://${encodeURIComponent(keyword)}`,
    IS_FRONTALIERE: section === 'frontaliere',
    SECTION_NAME: section,
    sourceContext: {
      headline: keyword,
      relatedHeadlines: [],
      _generationAttempt: 1,
      _generationAttemptMax: 6,
      _minItalianWords: 900,
      _primaryLocale: 'it',
      ...extra,
    },
  });
}

const RETRY_CONTEXT = {
  _generationAttempt: 4,
  _previousWordCount: 640,
  _factCheckRefinement: '- "Il gettito sale a CHF 2 miliardi nel 2027" — non presente nella fonte\n'
    + '- "L\'accordo entra in vigore nel 2027" — data non presente nella fonte\n'
    + '- "Secondo uno studio dell\'USTAT il 62% dei frontalieri" — studio non citato dalla fonte',
  _headlineRefinement: 'title troppo lungo (128 caratteri) e con punto interrogativo finale',
};

// ═══ 0. Il fixture e' davvero il prompt, non un guscio vuoto ═════════════
//
// Senza questo, ogni numero sotto potrebbe essere la misura di una stringa
// mutilata da un anchor scivolato — e il test passerebbe verde per il motivo
// sbagliato, che e' il modo in cui il difetto originale e' sopravvissuto.

describe('estrazione', () => {
  test("l'estrazione produce il prompt VERO (guardia anti-verde-a-vuoto)", () => {
    const { llmMessages, prompt, articleSchema } = newsPrompt();

    expect(Array.isArray(llmMessages)).toBe(true);
    expect(llmMessages.length).toBeGreaterThanOrEqual(2);
    expect(llmMessages[0].role).toBe('system');
    expect(llmMessages[llmMessages.length - 1].role).toBe('user');

    for (const marker of [
      'REGOLA #1 — FEDELTÀ ALLA FONTE',
      'SOURCE CONTENT:',
      'ARTICLE IDS',
    ]) {
      expect(prompt, `il prompt estratto non contiene «${marker}»: l'anchor e' scivolato`).toContain(marker);
    }

    // `FATTI DI DOMINIO VERIFICATI` non e' in quella lista perche' sul caso
    // peggiore la scala di riduzione lo toglie — ed e' il comportamento voluto.
    // Provarlo dove la scala NON morde e' piu' forte che toglierlo dai marker:
    // distingue «l'ancora e' scivolata» da «la scala l'ha rimosso».
    const senzaPressione = newsPrompt({ _promptTokenBudget: 999_999 });
    expect(senzaPressione.shrink, 'con budget illimitato la scala non deve mordere').toBe(0);
    expect(
      senzaPressione.prompt,
      "il blocco dei fatti di dominio non c'e' nemmeno senza pressione di budget: l'anchor e' scivolato",
    ).toContain('FATTI DI DOMINIO VERIFICATI');

    // La notizia c'e' davvero, ed e' troncata (fonte oltre MAX_SOURCE_CHARS).
    expect(prompt, "la fonte non e' finita nel prompt").toContain('imposta alla fonte');
    expect(prompt, 'il fixture non satura MAX_SOURCE_CHARS').toContain('[...contenuto troncato per brevità]');
    expect(articleSchema?.schema, "lo schema JSON non e' stato costruito").toBeTruthy();
  });

  test('i pezzi ritagliati sono INTERI, non gusci che passano toBeTruthy()', () => {
    // Ogni assert del ratchet e' un `<=`: una mutilazione che ALLEGGERISCE il
    // prompt le supera tutte. Provato davvero — sostituendo
    // `buildArticleJsonSchema` con `() => ({ name: 'a', schema: { type: 'object' } })`
    // i 19 test restavano verdi mentre il prompt calava di 515 token (−5,3%).
    // `toBeTruthy()` da solo non e' una guardia: qui i pezzi ritagliati hanno un
    // pavimento di struttura, che una mutilazione non puo' soddisfare per caso.
    const { articleSchema } = newsPrompt();

    const props = Object.keys((articleSchema as { schema: { properties?: object } }).schema.properties || {});
    for (const campo of ['id', 'category', 'slugs', 'content', 'seo', 'imageAlt']) {
      expect(props, `lo schema ritagliato non ha il campo «${campo}»: il ritaglio e' mutilato`).toContain(campo);
    }
    expect(
      JSON.stringify((articleSchema as { schema: unknown }).schema).length,
      "lo schema serializzato e' troppo corto per essere quello vero — e conta nella stima",
    ).toBeGreaterThanOrEqual(1500);

    expect(CATEGORIES.length, 'CATEGORIES ritagliato incompleto').toBeGreaterThanOrEqual(4);
    expect(AVAILABLE_IMAGES.length, 'AVAILABLE_IMAGES ritagliato incompleto').toBeGreaterThanOrEqual(10);
    expect(
      EVERGREEN_FACTS_BRIEF.length,
      'EVERGREEN_FACTS_BRIEF ritagliato troppo corto: il ramo evergreen misurerebbe un brief che non esiste',
    ).toBeGreaterThanOrEqual(1200);

    // Il winner-fingerprint arriva davvero nei messaggi, e non come stringa vuota.
    expect(WINNER_FINGERPRINT_MESSAGE.length, 'il messaggio di winner-fingerprint non e\' stato costruito')
      .toBeGreaterThanOrEqual(600);
    expect(
      WINNER_FINGERPRINT_KEYWORDS.filter((k) => isFrontalieriDomainTerm(k)).length,
      "le keyword del fixture non superano piu' il filtro di dominio: il messaggio si accorcia e il caso peggiore non e' piu' tale",
    ).toBeGreaterThanOrEqual(14);
    const { llmMessages } = newsPrompt();
    expect(
      llmMessages.filter((m) => m.role === 'system').length,
      "il messaggio di winner-fingerprint non e' entrato in llmMessages: la misura e' piu' leggera del prompt reale",
    ).toBe(2);
  });
});

// ═══ 1. IL RATCHET: nessun ramo supera il tetto ══════════════════════════
//
// Il tetto e' `PROMPT_TOKEN_CEILING`, e puo' solo SCENDERE. La misura e' presa
// DOPO la scala di riduzione, cioe' sul prompt che parte davvero.

describe('il ratchet sul tetto', () => {
  const RATCHET_HINT = "Il tetto e' un ratchet: puo' solo SCENDERE, e scende fino a PROMPT_TOKEN_BUDGET. "
    + 'Se hai aggiunto un blocco al prompt, il costo va compensato altrove, non assorbito alzando il tetto.';

  test('il prompt NEWS nel caso peggiore resta sotto il tetto', () => {
    const { estTokens } = newsPrompt();
    expect(estTokens, `news frontaliere: ${estTokens} token. ${RATCHET_HINT}`)
      .toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
  });

  test('il ramo NEWS SVIZZERA resta sotto il tetto — non solo il frontaliere', () => {
    // `publish-journalist-articles.yml` chiama lo stesso create-article.mjs per
    // entrambe le sezioni: news+svizzera e' un path di produzione, non un caso
    // teorico. Sul corpus questa combinazione era l'unica mai esercitata, e il
    // gap era reale (10.362 token contro il tetto).
    const { estTokens } = newsPrompt({}, 'svizzera');
    expect(estTokens, `news svizzera: ${estTokens} token. ${RATCHET_HINT}`)
      .toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
  });

  test("il ramo NEWS regge anche il retry, che e' il tentativo piu' pesante", () => {
    // I retry riducono la fonte (MAX_SOURCE_CHARS scende a 4500) ma aggiungono
    // il feedback del fact-check e quello sulla headline: il saldo e' in salita,
    // quindi il caso peggiore vero non e' il primo tentativo.
    for (const section of ['frontaliere', 'svizzera']) {
      const { estTokens } = newsPrompt(RETRY_CONTEXT, section);
      expect(estTokens, `news ${section} al retry: ${estTokens} token. ${RATCHET_HINT}`)
        .toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
    }
  });

  test('anche il ramo EVERGREEN resta sotto il tetto', () => {
    for (const section of ['frontaliere', 'svizzera']) {
      const { estTokens } = evergreenPrompt(section);
      expect(estTokens, `evergreen ${section}: ${estTokens} token. ${RATCHET_HINT}`)
        .toBeLessThanOrEqual(PROMPT_TOKEN_CEILING);
    }
  });

  test("il tetto non e' sceso sotto il cap della flotta senza dirlo", () => {
    expect(
      PROMPT_TOKEN_CEILING,
      "PROMPT_TOKEN_CEILING e' sceso sotto PROMPT_TOKEN_BUDGET: ora il tetto E' il cap, e le due costanti vanno unificate",
    ).toBeGreaterThanOrEqual(PROMPT_TOKEN_BUDGET);
    expect(
      PROMPT_TOKEN_BUDGET,
      "il cap piu' alto dichiarato dalla flotta e' cambiato: verificare i default per provider in ai-models.mjs",
    ).toBe(8000);
  });
});

// ═══ 2. La distanza fra i due rami ═══════════════════════════════════════
//
// L'invariante violata davvero sul corpus era questa: un ramo misurato, l'altro
// no. Sono TRE i blocchi che il ramo news porta in piu', tutti dietro la stessa
// guardia `isSyntheticSource`: domainFactsBlock + sourceContract + la fonte
// scrapata al posto della pageContent sintetica. Il numero e' la loro somma
// misurata su questo lato, arrotondata in alto. Se sale, e' perche' e' comparso
// un QUARTO blocco news-only — ed e' quello il momento in cui va dichiarato,
// non sei mesi dopo contando gli skip nei log.
const NEWS_OVER_EVERGREEN_MAX_TOKENS = 700;

test('la distanza news − evergreen resta quella dei tre blocchi noti', () => {
  const news = newsPrompt().estTokens;
  const evergreen = evergreenPrompt('frontaliere').estTokens;
  const gap = news - evergreen;
  expect(
    gap,
    `il ramo news costa ${gap} token piu' dell'evergreen (news=${news}, evergreen=${evergreen}), sopra i `
    + `${NEWS_OVER_EVERGREEN_MAX_TOKENS} dichiarati. I tre blocchi che producono la distanza sono `
    + 'domainFactsBlock, sourceContract e la fonte scrapata, tutti dietro `isSyntheticSource`: se ne hai '
    + 'aggiunto un quarto, dichiaralo qui invece di alzare il numero.',
  ).toBeLessThanOrEqual(NEWS_OVER_EVERGREEN_MAX_TOKENS);
});

// ═══ 3. Il budget di OUTPUT ══════════════════════════════════════════════

describe('il budget di output', () => {
  test('IT_GENERATION_MAX_TOKENS resta sufficiente per il fabbisogno misurato', () => {
    // CREATE_ARTICLE_MIN_IT_WORDS parole IT + faq + seo + overhead JSON stanno
    // in ~2500-3000 token misurati: scendere sotto produce troncamenti.
    expect(
      IT_GENERATION_MAX_TOKENS,
      `IT_GENERATION_MAX_TOKENS=${IT_GENERATION_MAX_TOKENS} e' sotto il fabbisogno misurato (~2500-3000 token `
      + 'per 900 parole IT + faq + seo): scendere ancora produce troncamenti.',
    ).toBeGreaterThanOrEqual(3500);
  });

  test("il cap di output piu' basso della flotta resta leggibile, e la distanza e' dichiarata", () => {
    // DIFFERENZA STRUTTURALE COL CORPUS, la seconda. Li' il gemello di questo
    // test asserisce `IT_GENERATION_MAX_TOKENS <= lowest`, perche' il corpus ha
    // gia' portato la costante da 8000 a 4000 (corpus #6595-6607): il guard di
    // `callLLM` salta ogni modello con `maxTokens > modelLimit`, quindi 8000
    // esclude da solo Phi-4-mini-reasoning (4000) e i due Cohere r/r7b (4096)
    // PRIMA ancora di guardare il prompt.
    //
    // Qui la costante e' ancora 8000, e questo test NON lo asserisce: farlo
    // aprirebbe una PR con la suite rossa, e abbassarla e' una scelta su QUALI
    // MODELLI generano, cioe' logica di generazione — fuori dal perimetro della
    // PR di osservabilita' che ha introdotto questo file, e dichiarata nel suo
    // piano di completamento. Cio' che il test blocca oggi e' il peggioramento:
    // la tabella deve restare leggibile e la distanza non deve crescere.
    const aiSrc = readFileSync(AI_MODELS_SRC, 'utf-8');
    const table = cut('const MODEL_MAX_OUTPUT_TOKENS = {', '\n};', { from: aiSrc });
    const limits = [...table.matchAll(/:\s*(\d+),/g)].map((m) => Number(m[1]));
    expect(limits.length, 'MODEL_MAX_OUTPUT_TOKENS non parsata — aggiornare questo test').toBeGreaterThanOrEqual(5);

    const lowest = Math.min(...limits);
    // La distanza, non un letterale. Asserire `<= 8000` sarebbe stato un guard
    // che sembra un guard: `lowest` compariva solo nel messaggio d'errore, e un
    // modello nuovo con cap 2000 avrebbe allargato la distanza a 6000 lasciando
    // il test verde — mentre il commento qui sopra promette il contrario.
    const DISTANZA_MAX = 4000; // misurata oggi: 8000 − 4000. Puo' solo SCENDERE, fino a 0.
    expect(
      IT_GENERATION_MAX_TOKENS - lowest,
      `IT_GENERATION_MAX_TOKENS=${IT_GENERATION_MAX_TOKENS} dista ${IT_GENERATION_MAX_TOKENS - lowest} dal cap di `
      + `output piu' basso della flotta (${lowest}), sopra i ${DISTANZA_MAX} dichiarati. La distanza puo' solo `
      + `scendere, e il traguardo e' 0 (cioe' IT_GENERATION_MAX_TOKENS <= ${lowest}): ogni modello che dichiara `
      + 'meno viene saltato dal pre-flight prima ancora di guardare il prompt.',
    ).toBeLessThanOrEqual(DISTANZA_MAX);
  });

  test("il budget e' un SIMBOLO, non un letterale sparso nel call-site", () => {
    const callSite = cut('const articleSchema = buildArticleJsonSchema(primaryLocale);', '\n  let itData;');
    expect(
      (callSite.match(/maxTokens:\s*\d+/g) || []).length,
      'la chiamata di generazione IT ha di nuovo un maxTokens letterale: il prossimo che lo cambia non '
      + "trovera' il vincolo che lo governa",
    ).toBe(0);
    expect(
      (callSite.match(/maxTokens:\s*IT_GENERATION_MAX_TOKENS/g) || []).length,
      'le due chiamate (Gemini diretta e cascade) non passano entrambe da IT_GENERATION_MAX_TOKENS',
    ).toBeGreaterThanOrEqual(2);
  });
});

// ═══ 4. Il marker che il watchdog leggera' ═══════════════════════════════

describe('il marker [prompt-budget]', () => {
  test('il pre-flight pubblica un marker machine-readable stabile', () => {
    const { logged, estTokens } = newsPrompt();
    const line = logged.find((l) => l.startsWith('[prompt-budget]'));
    expect(
      line,
      "nessuna riga [prompt-budget]: la dimensione del prompt e' di nuovo deducibile solo contando gli skip a valle",
    ).toBeTruthy();

    const fields = Object.fromEntries(
      [...line!.matchAll(/(\w+)=([^\s]+)/g)].map((m) => [m[1], m[2]]),
    );
    expect(fields.branch).toBe('news');
    expect(fields.section).toBe('frontaliere');
    expect(fields.attempt).toBe('1');
    expect(Number(fields.est)).toBe(estTokens);
    expect(Number(fields.budget)).toBe(PROMPT_TOKEN_BUDGET);
    expect(['0', '1']).toContain(fields.over);

    const ever = evergreenPrompt().logged.find((l) => l.startsWith('[prompt-budget]'));
    expect(ever).toContain('branch=evergreen');
  });

  test('il marker pubblica il gradino di riduzione', () => {
    // Un watchdog deve poter distinguere «non ha ridotto» da «ha ridotto e non
    // basta»: senza `shrink=` le due situazioni hanno lo stesso `over=1`.
    expect(
      src,
      'il marker ha cambiato forma: i watchdog che lo leggono smettono di matchare',
    ).toMatch(/\[prompt-budget\] branch=\$\{isSyntheticSource \? 'evergreen' : 'news'\} section=\$\{SECTION_NAME\} /);
    expect(src, 'il marker non pubblica il gradino di riduzione').toContain('shrink=${_promptShrinkStep}');
  });

  test('sopra budget il pre-flight avvisa ma NON rompe la pipeline', () => {
    // Un throw qui trasformerebbe un degrado (la catena scende ai modelli che il
    // payload lo reggono) in un run perso. Il contratto e' warning + marker.
    const { overBudget, logged } = newsPrompt();
    if (overBudget) {
      expect(
        logged.some((l) => l.includes('⚠️')),
        'over budget senza warning leggibile',
      ).toBe(true);
    }
    expect(() => newsPrompt(), 'il pre-flight lancia invece di avvisare').not.toThrow();
  });

  test('sopra il TETTO il pre-flight lo dice esplicitamente', () => {
    // La riga 🔺 e' l'unica che distingue «sopra il cap della flotta, come oggi
    // sappiamo di essere» da «cresciuto oltre il massimo mai misurato», che e'
    // una regressione. Provata iniettando un tetto assurdo invece di gonfiare il
    // prompt: il ramo esercitato e' lo stesso, il fixture resta il caso reale.
    const conTettoBasso = newsPrompt({}, 'frontaliere', { PROMPT_TOKEN_CEILING: 1 });
    const riga = conTettoBasso.logged.find((l) => l.includes('[prompt-budget-ceiling]'));
    expect(
      riga,
      'superato il tetto senza che il run lo dica: la regressione resta invisibile fino alla CI',
    ).toBeTruthy();
    expect(riga).toContain(`est=${conTettoBasso.estTokens}`);
    expect(riga).toContain('ceiling=1');

    // Prefisso distinto dal marker: chi estrae i campi del marker non deve
    // ritrovarsi a parsare una riga che quei campi non li ha.
    expect(
      conTettoBasso.logged.filter((l) => l.startsWith('[prompt-budget] ')).length,
      "la riga del tetto e' finita nel namespace del marker",
    ).toBe(1);

    // …e col tetto vero non la stampa, altrimenti sarebbe rumore a ogni run.
    expect(newsPrompt().logged.some((l) => l.includes('[prompt-budget-ceiling]'))).toBe(false);
  });
});

// ═══ 5. Il divisore di estimateRequestTokens ═════════════════════════════
//
// Il divisore 3.5 sposta la soglia di TUTTA la flotta: e' il numero che decide
// se un modello viene saltato, ed era senza lock su questo lato. Pinnato per
// COMPORTAMENTO, non per lettura del sorgente.

test("estimateRequestTokens e' pinnata su divisore 3.5 e margine 500", () => {
  const chars = (n: number) => [{ role: 'user', content: 'x'.repeat(n) }];

  expect(estimateRequestTokens([]), "il margine di sicurezza non e' piu' 500").toBe(500);
  expect(estimateRequestTokens(chars(3500)), "il divisore non e' piu' 3.5").toBe(1500);
  expect(estimateRequestTokens(chars(7000))).toBe(2500);
  // arrotondamento per eccesso
  expect(estimateRequestTokens(chars(1))).toBe(501);

  // I `content` di TUTTI i messaggi contano, non solo l'ultimo.
  expect(estimateRequestTokens([
    { role: 'system', content: 'x'.repeat(3500) },
    { role: 'user', content: 'y'.repeat(3500) },
  ])).toBe(2500);

  // Lo schema JSON serializzato conta: e' meta' della sorpresa di questo difetto.
  const schema = { schema: { type: 'object', properties: {} } };
  expect(
    estimateRequestTokens(chars(3500), { jsonSchema: schema }),
    "lo jsonSchema non viene piu' conteggiato: il prompt reale e' piu' grande della stima",
  ).toBe(1500 + Math.ceil(JSON.stringify(schema.schema).length / 3.5));
});

// ═══ 6. La scala di riduzione: quanto morde, e su cosa ═══════════════════

describe('la scala di riduzione', () => {
  test('la scala morde sul ramo NEWS, che il prompt pieno non lo farebbe stare', () => {
    for (const section of ['frontaliere', 'svizzera']) {
      const { shrink, estTokens } = newsPrompt({}, section);
      expect(
        shrink,
        `news ${section}: la scala non ha morso a ${estTokens} token, ma il prompt pieno non ci sta`,
      ).toBeGreaterThan(0);
    }
  });

  test("la scala NON morde quando il prompt ci sta gia'", () => {
    // Ridurre un prompt che rientra sarebbe una regressione silenziosa: meno
    // contesto a parita' di necessita'.
    for (const build of [() => newsPrompt({ _promptTokenBudget: 999_999 }),
      () => evergreenPrompt('frontaliere', { _promptTokenBudget: 999_999 }),
      () => evergreenPrompt('svizzera', { _promptTokenBudget: 999_999 })]) {
      const { shrink, estTokens } = build();
      expect(shrink, `la scala ha morso a ${estTokens} token contro un target illimitato`).toBe(0);
    }
  });

  test('il budget del retry viene LETTO, non ignorato', () => {
    // `retryRequestTokenBudget` arriva qui come `_promptTokenBudget`. Un target
    // piu' STRETTO del default deve far mordere di piu': e' l'intera ragione per
    // cui callLLM calcola quel numero.
    const largo = newsPrompt({ _promptTokenBudget: 999_999 });
    const stretto = newsPrompt({ _promptTokenBudget: 6000 });
    expect(largo.target, "il target non e' stato letto dal contesto").toBe(999_999);
    expect(stretto.target, "il target stretto non e' stato letto dal contesto").toBe(6000);
    expect(
      stretto.shrink,
      `un target piu' stretto deve ridurre di piu': stretto=${stretto.shrink} largo=${largo.shrink}`,
    ).toBeGreaterThan(largo.shrink);
    expect(
      stretto.estTokens,
      `un target piu' stretto deve produrre un prompt piu' corto: ${stretto.estTokens} vs ${largo.estTokens}`,
    ).toBeLessThan(largo.estTokens);
  });

  test('la fonte non scende sotto il pavimento dichiarato', () => {
    // Anche con un target impossibile la scala si ferma: sotto una certa soglia
    // l'articolo non ha piu' sostanza da riscrivere e il gate di fedelta' non e'
    // soddisfacibile comunque. Meglio restare sopra budget che consegnare al
    // writer una fonte inutilizzabile.
    const impossibile = newsPrompt({ _promptTokenBudget: 100 });
    expect(impossibile.overBudget, 'con un target da 100 token il prompt DEVE restare sopra budget').toBe(true);
    expect(impossibile.prompt, "la fonte e' sparita del tutto dal prompt").toContain('SOURCE CONTENT:');
    const dopo = impossibile.prompt.split('SOURCE CONTENT:')[1] || '';
    const corpo = dopo.split('[...contenuto troncato per brevità]')[0] || '';
    expect(
      corpo.length,
      `il corpo della fonte e' sceso a ${corpo.length} caratteri, sotto il pavimento dichiarato`,
    ).toBeGreaterThanOrEqual(2000);
  });
});
