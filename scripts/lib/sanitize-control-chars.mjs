/**
 * Strip XML-invalid C0 control characters at the emitters' output boundary.
 *
 * ## The defect this exists for
 *
 * Two source titles in `content/` carry raw control bytes, born upstream from a
 * mangling of accented characters and typographic quotes — `sar\x170` for
 * «sarò», `marted\x088` for «martedì», `\x083…\x083` for the pair of curly
 * quotes. Those three are OBSERVATIONS OF TWO TITLES, not a mapping to repair
 * from; read "Do not repair from the list above" before using any of them.
 * They are ordinary string data as far as every emitter here is concerned, so
 * every emitter forwarded them verbatim into the public surface:
 *
 *   - `sitemap-blog.xml` carried 0x08 and 0x17 inside `<image:title>` at two
 *     of its 3120 `<url>` blocks. XML 1.0 §2.2 admits no C0 character other
 *     than TAB/LF/CR, escaped or not, so the document was NOT well-formed:
 *     `xml.etree` refuses it at "line 8745, column 22" and a strict consumer
 *     (Google's sitemap fetcher included) is entitled to reject the ENTIRE
 *     file — 3120 URLs lost to two bytes.
 *   - the live article page carried them raw in `<title>`, `og:title`,
 *     `og:image:alt`, `<h1>` and the hero `alt`, and — JSON-escaped, so
 *     invisible to a grep for the raw byte — as `\u0017` / `\b` inside the
 *     `headline`, `caption` and `BreadcrumbList` `name` of its `ld+json`
 *     blocks. Structured data is parsed, not rendered: a control character in
 *     `headline` is served to the crawler, not swallowed by the browser.
 *   - `meta-<locale>.json` and `data/blog-index-*.json` carried them through
 *     `JSON.stringify`, which escapes them into valid JSON and therefore
 *     raises nothing at all.
 *
 * The common shape: a control character is *legal* in a JavaScript string and
 * *illegal* in the two serialisations we publish. Nothing between the corpus
 * and the reader was looking, so the failure was silent in the producer and
 * total in the consumer.
 *
 * ## Do not repair from the list above
 *
 * The three pairs are what was MEASURED in two titles. They are NOT a
 * `(byte, digit) → character` function, and reading them as one has already
 * produced a wrong answer: this docstring said `sar\x170` was «sarà» until
 * 2026-08-11, and the corpus holds the same sentence clean in
 * `content/blog-body/it/trump-intesa-o-inferno.ts` — `Trump: "Intesa o sarò
 * l'inferno"`, Trump speaking in the first person. A repair guided by this file
 * would have written `sarà`: corrupt text, green CI, and no residue left for
 * anyone to grep. The same wrong pair is in corpus issue #66's census.
 *
 * The relation is not a function in EITHER direction. Byte-verified in the
 * corpus repo's merged #218:
 *
 *   - one key, two characters — `\x083` spells BOTH ends of
 *     `\x083territorio poroso\x083`, so it cannot say which quote to write;
 *   - one byte, two characters — `\x0f` is «ù» in `O\x0f :` → `Où` and «œ» in
 *     `en \x0fuvre` → `en œuvre`, in the same file;
 *   - two keys, one character — «é» is `\x0e` in `Municipalit\x0e de` and
 *     `\x169` in `comp\x169tences`.
 *
 * What holds instead is the WITNESS channel corpus #218 established: take the
 * 16 characters before the marker and the 24 after, look that anchor up in the
 * corpus files that carry no marker at all, and accept what the witnesses have
 * in between ONLY if they are unanimous and it is a single letter. No witness,
 * or witnesses that disagree, and the byte stays where it is. That is the
 * method to reach for; this list is not.
 *
 * Of the three pairs, only `marted\x088` → «martedì» is confirmed by a clean
 * witness (the same title, in the file named above). `\x083` is confirmed to be
 * a typographic quote and NOT which one. Neither says anything about any other
 * byte, and nothing here was verified for the bytes not listed.
 *
 * ## Why here, and not in `content/`
 *
 * The corpus is written by the generator; hand-editing the two titles would fix
 * these two articles and leave the next one to the same fate. This module is
 * the *boundary* guard: whatever the corpus holds, what leaves this repo is
 * serialisable. Fixing the generator's mangling is separate work, and both are
 * needed — this one is the one that cannot be skipped, because a corpus is
 * allowed to be wrong and a published sitemap is not.
 *
 * ## Scope
 *
 * Removed: U+0000-U+0008, U+000B, U+000C, U+000E-U+001F.
 * Preserved: TAB (U+0009), LF (U+000A), CR (U+000D) — the three C0 characters
 * XML 1.0 and JSON both admit, and the three that carry meaning in our output.
 * Nothing else is touched: a clean string comes back byte-identical. That is
 * not an optimisation — the article renderer is held to producing the same
 * bytes as the full site build, so a sanitiser that normalised anything beyond
 * the illegal characters would become a divergence of its own.
 */

