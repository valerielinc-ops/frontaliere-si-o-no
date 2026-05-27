/**
 * Static-source guard: ensures no `inLanguage` property is assigned to a
 * Schema.org type that does NOT support it (BreadcrumbList, ItemList,
 * Place, Organization, SoftwareApplication, WebApplication).
 *
 * Complements `inlanguage-whitelist.test.ts`, which only covers the
 * runtime `services/seoService.ts` injection path. This test scans every
 * build-plugin source file directly so static-HTML regressions are
 * caught at PR time — no full Vite build required.
 *
 * Root cause for issue: Semrush flagged ~8k `inLanguage` errors on
 * BreadcrumbList / ItemList because schema.org rejects the property on
 * those types (it lives on `CreativeWork` and subtypes only).
 *
 * Implementation note: the previous version used a naive char-by-char
 * brace counter that (a) didn't track string boundaries (so `{` inside
 * template literals corrupted the stack) and (b) only matched bare
 * `inLanguage:` keys, missing the quoted `"inLanguage":` form that
 * makes up the bulk of `services/seo/seo-pages.ts`. We now mirror
 * `build-plugins/staticPagesPlugin.ts` extractBalanced + jsToJson +
 * recursive tree-walk approach, which is JSON-correct.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// @types that do NOT accept inLanguage per schema.org. Anything else flagged
// here was a false-positive: see services/seo/inlanguage-whitelist.ts for the
// canonical positive list (CreativeWork descendants + Event + JobPosting +
// Product). SoftwareApplication / WebApplication are CreativeWork descendants
// and DO accept inLanguage despite an earlier comment claiming otherwise.
const FORBIDDEN = new Set([
  'BreadcrumbList',
  'ItemList',
  'Place',
  'Organization',
  'LocalBusiness',
  'Offer',
]);

const ROOTS = ['build-plugins', 'services/seo', 'services/seoService.ts'];

interface Offender {
  readonly file: string;
  readonly schemaType: string;
  readonly path: string;
  readonly fingerprint: string;
}

function* walk(dir: string): Iterable<string> {
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    yield dir;
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(entry.name)) yield p;
  }
}

/**
 * Extract a balanced { ... } or [ ... ] block starting at `pos`.
 * String-aware: braces inside ', ", or ` strings are ignored. Mirrors
 * `build-plugins/staticPagesPlugin.ts` extractBalanced.
 */
function extractBalanced(src: string, pos: number): string | null {
  const open = src[pos];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0;
  let inStr = false;
  let strChar = '';
  for (let j = pos; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === strChar) inStr = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = true; strChar = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.substring(pos, j + 1); }
  }
  return null;
}

/**
 * Convert a TS object/array literal into JSON. Handles:
 * - Template literals (`...`) → JSON string with placeholder for ${...}
 * - Single-quoted strings → double-quoted
 * - Unquoted keys → quoted keys
 * - Bare identifier values (BUILD_DATE_ISO, BASE_URL, …) → placeholder string
 * - Trailing commas
 * - // line comments
 *
 * Lossy by design: the goal is structural parseability, not value fidelity.
 * We only need the resulting tree to be walkable so we can inspect @type /
 * inLanguage relationships.
 */
function jsToJson(js: string): string {
  let s = js;

  // Strip // line comments (but not inside strings — handled by scanner below).
  // Quick-and-dirty: only strip lines whose // is unambiguously a comment
  // (preceded by whitespace or line start). We keep this minimal because
  // the scanner below is already string-aware.

  // Replace template literals with JSON strings, substituting ${...} with
  // a placeholder so braces inside don't confuse the structural parse.
  s = s.replace(/`([^`]*)`/g, (_, content: string) => {
    const sanitized = String(content).replace(/\$\{[^}]*\}/g, '__EXPR__');
    return JSON.stringify(sanitized);
  });

  // Single-pass scanner: convert single-quoted strings to double-quoted,
  // quote unquoted keys, replace bare identifier values with placeholder,
  // strip // line comments. All transforms are string-aware so regex-inside-
  // string corruption (e.g. `: AVS,` inside a description) cannot happen.
  let out = '';
  let i = 0;
  while (i < s.length) {
    // Pass through double-quoted strings verbatim
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
    // Convert single-quoted strings to double-quoted
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
      out += `"${content.replace(/"/g, '\\"')}"`;
      i = j;
      continue;
    }
    // Strip // line comments
    if (s[i] === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    // Quote unquoted keys: only when preceded by `{`, `,`, `[`, or whitespace
    const prev = i > 0 ? s[i - 1] : '\n';
    if (/[{,[\s]/.test(prev)) {
      const keyMatch = s.substring(i).match(/^([a-zA-Z_$][\w$]*)(\s*:)/);
      if (keyMatch) {
        out += `"${keyMatch[1]}"${keyMatch[2]}`;
        i += keyMatch[0].length;
        continue;
      }
    }
    // Bare identifier as VALUE (after `:` and optional whitespace).
    // Detect by looking at the previous non-whitespace char in `out`.
    const prevNonWs = out.replace(/\s+$/, '').slice(-1);
    if (prevNonWs === ':') {
      const valMatch = s.substring(i).match(/^([a-zA-Z_$][\w$]*)/);
      if (valMatch) {
        const ident = valMatch[1];
        if (ident === 'true' || ident === 'false' || ident === 'null') {
          out += ident;
        } else {
          // BUILD_DATE_ISO, BASE_URL, SOME_CONST, etc. → placeholder
          out += '"__IDENT__"';
        }
        i += ident.length;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  s = out;

  // Trailing commas
  s = s.replace(/,(\s*[}\]])/g, '$1');

  return s;
}

/**
 * Recursively walk a JSON-parsed tree, calling `visit(node)` for every
 * object encountered (arrays are descended into transparently).
 */
function walkTree(node: unknown, currentPath: string, visit: (obj: Record<string, unknown>, p: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, idx) => walkTree(item, `${currentPath}[${idx}]`, visit));
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    visit(obj, currentPath);
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object') {
        walkTree(val, `${currentPath}.${key}`, visit);
      }
    }
  }
}

