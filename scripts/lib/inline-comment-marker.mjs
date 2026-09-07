/**
 * Marker di esonero inline — devono stare DENTRO un commento.
 *
 * Issue #7676: i gate che riconoscono un opt-out inline (`cathedral-allow:`,
 * `locale-segment-ok:`) testavano il marker sul CONTENUTO GREZZO della riga.
 * La documentazione di entrambi dice «appendi ` // <marker>: <ragione>`», ma
 * il pattern non lo pretendeva: una riga di prosa editoriale (JSX, stringa,
 * blob HTML) che contenesse quelle parole si auto-esonerava, e il gate
 * diventava verde senza che nessuno avesse dichiarato nulla. È la stessa
 * classe di verde vacuo che il gate esiste per impedire.
 *
 * Qui il marker vale solo se sulla stessa riga, PRIMA di esso, compare un
 * apri-commento. Le forme ammesse sono quelle realmente usate nel repo:
 *
 *   `// marker: …`            riga JS/TS
 *   `/* marker: … *\/`        blocco su una riga
 *   ` * marker: …`            continuazione di un docblock JSDoc
 *   `# marker: …`             shell, Python
 *   `<!-- marker: … -->`      HTML/markdown
 *
 * Due restrizioni tolgono i falsi apri-commento che una riga di prosa può
 * contenere per caso:
 *  - `//` non preceduto da `:` → uno `https://…` dentro una stringa non apre
 *    un commento;
 *  - `#` solo a inizio riga o dopo uno spazio → un `href="#top"` o un colore
 *    `#0a0a0a` non apre un commento.
 */
const COMMENT_OPENER = String.raw`(?:(?<!:)\/\/|\/\*|<!--|(?:^|\s)#|^\s*\*)`;

/**
 * Costruisce il pattern «<apri-commento> … <marker>» a partire dal SORGENTE
 * del marker (una stringa di regex, non una RegExp), da usare al posto del
 * test sul contenuto grezzo.
 */
export function markerInComment(markerSource) {
  return new RegExp(`${COMMENT_OPENER}[^\\n]*(?:${markerSource})`);
}

/** Il marker compare dentro un commento su questa riga? */
export function hasMarkerInComment(line, markerSource) {
  return markerInComment(markerSource).test(line);
}
