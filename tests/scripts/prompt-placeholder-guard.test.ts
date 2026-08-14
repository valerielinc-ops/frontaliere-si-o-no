import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_PLACEHOLDER_LITERALS,
  SLUG_OWNED_LITERALS,
  PROMPT_SCAFFOLD_LABELS,
  PLACEHOLDER_RULES,
  leadOf,
  findPromptPlaceholders,
  hasPromptPlaceholder,
  cleanFaqPairs,
  orphanFaqLocales,
  sanitizePromptPlaceholders,
} from '../../scripts/lib/prompt-placeholder-guard.mjs';
import { unescapeTsString, tsStringEscapesWithNewlineAs, repairLegacyDoubleEscapedBreaks } from '../../scripts/lib/unescape-ts-string.mjs';

/**
 * prompt-placeholder-guard.test.ts — banco del GEMELLO SITO del guard sui
 * segnaposto del prompt (corpus PR #196; issue corpus #195, #208 item 1).
 *
 * Perche' questo file esiste ANCHE qui: `scripts/create-article.mjs` di
 * questo repo e' un gemello vivo del file omonimo del corpus —
 * `scripts/publish-journalist-article.mjs` importa `registerArticleFiles` da
 * QUI e gira ogni 15 minuti, e nessun mirror copia `generator/`. Misurato:
 * dopo la PR #196 del corpus, 2 articoli pubblicati da QUESTO percorso
 * portavano segnaposto letterali (`DALLA FONTE`, `Max 125 caratteri`) — il
 * guard del corpus non poteva vederli perche' non erano mai passati di la'.
 *
 * Quattro strati (stessa struttura del banco del corpus):
 *   1. UNIT    — segnaposto veri, verbatim.
 *   2. LOCK    — i letterali si ri-estraggono da QUESTO create-article.mjs
 *                (non da quello del corpus: i due prompt divergono su
 *                seo.ogDescription) e devono coincidere col modulo.
 *   3. WIRING  — il guard e' cablato sul percorso di scrittura CONDIVISO —
 *                sia `registerArticleFiles()` (il gap misurato) sia il
 *                flusso AI primario.
 *   4. MUTAZIONE — tre varianti reali (corpo con "DALLA FONTE", campo
 *                budget con "Max 125 caratteri", campo SEO) devono rendere
 *                rosso questo banco se il guard sparisce: e' la richiesta
 *                esplicita dopo che un guard analogo e' stato trovato vacuo
 *                (0 rossi su 85) altrove nel ciclo.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'scripts', 'create-article.mjs');
const createArticleSrc = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

// ═══════════════════════════════════════════════════════════════════════════
// 1. UNIT — la famiglia di segnaposto nota (elencata nel prompt di lavoro)
// ═══════════════════════════════════════════════════════════════════════════

describe('la famiglia di segnaposto nota, coperta campo per campo', () => {
  it('"DALLA FONTE" — nell\'excerpt (trasferirsi-a-marchirolo, offender reale del corpus)', () => {
    expect(hasPromptPlaceholder('Sottotitolo con dati concreti DALLA FONTE (max 160 chars)')).toBe(true);
  });

  it('"DALLA FONTE" — nella risposta FAQ', () => {
    expect(hasPromptPlaceholder('Risposta con dati DALLA FONTE. 50-100 parole.')).toBe(true);
    const [hit] = findPromptPlaceholders('Risposta con dati DALLA FONTE. 50-100 parole.');
    expect(hit.rule).toMatch(/^schema-lead-/);
  });

  it('"Max 125 caratteri" / "max 125 chars" — imageAlt, in tutte le varianti di maiuscole', () => {
    for (const valore of ['max 125 chars', 'Max 125 chars', 'Max 125 caratteri', 'max 125 caratteri']) {
      expect(hasPromptPlaceholder(valore), `«${valore}» doveva essere un segnaposto`).toBe(true);
    }
  });

  it('"Max 125 caratteri" NON e\' nel prompt: e\' la traduzione che il modello inventa', () => {
    expect(createArticleSrc.includes('Max 125 caratteri')).toBe(false);
    expect(createArticleSrc.includes('max 125 chars')).toBe(true);
    const [hit] = findPromptPlaceholders('Max 125 caratteri');
    expect(hit.rule).toBe('budget-as-value');
  });

  it('"sottotitolo" / "Sottotitolo con dati concreti" — la testa del letterale excerpt', () => {
    expect(hasPromptPlaceholder('Sottotitolo con dati concreti DALLA FONTE (max 160 char)')).toBe(true);
  });

  it('"titolo" / "Titolo giornalistico con keyword" — la testa del letterale title', () => {
    expect(hasPromptPlaceholder("Titolo giornalistico con keyword (OBBLIGATORIO ≤ 60 caratteri totali, target 50-55. Il suffisso ' | Frontaliere Ticino' viene aggiunto automaticamente — NON includerlo nel title)")).toBe(true);
  });

  it('"HEADLINE:" e "RECENT ARTICLE IDS" — le etichette del preambolo, non dello schema', () => {
    expect(hasPromptPlaceholder('Testo vero.\n\nHEADLINE: qualcosa')).toBe(true);
    expect(hasPromptPlaceholder('RECENT ARTICLE IDS (last 50 of 3006 total — do NOT reuse): x')).toBe(true);
  });

  it('"50-100 parole" — solo come coda del letterale FAQ, non isolato (evita falsi positivi su prosa)', () => {
    expect(hasPromptPlaceholder('Risposta con dati DALLA FONTE. 50-100 parole.')).toBe(true);
    // Isolato non e' un segnaposto: e' una prescrizione di lunghezza generica
    // che puo' comparire in prosa legittima (istruzioni editoriali, non testo pubblicato).
    expect(hasPromptPlaceholder('50-100 parole')).toBe(false);
  });

  it('"Domanda frequente 1" — con o senza contenuto vero dietro', () => {
    expect(hasPromptPlaceholder('Domanda frequente 1')).toBe(true);
    expect(hasPromptPlaceholder("Domanda frequente 1 basata sui fatti dell'articolo?")).toBe(true);
    expect(hasPromptPlaceholder('Domanda frequente 4:')).toBe(true); // lo schema si ferma a 3 — la regola conta qualunque cifra
  });

  it('l\'excerpt TRADOTTO in quattro lingue: solo la regola di FORMA lo vede, nessun letterale', () => {
    const casi: Array<[string, string]> = [
      ['it', 'Sottotitolo con dati concreti DALLA FONTE (max 160 char)'],
      ['en', 'Subtitle with concrete data FROM THE SOURCE (max 160 char)'],
      ['de', 'Untertitel mit konkreten Angaben AUS DER QUELLE (max 160 char)'],
      ['fr', 'Sous-titre avec des données concrètes DE LA SOURCE (max 160 char)'],
    ];
    for (const [locale, valore] of casi) {
      expect(hasPromptPlaceholder(valore), `${locale} non visto`).toBe(true);
    }
    for (const [, valore] of casi.slice(1)) {
      const regole = findPromptPlaceholders(valore).map((h) => h.rule);
      expect(regole).toEqual(['budget-parenthetical']);
    }
  });

  it('prosa legittima con "(max " NON e\' un segnaposto — il tasso di falsi positivi che conta', () => {
    const prosaLegittima = [
      'Il Cantone ha approvato un tetto di spesa (max 15.000 CHF/anno) per le imprese ticinesi.',
      'possono lavorare un numero limitato di ore per settimana (max 9 ore/giorno, 42 ore/settimana).',
      'Lettre de motivation (max 1 page)',
    ];
    for (const testo of prosaLegittima) {
      expect(findPromptPlaceholders(testo), testo).toEqual([]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. LOCK — il criterio segue IL TEMPLATE DI QUESTO FILE, non il corpus
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ri-estrae i valori letterali dallo schema JSON che il prompt DI QUESTO
 * SCRIPT mostra al modello. Stessa ancora del banco del corpus
 * (`Genera JSON (no markdown, no code fences):` … `REGOLE FINALI:`), ma sui
 * byte di QUESTO file: i due prompt sono quasi identici ma non uguali
 * (seo.ogDescription diverge), quindi la lista non puo' essere presa in
 * prestito da SCHEMA_PLACEHOLDER_LITERALS del corpus.
 */
