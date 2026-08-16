/**
 * Le tre falle di `scripts/batch-add-faq-to-articles.mjs` gia' chiuse sul
 * gemello del corpus con `nanakokyobashi-rgb/frontaliere-articles#397`
 * (issue nanako#393, #394, #395), piu' la bomba SIGTERM che li' era stata
 * disinnescata da nanako#392 e qui era ancora armata.
 *
 * Il manifest del ciclo (`loop-sync-manifest.json`) da' questo file
 * `mode: adapted`: i due gemelli sono diversi per costruzione, quindi la fix e'
 * RIAPPLICATA nel contesto di questo file, non copiata. Le differenze che
 * contano rispetto al corpus:
 *
 *   · `replaceFaqInBodyFile` qui usa gia' un replacer-FUNZIONE, quindi il
 *     difetto #395 vive solo nei due punti di `insertFaqIntoBodyFile`;
 *   · gli scrittori vivi sono DUE e scrivono in due formati diversi — INSERT
 *     passa da `escapeForSingleQuoteTS` (raddoppia il backslash), REPLACE usa
 *     ancora `JSON.stringify(...).replace(/'/g, "\\'")` (escapa il solo
 *     apostrofo) — il che rende il lettore a due decodifiche di #394 non una
 *     comodita' ma una necessita';
 *   · `hasFaqKey`/`extractFaqFromContent` qui non sono ancora ancorate all'id
 *     (nanako#392 non e' mai scesa): fuori dallo scopo di questa PR, e le prove
 *     qui sotto non la assumono.
 *
 * ## PERCHE' SIGTERM PESA DI PIU' QUI
 *
 * `scripts/publish-journalist-article.mjs` IMPORTA questo modulo per riusare
 * `generateFaqIT`, e gira ogni 15 minuti. Con l'handler a module scope, ognuna
 * di quelle esecuzioni armava un `git add` + `git commit` + `git push origin
 * main` su SIGTERM — da un processo che non stava generando niente. E il
 * segnale non e' ipotetico: i workflow hanno `cancel-in-progress: true`.
 *
 * ## MUTAZIONI
 *
 * Ogni gruppo e' stato falsificato ripristinando il comportamento vecchio e
 * verificando che il test diventasse rosso; la riga esatta e' sopra ciascun blocco.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unescapeTsString } from '../scripts/lib/unescape-ts-string.mjs';
import {
  extractArticleId,
  extractBodyContent,
  extractFaqFromContent,
  hasBodyKey,
  insertFaqIntoBodyFile,
  parseFaqLiteral,
} from '../scripts/batch-add-faq-to-articles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'batch-add-faq-to-articles.mjs');
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, 'utf-8');

const ALPHA = 'alpha-uno';
const BETA = 'beta-due';

const bodyLine = (id: string, n: number, testo: string) =>
  `    'blog.article.${id}.body${n}': '${testo}',`;
const faqLine = (id: string, pairs: unknown) =>
  `    'blog.article.${id}.faq': '${JSON.stringify(pairs)}',`;

const bodyFile = (...righe: string[]) =>
  ['const blogBody: Record<string, string> = {', ...righe, '};', '', 'export default blogBody;', ''].join('\n');

/**
 * L'oracolo: rilegge il valore `.faq` senza passare da nessuna delle funzioni
 * sotto esame. Decodifica solo `\\` e `\'` e lascia intatto il resto, che e'
 * cio' che `JSON.parse` deve vedere.
 */
