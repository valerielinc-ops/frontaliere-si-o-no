/**
 * prompt-placeholder-guard.mjs — GEMELLO SITO del guard sui SEGNAPOSTO DEL
 * PROMPT che vive nel corpus, aggiunto la' dalla PR #196
 * (`frontaliere-articles/generator/scripts/lib/prompt-placeholder-guard.mjs`).
 *
 * ## Perche' serve ANCHE qui, e non solo nel corpus
 *
 * `scripts/create-article.mjs` di QUESTO repo e' un gemello vivo del file
 * omonimo del corpus — nessun mirror copia `generator/`, e
 * `scripts/publish-journalist-article.mjs` importa `registerArticleFiles` da
 * QUESTO file e gira ogni 15 minuti. Un guard messo solo nel corpus non
 * protegge questo percorso di pubblicazione. Misurato: dopo la PR #196 del
 * corpus sono stati trovati **2 articoli pubblicati da questo lato** con
 * segnaposto letterali del prompt (`DALLA FONTE`, `Max 125 caratteri`) che il
 * guard del corpus non poteva vedere, perche' non erano mai passati di la'.
 * Vedi corpus issue #195 e #208 (item 1).
 *
 * ## Il difetto che chiude (stesso del corpus, stessa forma)
 *
 * Il prompt di `create-article.mjs` mostra al modello uno schema JSON con
 * valori di esempio LETTERALI. Un modello che esaurisce l'attenzione li
 * ricopia invece di compilarli, e nessuno se ne accorge perche' un segnaposto
 * e' un valore **ben formato**: e' una stringa, ha la lunghezza giusta, e ogni
 * controllo che guarda la FORMA lo lascia passare.
 *
 * ## Perche' la FAQ e' il caso grave, e non `imageAlt`
 *
 * Una FAQ segnaposto non resta nel corpo: `engine/ogPagesPlugin.ts` la legge,
 * ne fa lo **schema FAQPage** e la stampa anche come accordion visibile. Un
 * articolo con una FAQ segnaposto pubblica quindi verso i motori di ricerca
 * dati strutturati la cui domanda e' «Domanda frequente 1». Non e' un campo
 * brutto: e' structured data falso.
 *
 * Il filtro di FORMA che questo file sostituisce (`pair.q.length > 10 &&
 * pair.a.length > 20`) stampava «✅ FAQ: 3 coppie valide» esattamente mentre
 * le tre coppie ERANO lo schema — la domanda segnaposto e' lunga 50 caratteri
 * e la risposta 44, quindi passa qualunque controllo che conti solo lunghezza.
 *
 * ## Perche' UN guard e non tre
 *
 * Tre fix isolati chiuderebbero tre campi e lascerebbero la classe aperta —
 * e' esattamente cosi' che e' andata sul corpus: la PR #121 lo slug,
 * `it-microcopy-guard.mjs` lo stile di titolo/excerpt, il filtro di FORMA
 * sopra la FAQ. Ogni volta il segnaposto e' semplicemente ricomparso nel campo
 * successivo. Qui il criterio e' uno solo e vale per ogni campo di testo
 * pubblicato — corpo, FAQ, excerpt, imageAlt, title, seo.
 *
 * ## Il criterio e' DERIVATO dal template di QUESTO file, non copiato a mano
 *
 * `SCHEMA_PLACEHOLDER_LITERALS` e' la copia dei valori letterali dello schema
 * JSON del prompt DI QUESTO SCRIPT (`scripts/create-article.mjs`, blocco
 * «Genera JSON»), non del corpus: i due prompt sono quasi identici ma NON
 * uguali — `seo.ogDescription` diverge (vedi sotto) — quindi i letterali sono
 * stati ripresi da qui, campo per campo, non incollati dal corpus. I matcher
 * si costruiscono da quella lista con `leadOf()`, meccanicamente.
 *
 * `tests/scripts/prompt-placeholder-guard.test.ts` ri-estrae il blocco
 * «Genera JSON» da `scripts/create-article.mjs` e pretende l'uguaglianza con
 * questa lista: se il template acquisisce un segnaposto nuovo, il test
 * diventa rosso, non un articolo in produzione fra tre giorni.
 *
 * ## Le tre forme che un letterale non basta a coprire
 *
 * E' la lezione gia' scritta al guard degli slug (`findSlugPromptLeak` /
 * `assertNoSlugPromptLeak` in `scripts/lib/slug-prompt-leak-guard.mjs`): «il
 * segnaposto non sopravvive come letterale». Il prompt e' scritto in
 * italiano, quindi il modello ne traduce il SIGNIFICATO e restituisce un
 * token che non era nel suo input. Tre regole di FORMA coprono cio' che
 * nessuna lista di stringhe puo' vedere:
 *
 *   · `budget-as-value`   — `Max 125 caratteri`. Nel template c'e'
 *     `max 125 chars`: la variante italiana e' un'invenzione del modello.
 *   · `faq-numbered-label` — `Domanda frequente 4:`. Lo schema si ferma a 3.
 *   · `prompt-scaffold`    — `HEADLINE:`, `RECENT ARTICLE IDS`. Non sono nello
 *     schema JSON: sono le etichette del PREAMBOLO, che il modello rispedisce
 *     indietro insieme alla pagina di origine.
 *
 * `(max ` NON e' un marcatore, ed e' l'esclusione piu' importante del file:
 * compare in campi body legittimi («max 15.000 CHF/anno», «max 9 ore/giorno»,
 * «max 1 page»). Un guard che lo includesse rigetterebbe articoli buoni — peggio
 * del difetto che ripara. Cio' che identifica il segnaposto non e' `(max `:
 * e' il budget di caratteri USATO COME VALORE INTERO del campo (`budget-as-value`),
 * o incollato come inciso parentetico (`budget-parenthetical`, la forma che
 * sopravvive alla traduzione — vedi il commento sulla regola sotto).
 *
 * Restano fuori per la stessa ragione del corpus, con lo stesso segnale nullo:
 *   · `RELATED:` — il prompt la emette, ma e' un'etichetta editoriale corrente
 *     su una pagina inglese scrapata: il segnale non distingue il leak dalla
 *     fonte.
 *   · `id` e `slugs` — non sono campi di testo e hanno gia' il loro
 *     classificatore, `findSlugPromptLeak()` / `assertNoSlugPromptLeak()` in
 *     `scripts/lib/slug-prompt-leak-guard.mjs`, che copre anche le varianti
 *     tradotte. Ogni letterale dello schema dev'essere visto da QUESTO guard
 *     **oppure** da quello — mai da nessuno dei due.
 *
 * @see tests/scripts/prompt-placeholder-guard.test.ts
 * @see scripts/lib/slug-prompt-leak-guard.mjs — il guard gemello per id/slug
 * @see frontaliere-articles#195, frontaliere-articles#208 (item 1) — le issue del corpus
 *      che misurano il buco su QUESTO percorso
 */