function extractSchemaLiterals(src: string): string[] {
  const start = src.indexOf('Genera JSON (no markdown, no code fences):');
  expect(start, 'ancora dello schema JSON non trovata in create-article.mjs — il prompt e\' cambiato forma').toBeGreaterThan(0);
  const end = src.indexOf('\nREGOLE FINALI:', start);
  expect(end, 'chiusura dello schema JSON non trovata').toBeGreaterThan(start);
  const block = src.slice(start, end);
  const out: string[] = [];
  const rx = /"([A-Za-z0-9_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(block)) !== null) {
    if (m[2].includes('${')) continue;
    out.push(m[2]);
  }
  return out;
}

describe('LOCK — se il template di questo file acquisisce un segnaposto, questo test diventa rosso', () => {
  const estratti = extractSchemaLiterals(createArticleSrc);

  it('lo schema del prompt espone almeno 20 valori letterali', () => {
    expect(estratti.length).toBeGreaterThanOrEqual(20);
  });

  it('i letterali del modulo coincidono ESATTAMENTE con quelli DI QUESTO template', () => {
    const dalTemplate = [...new Set(estratti)].sort();
    const dalModulo = [...new Set(SCHEMA_PLACEHOLDER_LITERALS)].sort();
    expect(
      dalTemplate,
      'SCHEMA_PLACEHOLDER_LITERALS non e\' allineato al prompt di scripts/create-article.mjs (di QUESTO repo). ' +
        'Aggiungere/togliere un campo nello schema JSON richiede di aggiornare la lista nel modulo.',
    ).toEqual(dalModulo);
  });

  it('OGNI letterale e\' visto da questo guard OPPURE dal classificatore degli slug del sito', () => {
    const scoperti = estratti.filter((literal) => !hasPromptPlaceholder(literal) && !SLUG_OWNED_LITERALS.includes(literal));
    expect(scoperti, 'letterali dello schema che nessun guard riconosce').toEqual([]);
  });

  it('i letterali delegati allo slug guard sono davvero classificati da lui (scripts/lib/slug-prompt-leak-guard.mjs)', async () => {
    const { findSlugPromptLeak } = await import('../../scripts/lib/slug-prompt-leak-guard.mjs');
    for (const literal of SLUG_OWNED_LITERALS) {
      expect(findSlugPromptLeak(literal), `lo slug guard non riconosce "${literal}"`).not.toBeNull();
    }
  });

  it('le etichette del preambolo sono ancora quelle che il prompt costruisce', () => {
    for (const label of PROMPT_SCAFFOLD_LABELS) {
      expect(createArticleSrc.includes(label), `"${label}" non compare piu' in create-article.mjs`).toBe(true);
    }
  });

  it('leadOf e\' deterministica e non degenera su nessun letterale', () => {
    for (const literal of SCHEMA_PLACEHOLDER_LITERALS) {
      const lead = leadOf(literal);
      expect(lead.length, `lead troppo corto per "${literal}"`).toBeGreaterThanOrEqual(7);
      expect(literal.startsWith(lead), `lead non e' un prefisso di "${literal}"`).toBe(true);
    }
  });

  it('la divergenza nota dal corpus (seo.ogDescription) e\' quella attesa, non un drift silenzioso', () => {
    expect(SCHEMA_PLACEHOLDER_LITERALS).toContain('OG desc (≤ 160 caratteri)');
    expect(SCHEMA_PLACEHOLDER_LITERALS).not.toContain(
      "OG desc per la card social — 200-250 caratteri, NON una copia della description: Facebook/LinkedIn/WhatsApp mostrano molto piu' di una SERP (HARD CAP: ≤ 250 caratteri)",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. WIRING — il guard e' invocato davvero, e nei due punti giusti
// ═══════════════════════════════════════════════════════════════════════════

describe('wiring — il guard e\' cablato sul percorso di scrittura CONDIVISO', () => {
  it('create-article.mjs importa il modulo', () => {
    expect(createArticleSrc).toMatch(/from '\.\/lib\/prompt-placeholder-guard\.mjs'/);
  });

  it('sanitizePromptPlaceholders gira dentro registerArticleFiles() — il gap misurato (#195, #208 item 1)', () => {
    // publish-journalist-article.mjs importa registerArticleFiles direttamente
    // e gira ogni 15 minuti senza mai passare da main()/generateAndValidateArticle.
    const i = createArticleSrc.indexOf('export async function registerArticleFiles');
    expect(i, 'registerArticleFiles non trovata').toBeGreaterThan(0);
    const corpo = createArticleSrc.slice(i, i + 2000);
    expect(corpo, 'guard non invocato in registerArticleFiles').toContain('sanitizePromptPlaceholders(data)');
    expect(
      corpo.indexOf('sanitizePromptPlaceholders(data)') < corpo.indexOf('clampSeoDescriptions(data)'),
      'il guard deve precedere il clamp — troncare un campo che E\' il segnaposto lo renderebbe solo piu\' corto',
    ).toBe(true);
  });

  it('sanitizePromptPlaceholders gira anche nel flusso AI primario (generateAndValidateArticle)', () => {
    const i = createArticleSrc.indexOf('async function generateAndValidateArticle');
    const j = createArticleSrc.indexOf('function slugifySlugPart');
    expect(i > 0 && j > i, 'generateAndValidateArticle non trovata').toBe(true);
    const corpo = createArticleSrc.slice(i, j);
    expect(corpo, 'guard non invocato nel flusso AI primario').toContain('sanitizePromptPlaceholders(data)');
    expect(
      corpo.indexOf('translateArticle(data)') < corpo.indexOf('sanitizePromptPlaceholders(data)'),
      'il guard deve girare DOPO translateArticle(), altrimenti non vede i segnaposto propagati dalla traduzione',
    ).toBe(true);
    expect(
      corpo.indexOf('sanitizePromptPlaceholders(data)') < corpo.indexOf('modifyRouterTs(data)'),
      'il guard deve girare PRIMA della scrittura dei file',
    ).toBe(true);
  });

  it('il filtro FAQ passa da cleanFaqPairs, non piu\' solo dalla lunghezza', () => {
    expect(createArticleSrc, 'il filtro FAQ non usa il guard').toContain('cleanFaqPairs(rawFaq)');
    expect(
      /const validFaq = rawFaq\.filter/.test(createArticleSrc),
      'il vecchio filtro di sola FORMA e\' ancora al suo posto: una FAQ segnaposto lo supera (stampava "✅ FAQ: 3 coppie valide" sullo schema puro)',
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3-bis. WIRING — il SECONDO generatore che scrive FAQ nei body pubblicati
// ═══════════════════════════════════════════════════════════════════════════
//
// `create-article.mjs` non e' l'unico produttore di FAQ del sito.
// `batch-add-faq-to-articles.mjs` genera coppie via LLM
// (`generateFaqIT`/`generateTopUpFaqIT`), le traduce e le scrive nei body file
// pubblicati (`insertFaqIntoBodyFile`) — da cui `engine/ogPagesPlugin.ts` fa lo
// schema FAQPage. Aveva la copia esatta del filtro di sola FORMA che questa PR
// ha tolto dall'altro lato (`q.length > 10 && a.length > 20` in `validateFaq`),
// quindi la stessa FAQ segnaposto usciva come structured data reale passando di
// qua. Trovato in review su questa PR, non da un gate: e' la ragione per cui il
// blocco esiste.

describe('wiring — batch-add-faq-to-articles.mjs, il secondo produttore di FAQ', () => {
  const BATCH = path.join(ROOT, 'scripts', 'batch-add-faq-to-articles.mjs');
  const batchSrc = fs.readFileSync(BATCH, 'utf-8');

  it('importa il guard condiviso', () => {
    expect(batchSrc).toMatch(/from '\.\/lib\/prompt-placeholder-guard\.mjs'/);
  });

  it('validateFaq passa da cleanFaqPairs, non piu\' da un filtro di sola lunghezza', () => {
    const i = batchSrc.indexOf('function validateFaq');
    expect(i, 'validateFaq non trovata').toBeGreaterThan(0);
    const corpo = batchSrc.slice(i, i + 1200);
    expect(corpo, 'validateFaq non chiama il guard').toContain('cleanFaqPairs(faq');
    expect(
      /pair\.q\.length > 10 && pair\.a\.length > 20/.test(corpo),
      'il filtro di sola FORMA e\' ancora dentro validateFaq: una coppia segnaposto dello schema e\' lunga abbastanza e lo supera',
    ).toBe(false);
  });

  it('conserva la soglia di UNA coppia, perche\' e\' quella che arma il top-up', () => {
    // `MIN_FAQ_PAIRS` (3) e il ramo `validFaq.length > 0 && validFaq.length <
    // MIN_FAQ_PAIRS` vivono nel CHIAMANTE: se validateFaq collassasse a null
    // sotto le 2 coppie, il top-up non partirebbe mai per il caso di UNA — che
    // e' esattamente il caso per cui esiste.
    const i = batchSrc.indexOf('function validateFaq');
    const corpo = batchSrc.slice(i, i + 1200);
    expect(corpo, 'la soglia dell\'engine (2) e\' stata importata dove non serve').toContain('minPairs: 1');
    expect(corpo, 'il cap a 7 e\' sparito').toContain('slice(0, 7)');
  });

  it('minPairs non allenta il default: chi scrive il campo finito resta a 2', () => {
    // Il difetto che questo previene: aggiungere `minPairs` e lasciarlo a 1
    // ovunque spegnerebbe la soglia di `ogPagesPlugin.ts` sul percorso di
    // create-article.mjs, cioe' proprio la protezione che la PR installa.
    const unaCoppiaVera = [{ q: 'Chi paga i contributi del frontaliere?', a: 'Li versa il datore di lavoro svizzero, con la quota a carico del dipendente trattenuta in busta paga.' }];
    expect(cleanFaqPairs(unaCoppiaVera).pairs, 'il default deve restare la soglia dell\'engine (2)').toBeNull();
    expect(cleanFaqPairs(unaCoppiaVera, { minPairs: 1 }).pairs).toHaveLength(1);
  });

  it('una FAQ segnaposto viene scartata anche con minPairs: 1 — la soglia non e\' una scappatoia', () => {
    // L'asserzione che rende non vacuo il blocco: abbassare la soglia non deve
    // far passare il CONTENUTO che il guard esiste per fermare.
    const schema = [
      { q: 'Domanda frequente 1 basata sui fatti dell\'articolo?', a: 'Risposta con dati DALLA FONTE. 50-100 parole.' },
      { q: 'Domanda frequente 2', a: 'Risposta pratica basata sulla fonte. 50-100 parole.' },
    ];
    const { pairs, dropped } = cleanFaqPairs(schema, { minPairs: 1 });
    expect(pairs, 'lo schema puro e\' passato con la soglia abbassata').toBeNull();
    expect(dropped.filter((d: any) => d.placeholder).length).toBe(2);
  });
});

describe('orphanFaqLocales — esercitata dal banco finche\' la bonifica (#5834) non la cabla', () => {
  // Non ha chiamanti nel percorso di scrittura, per costruzione (li' la FAQ it
  // e le sue traduzioni nascono e cadono insieme). Il test esiste perche' un
  // export puro senza nessuno che lo eserciti e' cio' che marcisce in silenzio.
  it('segnala le locali tradotte rimaste senza originale it', () => {
    expect(
      orphanFaqLocales({
        it: { hasFile: true, hasFaq: false },
        en: { hasFile: true, hasFaq: true },
        de: { hasFile: true, hasFaq: true },
        fr: { hasFile: true, hasFaq: false },
      }),
    ).toEqual(['de', 'en']);
  });

  it('non tocca niente se it ha ancora la sua FAQ', () => {
    expect(
      orphanFaqLocales({
        it: { hasFile: true, hasFaq: true },
        en: { hasFile: true, hasFaq: true },
      }),
    ).toEqual([]);
  });

  it('non tocca niente se il file it non esiste — e\' un difetto di un\'altra classe', () => {
    // Un articolo pubblicato solo in traduzione: qui cancellare distruggerebbe
    // l'unico contenuto rimasto invece di ripararlo.
    expect(
      orphanFaqLocales({
        it: { hasFile: false, hasFaq: false },
        en: { hasFile: true, hasFaq: true },
      }),
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. MUTAZIONE — le tre varianti reali richieste, fail-closed
// ═══════════════════════════════════════════════════════════════════════════
//
// Un guard analogo e' stato trovato VACUO altrove nel ciclo (0 rossi su 85):
// contava le coppie/i caratteri e passava lo schema stesso. Questo blocco
// prova che QUESTO guard discrimina davvero: ogni variante e' un `data` che
// `registerArticleFiles()`/`generateAndValidateArticle()` avrebbero altrimenti
// scritto su file sorgente pubblici, e ognuna deve LANCIARE — non solo
// segnalare — perche' il percorso che protegge (publish-journalist-article,
// ogni 15 minuti) non ha nessuno che legga un avviso.

describe('MUTAZIONE 1/3 — "DALLA FONTE" in un campo di corpo', () => {
  it('body1 contaminato da un frammento dello schema FAQ → LANCIA', () => {
    const data = {
      id: 'x',
      content: {
        it: {
          title: 'Ristorni sospesi: cosa cambia per i frontalieri',
          body1: 'Il Consiglio di Stato ha deciso di sospendere i versamenti. Risposta con dati DALLA FONTE. 50-100 parole.',
        },
      },
    };
    expect(() => sanitizePromptPlaceholders(data)).toThrow(/content\.it\.body1/);
  });

  it('l\'articolo NON viene registrato: nessun campo resta scritto dopo il lancio', () => {
    const data = { id: 'x', content: { it: { title: 'T', body1: 'Risposta con dati DALLA FONTE. 50-100 parole.' } } };
    let threw = false;
    try {
      sanitizePromptPlaceholders(data);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Il campo non e' stato rattoppato silenziosamente: e' rimasto tale e
    // quale, e la funzione non e' mai arrivata a restituire `fixes`.
    expect(data.content.it.body1).toContain('DALLA FONTE');
  });
});

describe('MUTAZIONE 2/3 — "Max 125 caratteri" (budget-as-value tradotto)', () => {
  it('excerpt ridotto al solo budget tradotto → LANCIA', () => {
    const data = { id: 'x', content: { it: { title: 'T', excerpt: 'Max 125 caratteri' } } };
    expect(() => sanitizePromptPlaceholders(data)).toThrow(/content\.it\.excerpt/);
  });

  it('la stessa stringa in imageAlt viene invece RIPARATA (ricostruita dal titolo), non pubblicata verbatim', () => {
    // Risposta diversa, stesso fail-closed: imageAlt ha una ricetta
    // deterministica in validate(), quindi qui si ripara invece di lanciare —
    // ma il segnaposto NON sopravvive nell'output in nessuno dei due casi.
    const data = {
      id: 'x',
      imageAlt: { it: 'Max 125 caratteri', en: 'max 125 chars' },
      content: { it: { title: 'Ristorni sospesi: cosa cambia' } },
    };
    sanitizePromptPlaceholders(data);
    expect(data.imageAlt.it).toBe('Immagine editoriale relativa a: Ristorni sospesi: cosa cambia');
    expect(hasPromptPlaceholder(data.imageAlt.it)).toBe(false);
  });
});

describe('MUTAZIONE 3/3 — segnaposto in un campo SEO, non nel corpo', () => {
  it('seo.ogTitle contaminato dalla testa del letterale schema → LANCIA', () => {
    const data = {
      id: 'x',
      content: { it: { title: 'Ristorni sospesi: cosa cambia per i frontalieri' } },
      seo: { ogTitle: 'OG title (OBBLIGATORIO ≤ 60 caratteri)' },
    };
    expect(() => sanitizePromptPlaceholders(data)).toThrow(/seo\.ogTitle/);
  });

  it('seo.description con il letterale DI QUESTO SITO (≤ 160, non 250 come il corpus) → LANCIA', () => {
    // Copre la divergenza reale: il letterale ogDescription del sito e' "OG
    // desc (≤ 160 caratteri)", diverso da quello del corpus. Se il guard
    // fosse rimasto quello del corpus (letterale sbagliato), questa riga
    // NON avrebbe fatto match e il test sarebbe andato verde a vuoto.
    const data = {
      id: 'x',
      content: { it: { title: 'T' } },
      seo: { ogDescription: 'OG desc (≤ 160 caratteri)' },
    };
    expect(() => sanitizePromptPlaceholders(data)).toThrow(/seo\.ogDescription/);
  });
});

describe('la premessa della mutazione 1: il vecchio filtro di FORMA le avrebbe accettate', () => {
  // Stessa dimostrazione del banco del corpus: se questa assert cade, la
  // premessa del guard e' sbagliata e le mutazioni sopra provano meno di
  // quanto sembra.
  const FAQ_SEGNAPOSTO = [
    { q: "Domanda frequente 1 basata sui fatti dell'articolo?", a: 'Risposta con dati DALLA FONTE. 50-100 parole.' },
    { q: 'Domanda frequente 2?', a: 'Risposta pratica basata sulla fonte.' },
    { q: 'Domanda frequente 3?', a: 'Risposta con procedura o scadenza dalla fonte.' },
  ];

  it('il vecchio filtro (q.length > 10 && a.length > 20) le contava tutte e tre valide', () => {
    const passavano = FAQ_SEGNAPOSTO.filter((p) => p.q.length > 10 && p.a.length > 20);
    expect(passavano.length).toBe(3);
  });

  it('cleanFaqPairs le scarta tutte e tre e rimuove il campo — questo e\' il discriminante che mancava', () => {
    const { pairs, dropped } = cleanFaqPairs(FAQ_SEGNAPOSTO);
    expect(dropped.length).toBe(3);
    expect(pairs).toBeNull();
  });

  it('sanitizePromptPlaceholders rimuove la FAQ segnaposto dal data pronto per la scrittura', () => {
    const data = { id: 'x', content: { it: { title: 'T', faq: FAQ_SEGNAPOSTO } } };
    sanitizePromptPlaceholders(data);
    expect('faq' in data.content.it).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. CONTROLLO — un articolo pulito non viene toccato (l'altra direzione del falso)
// ═══════════════════════════════════════════════════════════════════════════

describe('controllo — un articolo pulito passa senza modifiche', () => {
  it('nessuna riparazione, nessun lancio, dati invariati', () => {
    const data = {
      id: 'x',
      imageAlt: { it: 'Un frontaliere alla dogana di Chiasso' },
      content: {
        it: {
          title: 'Ristorni sospesi: cosa cambia per i frontalieri',
          excerpt: 'Il Consiglio di Stato ticinese ha sospeso i ristorni alla Lombardia: oltre 50 milioni bloccati.',
          body1: 'Testo con un tetto di spesa (max 15.000 CHF/anno) approvato dal Gran Consiglio.',
          faq: [
            { q: 'Cosa significa la sospensione dei ristorni?', a: 'Significa che il Cantone non versa la quota dovuta ai comuni italiani di frontiera.' },
            { q: 'Quando riprenderanno i versamenti?', a: 'Non è ancora stata fissata una data: dipende dai colloqui fra Berna e Roma.' },
          ],
        },
      },
      seo: { description: 'Ristorni sospesi dal Ticino: cosa cambia per i frontalieri e per i comuni italiani.' },
    };
    const prima = JSON.stringify(data);
    expect(sanitizePromptPlaceholders(data)).toEqual([]);
    expect(JSON.stringify(data)).toBe(prima);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. GATE — il PUBBLICATO, non il percorso di scrittura (ratchet, #5834)
// ═══════════════════════════════════════════════════════════════════════════
//
// I blocchi sopra provano che il guard blocca la SCRITTURA di un nuovo
// segnaposto. Non dicono niente su cio' che e' gia' pubblicato: uno script
// one-off, una bonifica fatta a mano, o un `git revert` puo' rimettere un
// segnaposto nel pubblicato senza passare da `sanitizePromptPlaceholders`, e
// nessun test sopra se ne accorgerebbe.
//
// Misurato il 2026-08-14 (issue #5834, che rifa' la misura della PR #5812
// perche' i numeri di una issue scadono in fretta su questo repo):
//   117.255 campi scansionati, 16.780 file, 0 offender.
// Baseline comoda: qualunque numero > 0 e' un regresso, non serve una soglia
// a conteggio assoluto che altrove sfarfalla.
//
// Stessa estrazione escape-aware gia' usata da `staticPagesPlugin.ts` per
// leggere `blog-body/<locale>/*.ts` (`/'blog\.article\.([^']+)\.(campo)'\s*:\s*'((?:[^'\\]|\\.)*)'/g`
// + `unescapeTsString`), generalizzata al nome di campo cosi' da coprire in un
// solo giro `title`/`excerpt`/`imageAlt`/`body1..bodyN`/`faq`/`seoDescription`/
// `ogDescription` — le stesse chiavi, ovunque compaiano, senza doverle
// enumerare a mano (un campo nuovo nello schema resta coperto automaticamente).
describe('GATE — 0 offender sul pubblicato, ratchet contro il buco fra scrittura e bonifica', () => {
  const CONTENT_ROOT = path.join(ROOT, 'packages', 'articles', 'content');
  const FIELD_RX = /'blog\.article\.([^']+)\.([a-zA-Z0-9]+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;

  function collectContentFiles(): string[] {
    const files: string[] = [];
    for (const sub of ['blog-body', 'blog-body-ch']) {
      const base = path.join(CONTENT_ROOT, sub);
      if (!fs.existsSync(base)) continue;
      for (const locale of fs.readdirSync(base)) {
        const dir = path.join(base, locale);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.ts')) files.push(path.join(dir, f));
        }
      }
    }
    for (const f of fs.readdirSync(CONTENT_ROOT)) {
      if (/^blog-meta.*\.ts$/.test(f)) files.push(path.join(CONTENT_ROOT, f));
    }
    return files;
  }

  type Offender = { file: string; id: string; field: string; rules: string[] };

  function scanContent(): { totalFields: number; offenders: Offender[] } {
    let totalFields = 0;
    const offenders: Offender[] = [];
    for (const file of collectContentFiles()) {
      const src = fs.readFileSync(file, 'utf-8');
      const rx = new RegExp(FIELD_RX.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = rx.exec(src)) !== null) {
        const [, id, field, raw] = m;
        // Decode allineato al lettore di produzione in staticPagesPlugin.ts
        // (parseBlogBodyLocale): unescapeTsString gira PRIMA, sul testo grezzo
        // catturato tra le virgolette, con lo stesso escape set con \n -> ' '
        // usato per i campi single-line di questo gate.
        // repairLegacyDoubleEscapedBreaks gira DOPO, sull'output gia' decodificato
        // (mai sul sorgente grezzo): ripara il residuo di un vecchio bug di
        // scrittura del corpus (\\n doppiamente sfuggito) collassandolo allo
        // stesso spazio target, invece di lasciare un backslash visibile.
        // Nessuna delle due chiamate va invertita: l'ordine e' quello che
        // decide se un `\\n` legacy diventa uno spazio o resta un backslash.
        // Vedi unescape-ts-string.mjs per il dettaglio del perche'.
        const value = repairLegacyDoubleEscapedBreaks(unescapeTsString(raw, tsStringEscapesWithNewlineAs(' ')), ' ');
        totalFields += 1;
        const hits = findPromptPlaceholders(value);
        if (hits.length) {
          offenders.push({ file: path.relative(ROOT, file), id, field, rules: hits.map((h) => h.rule) });
        }
      }
    }
    return { totalFields, offenders };
  }

  it('scansiona almeno ~100k campi — la soglia che distingue "zero offender" da "zero file letti"', () => {
    // Difende contro un gate che passa a vuoto: un path rinominato, una
    // cartella spostata, un worktree sparse configurato male. La misura reale
    // e' ~117k; 100k lascia margine al normale via-vai editoriale senza
    // indebolire il segnale se lo scan smette di leggere quasi tutto.
    const { totalFields } = scanContent();
    expect(totalFields).toBeGreaterThanOrEqual(100_000);
  });

  it('0 offender: nessun campo pubblicato porta un segnaposto del prompt', () => {
    const { offenders } = scanContent();
    if (offenders.length) {
      const sample = offenders
        .slice(0, 10)
        .map((o) => `  ${o.file} :: blog.article.${o.id}.${o.field} — ${o.rules.join(', ')}`)
        .join('\n');
      const more = offenders.length > 10 ? `\n  ... e altri ${offenders.length - 10}` : '';
      throw new Error(
        `${offenders.length} campo/i pubblicato/i con segnaposto del prompt del modello:\n${sample}${more}\n\n` +
          'Il ratchet e\' 0: la scrittura ha il suo guard (sanitizePromptPlaceholders), quindi un offender qui ' +
          'e\' entrato da un percorso non coperto (script one-off, bonifica a mano, revert). Ripara il campo ' +
          '(o rigenera l\'articolo) invece di alzare questa soglia.',
      );
    }
    expect(offenders).toEqual([]);
  });
});

describe('coerenza interna delle regole', () => {
  it('nessun id di regola duplicato', () => {
    const ids = PLACEHOLDER_RULES.map((r) => r.id);
    expect([...new Set(ids)]).toEqual(ids);
  });

  it('ogni regola ha un `why` non vuoto', () => {
    for (const r of PLACEHOLDER_RULES) expect(r.why && r.why.length > 30, `regola ${r.id} senza motivazione`).toBe(true);
  });

  it('nessuna regola scatta sulla stringa vuota o su testo neutro', () => {
    for (const testo of ['', '   ', 'Il permesso G si rinnova ogni anno.']) {
      expect(findPromptPlaceholders(testo), testo).toEqual([]);
    }
  });
});
