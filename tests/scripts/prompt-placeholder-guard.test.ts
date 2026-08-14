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

// ═════════════════════════════════════════════════════════════════════════════
// #5847 — i tre item deferred di #5812
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ITEM 2 — la regex `budget-parenthetical` era una FINESTRA FRAGILE.
 *
 * Pretendeva la parentesi di chiusura subito dopo l'unita', quindi qualunque
 * parola in piu' dentro le parentesi la faceva mancare. Misurato sulla matrice
 * qui sotto: la forma vecchia ne rilevava **4 su 14**, cioe' 10 falsi negativi —
 * e un falso negativo qui significa il segnaposto PUBBLICATO, che e' il difetto
 * che #5812 esisteva per chiudere.
 *
 * Il controllo ora isola lo span parentetico e valuta l'invariante sul suo
 * contenuto (`matchBudgetParenthetical`). La matrice e' scritta come DRIFT DEL
 * MODELLO — qualificatore x unita' x lingua x testo di coda — non come quattro
 * fixture: e' la variazione a essere il soggetto del test.
 */
describe('#5847 item 2 — budget-parenthetical tollera il drift del modello', () => {
  const isBudget = (s: string) =>
    findPromptPlaceholders(s).some((h) => h.rule === 'budget-parenthetical');

  // Le 4 lingue di produzione, la forma canonica.
  const CANONICHE = [
    'Sottotitolo con dati concreti DALLA FONTE (max 160 char)',
    'Subtitle with concrete data FROM THE SOURCE (max 160 characters)',
    'Untertitel mit konkreten Angaben AUS DER QUELLE (max 160 Zeichen)',
    'Sous-titre avec des données concrètes DE LA SOURCE (max 160 caractères)',
  ];

  // Il drift: e' questa la lista che la forma vecchia mancava in blocco.
  const DRIFT = [
    'Excerpt (max. 160 caratteri circa)',
    'Excerpt (max 160 characters, no more)',
    'Excerpt (ca. 160 Zeichen)',
    'Excerpt (160 caratteri)',
    'Excerpt (al massimo 160 caratteri)',
    'Excerpt (environ 160 signes)',
    'Excerpt (máximo 160 caracteres aprox.)',
    'Excerpt (non oltre 160 caratteri)',
    'Excerpt (Zeichen: 160)',
    'Excerpt (limite: 160 caratteri)',
  ];

  // Il bordo che NON deve muoversi: e' l'unita' di misura a fare il lavoro.
  const LEGITTIMI = [
    "Il contributo e' plafonato (max 15.000 CHF/anno) per il frontaliere.",
    "L'orario e' limitato (max 9 ore/giorno) dal contratto collettivo.",
    'Il modulo occupa una facciata (max 1 page).',
    'La franchigia annua (max 2500 CHF) resta invariata nel 2026.',
    'Il permesso G dura un anno (12 mesi) e si rinnova automaticamente.',
    'Lo sportello riceve su appuntamento (dalle 9 alle 17).',
    'La domanda va inviata entro 30 giorni (termine perentorio).',
  ];

  it.each(CANONICHE)('rileva la forma canonica: %s', (s) => {
    expect(isBudget(s)).toBe(true);
  });

  it.each(DRIFT)('rileva il drift del modello: %s', (s) => {
    expect(isBudget(s)).toBe(true);
  });

  it.each(LEGITTIMI)('NON scatta su prosa legittima: %s', (s) => {
    expect(isBudget(s)).toBe(false);
  });

  it('la forma vecchia mancava 10 delle 14 varianti — il regresso e\' fissato qui', () => {
    // La regex esatta che questa PR sostituisce. Se qualcuno la reintroduce,
    // questo test dice quanto costa: il conteggio, non un'opinione.
    const VECCHIA =
      /\(\s*(?:max|max\.|massimo|maximum|maximal|máximo)\s+\d{2,4}\s*(?:chars?|characters?|caratteri|carattere|caractères|caracteres|Zeichen)\s*\)/i;
    const tutte = [...CANONICHE, ...DRIFT];
    expect(tutte.filter((s) => VECCHIA.test(s))).toHaveLength(4);
    expect(tutte.filter((s) => isBudget(s))).toHaveLength(14);
  });

  it('un inciso lungo resta prosa editoriale, non un budget incollato', () => {
    // Il tetto sullo span e' cio' che tiene la regola un INCISO. Una frase
    // intera fra parentesi che parla di caratteri e' scrittura umana.
    expect(
      isBudget(
        'Il riassunto (che secondo le linee guida redazionali non dovrebbe mai superare i 160 caratteri complessivi) resta breve.',
      ),
    ).toBe(false);
  });

  it('il controllo strutturale non e\' invisibile a nessun consumatore', () => {
    // Una regola con `match` invece di `rx` deve passare da `matchRule` in TUTTI
    // i consumatori: uno solo che legga `rule.rx` direttamente la salterebbe in
    // silenzio, ed e' esattamente la forma «guardia che non guarda».
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../scripts/lib/prompt-placeholder-guard.mjs'),
      'utf8',
    );
    // L'unica lettura diretta ammessa e' il fallback DENTRO `matchRule`: e' il
    // punto in cui una regola a sola `rx` viene applicata. Qualunque altra e' un
    // consumatore che salterebbe le regole strutturali.
    const letture = src.match(/\b(?:rule|r)\.rx\b/g) || [];
    expect(letture, 'una regola strutturale sarebbe invisibile a un consumatore').toHaveLength(1);
    const matchRuleSrc = src.slice(src.indexOf('export function matchRule'));
    expect(matchRuleSrc.slice(0, 300)).toContain('rule.rx.exec');
    const budget = PLACEHOLDER_RULES.find((r) => r.id === 'budget-parenthetical');
    expect(typeof budget?.match, 'la regola non e\' piu\' strutturale').toBe('function');
  });
});