/** The C0 characters XML 1.0 §2.2 forbids: everything below 0x20 but TAB/LF/CR. */
const INVALID_C0 = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** True for a code point no XML document and no useful JSON string may carry. */
export function isInvalidControlCode(code) {
  return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
}

/**
 * Strip the invalid C0 characters from a string. Non-strings pass through
 * untouched — callers hand this whole values, not only text.
 */
export function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(INVALID_C0, '');
}

/**
 * Every invalid control character in `text`, as `{ index, code }`. Used by the
 * emitters' own post-write assertion and by the tests; a caller that only needs
 * a yes/no answer should read `.length`.
 */
export function findControlChars(text) {
  const found = [];
  if (typeof text !== 'string') return found;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isInvalidControlCode(code)) found.push({ index: i, code });
  }
  return found;
}

/**
 * Sanitize every string inside a JSON-shaped value, keys included.
 *
 * Recurses into arrays and PLAIN objects only. A `Date`, a `Map`, a class
 * instance — anything with a prototype of its own — is returned as-is rather
 * than rebuilt as a bare object, because rebuilding it would change what
 * `JSON.stringify` then emits. That is a data-corrupting fix for a
 * data-corruption bug, so it is refused explicitly instead of accidentally.
 *
 * KEYS ARE SANITISED TOO, and that is the one place this can lose data: strip a
 * control character out of `blog.article.x.ti<0x08>tle` and it becomes
 * `blog.article.x.title`, which the object may already have. The clean entry
 * would be silently overwritten by the poisoned one — a whole article's title
 * replaced by another's, with nothing raised. So a collision THROWS. It has
 * never been observed in the corpus (the meta keys are generated from slugs and
 * carry no control character); refusing is what keeps "never observed" from
 * quietly becoming "never noticed".
 */
export function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    const origin = new Map();
    for (const [key, val] of Object.entries(value)) {
      const cleanKey = sanitizeText(key);
      const previous = origin.get(cleanKey);
      // Checked on the ORIGINAL keys, in both directions: whichever of the two
      // arrives second would win, and neither order is a correct outcome.
      if (previous !== undefined && previous !== key) {
        throw new Error(
          `sanitizeDeep: keys ${JSON.stringify(previous)} and ${JSON.stringify(key)} both become ` +
            `${JSON.stringify(cleanKey)} once their control characters are removed — ` +
            'refusing to drop one of the two values',
        );
      }
      origin.set(cleanKey, key);
      out[cleanKey] = sanitizeDeep(val);
    }
    return out;
  }
  return value;
}

function findXmlMarkupEnd(xml, start) {
  let quote = null;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index + 1;
    }
  }
  return -1;
}

function isDoctypeStart(xml, index) {
  if (!xml.startsWith('<!DOCTYPE', index)) return false;
  const boundary = xml[index + '<!DOCTYPE'.length];
  return boundary !== undefined && /[\t\n\r >]/u.test(boundary);
}

/**
 * A doctype has its own quoted values and internal subset. Delimiter-looking
 * text inside an entity value is data, while comments and processing
 * instructions between declarations are real XML literals. Keep the quoted
 * ranges in the transformed text so numeric C0 references inside them remain
 * visible to the gate.
 */
