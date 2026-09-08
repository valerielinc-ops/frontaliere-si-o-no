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
 *  - gli apri-commento dentro una stringa non contano: questo copre sia un
 *    colore `#0a0a0a` sia un URL protocol-relative `//cdn.example/...`;
 *  - `#` solo a inizio riga o dopo uno spazio → un `href="#top"` non apre un
 *    commento.
 */
const COMMENT_OPENER = String.raw`(?:(?<!:)\/\/|\/\*|<!--|(?:^|\s)#|^\s*\*)`;

const MARKER_SOURCE = Symbol('markerSource');

/**
 * True when the prefix contains a real comment opener, not one lexed inside
 * a quoted JS/TS/HTML value. This is intentionally a small line lexer rather
 * than a second language parser: the marker contract only needs quote state
 * and the five opener forms above.
 */
function hasCommentBefore(line, markerIndex) {
  let quote = '';
  let escaped = false;
  let regex = false;
  let regexClass = false;
  const firstCode = line.search(/\S/);

  for (let i = 0; i < markerIndex; i += 1) {
    const ch = line[i];
    if (regex) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') regexClass = true;
      else if (ch === ']') regexClass = false;
      else if (ch === '/' && !regexClass) regex = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }

    if (ch === '/' && line[i + 1] !== '/' && line[i + 1] !== '*' &&
        isRegexLiteralStart(line, i)) {
      regex = true;
      regexClass = false;
      continue;
    }
    if ((ch === "'" || ch === '"' || ch === '`') && isQuoteStart(line, i)) {
      quote = ch;
      continue;
    }
    if (line.startsWith('//', i) && (i === 0 || line[i - 1] !== ':')) return true;
    if (line.startsWith('/*', i) || line.startsWith('<!--', i)) return true;
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return true;
    if (ch === '*' && i === firstCode) return true;
  }
  return false;
}

function isQuoteStart(line, index) {
  const previous = line[index - 1] || '';
  return !(previous && /[\p{L}\p{N}_]/u.test(previous));
}

function isRegexLiteralStart(line, index) {
  const prefix = line.slice(0, index).trimEnd();
  const previous = prefix.at(-1) || '';
  if (!previous) return true;
  if (previous === '<' && /[\p{L}\p{N}]/u.test(line[index + 1] || '')) return false;
  if (/(?:\+\+|--)$/.test(prefix)) return false;
  if (/[=([{,:;!&|?+\-*%^~<>]/.test(previous)) return true;
  return /\b(?:case|delete|do|else|in|instanceof|of|return|throw|typeof|void|yield|await)\s*$/u.test(prefix);
}

/** The actual context-sensitive implementation behind both public APIs. */
function markerMatches(line, markerSource) {
  const s = String(line ?? '');
  let marker;
  try {
    marker = new RegExp(markerSource, 'g');
  } catch {
    return false;
  }
  for (const match of s.matchAll(marker)) {
    if (hasCommentBefore(s, match.index ?? 0)) return true;
  }
  return false;
}

/** RegExp-compatible wrapper whose `.test()` uses the line lexer above. */
class CommentMarkerRegExp extends RegExp {
  constructor(markerSource) {
    // Keep a useful native `.source` for callers that inspect the expression;
    // `.test()` is overridden because quote context cannot be expressed by a
    // fixed opener regex.
    super(`${COMMENT_OPENER}[^\\n]*(?:${markerSource})`);
    this[MARKER_SOURCE] = markerSource;
  }

  test(line) {
    return markerMatches(line, this[MARKER_SOURCE]);
  }
}

/**
 * Costruisce il pattern «<apri-commento> … <marker>» a partire dal SORGENTE
 * del marker (una stringa di regex, non una RegExp), da usare al posto del
 * test sul contenuto grezzo.
 */
export function markerInComment(markerSource) {
  return new CommentMarkerRegExp(markerSource);
}

/** Il marker compare dentro un commento su questa riga? */
export function hasMarkerInComment(line, markerSource) {
  return markerMatches(line, markerSource);
}