/**
 * Find every literal object/array following a `structuredData:` token,
 * plus every standalone object literal containing `@type`. Each extracted
 * block is JSON-converted and walked.
 */
function scanFile(file: string): readonly Offender[] {
  const src = fs.readFileSync(file, 'utf8');
  const offenders: Offender[] = [];

  // Collect candidate (start position, raw block) entries: every `[`/`{`
  // that follows a `structuredData:` token, AND every `{` whose body
  // contains an `@type` property at any nesting level. Dedupe by position.
  const candidates = new Map<number, string>();
  const coveredRanges: { start: number; end: number }[] = [];

  // 1. structuredData: blocks. Extract eagerly so we know the end and can
  //    use it as a covering range in pass 2 — otherwise every `@type`
  //    nested inside a structuredData block (the common case in
  //    services/seo/seo-blog*.ts, ~3-4 @types per block) re-triggers a
  //    backwards scan + extractBalanced and the test runs O(N*K) on
  //    multi-million-char source. Adding pass-1 ranges to coveredRanges
  //    drops the work to ~one extract per outer block.
  const sdRx = /\bstructuredData\s*:\s*/g;
  let sdMatch: RegExpExecArray | null;
  while ((sdMatch = sdRx.exec(src)) !== null) {
    const after = sdMatch.index + sdMatch[0].length;
    const ch = src[after];
    if (ch !== '{' && ch !== '[') continue;
    if (candidates.has(after)) continue;
    const block = extractBalanced(src, after);
    if (!block) continue;
    candidates.set(after, block);
    coveredRanges.push({ start: after, end: after + block.length });
  }

  // 2. Every `{` whose balanced body contains an `@type:` key. The
  //    structuredData: pass above already catches every seo-pages.ts
  //    style entry, but plugins may also build inline schema literals
  //    (e.g. `const sd = { '@type': 'Organization', inLanguage: ... }`)
  //    elsewhere — we widen coverage with a guarded backwards scan.
  //
  //    To keep this O(N) we cache covered ranges (from pass 1 + this
  //    pass): once a `{` block is added as a candidate, every nested
  //    @type inside it is considered already-handled (the recursive
  //    walkTree pass will descend into it).
  const typeRx = /['"]?@type['"]?\s*:/g;
  let tm: RegExpExecArray | null;
  while ((tm = typeRx.exec(src)) !== null) {
    // Skip if already inside a covered block
    if (coveredRanges.some((r) => tm!.index >= r.start && tm!.index < r.end)) continue;

    // Bounded backwards search for the enclosing `{`
    const searchStart = Math.max(0, tm.index - 8192);
    for (let k = tm.index - 1; k >= searchStart; k--) {
      if (src[k] !== '{') continue;
      // Skip template-literal interpolation `${`
      if (k > 0 && src[k - 1] === '$') continue;
      const block = extractBalanced(src, k);
      if (block && k + block.length > tm.index) {
        if (!candidates.has(k)) candidates.set(k, block);
        coveredRanges.push({ start: k, end: k + block.length });
        break;
      }
    }
  }

  for (const [pos, raw] of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsToJson(raw));
    } catch {
      continue; // un-parseable block — best-effort scan
    }
    walkTree(parsed, `${file}@${pos}`, (obj, p) => {
      const type = obj['@type'];
      if (typeof type === 'string' && FORBIDDEN.has(type) && Object.prototype.hasOwnProperty.call(obj, 'inLanguage')) {
        // Fingerprint by stable object identifiers (name + url + inLanguage)
        // so the same offender discovered through two enclosing brace
        // positions dedupes to one entry.
        const fingerprint = JSON.stringify({
          t: type,
          n: obj.name ?? null,
          u: obj.url ?? null,
          l: obj.inLanguage ?? null,
        });
        offenders.push({ file, schemaType: type, path: p, fingerprint });
      }
    });
  }

  return offenders;
}

describe('static guard — no inLanguage on forbidden schema types', () => {
  // Full parse of services/seo + build-plugins typically takes ~13-14s on
  // CI but has been observed to spike past 60s on slow runners (deploy
  // run #25104752154 timed out at 60s). 180s is well above the worst
  // observed wall while still failing fast if the parser ever loops.
  it('scans all build-plugin and seo source files for offenders', { timeout: 180_000 }, () => {
    const all: Offender[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        all.push(...scanFile(file));
      }
    }
    // Dedup: the same offender object is often discovered twice (once via
    // its enclosing structuredData: array, once via its own `{` opening
    // brace through the @type backwards scan). Collapse by fingerprint so
    // the failure message lists each real offender exactly once.
    const seen = new Set<string>();
    const unique = all.filter((o) => {
      const key = `${o.file}|${o.fingerprint}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    expect(
      unique.map((o) => `${o.file} (${o.schemaType}) @ ${o.path}`),
    ).toEqual([]);
  });
});