function transformDoctype(xml, start, transform) {
  let output = '';
  let segmentStart = start;
  let index = start + '<!DOCTYPE'.length;
  let quote = null;
  let subsetDepth = 0;

  while (index < xml.length) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
      index += 1;
      continue;
    }

    const literal = xml.startsWith('<!--', index)
      ? { open: '<!--', close: '-->' }
      : xml.startsWith('<?', index)
        ? { open: '<?', close: '?>' }
        : null;
    if (literal) {
      output += transform(xml.slice(segmentStart, index), segmentStart);
      const close = xml.indexOf(literal.close, index + literal.open.length);
      if (close < 0) {
        // An unterminated region is not exempt: process its tail as ordinary
        // text so malformed markup cannot hide a forbidden reference.
        output += transform(xml.slice(index), index);
        return { text: output, end: xml.length };
      }
      const end = close + literal.close.length;
      output += xml.slice(index, end);
      index = end;
      segmentStart = end;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      subsetDepth += 1;
    } else if (character === ']' && subsetDepth > 0) {
      subsetDepth -= 1;
    } else if (character === '>' && subsetDepth === 0) {
      const end = index + 1;
      output += transform(xml.slice(segmentStart, end), segmentStart);
      return { text: output, end };
    }
    index += 1;
  }

  output += transform(xml.slice(segmentStart), segmentStart);
  return { text: output, end: xml.length };
}

function transformOutsideXmlLiterals(xml, transform) {
  let output = '';
  let index = 0;

  while (index < xml.length) {
    const markup = xml.indexOf('<', index);
    if (markup < 0) {
      output += transform(xml.slice(index), index);
      break;
    }
    output += transform(xml.slice(index, markup), index);

    const literal = xml.startsWith('<!--', markup)
      ? { open: '<!--', close: '-->' }
      : xml.startsWith('<![CDATA[', markup)
        ? { open: '<![CDATA[', close: ']]>' }
        : xml.startsWith('<?', markup)
          ? { open: '<?', close: '?>' }
          : null;
    if (literal) {
      const close = xml.indexOf(literal.close, markup + literal.open.length);
      if (close < 0) {
        // A literal-region exemption requires a closing delimiter. Malformed
        // XML must not hide references from the publish gate or sanitizer.
        output += transform(xml.slice(markup), markup);
        break;
      }
      const end = close + literal.close.length;
      output += xml.slice(markup, end);
      index = end;
      continue;
    }

    if (isDoctypeStart(xml, markup)) {
      const result = transformDoctype(xml, markup, transform);
      output += result.text;
      index = result.end;
      continue;
    }

    const next = xml[markup + 1];
    const isMarkup = next === '!' || next === '?' || next === '/' || (next && /[\p{L}_:]/u.test(next));
    if (!isMarkup) {
      output += transform(xml.slice(markup, markup + 1), markup);
      index = markup + 1;
      continue;
    }

    const end = findXmlMarkupEnd(xml, markup);
    if (end < 0) {
      output += transform(xml.slice(markup), markup);
      break;
    }
    // Tags and other markup declarations are transformed as a unit. In
    // particular, comment/PI-looking text in a quoted attribute is not a
    // literal XML region and cannot hide a reference.
    output += transform(xml.slice(markup, end), markup);
    index = end;
  }
  return output;
}

function numericReferenceCode(digits) {
  return digits[0] === 'x'
    ? Number.parseInt(digits.slice(1), 16)
    : Number.parseInt(digits, 10);
}

function isInvalidNumericReference(_reference, digits) {
  const code = numericReferenceCode(digits);
  return Number.isFinite(code) && isInvalidControlCode(code);
}

/**
 * Decode only references that represent XML-forbidden C0 characters in XML
 * character data. References in comments, CDATA, and processing instructions
 * are literal text and must remain byte-identical there.
 */
export function decodeInvalidXmlReferencesOutsideLiterals(xml) {
  if (typeof xml !== 'string') return xml;
  return transformOutsideXmlLiterals(xml, (text) => text.replace(
    /&#(x[0-9a-fA-F]+|[0-9]+);/g,
    (reference, digits) => isInvalidNumericReference(reference, digits)
      ? String.fromCharCode(numericReferenceCode(digits))
      : reference,
  ));
}