// ─────────────────────────────────────────────────────────────────────────────
// I letterali dello schema JSON del prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I valori di esempio che il prompt mostra al modello, verbatim.
 *
 * Copiati dal blocco «Genera JSON (no markdown, no code fences)» di
 * `scripts/create-article.mjs` DI QUESTO REPO. Il test ri-estrae quel blocco
 * e pretende che i due insiemi coincidano: questa lista non puo' restare
 * indietro rispetto al template senza che la CI se ne accorga.
 *
 * DIVERGENZA nota dal corpus: `seo.ogDescription` qui e' "OG desc (≤ 160
 * caratteri)", non la versione lunga del corpus ("OG desc per la card
 * social — 200-250 caratteri, ..."). I due prompt sono quasi identici ma non
 * uguali; questo letterale segue QUESTO template, non quello del corpus.
 *
 * `id` e `slugs` sono inclusi per completezza del lock (il test verifica che
 * qualcuno li copra) ma non producono matcher qui — vedi l'intestazione.
 */
export const SCHEMA_PLACEHOLDER_LITERALS = Object.freeze([
  'kebab-case-3-5-words-max-40-chars',
  'max 125 chars',
  'slug-it',
  'slug-en',
  'slug-de',
  'slug-fr',
  "Titolo giornalistico con keyword (OBBLIGATORIO ≤ 60 caratteri totali, target 50-55. Il suffisso ' | Frontaliere Ticino' viene aggiunto automaticamente — NON includerlo nel title)",
  'Sottotitolo con dati concreti DALLA FONTE (max 160 chars)',
  "Inizia con '## In breve' (3-4 bullet TL;DR ≤80 char) + '## Fatti chiave' (5-8 coppie **Cosa/Quando/Dove/Chi/Importo**: valore). Poi il LEAD: FATTI dalla fonte (chi, cosa, dove, quando, perché). Solo cronaca verificabile. 300-400 parole (escluse TL;DR/Fatti chiave). Min 1 ### sotto-sezione.",
  'Analisi pratica: implicazioni, confronti, scenari. Contenuto DIVERSO da body1. 300-400 parole. Min 1 ### sotto-sezione.',
  'Azione: procedura step-by-step, scadenze, strumenti + CTA finale. NON riassumere body1/body2. 300-400 parole.',
  "Domanda frequente 1 basata sui fatti dell'articolo?",
  'Risposta con dati DALLA FONTE. 50-100 parole.',
  'Domanda frequente 2?',
  'Risposta pratica basata sulla fonte.',
  'Domanda frequente 3?',
  'Risposta con procedura o scadenza dalla fonte.',
  "SEO Title senza brand suffix (OBBLIGATORIO ≤ 60 caratteri TOTALI; il suffisso ' | Frontaliere Ticino' viene aggiunto automaticamente — NON includerlo)",
  'Meta description 150-160 chars (HARD CAP: ≤ 160 caratteri)',
  '6-8 keywords IT',
  'OG title (OBBLIGATORIO ≤ 60 caratteri)',
  'OG desc (≤ 160 caratteri)',
  'Headline JSON-LD',
  'Breadcrumb 2-3 parole',
]);

/**
 * I letterali che NON producono un matcher testuale qui: non sono campi di
 * testo, e `findSlugPromptLeak()` / `assertNoSlugPromptLeak()` in
 * `scripts/lib/slug-prompt-leak-guard.mjs` li classificano gia' — compresa la
 * famiglia tradotta (`slug-inglese`) che una lista di stringhe non puo'
 * vedere. Duplicarli qui creerebbe due verita' sullo stesso campo.
 */
export const SLUG_OWNED_LITERALS = Object.freeze([
  'kebab-case-3-5-words-max-40-chars',
  'slug-it',
  'slug-en',
  'slug-de',
  'slug-fr',
]);

