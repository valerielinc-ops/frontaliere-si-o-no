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

/** Index of the bracket/brace matching the opener at openIdx, quote/escape aware. */
export function findMatchingClose(src, openIdx) {
  const open = src[openIdx];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
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
 * check that what follows looks like the start of an actual JSON token
 * (a key/value start, or a closer) rather than a lowercase prose word —
 * only then is the comma/colon trusted as structural. A bare digit-start or
 * `true`/`false`/`null`-start is not enough either: Italian prose routinely
 * puts a number right after a quoted phrase + comma/colon (prices,
 * percentages, counts — `..."tassa": 8% del prezzo.`) or a negative number
 * (`..."forte": -5% ieri.`), which starts like a JSON number but isn't one.
 * A number/literal is only trusted as a real token if what follows IT is
 * also a structural continuation (comma, closer, or end of input) rather
 * than more prose.
 */
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
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      const next = input[j];
      let closes = next === undefined || next === '}' || next === ']'
        || (fixAsterisks && next === '*');
      if (!closes && (next === ',' || next === ':')) {
        let k = j + 1;
        while (k < input.length && /\s/.test(input[k])) k++;
        const rest = input.slice(k);
        closes = rest === ''
          || /^["{}[\]]/.test(rest)
          || /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*(?:[,}\]]|$)/.test(rest)
          || /^(?:true|false|null)\b\s*(?:[,}\]]|$)/.test(rest);
      }
      if (closes) {
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