/** Find invalid numeric references with offsets in the original XML source. */
export function findInvalidXmlReferencesOutsideLiterals(xml) {
  if (typeof xml !== 'string') return [];
  const found = [];
  transformOutsideXmlLiterals(xml, (text, offset) => {
    const references = /&#(x[0-9a-fA-F]+|[0-9]+);/g;
    for (const match of text.matchAll(references)) {
      if (!isInvalidNumericReference(match[0], match[1])) continue;
      found.push({ code: numericReferenceCode(match[1]), index: offset + match.index });
    }
    return text;
  });
  return found;
}

/**
 * Sanitize a whole XML document: raw forbidden characters everywhere, and
 * numeric character references only in XML character data. Numeric references
 * inside comments, CDATA, and processing instructions are ordinary text.
 */
export function sanitizeXmlDocument(xml) {
  if (typeof xml !== 'string') return xml;
  const cleanRaw = xml.replace(INVALID_C0, '');
  return transformOutsideXmlLiterals(cleanRaw, (text) => text.replace(
    /&#(x[0-9a-fA-F]+|[0-9]+);/g,
    (reference, digits) => isInvalidNumericReference(reference, digits) ? '' : reference,
  ));
}

/**
 * Strip escape sequences that denote an invalid control character, walking the
 * string escape by escape.
 *
 * A scan is used rather than a regex because `\\b` is a literal backslash
 * followed by `b`, not a backspace, and a regex that does not consume `\\`
 * first would eat the wrong two characters.
 */
function stripEscapedControlChars(str) {
  let out = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] !== '\\') {
      out += str[i];
      i += 1;
      continue;
    }
    const next = str[i + 1];
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(str.slice(i + 2, i + 6))) {
      if (isInvalidControlCode(Number.parseInt(str.slice(i + 2, i + 6), 16))) {
        i += 6;
        continue;
      }
      out += str.slice(i, i + 6);
      i += 6;
      continue;
    }
    if (next === 'b' || next === 'f') {
      i += 2;
      continue;
    }
    // Any other escape, `\\` included — copied whole, which is what keeps the
    // next iteration from reading an escaped backslash as an escape opener.
    out += str.slice(i, i + 2);
    i += 2;
  }
  return out;
}

/**
 * Quoted string literals, double and single, with escapes consumed so `\"` does
 * not close one.
 *
 * Both quote styles, because `JSON.stringify` produces double quotes but hand-
 * written inline script does not, and the escape rules are identical in either.
 * NOT template literals: a `${...}` interpolation can hold arbitrary code — a
 * regex literal included — and `\b` in a regex is a word boundary. Covering
 * backticks would mean parsing the interpolation to know where the string
 * really is, and getting that wrong changes the program. If an emitter ever
 * interpolates a title into a template literal, this pass misses it silently;
 * the raw-character pass still catches the unescaped spelling.
 */
const QUOTED = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/g;

/** Inline `<script>` blocks; the `src` test is applied to the attributes by the caller. */
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Sanitize a rendered HTML document.
 *
 * Two passes, because the same control character reaches the page in two
 * spellings and only one of them is visible to a byte scan:
 *
 *  1. raw C0 anywhere in the document — `<title>`, `og:*`, `<h1>`, `alt`, body
 *     text. These are the ones a `grep -P '[\x00-\x08...]'` finds.
 *  2. C0 written as a JS/JSON escape (`\u0017`, `\b`) inside INLINE `<script>`
 *     blocks — the `ld+json` structured data and the `window.__ARTICLE_TITLE__`
 *     assignment. `JSON.stringify` produced these from the same title, so a
 *     document can be clean under pass 1 and still serve a poisoned `headline`.
 *
 * Pass 2 is confined twice over: to inline scripts (a `src=` block has no body
 * of ours to fix), and within those, to quoted string literals. That second
 * confinement is what makes removing `\b` safe — in a JavaScript regex literal
 * `\b` is a word boundary and deleting it would change the program, but a regex
 * literal is not inside a quoted string. See QUOTED for what that leaves out.
 */
export function sanitizeHtmlDocument(html) {
  if (typeof html !== 'string') return html;
  return html.replace(INVALID_C0, '').replace(SCRIPT_BLOCK, (whole, attrs, body) => {
    if (/\bsrc\s*=/i.test(attrs) || body === '') return whole;
    const cleaned = body.replace(QUOTED, stripEscapedControlChars);
    return cleaned === body ? whole : `<script${attrs}>${cleaned}</script>`;
  });
}

