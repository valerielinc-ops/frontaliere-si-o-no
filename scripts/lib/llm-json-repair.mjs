/**
 * Shared JSON-repair helpers for cleaning up common LLM JSON output quirks
 * (markdown fences, literal newlines inside strings, unescaped inner quotes,
 * stray markdown-bold asterisks). Used by every script that JSON.parse()s an
 * LLM response so a fix to the repair logic lands once instead of drifting
 * across independent copies (create-article.mjs repairLlmJson,
 * batch-add-faq-to-articles.mjs repairJsonArray both had this inlined).
 */

/** Strip leading/trailing ```json fences and trim. */
export function stripCodeFences(raw) {
  return String(raw).replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
}

/**
 * Prompt-side guard against the recurring "quoted term echoed from the
 * source" JSON corruption (e.g. a headline quoting «tassa sulla salute» —
 * see issue #3282, run 28600753915: 6/6 attempts across 6 different models
 * — gpt-4.1, gemini-2.5-flash, gpt-4.1-nano, groq/gpt-oss-120b, gpt-4o-mini,
 * plus every free fallback — hit the identical corruption, proving this is
 * a prompt gap, not a model-quality issue the fallback chain can route
 * around). Append/inline this into every prompt whose response is
 * JSON.parse()'d, so models are told up front how to emit an internal
 * double quote instead of leaving it to the fixJsonStringBody() heuristic
 * below to guess after the fact.
 */
export const JSON_QUOTE_SAFETY_RULE_IT = '⚠️ VIRGOLETTE NEI VALORI JSON: se riporti un termine o una frase citata tra virgolette (es. la cosiddetta "tassa sulla salute"), NON usare mai il carattere " dentro un valore stringa JSON — usa virgolette singole (\'tassa sulla salute\') o guillemet («tassa sulla salute»). Se devi proprio usare virgolette doppie interne, escapale sempre con \\" (es. "la cosiddetta \\"tassa sulla salute\\""). Una virgoletta doppia non escapata dentro una stringa rende l\'intero JSON non valido e scarta l\'intero articolo.';

/**
 * ── Memo condiviso dalle funzioni mutuamente ricorsive di questo modulo ─────
 *
 * IL DIFETTO CHE CHIUDE (run 32130136859, 2026-08-18, fallita dopo 1058s).
 *
 * Un watchdog ha campionato il processo ogni 30s. Firma, letterale:
 *
 *   elapsed  rss_MB  cpu%(cumulativo)  stato  log_bytes
 *      402s   198.8   7.2               S      31179   <- ultima riga scritta
 *      432s   198.8   6.8               R      31179
 *     1003s   198.8  72.4               R      31179
 *
 * Dieci minuti senza una riga di log, stato `R` (gira, non aspetta I/O), e RSS
 * fermo a 198.8 MB al decimo di MB per 500 secondi: **spin CPU sincrono senza
 * allocazione**. Il watchdog ha anche aperto l'inspector e il dump dello stack
 * e' uscito 0 byte — la porta 9229 sta su un thread suo, ma l'isolate non ha
 * mai ceduto per servire la richiesta: l'event loop era bloccato.
 *
 * L'ultima riga viva del run e' la riduzione del prompt, quindi il sospetto e'
 * caduto li'. Non era li': la riduzione aveva gia' stampato il suo esito, e fra
 * quella riga e il silenzio c'e' `callLLM` (stato `S`, attesa di rete) e poi
 * `repairLlmJson` sulla risposta (stato `R`). Lo spin e' QUI dentro.
 *
 * PERCHE'. `decideQuoteCloses`, `afterSeparatorLooksValid`,
 * `looksLikeJsonContinuation`, `scanValueEnd`, `scanStringEnd` e
 * `findMatchingClose` sono mutuamente ricorsive, e nessuna ricordava una
 * risposta gia' calcolata. Il commento di `looksLikeJsonContinuation` dice che
 * la catena «non puo' accumulare profondita' di stack oltre il numero di
 * chiavi»: e' vero sulla PROFONDITA' e falso sul LAVORO. `scanStringEnd`
 * riprova su OGNI virgoletta interna, e `afterSeparatorLooksValid` esplora due
 * alternative (la chiave con i due punti, e la continuazione) — due rami per
 * posizione, ripetuti a ogni livello, cioe' 2^k.
 *
 * Misurato su `{"body1":"` + `"chiave": "valore", ` × n + `fine"}` — la forma
 * che un modello produce quando inlinea uno pseudo-JSON dentro un campo di
 * prosa senza escapare le virgolette:
 *
 *   n=20  416 char     668 ms
 *   n=25  516 char  21.270 ms      (×2,4 per ripetizione: esponenziale)
 *   n=30  616 char  ~11 minuti     ← la finestra osservata nella run
 *
 * 516 caratteri per 21 secondi. Su una risposta da 30 KB non finisce mai.
 *
 * IL RIMEDIO. `decideQuoteCloses(str, idx, fix)` e `scanStringEnd(str, i, fix)`
 * sono funzioni PURE dei loro argomenti, e la ricorsione e' strettamente
 * crescente sull'indice (ogni chiamata annidata parte da una posizione
 * maggiore), quindi non ci sono cicli e memoizzarle non cambia UNA risposta:
 * toglie solo il ricalcolo. Il ramo esponenziale collassa perche' ogni
 * posizione viene decisa una volta sola.
 *
 * NON un timeout, e non un cap sulla lunghezza: un timeout nasconde lo spin e
 * un cap butterebbe via l'articolo. Qui la semantica resta identica — e' il
 * test `llm-json-repair-blowup.test.mjs` a dimostrarlo, confrontando l'output
 * riparato su tutte le forme del caso.
 */
