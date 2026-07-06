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
 */
function decideQuoteCloses(str, quoteIdx, fixAsterisks) {
  let j = quoteIdx + 1;
  while (j < str.length && /\s/.test(str[j])) j++;
  const next = str[j];
  if (next === undefined || next === '}' || next === ']' || (fixAsterisks && next === '*')) {
    return true;
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
 * expects a fresh key: unlike a value, a key can't legitimately contain its
 * own embedded quote, so it's scanned strictly and must be followed by a
 * real colon — this is what rejects `"tassa", "un tributo", e discusso.`
 * (no colon after the strictly-scanned "un tributo") while still accepting
 * `"a":"...","b":"..."` (each key strictly closes, colon follows).
 */
function afterSeparatorLooksValid(str, afterSepPos, isColon, fixAsterisks) {
  let i = afterSepPos;
  while (i < str.length && /\s/.test(str[i])) i++;
  if (isColon) {
    const valueEnd = scanValueEnd(str, i, fixAsterisks);
    return valueEnd !== -1 && looksLikeJsonContinuation(str, valueEnd, fixAsterisks);
  }
  if (str[i] === '"') {
    const keyEnd = scanKeyEnd(str, i);
    if (keyEnd === -1) return false;
    let m = keyEnd;
    while (m < str.length && /\s/.test(str[m])) m++;
    if (str[m] !== ':') return false;
    return afterSeparatorLooksValid(str, m + 1, true, fixAsterisks);
  }
  const valueEnd = scanValueEnd(str, i, fixAsterisks);
  return valueEnd !== -1 && looksLikeJsonContinuation(str, valueEnd, fixAsterisks);
}

/**
 * True if `str` starting at `pos` is either end-of-input / a structural
 * closer, or a `, value` / `: value` / (fixAsterisks) `*...* value`
 * continuation that itself resolves (afterSeparatorLooksValid recurses
 * forward for chained keys, so a long chain still can't build up unbounded
 * stack depth beyond the key count). The `*` run case matters because a
 * value can end exactly at an asterisk boundary the real main loop would
 * convert to a comma (e.g. `"bold text"***"b"`) — this lookahead has to
 * recognize that same convention or it wrongly rejects a value the main
 * loop would accept.
 */
function looksLikeJsonContinuation(str, pos, fixAsterisks) {
  let i = pos;
  while (i < str.length && /\s/.test(str[i])) i++;
  if (i >= str.length) return true;
  const ch = str[i];
  if (ch === '}' || ch === ']') return true;
  if (fixAsterisks && ch === '*') {
    let k = i;
    while (k < str.length && str[k] === '*') k++;
    return afterSeparatorLooksValid(str, k, false, fixAsterisks);
  }
  if (ch !== ',' && ch !== ':') return false;
  return afterSeparatorLooksValid(str, i + 1, ch === ':', fixAsterisks);
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
 */
export function describeRawForDiagnostics(raw, maxChars = 4000) {
  const str = String(raw ?? '');
  const truncated = str.length > maxChars;
  return `raw[0:${Math.min(str.length, maxChars)}]${truncated ? ` (troncato, totale ${str.length})` : ''}: ${str.slice(0, maxChars).replace(/\n/g, '\\n')}`;
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
