/**
 * Convert a JS object-literal source string (as written in services/seo/*.ts
 * structuredData literals) into a JSON string parseable by JSON.parse.
 *
 * Handles: unquoted keys, single-quoted strings (incl. Italian apostrophes
 * like l'imposta), template literals, trailing commas, and the two build-time
 * substitutions BUILD_DATE_ISO and BASE_URL.
 *
 * Single source of truth: staticPagesPlugin's structuredData emit step and the
 * regression guard tests/static-pages-seo-entry-lookup.test.ts BOTH import this
 * function. The guard previously re-implemented the substitution/parse logic
 * locally (`toJson`), which could stay green while the real emitter diverged —
 * exactly the silent-drift failure class the guard exists to catch (#2256).
 * Keeping one implementation makes that drift impossible by construction.
 *
 * @param js   the raw JS object-literal source
 * @param opts build-time substitution values:
 *   - baseUrl:      origin substituted for `${BASE_URL}` / bare `BASE_URL`
 *   - buildDateIso: ISO timestamp substituted for `BUILD_DATE_ISO`
 */
export const jsToJson = (
  js: string,
  opts: { baseUrl: string; buildDateIso: string },
): string => {
  const { baseUrl, buildDateIso } = opts;
  let s = js;
  // Replace BUILD_DATE_ISO variable reference with the build timestamp
  s = s.replace(/\bBUILD_DATE_ISO\b/g, `"${buildDateIso}"`);
  // Replace ${BASE_URL} template literals AND bare BASE_URL variable references
  s = s.replace(/\$\{BASE_URL\}/g, baseUrl);
  s = s.replace(/\bBASE_URL\b/g, `"${baseUrl}"`);
  // Replace backtick strings with double-quoted strings
  s = s.replace(/`([^`]*)`/g, (_, content: string) => JSON.stringify(content));
  // Single-pass scanner: convert single-quoted strings to double-quoted,
  // quote unquoted keys, and skip double-quoted string regions.
  // This avoids the apostrophe-in-Italian-text problem where a naive regex
  // would misinterpret l'imposta as a string boundary.
  {
    let out = '';
    let i = 0;
    while (i < s.length) {
      // Skip double-quoted strings verbatim
      if (s[i] === '"') {
        let j = i + 1;
        while (j < s.length) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '"') { j++; break; }
          j++;
        }
        out += s.substring(i, j);
        i = j;
        continue;
      }
      // Convert single-quoted strings to double-quoted (only at value positions)
      if (s[i] === "'") {
        let j = i + 1;
        let content = '';
        while (j < s.length) {
          if (s[j] === '\\' && j + 1 < s.length) {
            const next = s[j + 1];
            if (next === "'") { content += "'"; j += 2; continue; }
            content += s[j] + next; j += 2; continue;
          }
          if (s[j] === "'") { j++; break; }
          content += s[j]; j++;
        }
        // Escape double quotes inside the converted string
        const escaped = content.replace(/"/g, '\\"');
        out += `"${escaped}"`;
        i = j;
        continue;
      }
      // Try to match an unquoted key (word followed by :)
      const prev = i > 0 ? s[i - 1] : '\n';
      if (/[{,[\s]/.test(prev)) {
        const m = s.substring(i).match(/^([a-zA-Z_$][\w$]*)(\s*:\s*)/);
        if (m) {
          out += `"${m[1]}"${m[2]}`;
          i += m[0].length;
          continue;
        }
      }
      out += s[i];
      i++;
    }
    s = out;
  }
  // Remove trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s;
};