let _memoSrc = null;
let _memoFix = null;
let _memoQuoteCloses = null;
let _memoStringEnd = null;

/**
 * Prepara (e riempie) il memo per `str`. Il riempimento e' DAL FONDO VERSO
 * L'INIZIO, e non e' un'ottimizzazione: e' cio' che tiene la profondita' di
 * stack costante.
 *
 * `_decideQuoteCloses(str, q, fix)` guarda solo posizioni > q — direttamente,
 * e attraverso `afterSeparatorLooksValid` → `scanValueEnd` → `scanStringEnd`,
 * che a loro volta ripartono da un indice maggiore. E' la stessa proprieta'
 * che rende la memoizzazione lecita (nessun ciclo), e qui la si usa una
 * seconda volta: calcolando le virgolette in ordine di indice DECRESCENTE,
 * ogni chiamata annidata trova la sua risposta gia' nel memo e torna subito.
 * Lo stack non annida piu' una volta per chiave — resta a due o tre frame,
 * qualunque sia la lunghezza della risposta.
 *
 * Senza questo passaggio la sola memoizzazione toglieva il tempo esponenziale
 * ma non la profondita': `RangeError: Maximum call stack size exceeded`
 * misurato su 30 KB, cioe' sulla taglia normale di una risposta di questa
 * pipeline. Uno stack overflow qui non e' meno grave dello spin — butta
 * l'articolo con un errore che non nomina nemmeno questo modulo.
 *
 * Le chiamate ricorsive rientrano in `_memoFor`, ma con `str`/`fixAsterisks`
 * gia' registrati: il controllo di identita' le fa uscire subito, quindi il
 * riempimento non si ri-annida. Non serve un flag di reentrancy, serve
 * assegnare `_memoSrc`/`_memoFix` PRIMA del giro (ed e' fatto).
 */
function _memoFor(str, fixAsterisks) {
  if (_memoSrc === str && _memoFix === fixAsterisks) return;
  _memoSrc = str;
  _memoFix = fixAsterisks;
  _memoQuoteCloses = new Map();
  _memoStringEnd = new Map();
  for (let q = str.length - 1; q >= 0; q--) {
    if (str[q] !== '"' || isEscapedAt(str, q)) continue;
    if (!_memoQuoteCloses.has(q)) {
      _memoQuoteCloses.set(q, _decideQuoteCloses(str, q, fixAsterisks));
    }
  }
}

