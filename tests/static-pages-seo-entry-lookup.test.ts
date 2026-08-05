import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BASE_URL } from '../build-plugins/constants';
import { jsToJson } from '../build-plugins/shared/jsToJson';

/**
 * Regression gate for the seoMap key-form bug (June 2026).
 *
 * Hand-written SEO entries store canonicalPath WITH a trailing slash
 * ('/tasse-e-pensione/festivita-ticino/'), but the emit loop looked up
 * `url.path` (no trailing slash) and the dynamic glossary/border entries
 * inserted slash-less keys. Result: ~3.8k curated title/description/
 * structuredData entries were silently shadowed by the URL-derived
 * fallback ("Informazioni utili per frontalieri Svizzera-Italia: …"),
 * tanking SERP CTR on the highest-impression info pages (GSC: 19.5k
 * impressions / 48 clicks on the school-calendar page alone).
 *
 * Contract enforced here:
 *  1. Every seoMap.set/get/has call site goes through seoKey() so the
 *     key form can never diverge again.
 *  2. The entry-start regex accepts the 1-space indentation used by the
 *     space-compressed services/seo/*.ts files.
 *  3. End-to-end on the real source files: the parse regexes recover the
 *     curated entries for known high-impression pages.
 */

const ROOT = path.resolve(__dirname, '..');
const pluginSource = readFileSync(path.resolve(ROOT, 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');

describe('staticPagesPlugin seoMap key normalization', () => {
  it('routes every seoMap set/get/has through seoKey()', () => {
    const calls = pluginSource.match(/seoMap\.(?:set|get|has)\([^)\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    const unnormalized = calls.filter(c => !c.includes('seoKey('));
    expect(unnormalized).toEqual([]);
  });

  it('seoKey helper exists and yields trailing-slash form', () => {
    expect(pluginSource).toContain('const seoKey = (p: string): string =>');
  });

  it('entry-start regex accepts 1-space indentation (space-compressed seo files)', () => {
    expect(pluginSource).toMatch(/entryStartRx = \/\^\\s\{1,8\}/);
  });
});

describe('llmsTxtPlugin seo lookup key normalization', () => {
  // Same slash-divergence class: parseSitemapUrls strips trailing slashes,
  // so parseSeoEntries must key the map in the same slash-less form or every
  // hand-written entry (canonicalPath WITH slash) misses at lookup and the
  // llms.txt page index degrades to slug-derived labels.
  //
  // parseSeoEntries was extracted out of build-plugins/llmsTxtPlugin.ts into
  // scripts/lib/llms-txt-generator.mjs (issue #4881 Fase 3) so the
  // fast-publish pipeline can regenerate llms.txt outside a full Vite build;
  // llmsTxtPlugin.ts is now a thin wrapper with no logic of its own. These
  // assertions follow the code to its new location — the contract they
  // guard is unchanged.
  const llmsGeneratorSource = readFileSync(path.resolve(ROOT, 'scripts', 'lib', 'llms-txt-generator.mjs'), 'utf-8');

  it('parseSeoEntries keys the map in strip-slash form', () => {
    expect(llmsGeneratorSource).toContain("map.set(cp.replace(/\\/+$/, '') || '/', { title, desc });");
    expect(llmsGeneratorSource).not.toMatch(/map\.set\(cp,/);
  });

  // #2996: seo-pages.ts mixes single- and double-quoted `description:`/`title:`
  // values; the parser must read BOTH or the 4 double-quoted entries
  // (metodologia + 3 author pages) ship an empty llms.txt description.
  it('parseSeoEntries reads double-quoted title/description values', () => {
    // A shared helper now extracts title/description trying single- then
    // double-quoted values (was single-quote-only `descMatches`/`titleMatches`).
    expect(llmsGeneratorSource).toContain('lastQuoted');
    expect(llmsGeneratorSource).not.toContain('const descMatches');
    expect(llmsGeneratorSource).not.toContain('const titleMatches');
  });
});

describe('seo source files parse contract (real files)', () => {
  // Mirror of the plugin's entry scanner — keep in sync with
  // build-plugins/staticPagesPlugin.ts. Allowlist-free (#1898 item 2): a
  // candidate `key: {` is a real page entry iff its BALANCED object block
  // carries a top-level canonicalPath; nested structured-data properties at
  // indent 1 (offers, areaServed, a brand-new schema prop, …) are skipped
  // because they live inside an already-claimed entry and carry no canonicalPath.
  const extractBalanced = (src: string, pos: number): string | null => {
    const open = src[pos];
    const close = open === '{' ? '}' : open === '[' ? ']' : null;
    if (!close) return null;
    let depth = 0, inStr = false, strChar = '';
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
  };

  const parseEntries = (src: string): Map<string, { title: string; desc: string; sd: string }> => {
    const entryStartRx = /^\s{1,8}(?:'([^']+)'|([a-zA-Z_]\w*)):\s*\{/gm;
    const hasCanonicalPath = (b: string): boolean => /canonicalPath:\s*'[^']+'/.test(b);
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    let claimedUntil = -1;
    while ((m = entryStartRx.exec(src)) !== null) {
      if (m.index < claimedUntil) continue;
      const bracePos = m.index + m[0].length - 1;
      const balanced = extractBalanced(src, bracePos);
      if (!balanced) continue;
      if (!hasCanonicalPath(balanced)) continue;
      blocks.push(balanced);
      claimedUntil = bracePos + balanced.length;
    }
    const map = new Map<string, { title: string; desc: string; sd: string }>();
    for (const block of blocks) {
      const cp = block.match(/canonicalPath:\s*'([^']+)'/)?.[1];
      if (!cp) continue;
      // Mirrors staticPagesPlugin.matchStr: single-quoted first, then
      // double-quoted (seo-pages.ts mixes both — #2996).
      const matchStr = (key: string): string => {
        const rxSingle = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`);
        const rxDouble = new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
        return (block.match(rxSingle) || block.match(rxDouble))?.[1] ?? '';
      };
      // Recover the raw structuredData block (intact only if the entry block was
      // not truncated by a spurious nested-property entry-start).
      let sd = '';
      const sdMatch = block.match(/structuredData:\s*/);
      if (sdMatch && sdMatch.index != null) {
        const sdStart = sdMatch.index + sdMatch[0].length;
        const firstChar = block.substring(sdStart).match(/[{[]/);
        if (firstChar && firstChar.index != null) {
          sd = extractBalanced(block, sdStart + firstChar.index) ?? '';
        }
      }
      const title = matchStr('title');
      if (title) map.set(cp.replace(/\/+$/, '') + '/', { title, desc: matchStr('description'), sd });
    }
    return map;
  };

  it('keeps a real entry intact when an unknown nested schema property sits at indent 1', () => {
    // Space-compressed format (1-space indent at every nesting level). The
    // structuredData carries `geoRadius` — a property name absent from the old
    // hand-maintained denylist. The previous boundary-splitting parser read it
    // as an entry-start, truncating this entry's structuredData (silent
    // rich-result loss); the balanced-block parser keeps the whole entry.
    const src = [
      'export const X = {',
      " 'page-with-new-schema-prop': {",
      "  title: 'Curated Title For New Schema Page',",
      "  description: 'A substantive curated description, clearly not the generic fallback.',",
      "  canonicalPath: '/area/new-schema-page/',",
      '  structuredData: {',
      "   '@type': 'Place',",
      '   geoRadius: {',
      "    '@type': 'GeoShape',",
      "    name: 'radius',",
      '   },',
      '  },',
      ' },',
      " 'next-real-entry': {",
      "  title: 'Second Curated Title',",
      "  canonicalPath: '/area/second/',",
      ' },',
      '};',
    ].join('\n');
    const entries = parseEntries(src);
    const first = entries.get('/area/new-schema-page/');
    expect(first?.title).toBe('Curated Title For New Schema Page');
    // The structuredData must survive intact — this is what the old splitting
    // parser dropped when geoRadius was mis-read as an entry boundary.
    expect(first?.sd, 'structuredData truncated — nested prop split the entry').toContain('GeoShape');
    expect(entries.get('/area/second/')?.title).toBe('Second Curated Title');
  });

  it('recovers curated entries for known high-impression pages', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);

    // High-impression pages that shipped fallback meta while the bug was live.
    const mustHave = [
      '/vita-in-ticino/vacanze-scolastiche-ticino-2026/',
      '/tasse-e-pensione/festivita-ticino/',
      '/vivere-in-ticino/comuni-di-frontiera/',
      '/tasse-e-pensione/ristorni-fiscali/',
      // Double-quoted `description: "…"` entry — shipped an EMPTY meta
      // description until matchStr learned to read double quotes (#2996).
      '/metodologia/',
    ];
    for (const cp of mustHave) {
      const entry = entries.get(cp);
      expect(entry, `missing curated entry for ${cp}`).toBeTruthy();
      // The curated title must NOT be the URL-derived fallback shape
      // ("Vacanze Scolastiche Ticino 2026 | Frontaliere Ticino" built from the slug).
      expect(entry!.desc, `curated description for ${cp} must not be the generic fallback`)
        .not.toMatch(/^Informazioni utili per frontalieri/);
      expect(entry!.desc.length, `curated description for ${cp} should be substantive`).toBeGreaterThan(60);
    }
  });

  it('parses a substantial share of hand-written canonicalPath entries', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);
    const cpCount = (src.match(/canonicalPath:\s*'/g) ?? []).length;
    // Every canonicalPath belongs to exactly one entry; allow a small slack
    // for entries without a single-quoted title (template-literal titles).
    expect(entries.size).toBeGreaterThanOrEqual(Math.floor(cpCount * 0.95));
  });

  // Regression gate (PR #2229 → live regression): staticPagesPlugin's jsToJson
  // text-parser does NOT strip `//` comments and cannot evaluate JS method calls
  // (e.g. `BUILD_DATE_ISO.slice(0, 10)`). Either one makes the downstream
  // JSON.parse throw, and the parser's silent `catch { /* skip SD */ }` then
  // DROPS the whole structuredData block — the page ships with no schema and no
  // build error. This silently stripped /supporto/ (lost its WebPage→ContactPage)
  // and /metodologia/ (AboutPage). Forbid both constructs inside any
  // structuredData literal so the class can never silently recur.
  it('no structuredData literal contains a // comment or JS method-call (jsToJson breakers)', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);
    // Method calls jsToJson leaves intact after substituting BUILD_DATE_ISO /
    // BASE_URL — any `."identifier"(` that is not a schema key. The leading
    // `.` after a value is the tell (e.g. `.slice(`, `.replace(`, `.toLowerCase(`).
    const methodCallRx = /\.[a-zA-Z_$][\w$]*\s*\(/;
    // `//` anywhere in the SD (leading OR trailing comment). Both break
    // jsToJson→JSON.parse identically. Run on the string-stripped form so
    // `https://` inside string values is already gone (no false positives).
    const lineCommentRx = /\/\//;
    const offenders: string[] = [];
    for (const [cp, { sd }] of entries) {
      if (!sd) continue;
      // Strip string literals first; whatever `//` or `.method(` survives is real code.
      const noStrings = sd.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""');
      if (lineCommentRx.test(noStrings)) offenders.push(`${cp}: inline // comment in structuredData`);
      if (methodCallRx.test(noStrings)) offenders.push(`${cp}: JS method-call in structuredData`);
    }
    expect(offenders, `structuredData parse-breakers (jsToJson would silently drop these):\n${offenders.join('\n')}`).toEqual([]);
  });

  // The general form of the gate above, and the one that would have caught the
  // #5004 regression the two specific gates missed: a spread of an IMPORTED
  // identifier (`...ORGANIZATION_LD_FULL`) inside a structuredData literal.
  //
  // staticPagesPlugin regex-parses this file, it does not import it — its
  // `constDefs` map only resolves `const NAME = …` declared in the concatenated
  // source, never an imported binding. The spread therefore survives into
  // jsToJson as literal text, JSON.parse throws, and the silent
  // `catch { /* skip SD */ }` drops the ENTIRE structuredData array for that
  // entry — every node in it, not just the offending one. On the home entry
  // that is WebSite + SearchAction + WebPage gone, with a green build.
  //
  // Rather than enumerate breaker constructs one at a time (`//` comments,
  // method calls, now spreads), assert the property that actually matters:
  // every literal must survive the real parse path.
  /** Same brace/bracket walk as staticPagesPlugin's local `extractBalanced`. */
  const extractBalancedLiteral = (src: string, pos: number): string | null => {
    const open = src[pos];
    if (open !== '{' && open !== '[') return null;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let instr: string | null = null;
    for (let i = pos; i < src.length; i++) {
      const c = src[i];
      if (instr) {
        if (c === '\\') { i++; continue; }
        if (c === instr) instr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { instr = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return src.slice(pos, i + 1); }
    }
    return null;
  };

  it('EVERY structuredData literal survives the real jsToJson → JSON.parse path', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);

    // Mirror staticPagesPlugin's constDefs pass (its lines ~1988 and ~2077):
    // a `const NAME = …` DECLARED IN THIS SOURCE is substituted into the
    // literal before jsToJson runs, which is why SPEAKABLE_SECTION and
    // HOWTO_CALCULATOR are legitimate. An IMPORTED binding is not in this map
    // and never gets resolved — that asymmetry is the whole bug class.
    const constDefs = new Map<string, string>();
    const constRefRx = /^const\s+([A-Z_][A-Z0-9_]*)\s*=\s*/gm;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = constRefRx.exec(src)) !== null) {
      const valStart = cMatch.index + cMatch[0].length;
      const balanced = extractBalancedLiteral(src, valStart);
      if (balanced) constDefs.set(cMatch[1], balanced);
    }
    const resolveConsts = (sd: string): string => {
      let out = sd;
      for (const [name, value] of constDefs) {
        out = out.replace(new RegExp(`(?<=[\\[,\\s])${name}(?=[\\],\\s,;])`, 'g'), value);
      }
      return out;
    };

    const offenders: string[] = [];
    for (const [cp, { sd }] of entries) {
      if (!sd) continue;
      try {
        JSON.parse(
          jsToJson(resolveConsts(sd), { baseUrl: BASE_URL, buildDateIso: '2026-01-01T00:00:00.000Z' }),
        );
      } catch (err) {
        offenders.push(`${cp}: ${(err as Error).message}`);
      }
    }
    expect(
      offenders,
      `structuredData that staticPagesPlugin would SILENTLY DROP (whole array, no build error):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // Narrower companion, for a clearer failure message than a JSON position
  // offset when someone reaches for the obvious refactor.
  it('no structuredData literal spreads an identifier (regex parser cannot resolve it)', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);
    const spreadRx = /\.\.\.[A-Za-z_$][\w$]*/;
    const offenders: string[] = [];
    for (const [cp, { sd }] of entries) {
      if (!sd) continue;
      const noStrings = sd.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""');
      const m = noStrings.match(spreadRx);
      if (m) offenders.push(`${cp}: spreads ${m[0]} — this file is regex-parsed, not imported`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('/supporto/ and /metodologia/ structuredData parse to their declared @type', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);
    // Use the REAL jsToJson from staticPagesPlugin (single source of truth,
    // #2256) — not a local re-implementation that could stay green while the
    // emitter diverges. buildDateIso is arbitrary here (no SD asserts on it).
    const toJson = (js: string): string =>
      jsToJson(js, { baseUrl: BASE_URL, buildDateIso: '2026-01-01T00:00:00.000Z' });
    const typesFor = (cp: string): string[] => {
      const sd = entries.get(cp)?.sd ?? '';
      const parsed = JSON.parse(toJson(sd));
      return (Array.isArray(parsed) ? parsed : [parsed]).map((x: Record<string, unknown>) => String(x['@type'] ?? ''));
    };
    expect(typesFor('/supporto/')).toContain('ContactPage');
    expect(typesFor('/metodologia/')).toContain('AboutPage');
  });
});