/**
 * Le etichette del PREAMBOLO del prompt — non dello schema JSON. Il modello le
 * rispedisce indietro insieme alla pagina scrapata quando confonde l'input con
 * l'output. Il test verifica che ognuna sia ancora costruita da
 * `scripts/create-article.mjs`, cosi' una rinomina del preambolo non lascia la
 * regola a puntare nel vuoto.
 *
 * `RELATED:` e' esclusa di proposito: vedi l'intestazione.
 */
export const PROMPT_SCAFFOLD_LABELS = Object.freeze([
  'HEADLINE:',
  'SOURCE URL:',
  'SOURCE CONTENT:',
  'RECENT ARTICLE IDS',
  'EXISTING ARTICLE IDS',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Derivazione dei matcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La testa DISTINTIVA di un letterale dello schema: la parte che identifica il
 * segnaposto senza portarsi dietro la coda di istruzioni, che il modello
 * riscrive volentieri (`(max 160 chars)` → `(max 160 char)`).
 *
 * Taglia, in ordine: al primo inciso fra parentesi, alla prima frase, a 60
 * caratteri su confine di parola. Deterministica.
 */
export function leadOf(literal) {
  let s = String(literal || '').trim();
  const paren = s.indexOf(' (');
  if (paren > 12) s = s.slice(0, paren);
  const sentence = /^(.*?[.?!])(?:\s|$)/.exec(s);
  if (sentence) s = sentence[1];
  s = s.replace(/[.?!]+$/, '').trim();
  if (s.length > 60) {
    const cut = s.lastIndexOf(' ', 60);
    if (cut > 20) s = s.slice(0, cut).trim();
  }
  return s;
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** I letterali che diventano matcher (tutti tranne quelli di competenza dello slug guard). */
const TEXT_LITERALS = SCHEMA_PLACEHOLDER_LITERALS.filter((l) => !SLUG_OWNED_LITERALS.includes(l));

/**
 * ── LE REGOLE ─────────────────────────────────────────────────────────────
 *
 * `kind` decide cosa se ne fa il chiamante, non solo se segnalare:
 *
 *   · `schema-echo`   — il campo ricopia una descrizione dello schema. Non c'e'
 *                       contenuto da salvare.
 *   · `schema-label`  — l'etichetta dello schema e' incollata davanti a
 *                       contenuto VERO («Domanda frequente 1: Quali sono i
 *                       portali di annunci di lavoro?»). Togliere l'etichetta
 *                       lascia un campo corretto: e' riparabile.
 *   · `budget`        — il valore E' un budget di caratteri.
 *   · `scaffold`      — il campo contiene il preambolo del prompt. Il testo che
 *                       segue e' input, non articolo.
 */
/**
 * L'unita' di misura del budget, nelle lingue in cui il traduttore la puo'
 * riscrivere. E' questo token a portare il segnale: senza, `160` e' un numero
 * qualunque e il campo e' legittimo.
 */
export const CHAR_UNIT_RE =
  /(?:chars?|characters?|caratteri|carattere|caractères|caracteres|Zeichen|signes?|tekens?)\b/i;

/** Uno span parentetico abbastanza corto da essere un inciso, non una frase. */
const PARENTHETICAL_RE = /\(([^()]{1,60})\)/g;

/**
 * L'invariante: un numero di 2-4 cifre ADIACENTE a un'unita' di caratteri, nei
 * due ordini possibili. «adiacente» = al massimo 12 caratteri non-cifra in
 * mezzo, che copre `160 caratteri`, `160 char`, `160 Zeichen`, `160 di
 * caratteri` senza arrivare a legare un numero e un'unita' che stanno in due
 * proposizioni diverse.
 */
const BUDGET_NUM_UNIT_RE = new RegExp(
  `(?:\\d{2,4}\\s*[^()\\d]{0,12}?${CHAR_UNIT_RE.source})` +
    `|(?:${CHAR_UNIT_RE.source}[^()\\d]{0,12}?\\s*\\d{2,4})`,
  'i',
);

/**
 * Controllo STRUTTURALE del budget parentetico (#5847 item 2): isola ogni
 * inciso fra parentesi e valuta l'invariante sul suo CONTENUTO, invece di
 * codificare la forma intera — terminatore compreso — in un solo pattern.
 *
 * Tollera per costruzione il drift del modello dentro le parentesi (parole in
 * piu', qualificatori, punteggiatura, ordine diverso) e resta insensibile al
 * verbo, che non e' mai stato il segnale. Vedi la nota estesa sulla regola
 * `budget-parenthetical`.
 *
 * @param {string} value
 * @returns {{ found: string, index: number }|null}
 */
export function matchBudgetParenthetical(value) {
  const s = typeof value === 'string' ? value : '';
  if (!s) return null;
  const rx = new RegExp(PARENTHETICAL_RE.source, 'g'); // istanza fresca: `lastIndex` non condiviso
  let m;
  while ((m = rx.exec(s)) !== null) {
    if (BUDGET_NUM_UNIT_RE.test(m[1])) return { found: m[0], index: m.index };
  }
  return null;
}

/**
 * Applica una regola a un valore, qualunque sia la sua FORMA.
 *
 * Una regola porta `rx` (pattern) **oppure** `match` (controllo strutturale).
 * Tutti i consumatori passano di qui, cosi' una regola strutturale non e'
 * invisibile a uno di loro — che e' il modo in cui un guard smette di guardare
 * senza che nessun test diventi rosso.
 *
 * @returns {{ found: string, index: number }|null}
 */
export function matchRule(rule, value) {
  if (typeof rule.match === 'function') return rule.match(value);
  const m = rule.rx.exec(value);
  return m ? { found: m[0], index: m.index } : null;
}

export const PLACEHOLDER_RULES = Object.freeze([
  // ── Forme che nessun letterale copre ────────────────────────────────────
  {
    id: 'budget-as-value',
    kind: 'budget',
    // Ancorata: e' il valore INTERO a dover essere il budget. Senza le ancore
    // questa regola diventerebbe `(max ` e rigetterebbe body legittimi
    // («max 15.000 CHF/anno», «max 9 ore/giorno»).
    rx: /^\s*\(?\s*(?:max|max\.|massimo|maximum|maximal)\s+\d{2,4}\s*(?:chars?|characters?|caratteri|carattere|caractères|caracteres|Zeichen)\s*\)?[.]?\s*$/i,
    why: "Il campo E' l'istruzione di lunghezza dello schema (`max 125 chars`), o la sua traduzione italiana `Max 125 caratteri`, che nel prompt non compare.",
  },
  {
    id: 'budget-parenthetical',
    kind: 'schema-echo',
    // ── LA REGOLA CHE SOPRAVVIVE ALLA TRADUZIONE ─────────────────────────
    //
    // Un segnaposto non resta in italiano. `translateArticle()` lo tratta come
    // contenuto e lo traduce, quindi lo stesso segnaposto dell'excerpt puo'
    // uscire in produzione in quattro lingue:
    //
    //   it  Sottotitolo con dati concreti DALLA FONTE (max 160 char)
    //   en  Subtitle with concrete data FROM THE SOURCE (max 160 char)
    //   de  Untertitel mit konkreten Angaben AUS DER QUELLE (max 160 char)
    //   fr  Sous-titre avec des données concrètes DE LA SOURCE (max 160 char)
    //
    // Nessun matcher costruito sul letterale italiano vede le altre tre. Cio'
    // che il traduttore NON tocca — perche' non e' prosa — e' l'inciso col
    // budget di caratteri: e' quello l'invariante, ed e' questa la regola.
    //
    // FALSO POSITIVO: e' l'unita' di misura a fare il lavoro. `(max ` da solo
    // compare in campi body legittimi («max 15.000 CHF/anno», «max 9
    // ore/giorno», «max 1 page»), e nessuno di quei campi nomina caratteri.
    //
    // ── PERCHE' NON E' PIU' UNA REGEX SOLA (#5847 item 2) ────────────────
    //
    // La forma precedente era:
    //
    //   /\(\s*(?:max|massimo|…)\s+\d{2,4}\s*(?:chars?|caratteri|…)\s*\)/i
    //
    // e pretendeva la parentesi di chiusura SUBITO dopo l'unita'. E' una
    // FINESTRA FRAGILE: codifica in un solo pattern sia l'invariante sia il
    // suo terminatore, quindi qualunque parola in piu' dentro le parentesi la
    // faceva mancare — «(max. 160 caratteri circa)», «(max 160 characters,
    // no more)», «(ca. 160 Zeichen)». Cioe' un FALSO NEGATIVO: il segnaposto
    // veniva pubblicato, che e' esattamente il difetto che questa regola
    // esiste per fermare.
    //
    // Allargare la regex avrebbe solo spostato il bordo: la prossima parafrasi
    // del modello sarebbe caduta appena fuori dal nuovo bordo. La matrice che
    // conta e' questa:
    //
    //   mutazione                       | finestra fragile | controllo strutturale
    //   invariante rotta                | rosso            | rosso
    //   testo innocuo aggiunto dentro   | ROSSO (falso     | verde
    //   le parentesi                    |  negativo)       |
    //
    // Quindi il controllo ora ESEGUE LA PROVA invece di evitarla: isola lo
    // span parentetico e valuta l'invariante SUL SUO CONTENUTO. L'invariante
    // e' quella che il commento sopra gia' dichiarava — **un numero adiacente
    // a un'unita' di caratteri** — e tutto il resto dentro le parentesi e'
    // libero. Il verbo (`max`/`massimo`/`ca.`/niente) smette di essere
    // vincolante, perche' non e' mai stato lui a portare il segnale.
    //
    // Il tetto di 60 caratteri sullo span e' cio' che lo tiene un INCISO: una
    // frase intera fra parentesi che parla di caratteri e' prosa editoriale,
    // non un budget incollato dallo schema.
    match: matchBudgetParenthetical,
    why: "Inciso col budget di caratteri dello schema (`(max 160 chars)`): sopravvive alla traduzione del segnaposto in en/de/fr, dove nessun letterale italiano arriva.",
  },
  {
    id: 'faq-numbered-label',
    kind: 'schema-label',
    rx: /(?:^|[\s*#>\-–—.)\]])\**\s*domanda\s+frequente\s+\d+\**\s*[:.?\-–—]/i,
    why: "L'etichetta numerata dello schema FAQ, usata come intestazione o come domanda. Lo schema si ferma a 3: la regola conta qualunque cifra.",
  },
  {
    id: 'faq-numbered-bare',
    kind: 'schema-echo',
    rx: /^\s*\**\s*domanda\s+frequente\s+\d+\s*\**\s*\??\s*$/i,
    why: 'La domanda E\' l\'etichetta e basta ("Domanda frequente 1"), senza nulla dietro.',
  },
  ...PROMPT_SCAFFOLD_LABELS.map((label) => ({
    id: `scaffold-${label.replace(/[^A-Za-z]+/g, '-').toLowerCase().replace(/^-|-$/g, '')}`,
    kind: 'scaffold',
    rx: new RegExp(`(?:^|[\\s\\n])${escapeRx(label)}`),
    why: `Etichetta del preambolo del prompt ("${label}"): il modello ha rispedito il proprio input.`,
  })),
  // ── Forme derivate dai letterali dello schema ───────────────────────────
  ...TEXT_LITERALS.map((literal) => ({
    id: `schema-lead-${leadOf(literal).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '')}`,
    kind: 'schema-echo',
    rx: new RegExp(escapeRx(leadOf(literal)), 'i'),
    why: `Testa del valore di esempio dello schema: ${JSON.stringify(leadOf(literal))}.`,
    literal,
  })),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Rilevamento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ogni segnaposto trovato in un valore di testo.
 *
 * @param {unknown} value
 * @returns {Array<{ rule: string, kind: string, found: string, index: number }>}
 */
export function findPromptPlaceholders(value) {
  if (typeof value !== 'string' || !value) return [];
  const hits = [];
  for (const rule of PLACEHOLDER_RULES) {
    const m = matchRule(rule, value);
    if (!m) continue;
    hits.push({ rule: rule.id, kind: rule.kind, found: m.found.trim(), index: m.index });
  }
  return hits;
}

/** @returns {boolean} true se il valore porta almeno un segnaposto. */
export function hasPromptPlaceholder(value) {
  return findPromptPlaceholders(value).length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Riparazioni deterministiche
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toglie l'etichetta `Domanda frequente N:` lasciando il contenuto vero.
 *
 *   "1. **Domanda frequente 1**: Quali sono i servizi inclusi?"
 *     → "1. Quali sono i servizi inclusi?"
 *
 * Non tocca nulla quando dietro l'etichetta non resta niente: quel caso e'
 * `faq-numbered-bare`, e va scartato, non ripulito.
 */
export function stripFaqNumberedLabels(value) {
  if (typeof value !== 'string' || !value) return { value, stripped: 0 };
  let stripped = 0;
  // `pre` si porta dentro la spaziatura: senza, «- Domanda frequente 1: X»
  // tornerebbe «-X», perche' lo spazio del bullet viene mangiato dall'etichetta.
  const out = value.replace(
    /((?:^|[\s\n*#>\-–—.)\]])\s*)\**\s*[Dd]omanda\s+frequente\s+\d+\**\s*[:.\-–—]\s*(?=\S)/g,
    (match, pre, offset, whole) => {
      // Solo se dopo l'etichetta resta contenuto vero sulla stessa riga.
      const rest = whole.slice(offset + match.length);
      const line = rest.split('\n', 1)[0].trim();
      if (line.length < 8) return match;
      stripped += 1;
      return pre;
    },
  );
  return { value: out, stripped };
}

/**
 * Dopo `stripFaqNumberedLabels` una domanda puo' restare con l'iniziale
 * minuscola («che cosa significa la domanda scomoda?»), perche' la maiuscola
 * stava sull'etichetta. Rimetterla e' deterministico e vale solo qui: e' una
 * domanda che finisce in `FAQPage.name`.
 */
function capitalizeFirstLetter(text) {
  const s = String(text || '');
  const i = s.search(/\p{L}/u);
  if (i < 0) return s;
  const ch = s[i];
  if (ch !== ch.toLowerCase()) return s;
  return s.slice(0, i) + ch.toUpperCase() + s.slice(i + 1);
}

/**
 * Toglie una riga di intestazione che ripete la DESCRIZIONE del campo dallo
 * schema (`## Analisi pratica: implicazioni, confronti, scenari`), quando e'
 * la prima riga e il corpo sotto e' reale.
 */
export function stripSchemaHeadingLine(value) {
  if (typeof value !== 'string' || !value) return { value, stripped: 0 };
  const lines = value.split('\n');
  let stripped = 0;
  while (lines.length > 2) {
    const first = lines[0].trim();
    if (!/^#{1,6}\s/.test(first)) break;
    const heading = first.replace(/^#{1,6}\s*/, '').trim();
    const echo = PLACEHOLDER_RULES.some(
      (r) => r.kind === 'schema-echo' && matchRule(r, heading) !== null,
    );
    if (!echo) break;
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
    stripped += 1;
  }
  return { value: stripped ? lines.join('\n') : value, stripped };
}

/**
 * Taglia il campo al primo marcatore di preambolo del prompt.
 *
 * ATTENZIONE — questa riparazione e' pensata per una bonifica del gia'
 * pubblicato e NON per il percorso di scrittura. Su un articolo gia'
 * pubblicato togliere il preambolo e' meglio che lasciarlo; su un articolo in
 * generazione lo stesso taglio NASCONDEREBBE una generazione fallita e la
 * pubblicherebbe lo stesso. Il percorso di scrittura per questo `kind` lancia
 * (vedi `sanitizePromptPlaceholders`).
 */
export function truncateAtPromptScaffold(value) {
  if (typeof value !== 'string' || !value) return { value, removed: 0 };
  let cut = -1;
  for (const rule of PLACEHOLDER_RULES) {
    if (rule.kind !== 'scaffold') continue;
    const m = matchRule(rule, value);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut < 0) return { value, removed: 0 };
  const kept = value.slice(0, cut).replace(/\s+$/, '');
  return { value: kept, removed: value.length - kept.length };
}

/**
 * Ripara ogni forma riparabile in un campo di testo, in ordine.
 * @returns {{ value: string, changed: boolean, residual: Array }}
 *   `residual` sono i segnaposto che restano DOPO la riparazione: se non e'
 *   vuoto, il campo non e' recuperabile in modo deterministico.
 */
export function repairTextField(value, { allowTruncate = false } = {}) {
  let out = typeof value === 'string' ? value : '';
  const before = out;
  out = stripFaqNumberedLabels(out).value;
  out = stripSchemaHeadingLine(out).value;
  if (allowTruncate) out = truncateAtPromptScaffold(out).value;
  return { value: out, changed: out !== before, residual: findPromptPlaceholders(out) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FAQ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ripulisce le coppie FAQ, con **tre esiti diversi per tre casi diversi**:
 *
 *   · «Domanda frequente 1: che cosa significa la domanda scomoda?» → l'etichetta
 *     si toglie e resta una domanda vera. RIPARATA.
 *   · «Domanda frequente 1 basata sui fatti dell'articolo?» + «Risposta con dati
 *     DALLA FONTE. 50-100 parole.» → schema puro. SCARTATA.
 *   · «Domanda frequente 1 basata sui fatti dell'articolo?» + una risposta VERA
 *     → SCARTATA lo stesso: una domanda non si inventa, e la coppia finirebbe
 *     in `FAQPage.name`.
 *
 * Sotto le 2 coppie superstiti il campo intero va tolto, non lasciato monco:
 * e' la stessa soglia che `engine/ogPagesPlugin.ts` applica prima di ricadere
 * sull'euristica (`if (faqPairsFromData!.length < 2) … = null`), quindi un
 * articolo senza `faq` torna semplicemente al comportamento pre-FAQ invece di
 * pubblicare uno schema mutilato.
 *
 * Una FAQ ASSENTE e' meglio di una FAQ FINTA: l'assente non produce
 * structured data, la finta sì.
 *
 * ## `dropShort`, e perche' non e' sempre acceso
 *
 * Le due soglie `q > 10` / `a > 20` sono quelle che il filtro di FORMA in
 * `scripts/create-article.mjs` applicava gia' al punto di accettazione:
 * restano accese LI', perche' toglierle allargherebbe cio' che passa.
 *
 * Sul percorso di scrittura vanno invece SPENTE (`dropShort: false`): coppie
 * tradotte corte che nessun segnaposto tocca sono un difetto di un'altra
 * classe, con un altro proprietario. Un guard sui segnaposto che ne
 * approfitta per cancellarle sta facendo un secondo lavoro che nessuno ha
 * misurato — esattamente il modo in cui una bonifica diventa una regressione.
 *
 * ## `minPairs`, e perche' non e' sempre 2
 *
 * La soglia delle 2 coppie e' quella di `ogPagesPlugin.ts` sul campo PUBBLICATO,
 * e resta il default: chi scrive un `faq` finito lo vuole sopra la soglia
 * dell'engine o non lo vuole affatto.
 *
 * `scripts/batch-add-faq-to-articles.mjs` pero' non chiama questa funzione sul
 * campo finito: la chiama su un risultato INTERMEDIO che il suo `MIN_FAQ_PAIRS`
 * (3) valuta dopo, e il suo percorso di top-up e' armato **esattamente** dal
 * caso 1-2 coppie (`validFaq.length > 0 && validFaq.length < MIN_FAQ_PAIRS` →
 * seconda chiamata LLM che le completa). Collassare a `null` sotto le 2 li'
 * spegnerebbe il top-up per il caso di UNA coppia, che e' proprio quello che
 * esiste per essere recuperato — una regressione silenziosa introdotta da un
 * guard sui segnaposto, cioe' la stessa forma di errore che `dropShort`
 * descrive qui sopra. Da li' si passa `minPairs: 1`, e la soglia vera resta
 * dove gia' era, nel chiamante.
 *
 * @returns {{ pairs: Array<{q:string,a:string}>|null, repaired: number, dropped: Array }}
 */
export function cleanFaqPairs(pairs, { dropShort = true, minPairs = 2 } = {}) {
  if (!Array.isArray(pairs)) return { pairs: null, repaired: 0, dropped: [] };
  const kept = [];
  const dropped = [];
  let repaired = 0;
  for (const pair of pairs) {
    if (!pair || typeof pair.q !== 'string' || typeof pair.a !== 'string') {
      if (dropShort) {
        dropped.push({ pair, reason: 'shape', placeholder: false });
        continue;
      }
      kept.push(pair);
      continue;
    }
    const q = stripFaqNumberedLabels(pair.q);
    const a = stripFaqNumberedLabels(pair.a);
    const nextQ = q.stripped ? capitalizeFirstLetter(q.value.trim()) : q.value.trim();
    const nextA = a.stripped ? capitalizeFirstLetter(a.value.trim()) : a.value.trim();
    const bad = [...findPromptPlaceholders(nextQ), ...findPromptPlaceholders(nextA)];
    if (bad.length) {
      dropped.push({ pair, reason: bad.map((b) => b.rule).join(','), placeholder: true });
      continue;
    }
    if (dropShort && (nextQ.length < 10 || nextA.length < 20)) {
      dropped.push({ pair, reason: 'too-short', placeholder: false });
      continue;
    }
    if (q.stripped || a.stripped) repaired += 1;
    kept.push({ ...pair, q: nextQ, a: nextA });
  }
  return { pairs: kept.length >= minPairs ? kept : null, repaired, dropped };
}

/**
 * Le locali la cui `faq` e' rimasta ORFANA: `it` non ce l'ha, loro si'.
 *
 * Segue la stessa lezione degli slug: «il segnaposto non sopravvive come
 * letterale: il prompt e' scritto in italiano, quindi il modello ne traduce
 * il SIGNIFICATO». Una bonifica che rimuove una FAQ segnaposto dal file `it`
 * (dove i letterali italiani matchano) senza toccare en/de/fr (dove lo stesso
 * segnaposto e' gia' passato dal traduttore, in una forma che nessun letterale
 * italiano vede) lascia tre chiavi orfane — e sul sito quelle chiavi sono
 * l'unico modo in cui `tests/i18n-completeness.test.ts` ("consistent keys
 * across all locales") puo' diventare rosso per questa causa.
 *
 * ## Perche' la regola e' sull'ORFANO e non sul testo tradotto
 *
 * Inseguire il testo tradotto vorrebbe dire mantenere i letterali dello schema
 * in quattro lingue, e sarebbe una lista che il modello puo' sempre riscrivere.
 * La relazione strutturale invece non dipende dalla lingua: **la FAQ di
 * en/de/fr e' una TRADUZIONE di quella di `it`** (`translateArticle()` in
 * `scripts/create-article.mjs`), quindi una traduzione senza originale non e'
 * un dato incompleto, e' un dato che non ha piu' una fonte. Vale per
 * qualunque causa abbia tolto l'originale, non solo per i segnaposto.
 *
 * `hasFile` e' richiesto perche' l'assenza del file `it` e' un difetto di
 * un'altra classe (un articolo pubblicato solo in traduzione): li' cancellare
 * distruggerebbe l'unico contenuto rimasto invece di ripararlo.
 *
 * ## A chi serve, visto che oggi non ha chiamanti
 *
 * Nessuno la chiama nel percorso di SCRITTURA, ed e' voluto: li' la FAQ `it` e
 * le sue traduzioni nascono e cadono insieme, quindi un orfano non si forma.
 * Serve al percorso di BONIFICA — quello che tocca il gia' pubblicato — dove
 * invece si forma sempre, perche' i letterali italiani matchano solo su `it`.
 * Quel percorso e' tracciato in #5834 (il ratchet sul pubblicato che oggi il
 * sito non ha; il corpus lo ha, e ha anche il suo `repair-prompt-placeholders`).
 * Fino ad allora resta esercitata dal solo banco: e' una funzione pura, e la
 * cosa che protegge — non lasciare tre chiavi orfane dietro una riparazione —
 * si sbaglia molto piu' facilmente riscrivendola che leggendola.
 *
 * @param {Record<string, {hasFile?: boolean, hasFaq?: boolean}>} faqByLocale
 * @param {{sourceLocale?: string}} [opts]
 * @returns {string[]} locali da cui togliere la chiave, ordinate
 */
export function orphanFaqLocales(faqByLocale, { sourceLocale = 'it' } = {}) {
  if (!faqByLocale || typeof faqByLocale !== 'object') return [];
  const source = faqByLocale[sourceLocale];
  if (!source || source.hasFile !== true || source.hasFaq !== false) return [];
  return Object.entries(faqByLocale)
    .filter(([locale, state]) => locale !== sourceLocale && state && state.hasFaq === true)
    .map(([locale]) => locale)
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement sul percorso di scrittura
// ─────────────────────────────────────────────────────────────────────────────

/** I campi di testo pubblicati di un `data` di articolo, appiattiti. */
export function* iterateTextFields(data) {
  if (!data || typeof data !== 'object') return;
  const alt = data.imageAlt;
  if (alt && typeof alt === 'object') {
    for (const [locale, value] of Object.entries(alt)) {
      if (typeof value === 'string') yield { path: `imageAlt.${locale}`, field: 'imageAlt', locale, value };
    }
  }
  const content = data.content;
  if (content && typeof content === 'object') {
    for (const [locale, localeContent] of Object.entries(content)) {
      if (!localeContent || typeof localeContent !== 'object') continue;
      for (const [field, value] of Object.entries(localeContent)) {
        if (typeof value !== 'string') continue;
        yield { path: `content.${locale}.${field}`, field, locale, value };
      }
    }
  }
  const seo = data.seo;
  if (seo && typeof seo === 'object') {
    for (const [field, value] of Object.entries(seo)) {
      if (typeof value === 'string') yield { path: `seo.${field}`, field: `seo.${field}`, locale: 'it', value };
    }
  }
}

/** `imageAlt` mancante: la ricetta deterministica gia' usata da `validate()`. */
const IMAGE_ALT_FALLBACK = Object.freeze({
  it: (t) => `Immagine editoriale relativa a: ${t}`,
  en: (t) => `Editorial image related to: ${t}`,
  de: (t) => `Redaktionelles Bild zu: ${t}`,
  fr: (t) => `Image éditoriale relative à: ${t}`,
});

/**
 * Il gate del percorso di scrittura. **Due risposte diverse, di proposito** —
 * la stessa asimmetria che `deriveAndSanitizeArticleSlugs()` argomenta per gli
 * slug:
 *
 *  · RIPARA, rumorosamente, dove una riparazione deterministica esiste ed e'
 *    corretta: l'etichetta FAQ numerata davanti a contenuto vero, l'intestazione
 *    che ripete lo schema, le coppie FAQ (`cleanFaqPairs`), e `imageAlt`, che
 *    ha gia' la sua ricetta a partire dal titolo in `validate()` — un alt-text
 *    segnaposto e' equivalente a un alt-text assente.
 *
 *  · LANCIA su tutto il resto. Un titolo, un excerpt, un body o un campo seo
 *    che ricopia lo schema non e' un campo da rattoppare: e' una generazione
 *    FALLITA, e i due rattoppi possibili sono entrambi peggiori del rifiuto.
 *    Derivare l'excerpt dal body1 propagherebbe il leak quando e' il body a
 *    essere contaminato. E troncare il preambolo pubblicherebbe come articolo
 *    la pagina scrapata che lo precede.
 *
 * Va chiamato sia nel percorso AI primario (`main()`, dopo `translateArticle()`
 * cosi' da vedere anche i leak introdotti dalla traduzione, prima della
 * generazione immagine cosi' un articolo condannato non spende prima una
 * chiamata immagine) SIA dentro `registerArticleFiles()`, cioe' sul percorso
 * di scrittura CONDIVISO: `scripts/publish-journalist-article.mjs` lo importa
 * direttamente e gira ogni 15 minuti senza mai passare da `main()`. Un guard
 * messo in un solo produttore e' esattamente il buco che questo file chiude.
 *
 * @param {object} data
 * @returns {Array<{path: string, action: string, detail: string}>} le riparazioni fatte
 * @throws {Error} sul primo campo non recuperabile
 */
export function sanitizePromptPlaceholders(data) {
  const fixes = [];
  if (!data || typeof data !== 'object') return fixes;

  const itTitle = String(data?.content?.it?.title || data?.id || '');

  // ── FAQ, per locale ──────────────────────────────────────────────────────
  for (const [locale, localeContent] of Object.entries(data.content || {})) {
    if (!localeContent || typeof localeContent !== 'object') continue;
    if (!Array.isArray(localeContent.faq)) continue;
    // `dropShort: false` — qui si tolgono i segnaposto, non le coppie corte:
    // quelle sono di competenza del filtro di accettazione, che le ha gia'
    // viste. Vedi l'intestazione di `cleanFaqPairs`.
    const { pairs, repaired, dropped } = cleanFaqPairs(localeContent.faq, { dropShort: false });
    if (!dropped.length && !repaired) continue;
    if (pairs) {
      localeContent.faq = pairs;
    } else {
      delete localeContent.faq;
    }
    const detail = `${repaired} riparate, ${dropped.length} scartate (${dropped.map((d) => d.reason).join('; ')})`;
    fixes.push({ path: `content.${locale}.faq`, action: pairs ? 'faq-pruned' : 'faq-removed', detail });
    console.error(
      `  ⚠️ [prompt-placeholder] FAQ ${locale.toUpperCase()}: ${detail}. ` +
        (pairs
          ? `Restano ${pairs.length} coppie.`
          : 'Rimossa: sotto le 2 coppie ogPagesPlugin ricade sull\'euristica, e una FAQ assente non produce structured data — una finta si\'.'),
    );
  }

  // ── Ogni altro campo di testo ────────────────────────────────────────────
  for (const entry of iterateTextFields(data)) {
    const hits = findPromptPlaceholders(entry.value);
    if (!hits.length) continue;

    if (entry.field === 'imageAlt') {
      const build = IMAGE_ALT_FALLBACK[entry.locale] || IMAGE_ALT_FALLBACK.it;
      data.imageAlt[entry.locale] = build(itTitle);
      fixes.push({ path: entry.path, action: 'imagealt-rebuilt', detail: hits.map((h) => h.rule).join(',') });
      console.error(
        `  ⚠️ [prompt-placeholder] imageAlt ${entry.locale.toUpperCase()} era il segnaposto dello schema ` +
          `("${entry.value.slice(0, 60)}") → ricostruito dal titolo IT.`,
      );
      continue;
    }

    // Riparabile? Solo etichette/intestazioni, mai un troncamento.
    const repaired = repairTextField(entry.value, { allowTruncate: false });
    if (repaired.changed && !repaired.residual.length) {
      setTextField(data, entry, repaired.value);
      fixes.push({ path: entry.path, action: 'label-stripped', detail: hits.map((h) => h.rule).join(',') });
      console.error(
        `  ⚠️ [prompt-placeholder] ${entry.path}: rimossa l'etichetta dello schema (${hits.map((h) => h.rule).join(', ')}).`,
      );
      continue;
    }

    const rule = PLACEHOLDER_RULES.find((r) => r.id === (repaired.residual[0] || hits[0]).rule);
    throw new Error(
      `[prompt-placeholder] ${entry.path} contiene un segnaposto del prompt: ` +
        `"${(repaired.residual[0] || hits[0]).found}" (regola ${rule?.id}). ${rule?.why || ''} ` +
        'Il modello ha ricopiato lo schema invece di compilarlo: la generazione e\' FALLITA e va ripetuta, ' +
        'non rattoppata. Rattoppare questo campo pubblicherebbe come articolo il testo che lo circonda. ' +
        'Se ricorre, e\' il prompt a dover cambiare, non questa rete di sicurezza.',
    );
  }
  return fixes;
}

function setTextField(data, entry, value) {
  if (entry.path.startsWith('seo.')) data.seo[entry.path.slice(4)] = value;
  else if (entry.path.startsWith('content.')) data.content[entry.locale][entry.field] = value;
}
