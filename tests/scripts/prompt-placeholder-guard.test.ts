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
