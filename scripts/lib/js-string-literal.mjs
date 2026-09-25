/**
 * Estrarre un literal di stringa JS da un sorgente letto COME TESTO.
 *
 * Perche' esiste. Piu' punti del repo leggono un runner/parser con `readFileSync`
 * e ne pescano il nome dell'azienda con una regex. La forma che era stata copiata
 * in due file — `scripts/generate-crawler-companies.mjs` e
 * `build-plugins/crawlerRegistryPlugin.ts` — e' questa:
 *
 *     /COMPANY_NAME\s*=\s*['"`]([^'"`]+)['"`]/
 *
 * e ha due difetti che si vedono solo sul dato vero:
 *
 * 1. **La chiusura non e' la stessa virgoletta dell'apertura.** `['"`]` accetta
 *    QUALUNQUE delle tre, quindi su
 *    `const OTTOS_COMPANY_NAME = "OTTO'S AG";` la classe `[^'"`]+` si ferma su
 *    `OTTO` e l'apostrofo fa da chiusura: il nome estratto e' `OTTO`. Misurati su
 *    questo repo sei nomi troncati cosi' (`OTTO'S AG`, `Badrutt's Palace Hotel`,
 *    `Etablissements publics pour l'integration`, `Groupement Hospitalier de
 *    l'Ouest Lemanique`, `EVAM - Etablissement vaudois de l'accueil des
 *    migrants`, `Pole Sante Pays-d'Enhaut`).
 * 2. **I commenti contano come codice.** `String.match` torna la PRIMA
 *    occorrenza, e un docblock che cita un esempio vince sulla dichiarazione
 *    vera: `scripts/lib/tl-lausanne-job-parser.mjs` documenta a riga 34 che un
 *    altro parser «ships `VOLKSSCHULE_LUZERN_COMPANY_NAME = '...'`», e il
 *    generatore attribuiva «Volksschule Stadt Luzern» a `tl-lausanne`.
 *
 * Qui il literal viene letto con uno scanner invece che con una classe di
 * caratteri: la chiusura e' per forza il carattere che ha aperto, e gli escape
 * (`\'`, `\\`, `\n`, `\uXXXX`) sono interpretati invece di interrompere.
 *
 * Non e' un parser JS e non pretende di esserlo: e' un lettore di literal
 * ancorato a un prefisso noto. Su un sorgente che non sia una dichiarazione
 * semplice torna `null`, che e' il comportamento voluto — meglio nessun nome che
 * un nome inventato.
 */

/** Escape a un carattere: `\n` -> newline, `\'` -> apostrofo, ecc. */
const SIMPLE_ESCAPES = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  0: '\0',
};

/**
 * Righe che sono commento di linea (`//`) o corpo/apertura di un blocco
 * (`/*`, `*`). Sono tolte per INTERO, e questo e' deliberato: la riga di codice
 * che porta un literal non comincia mai con quei token, quindi non si perde
 * niente di reale, e in cambio non serve un tokenizer per sapere se una `//`
 * sta dentro una stringa.
 *
 * Le righe non vengono rimosse ma svuotate, cosi' i numeri di riga del sorgente
 * originale restano validi per chi volesse riportarli in un errore.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripCommentLines(src) {
  return String(src)
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n');
}

/**
 * Legge il literal di stringa che comincia esattamente a `index`.
 *
 * @param {string} src
 * @param {number} index posizione della virgoletta di apertura
 * @returns {{ value: string, end: number } | null} `null` se a `index` non c'e'
 *   una virgoletta, o se il literal non si chiude prima della fine riga/file.
 */
export function readStringLiteralAt(src, index) {
  const quote = src[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;

  let value = '';
  for (let i = index + 1; i < src.length; i += 1) {
    const ch = src[i];

    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) return null;
      if (next === 'u' && src[i + 2] === '{') {
        const close = src.indexOf('}', i + 3);
        const hex = close === -1 ? '' : src.slice(i + 3, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        i = close;
      } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
        value += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16));
        i += 5;
      } else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
        value += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 4), 16));
        i += 3;
      } else if (next === '\n') {
        i += 1; // line continuation: non produce nulla
      } else {
        value += Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next)
          ? SIMPLE_ESCAPES[next]
          : next;
        i += 1;
      }
      continue;
    }

    if (ch === quote) return { value, end: i + 1, quote };

    // Un literal ad apici singoli/doppi non attraversa la fine riga: se ci
    // arriviamo, il prefisso aveva agganciato qualcosa che non e' una stringa.
    if (ch === '\n' && quote !== '`') return null;

    value += ch;
  }
  return null;
}

/**
 * Primo literal di stringa che segue `prefix` nel sorgente.
 *
 * Il prefisso deve terminare immediatamente prima della virgoletta, spazi
 * inclusi nel pattern (il nome della costante, l'uguale, e uno `\s*` finale che
 * mangia lo spazio prima dell'apice). Se l'occorrenza trovata
 * non e' seguita da un literal — il caso `companyLabel: TL_LAUSANNE_COMPANY_NAME`,
 * dove il valore e' un identificatore — la ricerca **prosegue** all'occorrenza
 * successiva invece di arrendersi: e' quello che permette di saltare l'import e
 * arrivare alla dichiarazione vera.
 *
 * @param {string} src sorgente del file
 * @param {RegExp|string} prefix pattern che precede il literal
 * @param {{ stripComments?: boolean }} [options]
 * @returns {string|null} il valore del literal, con gli escape risolti
 */
export function matchQuotedLiteral(src, prefix, options = {}) {
  const { stripComments = true } = options;
  const haystack = stripComments ? stripCommentLines(String(src)) : String(src);

  const source = prefix instanceof RegExp ? prefix.source : String(prefix);
  const flags = prefix instanceof RegExp ? prefix.flags.replace(/[gy]/g, '') : '';
  const re = new RegExp(source, `${flags}g`);

  let match;
  while ((match = re.exec(haystack)) !== null) {
    const literal = readStringLiteralAt(haystack, match.index + match[0].length);
    // Un template con interpolazione non e' una costante: il suo TESTO contiene
    // `${...}`, e chi lo pubblica come nome o come URL pubblica il placeholder.
    // E' successo davvero — `alten` sarebbe finito nella directory con
    // `careersUrl: .../?per_page=${LISTING_PAGE_CAP}`, cioe' un link rotto in
    // pagina. Qui il candidato viene saltato e la ricerca prosegue.
    if (literal && literal.value.trim() && !/\$\{/.test(literal.value)) return literal.value;
    // Un prefisso a larghezza zero altrimenti riparte in eterno dalla stessa
    // posizione.
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return null;
}

/**
 * Come `matchQuotedLiteral`, ma prova i prefissi in ordine e torna il primo che
 * porta un literal.
 *
 * @param {string} src
 * @param {ReadonlyArray<RegExp|string>} prefixes
 * @param {{ stripComments?: boolean }} [options]
 * @returns {string|null}
 */
export function matchFirstQuotedLiteral(src, prefixes, options = {}) {
  for (const prefix of prefixes) {
    const value = matchQuotedLiteral(src, prefix, options);
    if (value) return value;
  }
  return null;
}