/**
 * ITEM 1 — il falso positivo FAQ temuto dal reviewer NON produce un `throw`.
 *
 * La preoccupazione era: «stripFaqNumberedLabels potrebbe troncare una domanda
 * reale che comincia per coincidenza come lo schema, bloccando la pubblicazione
 * di un articolo genuino». La prima meta' e' vera, la seconda no, e la
 * differenza e' strutturale: la regola e' `kind: 'schema-label'`, cioe'
 * RIPARABILE — `sanitizePromptPlaceholders` prende il ramo `label-stripped` e
 * prosegue. Il `throw` appartiene a `schema-echo`/`scaffold`, che una domanda
 * vera non puo' produrre (il valore dovrebbe essere l'etichetta e basta).
 *
 * Quindi il costo massimo del falso positivo e' cosmetico: un prefisso tolto da
 * una frase che senza sta meglio. Nessun articolo genuino viene bloccato.
 */
describe('#5847 item 1 — il falso positivo FAQ ripara, non blocca', () => {
  const articolo = (q: string, a: string) => ({
    id: 'test-articolo',
    content: {
      it: {
        title: 'Titolo vero',
        excerpt: 'Un excerpt reale con dati concreti sul frontalierato ticinese.',
        faq: [
          { q, a },
          { q: 'Quali documenti servono per il permesso G?', a: 'Servono il contratto di lavoro firmato e un documento di identita valido.' },
          { q: 'Quanto dura la procedura in Ticino?', a: 'La procedura richiede in media tra le due e le quattro settimane lavorative.' },
        ],
      },
    },
  });

  it('una domanda VERA col prefisso dello schema viene ripulita e SOPRAVVIVE', () => {
    const data = articolo(
      'Domanda frequente 1: quali sono i portali di annunci di lavoro in Ticino?',
      'I portali principali sono quelli cantonali e i grandi aggregatori svizzeri, aggiornati ogni giorno.',
    );
    expect(() => sanitizePromptPlaceholders(data)).not.toThrow();
    const faq = data.content.it.faq!;
    expect(faq, 'la coppia genuina e stata scartata invece che riparata').toHaveLength(3);
    expect(faq[0].q).toBe('Quali sono i portali di annunci di lavoro in Ticino?');
    expect(faq[0].a).toContain('portali principali');
  });

  it('lo schema PURO invece viene scartato: e la differenza che conta', () => {
    const data = articolo(
      'Domanda frequente 1 basata sui fatti dell articolo?',
      'Risposta con dati DALLA FONTE. 50-100 parole.',
    );
    expect(() => sanitizePromptPlaceholders(data)).not.toThrow();
    expect(data.content.it.faq, 'lo schema puro e sopravvissuto').toHaveLength(2);
  });

  it('la regola FAQ numerata e riparabile per costruzione (schema-label, non schema-echo)', () => {
    const r = PLACEHOLDER_RULES.find((x) => x.id === 'faq-numbered-label');
    expect(r?.kind, 'se diventasse schema-echo, un falso positivo bloccherebbe davvero').toBe(
      'schema-label',
    );
  });
});

