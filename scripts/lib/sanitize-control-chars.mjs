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

/**
 * Sanitize a whole XML document: the raw characters, and any numeric character
 * reference that would decode to one.
 *
 * `&#8;` is as fatal as a raw 0x08 — XML forbids the CHARACTER, and a reference
 * is just another spelling of it. The engine's own RSS builder escapes through
 * an entity table, so that spelling is the one a feed would take if the escape
 * ever reached a numeric branch. Both are removed; every other reference
 * (`&amp;`, `&#233;`, `&#x2019;`) is left exactly as written.
 */
export function sanitizeXmlDocument(xml) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(INVALID_C0, '').replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (ref, digits) => {
    const code = digits[0] === 'x' || digits[0] === 'X'
      ? Number.parseInt(digits.slice(1), 16)
      : Number.parseInt(digits, 10);
    return Number.isFinite(code) && isInvalidControlCode(code) ? '' : ref;
  });
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