/**
 * Sanitize a JSON document handed through verbatim (the border-wait ranking and
 * the daily brief are republished as the bytes the generator wrote).
 *
 * Returns the ORIGINAL text when there is nothing to fix, so the verbatim
 * contract holds in the normal case and only a document that actually carries a
 * control character — raw, or escaped as `\u0008` — is re-serialised.
 */
export function sanitizeJsonText(raw) {
  if (typeof raw !== 'string') return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not our document to repair: the caller validates and refuses it.
    return raw;
  }
  const cleaned = sanitizeDeep(parsed);
  const serialised = JSON.stringify(cleaned);
  return serialised === JSON.stringify(parsed) ? raw : serialised;
}

/**
 * Every unpaired surrogate code unit in `text`, as `{ index, code }`.
 *
 * Un surrogate spaiato non e' un carattere: e' meta' di una coppia UTF-16 che
 * non ha una codifica UTF-8. Su questo percorso non fallisce nulla, ed e'
 * proprio questo il problema — `fs.writeFileSync` lo sostituisce con U+FFFD
 * mentre lo scrive, e `Buffer.byteLength` calcola i byte della STESSA
 * sostituzione. Dichiarato e disco quindi coincidono, `manifest.files` resta
 * verde, e il documento pubblicato e' gia' alterato: il caso peggiore di
 * AGENTS.md, quello che non fallisce da solo.
 *
 * Sul percorso JSON la stringa e' protetta da `JSON.stringify` (well-formed
 * stringify: emette `\udXXX` invece di perdere il code unit); sul percorso XML
 * — sitemap e feed — no, e li' l'unica rete e' rifiutare a monte.
 */
export function findLoneSurrogates(text) {
  const found = [];
  if (typeof text !== 'string') return found;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // coppia valida: consuma anche il low surrogate
        continue;
      }
      found.push({ index: i, code });
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Un low surrogate raggiunto qui non e' preceduto da un high: se lo fosse,
      // il ramo sopra lo avrebbe gia' consumato insieme al suo.
      found.push({ index: i, code });
    }
  }
  return found;
}

/**
 * Throw if `text` still carries an invalid control character — or a lone
 * surrogate.
 *
 * The emitters call this on what they have just written, so a NEW output added
 * later without going through a sanitizer fails the build that adds it rather
 * than the crawler that reads it three days on. It is deliberately a tautology
 * on the paths already covered above: the paths not yet covered are the point.
 *
 * Sui surrogati spaiati NON e' una tautologia, ed e' voluto: non esiste un
 * sanitizer a monte che li tolga, perche' sostituirli in silenzio e'
 * esattamente cio' che gia' fa `writeFileSync` — e la coerenza fra dichiarato
 * e disco non e' correttezza del pubblicato. L'unica risposta corretta e'
 * rifiutare, cosi' fallisce la build che introduce il code unit rotto invece
 * del crawler che tre giorni dopo legge un documento diverso dal corpus.
 * Va quindi chiamata PRIMA della scrittura: riletta dal disco la stringa e'
 * gia' U+FFFD, e non c'e' piu' niente da vedere.
 */
export function assertNoControlChars(text, label) {
  const found = findControlChars(text);
  if (found.length > 0) {
    const detail = found
      .slice(0, 5)
      .map((f) => `0x${f.code.toString(16).padStart(2, '0')}@${f.index}`)
      .join(', ');
    throw new Error(
      `${label}: ${found.length} XML-invalid control character(s) survived sanitisation (${detail}) — refusing to publish`,
    );
  }
  const lone = findLoneSurrogates(text);
  if (lone.length > 0) {
    const detail = lone
      .slice(0, 5)
      .map((f) => `0x${f.code.toString(16).padStart(4, '0')}@${f.index}`)
      .join(', ');
    throw new Error(
      `${label}: ${lone.length} lone surrogate(s) (${detail}) — writeFileSync would publish them as U+FFFD ` +
        'and the byte-size gate would still match; refusing to publish an already-altered document',
    );
  }
}