/**
 * ITEM 3 — nessun call-site di `clampSeoDescriptions` sfugge al guard.
 *
 * Misurato: la funzione e' dichiarata a `scripts/create-article.mjs:10998`, NON
 * e' esportata, e ha **un solo** call-site (`:11028`), immediatamente dopo
 * `sanitizePromptPlaceholders(data)` (`:11027`). Non esiste percorso di bypass.
 *
 * Il test esistente fissava l'ORDINE al call-site noto — che non si accorgerebbe
 * di un SECONDO call-site che comparisse altrove, ne' di un `export` che aprisse
 * la funzione a un altro file. Sono quelle due mutazioni a essere fissate qui.
 */
describe('#5847 item 3 — clampSeoDescriptions non ha percorsi di bypass', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/create-article.mjs'),
    'utf8',
  );

  it('resta module-private: non e esportata', () => {
    expect(SRC).not.toMatch(/export\s+(?:async\s+)?function\s+clampSeoDescriptions/);
    expect(SRC).not.toMatch(/export\s*\{[^}]*\bclampSeoDescriptions\b/);
  });

  it('ha esattamente UN call-site, e il guard lo precede', () => {
    // `(?<!function\s)` toglie la DICHIARAZIONE dal conteggio: senza, la riga
    // `function clampSeoDescriptions(data) {` verrebbe contata come chiamata.
    const CALL_RE = /(?<!function\s)\bclampSeoDescriptions\(/g;
    const chiamate = SRC.match(CALL_RE) || [];
    expect(chiamate, 'un secondo call-site bypasserebbe il guard').toHaveLength(1);
    const iClamp = SRC.search(/(?<!function\s)\bclampSeoDescriptions\(/);
    const iGuard = SRC.lastIndexOf('sanitizePromptPlaceholders(data)', iClamp);
    expect(iGuard, 'nessun sanitize prima del clamp').toBeGreaterThan(-1);
    // Adiacenti: il guard e il clamp sono due righe consecutive dello stesso blocco.
    expect(iClamp - iGuard, 'il guard non e piu adiacente al clamp').toBeLessThan(400);
  });

  it('nessun ALTRO file del repo la nomina (non c\'e superficie condivisa)', () => {
    const dir = path.resolve(__dirname, '../../scripts');
    const trovati: string[] = [];
    const scan = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
        if (!/\.(mjs|js|ts)$/.test(e.name)) continue;
        if (p.endsWith('create-article.mjs')) continue;
        if (fs.readFileSync(p, 'utf8').includes('clampSeoDescriptions')) trovati.push(p);
      }
    };
    scan(dir);
    expect(trovati, `clampSeoDescriptions nominata fuori da create-article.mjs: ${trovati.join(', ')}`).toHaveLength(0);
  });
});