function faqDiId(testo: string, id: string): unknown {
  const m = new RegExp(`'blog\\.article\\.${id}\\.faq'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(testo);
  if (!m) return null;
  return JSON.parse(m[1].replace(/\\([\s\S])/g, (whole, c) => (c === '\\' || c === "'" ? c : whole)));
}

function fileTemporaneo(nome: string, contenuto: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-robust-site-'));
  const p = path.join(dir, nome);
  fs.writeFileSync(p, contenuto, 'utf-8');
  return p;
}

const CORPO_ALPHA_1 = 'Primo corpo di alpha, abbastanza lungo da sembrare un articolo vero.';
const CORPO_ALPHA_2 = 'Secondo corpo di alpha, che deve essere concatenato al primo.';
const CORPO_BETA = 'Corpo di beta, un articolo COMPLETAMENTE estraneo ad alpha.';

const DUE_ID = bodyFile(
  bodyLine(ALPHA, 1, CORPO_ALPHA_1),
  bodyLine(ALPHA, 2, CORPO_ALPHA_2),
  bodyLine(BETA, 1, CORPO_BETA),
);

// ── L'import non deve armare niente ──────────────────────────────────────────
//
// MUTAZIONE: rimettere `process.on('SIGTERM', ...)` a module scope → rosso.

describe('SIGTERM — la bomba che publish-journalist-article armava ogni 15 minuti', () => {
  it('importare il modulo non registra nessun handler di segnale', () => {
    // Questo file IMPORTA il modulo (vedi gli import in cima), quindi se
    // l'handler tornasse a module scope sarebbe gia' registrato qui.
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('installSigtermCheckpoint viene CHIAMATA solo dentro la guardia sull entry point', () => {
    const guardia = SCRIPT_SRC.indexOf('if (import.meta.url ===');
    expect(guardia).toBeGreaterThan(0);
    // Le CHIAMATE, non la definizione: `function installSigtermCheckpoint()`
    // sta per forza sopra la guardia, ed e' giusto che ci stia.
    const chiamate = [...SCRIPT_SRC.matchAll(/(?<!function\s)\binstallSigtermCheckpoint\(\)/g)].map((m) => m.index!);
    expect(chiamate.length).toBeGreaterThan(0);
    for (const i of chiamate) expect(i).toBeGreaterThan(guardia);
  });

  it('nessun process.on a module scope in questo script', () => {
    const guardia = SCRIPT_SRC.indexOf('function installSigtermCheckpoint');
    for (const m of SCRIPT_SRC.matchAll(/^\s*process\.on\(/gm)) {
      expect(m.index!).toBeGreaterThan(guardia);
    }
  });
});

// ── nanako#393 — il corpo che entra nel prompt e' quello del proprio id ──────
//
// MUTAZIONE: rimettere `const re = /\.body\d+'\s*:\s*(['`])((?:\\.|(?!\1)[\s\S])*?)\1/g`
// al posto di `bodyKeyRx(articleId)` → rosso.

describe('nanako#393 — extractBodyContent ancorata all id', () => {
  it('prende SOLO i bodyN del proprio id', () => {
    const testoAlpha = extractBodyContent(DUE_ID, ALPHA);
    expect(testoAlpha).toContain(CORPO_ALPHA_1);
    expect(testoAlpha).toContain(CORPO_ALPHA_2);
    expect(testoAlpha).not.toContain(CORPO_BETA);

    const testoBeta = extractBodyContent(DUE_ID, BETA);
    expect(testoBeta).toContain(CORPO_BETA);
    expect(testoBeta).not.toContain(CORPO_ALPHA_1);
  });

  it('tiene i bodyN in ordine', () => {
    const testo = extractBodyContent(DUE_ID, ALPHA);
    expect(testo.indexOf(CORPO_ALPHA_1)).toBeLessThan(testo.indexOf(CORPO_ALPHA_2));
  });

  it('legge anche i valori fra backtick, e sempre solo del proprio id', () => {
    const src = bodyFile(
      "    'blog.article.alpha-uno.body1': `Corpo di alpha fra backtick, lungo il giusto.`,",
      "    'blog.article.beta-due.body1': `Corpo di beta fra backtick, da NON leggere.`,",
    );
    const testo = extractBodyContent(src, ALPHA);
    expect(testo).toContain('Corpo di alpha fra backtick');
    expect(testo).not.toContain('Corpo di beta fra backtick');
  });

  it('un id non matcha un id piu lungo che lo contiene', () => {
    const src = bodyFile(
      bodyLine('alpha', 1, 'Corpo del solo alpha, che deve restare separato.'),
      bodyLine('alpha-uno', 1, 'Corpo di alpha-uno, un ALTRO articolo.'),
    );
    const testo = extractBodyContent(src, 'alpha');
    expect(testo).toContain('Corpo del solo alpha');
    expect(testo).not.toContain('Corpo di alpha-uno');
  });
});

// L'ancoraggio crea un esito che prima non esisteva — «nessuna chiave per
// questo id» — e il ramo che lo raccoglieva chiamava `enrichBodyForFaq`, cioe'
// faceva SCRIVERE all'LLM un articolo dal solo slug.
//
// MUTAZIONE: togliere `if (!articleId) throw` → rosso; togliere le due guardie
// `hasBodyKey` dai chiamanti → rosso.

describe('nanako#393 — il corpo assente non diventa un articolo inventato', () => {
  it('extractBodyContent si rifiuta di lavorare senza articleId', () => {
    // @ts-expect-error — e' esattamente la chiamata che la guardia deve fermare
    expect(() => extractBodyContent(DUE_ID)).toThrow(/articleId obbligatorio/);
    expect(() => extractBodyContent(DUE_ID, '')).toThrow(/articleId obbligatorio/);
  });

  it('hasBodyKey distingue «corpo corto» da «nessun corpo per questo id»', () => {
    expect(hasBodyKey(DUE_ID, ALPHA)).toBe(true);
    expect(hasBodyKey(DUE_ID, 'articolo-che-non-c-e')).toBe(false);
    expect(extractBodyContent(DUE_ID, 'articolo-che-non-c-e')).toBe('');
  });

  it('i due chiamanti si fermano PRIMA di arricchire', () => {
    for (const fn of ['async function processArticle', 'async function processTopUp']) {
      const inizio = SCRIPT_SRC.indexOf(fn);
      expect(inizio, `${fn} deve esistere`).toBeGreaterThan(0);
      const corpo = SCRIPT_SRC.slice(inizio, inizio + 2500);
      const guardia = corpo.indexOf('hasBodyKey(');
      const arricchimento = corpo.indexOf('enrichBodyForFaq(');
      expect(guardia, `${fn}: manca la guardia hasBodyKey`).toBeGreaterThan(0);
      expect(arricchimento, `${fn}: enrichBodyForFaq viene prima della guardia`).toBeGreaterThan(guardia);
    }
  });
});

// ── issue #5946 item 3 — contratto di charset fra extractArticleId e
// bodyKeyRx (hasBodyKey/extractBodyContent) ─────────────────────────────────
//
// extractArticleId puo' restituire SOLO id nel charset [a-z0-9-]+ (la sua
// stessa regex di estrazione non cattura altro). Un id fuori da quel
// charset — passato da un futuro chiamante, non da extractArticleId — deve
// fallire in modo esplicito invece di tornare in silenzio "nessun corpo per
// questo id".
//
// MUTAZIONE: rimuovere la guardia di charset da bodyKeyRx → questi test
// restano verdi ma senza piu' distinguere un id fuori contratto da uno
// semplicemente assente (nessuna eccezione, `hasBodyKey` risponderebbe solo
// `false`).

describe('issue #5946 item 3 — bodyKeyRx rifiuta un articleId fuori dal charset atteso', () => {
  it('hasBodyKey lancia su un id con maiuscole', () => {
    expect(() => hasBodyKey(DUE_ID, 'Alpha-Uno')).toThrow(/fuori dal charset atteso/);
  });

  it('extractBodyContent lancia su un id con caratteri non [a-z0-9-]', () => {
    expect(() => extractBodyContent(DUE_ID, 'alpha_uno')).toThrow(/fuori dal charset atteso/);
    expect(() => extractBodyContent(DUE_ID, 'alpha uno')).toThrow(/fuori dal charset atteso/);
  });

  it('un id nel charset atteso continua a funzionare come prima', () => {
    expect(hasBodyKey(DUE_ID, ALPHA)).toBe(true);
    expect(extractBodyContent(DUE_ID, ALPHA)).toContain(CORPO_ALPHA_1);
  });
});

// ── issue #5946 item 5 — casing di bodyN (N>1) diverso da body1 nello
// stesso file ─────────────────────────────────────────────────────────────
//
// Il reviewer chiedeva cosa succede se un articleId risolto da
// extractArticleId differisce per casing dal testo effettivo della chiave nel
// file (case-sensitivity di bodyKeyRx). Investigazione (non solo test):
//
// 1. Il falso "nessun corpo per questo id" TOTALE che il reviewer temeva non
//    e' raggiungibile: l'id che arriva a hasBodyKey/extractBodyContent viene
//    SEMPRE da extractArticleId, che lo estrae dalla chiave body1 di QUESTO
//    STESSO file — stessa sottostringa, stesso casing — quindi la chiave
//    body1 matcha sempre.
// 2. Il rischio reale, piu' stretto, e' un troncamento silenzioso: una chiave
//    bodyN (N>1) con casing diverso da body1 nello stesso file non matcha e
//    il suo testo sparisce da extractBodyContent senza errore ne' segnale.
// 3. L'unico scrittore di questo formato nel repo (`buildBodyFile` in
//    create-article.mjs) usa una singola costante `id` per tutte le chiavi
//    bodyN di un file — quel mismatch non puo' nascere da li'. Non e' un
//    difetto da correggere qui, ma il comportamento va tracciato.
//
// MUTAZIONE: aggiungere il flag `i` alla RegExp costruita in bodyKeyRx fa
// fallire l'ultimo test di questo blocco (il body2 mismatched tornerebbe
// incluso invece di sparire).

describe('issue #5946 item 5 — bodyN con casing diverso da body1 nello stesso file', () => {
  it('hasBodyKey matcha sempre almeno la chiave body1 da cui extractArticleId ha preso id', () => {
    const src = bodyFile(bodyLine(ALPHA, 1, CORPO_ALPHA_1));
    expect(extractArticleId(src)).toBe(ALPHA);
    expect(hasBodyKey(src, ALPHA)).toBe(true);
  });

  it('una chiave bodyN con casing diverso da body1 sparisce in silenzio da extractBodyContent', () => {
    const src = bodyFile(
      bodyLine(ALPHA, 1, CORPO_ALPHA_1),
      `    'blog.article.Alpha-Uno.body2': '${CORPO_ALPHA_2}',`,
    );
    // body1 resta l'ancora: hasBodyKey non segnala "nessun corpo".
    expect(hasBodyKey(src, ALPHA)).toBe(true);
    const testo = extractBodyContent(src, ALPHA);
    expect(testo).toContain(CORPO_ALPHA_1);
    // Il body2 a casing diverso non e' incluso — troncamento silenzioso,
    // non un errore. Comportamento documentato, non corretto qui (vedi punto 3).
    expect(testo).not.toContain(CORPO_ALPHA_2);
  });
});

// MUTAZIONE: rimettere `fileContent.match(/…/)` (primo match, senza `g`) e
// ignorare `fileName` → rosso.

describe('nanako#393 — extractArticleId decide per nome, non per posizione', () => {
  it('in un file a due id sceglie quello che il nome del file dichiara', () => {
    expect(extractArticleId(DUE_ID, `${BETA}.ts`)).toBe(BETA);
    expect(extractArticleId(DUE_ID, `${ALPHA}.ts`)).toBe(ALPHA);
  });

  it('ricade sul primo body1 quando il nome non compare, come prima', () => {
    expect(extractArticleId(DUE_ID, 'nessuno.ts')).toBe(ALPHA);
    expect(extractArticleId(DUE_ID)).toBe(ALPHA);
    expect(extractArticleId(bodyFile('    // niente'), 'x.ts')).toBe(null);
  });
});

// ── nanako#394 — il lettore e' simmetrico agli scrittori ────────────────────
//
// MUTAZIONE: rimettere `JSON.parse(raw.replace(/\\'/g, "'"))` come unica
// decodifica → rosso su ogni round-trip con virgolette o backslash.

const FAQ_OSTILE = [
  { q: 'Che cosa dice la "circolare" del 2026?', a: "Dice che l'imposta si calcola cosi': prima la base, poi l'aliquota." },
  { q: 'Come si scrive un percorso Windows?', a: 'Per esempio C:\\Users\\frontaliere\\documenti — con i backslash.' },
  { q: 'La risposta puo andare a capo?', a: "Si':\nprima riga\nseconda riga, e un tab\tin mezzo." },
];

describe('nanako#394 — round-trip write→read', () => {
  it('cio che insertFaqIntoBodyFile scrive, extractFaqFromContent rilegge', () => {
    const p = fileTemporaneo(`${ALPHA}.ts`, bodyFile(bodyLine(ALPHA, 1, 'Corpo di alpha.')));
    expect(insertFaqIntoBodyFile(p, ALPHA, FAQ_OSTILE)).toBe(true);
    const dopo = fs.readFileSync(p, 'utf-8');
    expect(extractFaqFromContent(dopo)).toEqual(FAQ_OSTILE);
    // E l'oracolo indipendente vede la stessa cosa: cosi' un difetto simmetrico
    // fra scrittore e lettore non puo' nascondersi da solo.
    expect(faqDiId(dopo, ALPHA)).toEqual(FAQ_OSTILE);
  });

  it('i file scritti dallo scrittore LEGACY restano leggibili', () => {
    // Lo scrittore legacy — che in questo file e' ancora VIVO dentro
    // `replaceFaqInBodyFile` — escapa il solo apostrofo, quindi il `\"` di
    // JSON.stringify resta con UN backslash. Il backslash letterale nella prima
    // risposta non e' decorativo: senza, la fixture la legge gia' il decoder
    // esatto, il fallback non viene mai raggiunto e il test resterebbe verde
    // anche togliendolo.
    const pairs = [
      { q: 'Come si scrive un percorso Windows?', a: 'Si scrive C:\\Users\\frontaliere, con i backslash.' },
      { q: 'Che cosa dice la "circolare"?', a: "Dice cosi', in modo abbastanza lungo da valere." },
    ];
    const legacy = JSON.stringify(pairs).replace(/'/g, "\\'");
    const src = bodyFile(bodyLine(ALPHA, 1, 'Corpo.'), `    'blog.article.${ALPHA}.faq': '${legacy}',`);
    expect(extractFaqFromContent(src)).toEqual(pairs);

    // La fixture esercita DAVVERO il fallback: il decoder esatto non la legge.
    const soloEsatto = (s: string) => s.replace(/\\([\s\S])/g, (whole, c) => (c === '\\' || c === "'" ? c : whole));
    expect(() => JSON.parse(soloEsatto(legacy))).toThrow();
    expect(JSON.parse(legacy.replace(/\\'/g, "'"))).toEqual(pairs);
  });

  it('parseFaqLiteral lascia intatti gli escape del JSON sottostante', () => {
    // Il caso reale che ha deciso la mappa di decodifica (nanako#401): un
    // `\u00a0` scritto dallo scrittore legacy. Un inverso che spoglia ogni
    // `\x` legge la `u` e produce `5u00a0000` — e parsa, quindi il fallback
    // legacy non scatta mai e il valore sbagliato passa.
    const raw = String.raw`[{"q":"Quanto vale la deduzione?","a":"Vale CHF 5\u00a0000 pieni, cifra tonda."}]`;
    const letto = parseFaqLiteral(raw) as Array<{ a: string }>;
    expect(letto[0].a).toBe('Vale CHF 5\u00a0000 pieni, cifra tonda.');
    expect(letto[0].a).not.toContain('u00a0');
  });

  it('torna null quando nessuna decodifica da un array', () => {
    expect(parseFaqLiteral('non e json')).toBe(null);
    expect(parseFaqLiteral('{"q":"un oggetto, non un array"}')).toBe(null);
    expect(parseFaqLiteral('')).toBe(null);
  });
});

// ── issue #5946 item 4 — sequenze di backslash concatenate anomale ──────────
//
// Il reviewer chiedeva se `unescapeTsString`/`parseFaqLiteral` sono verificati
// su run di backslash anomali (tripli/quadrupli), del tipo che una doppia
// riscrittura accidentale produrrebbe. Investigazione (non solo test):
//
// 1. Lo scrittore di questo file (`escapeForSingleQuoteTS`, riga ~134) e'
//    chiamato da UN SOLO punto (`insertFaqIntoBodyFile`), sempre una volta
//    sola sul JSON appena generato — mai su testo gia' escapato. Lo scrittore
//    legacy (`replaceFaqInBodyFile`) idem, con la propria formula. Nessun
//    percorso di QUESTO file applica l'escaping due volte: la "doppia
//    riscrittura" che ha prodotto danni reali sta nel gemello del corpus
//    (nanako#392-395/#401, item 1/2 di questa stessa issue, entrambi
//    `blocked` su quel repo esterno), non qui.
// 2. Simulando comunque l'input degenere (vedi sotto), il comportamento e'
//    deterministico ma NON un round-trip corretto: la seconda decodifica di
//    fallback puo' produrre un array valido con un backslash spurio nel
//    testo invece di rilanciare `null`. Nessun chiamante di QUESTO file puo'
//    produrre quell'input (punto 1), quindi non e' un difetto da correggere
//    qui — ma il comportamento va tracciato, non lasciato implicito.
//
// MUTAZIONE: cambiare la mappa di `parseFaqLiteral` o l'ordine dei decoder
// fa fallire questi test (in particolare l'ultimo, che fissa l'esito esatto
// dell'input a doppio escape).

function escapeForSingleQuoteTsDueVolte(s: string): string {
  const unaVolta = (t: string) => t.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
  return unaVolta(unaVolta(s));
}

describe('issue #5946 item 4 — backslash concatenati anomali (doppia riscrittura)', () => {
  it('unescapeTsString collassa correttamente run di 2, 3 e 4 backslash prima di un apostrofo', () => {
    const map = { '\\': '\\', "'": "'" };
    // 2 backslash + apostrofo -> 1 backslash + apostrofo (una coppia, poi il carattere isolato)
    expect(unescapeTsString(String.raw`\\'`, map)).toBe(String.raw`\'`);
    // 3 backslash + apostrofo -> 1 backslash + apostrofo decodificato (coppia + escape dell'apostrofo)
    expect(unescapeTsString(String.raw`\\\'`, map)).toBe("\\'");
    // 4 backslash + apostrofo -> 2 backslash, l'apostrofo resta non associato (nessun backslash libero prima)
    expect(unescapeTsString(String.raw`\\\\'`, map)).toBe("\\\\'");
  });

  it('un singolo giro di escaping resta un round-trip esatto (percorso reale, gia coperto sopra)', () => {
    const originale = [{ q: 'domanda', a: "it's a test with backslash C:\\Users\\x" }];
    const jsonStr = JSON.stringify(originale);
    const escapedUnaVolta = jsonStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
    expect(parseFaqLiteral(escapedUnaVolta)).toEqual(originale);
  });

  it('un input a DOPPIO escape (irraggiungibile dagli scrittori di questo file) non torna null ne lancia: produce un array con un backslash spurio', () => {
    // Questo e' l'input degenere che nessun chiamante di questo file produce
    // (vedi punto 1 sopra): fissiamo comunque l'esito esatto, cosi' un
    // cambiamento futuro al decoder non lo altera in silenzio.
    const originale = [{ q: 'domanda', a: "it's a test with backslash C:\\Users\\x" }];
    const jsonStr = JSON.stringify(originale);
    const doppioEscape = escapeForSingleQuoteTsDueVolte(jsonStr);

    const risultato = parseFaqLiteral(doppioEscape);
    expect(risultato).not.toBe(null);
    expect(Array.isArray(risultato)).toBe(true);
    // Non e' un round-trip: il testo decodificato differisce dall'originale
    // (backslash spurio davanti all'apostrofo). Documentato, non corretto qui.
    expect((risultato as Array<{ a: string }>)[0].a).not.toBe(originale[0].a);
  });

  it('escapeForSingleQuoteTS (lo scrittore) e chiamata da un solo punto in questo file, mai in cascata', () => {
    const chiamate = [...SCRIPT_SRC.matchAll(/(?<!function\s)\bescapeForSingleQuoteTS\(/g)];
    expect(chiamate.length).toBe(1);
  });
});

// ── nanako#395 — il testo FAQ non e' un pattern di sostituzione ─────────────
//
// MUTAZIONE: rimettere il replacer STRINGA (`` `\n${faqLine}\n$2` ``) in
// `insertFaqIntoBodyFile` → rosso, e il file su disco contiene
// `};\nexport default` dentro il literal della FAQ.

const FAQ_CON_DOLLARI = [
  { q: 'Quanto vale il primo gruppo di cattura?', a: 'Vale $1 e non deve espandersi in niente.' },
  { q: 'E il match intero quanto vale?', a: 'Vale $& e nemmeno lui deve espandersi.' },
  { q: 'E le altre sequenze speciali?', a: "Restano $2, $3, $`, $' e $$ — un massimo di $2 milioni." },
];

describe('nanako#395 — i $ del testo FAQ finiscono su disco verbatim', () => {
  it('percorso di INSERT', () => {
    const p = fileTemporaneo(`${ALPHA}.ts`, bodyFile(bodyLine(ALPHA, 1, 'Corpo di alpha.')));
    expect(insertFaqIntoBodyFile(p, ALPHA, FAQ_CON_DOLLARI)).toBe(true);
    const dopo = fs.readFileSync(p, 'utf-8');
    expect(faqDiId(dopo, ALPHA)).toEqual(FAQ_CON_DOLLARI);
    // L'espansione di $2 duplicherebbe la coda dentro il literal.
    expect(/export default[\s\S]*export default/.test(dopo)).toBe(false);
  });

  it('percorso di FALLBACK (quello via body3)', () => {
    // Il fallback scatta quando la prima regex non matcha: qui manca
    // `export default` sulla riga dopo `};`, che e' cio' che la prima pretende.
    const src = [
      'const blogBody: Record<string, string> = {',
      bodyLine(ALPHA, 1, 'Primo.'),
      bodyLine(ALPHA, 2, 'Secondo.'),
      bodyLine(ALPHA, 3, 'Terzo.'),
      '};',
      '',
    ].join('\n');
    const p = fileTemporaneo(`${ALPHA}.ts`, src);
    expect(insertFaqIntoBodyFile(p, ALPHA, FAQ_CON_DOLLARI)).toBe(true);
    expect(faqDiId(fs.readFileSync(p, 'utf-8'), ALPHA)).toEqual(FAQ_CON_DOLLARI);
  });
});

// ── Il guard strutturale: nessun ALTRO punto interpola in una replacement ───
//
// nanako#395 nomina due siti, ma la domanda giusta e' «ce ne sono altri?».
// Questo scanner li cerca tutti invece di fidarsi dell'elenco: trova ogni
// `.replace(` il cui SECONDO argomento e' un template literal con dentro un
// `${…}`. Un replacer-funzione e uno letterale non matchano.
//
// LIMITE DICHIARATO: riconosce la sola forma «template literal interpolato».
// `.replace(rx, faqLine)` (identificatore nudo) e `.replace(rx, '...' + faqLine)`
// sono lo stesso difetto e passerebbero. Lasciati fuori perche' un
// identificatore come secondo argomento e' anche la forma di un
// replacer-funzione passato per nome — distinguerli vuole il tipo, non la
// sintassi — e un rosso falso qui fermerebbe l'auto-merge di ogni PR aperta.
function replaceInterpolanti(src: string): string[] {
  const trovati: string[] = [];
  const rx = /\.replace\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    const virgole: number[] = [];
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 1) virgole.push(i);
      else if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        i++;
        while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      } else if (c === '/' && /[(,=:[]\s*$/.test(src.slice(Math.max(0, i - 30), i))) {
        i++;
        while (i < src.length && src[i] !== '/') i += src[i] === '\\' ? 2 : 1;
      }
      i++;
    }
    if (!virgole.length) continue;
    const secondo = src.slice(virgole[0] + 1, i - 1).trim();
    if (secondo.startsWith('`') && /\$\{/.test(secondo)) {
      trovati.push(src.slice(m.index, Math.min(src.length, m.index + 90)).split('\n')[0]);
    }
  }
  return trovati;
}

describe('nanako#395 — lo scanner, e il fatto che veda davvero il difetto', () => {
  it('riconosce la forma del difetto e assolve le forme sane', () => {
    const cattivo = 'content = content.replace(/(a)(b)/, `\\n${faqLine}\\n$2`);';
    expect(replaceInterpolanti(cattivo)).toHaveLength(1);
    const buono = 'content = content.replace(/(a)(b)/, (_m, x, y) => `${x}${faqLine}${y}`);';
    expect(replaceInterpolanti(buono)).toHaveLength(0);
    const letterale = String.raw`s.replace(/\\/g, '\\\\')`;
    expect(replaceInterpolanti(letterale)).toHaveLength(0);
  });

  it('nessun .replace() dello script interpola testo in una replacement string', () => {
    expect(replaceInterpolanti(SCRIPT_SRC)).toEqual([]);
  });
});