/** Index of the bracket/brace matching the opener at openIdx.
 *
 * Skips over string content using scanStringEnd's quote-disambiguation
 * (`fixAsterisks` must match the caller's setting) rather than a naive
 * unescaped-quote toggle: a nested string value can itself legitimately
 * contain a lone stray unescaped quote (an odd count before the real
 * closer — e.g. a quoted term missing its closing mark), which flips a
 * naive toggle's parity and makes depth-counting skip past or never reach
 * the true matching bracket, returning -1 or a wrong earlier close and
 * corrupting the *preceding* sibling field's own valid closing quote
 * (confirmed regression, issue #3604: `{"imagePrompt":"...","imageAlt":
 * {"it":"...torre "di Lugano...","en":"..."}}`, odd embedded quote count
 * in `it` → old toggle desyncs → `imagePrompt` itself gets corrupted). */
export function findMatchingClose(src, openIdx, fixAsterisks = false) {
  const open = src[openIdx];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      const strEnd = scanStringEnd(src, i, fixAsterisks);
      if (strEnd === -1) return -1;
      i = strEnd - 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Walk a JSON-ish string once, fixing:
 *  - literal newlines/CR inside string values -> \n (CR dropped)
 *  - unescaped inner double-quotes inside string values -> \"
 *  - (optional) stray markdown-bold `*`/`**` OUTSIDE strings -> `,`
 *
 * Unescaped-quote handling: once inside a string, a `"` only closes it if
 * the next non-whitespace char is a structural JSON token (`}` `]`) or end
 * of input — otherwise it's a literal quote the model forgot to escape
 * (common when source text already contains a quoted phrase, e.g. a title
 * like `..."tassa sulla salute"...` echoed into a generated answer) and
 * gets escaped instead of prematurely terminating the string and
 * desyncing the rest of the parse (`Unterminated string in JSON`).
 *
 * `,` and `:` are NOT trustworthy closers on their own: Italian prose
 * routinely follows a quoted phrase with a comma or colon (`..."tassa
 * sulla salute", che è controversa.` or `..."tassa": significa...`), which
 * looks identical to a real property/array separator. For those two, also
 * check that what follows is a genuine JSON value (string/number/bool/null/
 * object/array) immediately followed by a genuine continuation of its own —
 * recursively, since a quoted phrase is itself only "real" if it too closes
 * cleanly (a bare `"..."` start is not enough: `..."tassa": "un tributo"
 * imposto...` and `..."tassa", "un tributo", e discusso...` both start like
 * a real key/value or array element but the chain dead-ends in lowercase
 * prose a token further out, e.g. `imposto`/`e discusso` — vs. a genuine
 * `"b":"next"}` where the chain of value+continuation resolves cleanly all
 * the way to a real closer). A bare digit-start or `true`/`false`/`null`-
 * start is not enough either: Italian prose routinely puts a number right
 * after a quoted phrase + comma/colon (prices, percentages, counts —
 * `..."tassa": 8% del prezzo.`) or a negative number (`..."forte": -5%
 * ieri.`), which starts like a JSON number but isn't one — a number/literal
 * is only trusted if what follows it is also a structural continuation.
 */

/** True if the char at str[idx] is an unescaped quote, counting a run of
 * backslashes immediately before it (odd count means the quote is escaped). */
function isEscapedAt(str, idx) {
  let backslashes = 0;
  for (let p = idx - 1; p >= 0 && str[p] === '\\'; p--) backslashes++;
  return backslashes % 2 === 1;
}

/** Nearest unescaped quote before `beforeIdx`, or -1. Used to find a short
 * candidate key's own opening quote — safe only for keys, which (unlike
 * values) never legitimately contain their own embedded quote. */
function findPrecedingUnescapedQuote(str, beforeIdx) {
  for (let p = beforeIdx - 1; p >= 0; p--) {
    if (str[p] === '"' && !isEscapedAt(str, p)) return p;
  }
  return -1;
}

/** True if position `idx` is immediately preceded (past whitespace) by a
 * real separator (`,` or `{`) or by the very start of the input — i.e. it
 * looks like a freshly-opened key/value rather than a position reached
 * while some other string was already open.
 *
 * When `fixAsterisks` is set, a `*` run also counts as a separator, same
 * as the main loop's own forward rule (`fixAsterisks && next === '*'`
 * unconditionally trusts an asterisk boundary as a closer): since the main
 * loop only ever treats `*` as convertible while outside a string, a `*`
 * run can only occur right after a quote that itself closed — so landing
 * on that quote after skipping the run is trusted fresh too, mirroring the
 * forward rule's trust instead of re-deriving it via backward recursion. */
function precededByFreshOpen(str, idx, fixAsterisks) {
  let p = idx - 1;
  while (p >= 0 && /\s/.test(str[p])) p--;
  if (fixAsterisks && str[p] === '*') {
    while (p >= 0 && str[p] === '*') p--;
    while (p >= 0 && /\s/.test(str[p])) p--;
    return p < 0 || str[p] === ',' || str[p] === '{' || (str[p] === '"' && !isEscapedAt(str, p));
  }
  return p < 0 || str[p] === ',' || str[p] === '{';
}

/**
 * Does the (already known to be un-escaped) quote at str[quoteIdx] act as a
 * genuine closer? Shared by the main repair loop below and scanValueEnd's
 * string-lookahead so a quote nested inside a lookahead value is judged by
 * the exact same rule as a top-level one — a naive "first unescaped quote
 * ends the string" lookahead is wrong here precisely because the value
 * being validated may itself be a broken, not-yet-repaired string with its
 * own embedded literal quote (the same malformed shape this whole module
 * exists to fix), so it needs the full disambiguation, not a shortcut.
 *
 * When `next` is ':', str[quoteIdx] is being tested as the end of a KEY —
 * but a colon happening to follow isn't enough (Italian prose routinely
 * reads `..."tassa": "un tributo" imposto...`, where "tassa" is mid-prose,
 * not a key). A genuine key must itself have been freshly opened right
 * after a real `,`/`{`, not reached while another string was already open.
 *
 * A `*` run right after the quote isn't trusted unconditionally either —
 * bold markdown routinely sits INSIDE a still-open string right after an
 * earlier stray quote (`"testo "citato" **grassetto** fine."`), so what
 * follows the run must itself look like a fresh continuation, same as the
 * comma/colon branches below. Blind trust here closed the string early and
 * corrupted everything after it, including unrelated sibling JSON keys
 * (issue #3618 item 2).
 */
function decideQuoteCloses(str, quoteIdx, fixAsterisks) {
  _memoFor(str, fixAsterisks);
  const cached = _memoQuoteCloses.get(quoteIdx);
  if (cached !== undefined) return cached;
  const decided = _decideQuoteCloses(str, quoteIdx, fixAsterisks);
  _memoQuoteCloses.set(quoteIdx, decided);
  return decided;
}

function _decideQuoteCloses(str, quoteIdx, fixAsterisks) {
  let j = quoteIdx + 1;
  while (j < str.length && /\s/.test(str[j])) j++;
  const next = str[j];
  if (next === undefined || next === '}' || next === ']') {
    return true;
  }
  if (fixAsterisks && next === '*') {
    let k = j;
    while (k < str.length && str[k] === '*') k++;
    return afterSeparatorLooksValid(str, k, false, fixAsterisks);
  }
  if (next === ':') {
    const keyOpen = findPrecedingUnescapedQuote(str, quoteIdx);
    if (keyOpen === -1 || !precededByFreshOpen(str, keyOpen, fixAsterisks)) return false;
  }
  if (next === ',' || next === ':') {
    return afterSeparatorLooksValid(str, j + 1, next === ':', fixAsterisks);
  }
  return false;
}

/** End index just past a plausible JSON value starting at str[i], or -1.
 * `fixAsterisks` must match the caller's setting — this lookahead has to
 * agree with the real main-loop pass on whether a bare `*` run is a
 * structural comma-stand-in or literal content, or it can mis-scan across
 * an asterisk boundary the main loop would have converted.
 *
 * A `{`/`[` value must scan all the way to its real matching close (via
 * findMatchingClose), not just past the opening bracket — an early `i + 1`
 * return left `looksLikeJsonContinuation` checking the character right
 * after the bracket (the nested value's own first key/element, never a
 * valid top-level continuation), so it always rejected. That falsely
 * rejected any string value immediately followed by a nested-object/array
 * sibling — exactly `"imagePrompt": "...", "imageAlt": {"it": ...}`, used
 * in every article-generation prompt — cascading into "Expected ',' or
 * '}'" on the article's *own* well-formed imagePrompt string (run
 * 28751915972, confirmed post-#3597, 2026-07-05). */
function scanValueEnd(str, i, fixAsterisks) {
  if (i >= str.length) return -1;
  const ch = str[i];
  if (ch === '{' || ch === '[') {
    const closeIdx = findMatchingClose(str, i, fixAsterisks);
    return closeIdx === -1 ? -1 : closeIdx + 1;
  }
  if (ch === '"') return scanStringEnd(str, i, fixAsterisks);
  const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(str.slice(i));
  if (numMatch && numMatch[0]) return i + numMatch[0].length;
  const kwMatch = /^(?:true|false|null)\b/.exec(str.slice(i));
  if (kwMatch) return i + kwMatch[0].length;
  return -1;
}

/** Index just past a string's real closing quote (str[i] must be '"'), using
 * decideQuoteCloses to skip stray embedded unescaped quotes rather than
 * stopping at the first one. -1 if unterminated. Shared by scanValueEnd and
 * findMatchingClose so both treat "does this quote really close the
 * string?" identically. */
function scanStringEnd(str, i, fixAsterisks) {
  _memoFor(str, fixAsterisks);
  const cached = _memoStringEnd.get(i);
  if (cached !== undefined) return cached;
  const end = _scanStringEnd(str, i, fixAsterisks);
  _memoStringEnd.set(i, end);
  return end;
}

function _scanStringEnd(str, i, fixAsterisks) {
  let j = i + 1;
  while (j < str.length) {
    if (str[j] === '\\') { j += 2; continue; }
    if (str[j] === '"') {
      if (decideQuoteCloses(str, j, fixAsterisks)) return j + 1;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

/** Strict: first unescaped quote closes, no retry. A JSON key is a simple
 * field name and never legitimately contains its own embedded quote, so a
 * candidate that only "closes" by skipping past an embedded quote is
 * exactly the ambiguous prose shape afterSeparatorLooksValid's comma-branch
 * must reject, not a shortcut worth taking. */
function scanKeyEnd(str, i) {
  let j = i + 1;
  while (j < str.length) {
    if (str[j] === '\\') { j += 2; continue; }
    if (str[j] === '"') return j + 1;
    j++;
  }
  return -1;
}

/**
 * True if what follows a separator (a real `:`, a real `,`, or — when
 * `fixAsterisks` is set — a `*` run the main loop would convert to `,`)
 * looks like a valid JSON continuation, given `afterSepPos` already points
 * just past that separator. A colon expects a value (lenient: values
 * legitimately contain embedded quotes, e.g. prose). A comma/asterisk-run
 * first tries a fresh key: unlike a value, a key can't legitimately contain
 * its own embedded quote, so it's scanned strictly and must be followed by
 * a real colon — this is what rejects `"tassa", "un tributo", e discusso.`
 * (no colon after the strictly-scanned "un tributo") while still accepting
 * `"a":"...","b":"..."` (each key strictly closes, colon follows).
 *
 * If the key interpretation fails, a comma can still be a genuine
 * separator between bare VALUES, not just object entries (`["a","b"]`) —
 * rejecting outright here corrupted every bare string-array element
 * (issue #3602). But the fallback must reuse the SAME strict, no-retry
 * close (scanKeyEnd) rather than the permissive scanValueEnd/scanStringEnd
 * used for real values below: that permissive scanner is designed to skip
 * past an ambiguous embedded quote and keep looking for a later real
 * closer, which is exactly wrong for this candidate — it let a deliberate
 * prose aside (`"tassa", "un tributo", e discusso.`) telescope all the way
 * to the string's true end and get mistaken for a valid fresh value.
 */
function afterSeparatorLooksValid(str, afterSepPos, isColon, fixAsterisks) {
  return resolveLookahead(str, afterSepPos, isColon ? SEP_COLON : SEP_COMMA, fixAsterisks);
}

/**
 * True if `str` starting at `pos` is either end-of-input / a structural
 * closer, or a `, value` / `: value` / (fixAsterisks) `*...* value`
 * continuation that itself resolves. Il `*` run case matters because a
 * value can end exactly at an asterisk boundary the real main loop would
 * convert to a comma (e.g. `"bold text"***"b"`) — this lookahead has to
 * recognize that same convention or it wrongly rejects a value the main
 * loop would accept.
 */
function looksLikeJsonContinuation(str, pos, fixAsterisks) {
  return resolveLookahead(str, pos, CONTINUATION, fixAsterisks);
}

const CONTINUATION = 0;
const SEP_COLON = 1;
const SEP_COMMA = 2;

/**
 * `afterSeparatorLooksValid` e `looksLikeJsonContinuation` erano mutuamente
 * ricorsive, e OGNI chiamata fra le due era in posizione di coda: la coppia e'
 * quindi una macchina a stati su `(pos, modo)`, e qui e' scritta come tale.
 * La riscrittura non cambia una risposta — e' la stessa identica sequenza di
 * decisioni, senza un frame di stack per passo.
 *
 * PERCHE' NON BASTAVA MEMOIZZARE. Il memo su `decideQuoteCloses` /
 * `scanStringEnd` toglie il ricalcolo esponenziale (n=25 da 21.270 ms a 0,6
 * ms), ma non la PROFONDITA': appena il ramo esponenziale smette di scadere il
 * tempo, lo stesso input arriva in fondo alla catena e la fa sfondare —
 * misurato, `RangeError: Maximum call stack size exceeded` a n=1500 su
 * `{"body1":"` + `"chiave": "valore", ` × n + `fine"}`, cioe' su una risposta
 * da 30 KB, che e' la taglia normale di questa pipeline. Uno stack overflow
 * qui non e' meno grave dello spin: butta l'articolo con un errore che non
 * nomina il modulo.
 *
 * TERMINAZIONE, dimostrata e non sperata: `p` cresce STRETTAMENTE a ogni giro.
 * Da CONTINUATION si passa a un separatore con `p = i + 1 > p`; da un
 * separatore si passa a CONTINUATION con `p = valueEnd`, e `scanValueEnd`
 * restituisce sempre un indice maggiore della posizione da cui parte (o -1,
 * che esce). Quindi il ciclo fa al massimo `str.length` giri.
 */
function resolveLookahead(str, pos, mode, fixAsterisks) {
  let p = pos;
  let m = mode;
  for (;;) {
    let i = p;
    while (i < str.length && /\s/.test(str[i])) i++;

    if (m === CONTINUATION) {
      if (i >= str.length) return true;
      const ch = str[i];
      if (ch === '}' || ch === ']') return true;
      if (fixAsterisks && ch === '*') {
        let k = i;
        while (k < str.length && str[k] === '*') k++;
        p = k; m = SEP_COMMA;
        continue;
      }
      if (ch !== ',' && ch !== ':') return false;
      p = i + 1; m = (ch === ':') ? SEP_COLON : SEP_COMMA;
      continue;
    }

    if (m === SEP_COLON) {
      const valueEnd = scanValueEnd(str, i, fixAsterisks);
      if (valueEnd === -1) return false;
      p = valueEnd; m = CONTINUATION;
      continue;
    }

    // SEP_COMMA
    if (str[i] === '"') {
      const keyEnd = scanKeyEnd(str, i);
      if (keyEnd === -1) return false;
      let k = keyEnd;
      while (k < str.length && /\s/.test(str[k])) k++;
      if (str[k] === ':') { p = k + 1; m = SEP_COLON; continue; }
      p = keyEnd; m = CONTINUATION;
      continue;
    }
    const valueEnd = scanValueEnd(str, i, fixAsterisks);
    if (valueEnd === -1) return false;
    p = valueEnd; m = CONTINUATION;
  }
}

/**
 * Build a log-ready excerpt of `repairedText` centered on the byte offset a
 * `JSON.parse()` SyntaxError reports, so the logged snippet actually shows
 * the character that broke parsing.
 *
 * `repairedText` MUST be the exact string passed to `JSON.parse()` (i.e. the
 * repairLlmJson/repairJsonArray OUTPUT), not the original raw LLM response.
 * repairLlmJson/repairJsonArray change the string's length (escaping inner
 * quotes, collapsing `\n`, stripping code fences), so a `raw[0:300]` snippet
 * of the PRE-repair text logged next to a POST-repair error position points
 * at an unrelated byte — every "JSON parse fallito" log produced this way is
 * undiagnosable (confirmed by hand-reconstructing run 28744325535's logged
 * position against its logged raw snippet: they land on different
 * characters). Node's `SyntaxError.message` embeds the offset as
 * `at position N`; when present, this returns a window around N in
 * `repairedText` instead of an arbitrary prefix.
 */
export function describeJsonParseError(repairedText, parseErr, contextChars = 120) {
  const str = String(repairedText);
  const m = /position (\d+)/.exec(parseErr?.message || '');
  if (!m) {
    return `repaired[0:${contextChars * 2}]: ${str.slice(0, contextChars * 2).replace(/\n/g, '\\n')}`;
  }
  const pos = Math.min(Number(m[1]), str.length);
  const start = Math.max(0, pos - contextChars);
  const end = Math.min(str.length, pos + contextChars);
  const before = str.slice(start, pos).replace(/\n/g, '\\n');
  const after = str.slice(pos, end).replace(/\n/g, '\\n');
  return `repaired[${start}:${end}] around position ${pos}: ${before}<<HERE>>${after}`;
}

/**
 * Bounded raw (pre-repair) text snippet for diagnosing residual repair gaps
 * that describeJsonParseError() cannot show — its position windows around
 * the POST-repair string, which is undiagnosable on its own when the repair
 * itself is what's still wrong (repairLlmJson/repairJsonArray change the
 * string's length via escaping/fence-stripping, so that offset doesn't map
 * back into the untouched completion). Log this alongside it so the next
 * occurrence of a still-unparseable repaired string can actually be
 * root-caused from the real input instead of guessed at.
 *
 * When the completion exceeds maxChars the budget is split 50/50 between
 * head and tail so a single log line covers both the early imagePrompt/
 * imageAlt zone AND the late body2/body3/faq zone — article-generation
 * completions can reach 24-32k chars and a head-only window misses defects
 * that land deep in the tail. \r\n and \r are normalised to \n before
 * escaping so a raw completion with CRLF endings can't break one-event-
 * per-line log consumers.
 */
export function describeRawForDiagnostics(raw, maxChars = 4000) {
  const str = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (str.length <= maxChars) {
    return `raw[0:${str.length}]: ${str.replace(/\n/g, '\\n')}`;
  }
  const headChars = Math.ceil(maxChars / 2);
  const tailChars = maxChars - headChars;
  const tailStart = str.length - tailChars;
  const head = str.slice(0, headChars).replace(/\n/g, '\\n');
  const tail = str.slice(tailStart).replace(/\n/g, '\\n');
  const omitted = tailStart - headChars;
  return `raw[0:${headChars}]...[${tailStart}:${str.length}] (total ${str.length}, ${omitted} omitted): ${head} ...[omitted]... ${tail}`;
}

export function fixJsonStringBody(input, { fixAsterisks = false } = {}) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') {
      if (!inStr) {
        inStr = true;
        out += ch;
        continue;
      }
      if (decideQuoteCloses(input, i, fixAsterisks)) {
        inStr = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') continue;
    if (fixAsterisks && !inStr && ch === '*') {
      while (i + 1 < input.length && input[i + 1] === '*') i++;
      out += ',';
      continue;
    }
    out += ch;
  }
  return out;
}
