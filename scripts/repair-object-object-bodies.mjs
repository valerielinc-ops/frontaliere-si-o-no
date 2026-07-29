#!/usr/bin/env node

/**
 * Repairs the article bodies that shipped a literal `[object Object]` block.
 *
 * A translation call asks for {"body1": "..."} but a model may answer
 * {"body1": {...}}. That parsed as valid JSON, passed every truthiness check,
 * and got stringified into published prose. 206 en/de/fr body files carry the
 * marker (it/ is generated, not translated, so it was never affected). The
 * pipeline hole itself is fixed in scripts/lib/article-free-mt.mjs — this script
 * only repairs the data already on disk.
 *
 * The marker REPLACED a block, it did not add one, so removing it would leave a
 * hole (and, in the 175 bodies where the marker stands for the whole translated
 * text, a body that is nothing but its CTA — thin content). Git history is not a
 * recovery source: every affected file was born corrupted, verified across the
 * corpus. So the body is re-translated from the Italian source, which is intact,
 * through the same free MT cascade the pipeline uses.
 *
 * Trailing CTA / source blocks are localized AFTER translation, so they are kept
 * verbatim from the current file rather than re-derived — but only when the new
 * translation does not already carry the same nav: target or source URL, which
 * would duplicate them.
 *
 * Usage:
 *   node scripts/repair-object-object-bodies.mjs --locale en [--limit N] [--apply]
 *   node scripts/repair-object-object-bodies.mjs --all --apply
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { extractBodies, escapeForTS, unescapeFromTS, BODY_DIRS } from './lib/blog-body-io.mjs';
import { maskNavLinks } from './lib/article-free-mt.mjs';
import { freeTranslateWithRetry, balanceMarkdownMarkers } from './lib/free-translate.mjs';

const MARKER = '[object Object]';
const BODY_KEYS = ['body1', 'body2', 'body3'];
const CONCURRENCY = 4;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const localeArg = (() => {
  const i = argv.indexOf('--locale');
  return i !== -1 ? argv[i + 1] : null;
})();
const LOCALES = argv.includes('--all') ? ['en', 'de', 'fr'] : (localeArg ? [localeArg] : ['en']);
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i !== -1 ? Number(argv[i + 1]) || Infinity : Infinity;
})();

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fieldRe = (id, key) =>
  new RegExp(`('blog\\.article\\.${escRe(id)}\\.${key}':\\s*')((?:[^'\\\\]|\\\\.)*)(')`, 's');

function readField(src, id, key) {
  const m = src.match(fieldRe(id, key));
  return m ? unescapeFromTS(m[2]) : null;
}

function writeField(src, id, key, value) {
  return src.replace(fieldRe(id, key), (_m, pre, _old, post) => `${pre}${escapeForTS(value)}${post}`);
}

/** A trailing CTA / attribution block, localized after translation. */
const isTailBlock = (p) => /\(nav:/.test(p) || /^\*\s*(Source|Fonte|Quelle)\s*:/i.test(p);

/** nav: targets and source URLs a block points at — used to avoid duplicating it. */
function blockTargets(block) {
  const out = new Set();
  for (const m of block.matchAll(/\(nav:([^)]+)\)/g)) out.add(`nav:${m[1]}`);
  for (const m of block.matchAll(/\((https?:\/\/[^)]+)\)/g)) out.add(m[1]);
  return out;
}

/**
 * "frontalieri" must never come back as border GUARDS — a different job. This
 * error was already corrected across the corpus once; MT must not reintroduce it.
 */
const TERM_FIXES = {
  en: [[/\bborder guards?\b/gi, 'cross-border commuters'], [/\bfrontier guards?\b/gi, 'cross-border commuters']],
  fr: [[/\bgardes?-fronti[eè]res?\b/gi, 'frontaliers'], [/\bgarde-fronti[eè]re\b/gi, 'frontalier']],
  de: [[/\bGrenzw[aä]chter\w*\b/g, 'Grenzgänger'], [/\bGrenzschützer\w*\b/g, 'Grenzgänger']],
};

function applyTermFixes(text, locale) {
  let out = text;
  for (const [re, to] of TERM_FIXES[locale] || []) out = out.replace(re, to);
  return out;
}

/**
 * Brand and Swiss-institution acronyms MT must pass through untouched — it
 * rendered the broadcaster RSI as "CSR" on the first pass. Deliberately excludes
 * acronyms that SHOULD localize (IA→AI, PIL→GDP, IVA→VAT, UE→EU, OMS→WHO).
 */
const KEEP_ACRONYMS = [
  'RSI', 'SSR', 'SRG', 'FFS', 'SBB', 'CFF', 'USTAT', 'SEM', 'AFC', 'ESTV', 'UST', 'BFS',
  'SECO', 'UFAM', 'USTRA', 'DECS', 'DSS', 'OCST', 'UNIA', 'SYNA', 'SUPSI', 'USI', 'EOC',
  'SUVA', 'FINMA', 'BNS', 'SNB', 'COMCO', 'WEKO', 'INPS', 'INAIL', 'ISTAT', 'ANSA', 'AITI',
  'AVS', 'AHV', 'LPP', 'BVG', 'LAINF', 'UVG', 'LAMal', 'KVG', 'IPG', 'LADI', 'AVIG',
];
const ACRONYM_RE = new RegExp(`\\b(${KEEP_ACRONYMS.join('|')})\\b`, 'g');

/** Same digit-delimited sentinel trick as the nav-link mask. */
function maskAcronyms(text) {
  const store = [];
  const masked = String(text).replace(ACRONYM_RE, (m) => {
    const token = `0ACR${store.length}0`;
    store.push(m);
    return token;
  });
  const restore = (s) => {
    let n = 0;
    const out = String(s).replace(/0ACR(\d+)0/g, (_, i) => {
      const original = store[Number(i)];
      if (original === undefined) return '';
      n += 1;
      return original;
    });
    return { text: out, ok: n === store.length };
  };
  return { masked, expected: store.length, restore };
}

/**
 * Once nav-links and acronyms are masked, a block can hold no translatable text
 * at all: a `---` thematic break, a `|---|---|` table rule, or a block that is
 * nothing but a nav-link (the shared mask swallows the whole `[text](nav:x)`,
 * leaving a bare sentinel), or an all-caps marker heading such as `### CTA`.
 * MT answers empty for those, which used to abort the whole file over a
 * horizontal rule. Pass them through verbatim — that is the identity
 * translation, not a skipped check.
 *
 * The test is "no LOWERCASE letter": Italian prose always carries lowercase, so
 * this cannot swallow a real sentence, while `### CTA` (an editorial marker in
 * 327 Italian bodies, already kept verbatim in the healthy DE/FR/EN corpus)
 * passes straight through.
 */
const hasNothingToTranslate = (masked) =>
  !/\p{Ll}/u.test(String(masked).replace(/0NAV\d+0|0ACR\d+0/g, ''));

/** Translate one markdown block, preserving internal nav-links. */
async function translateBlock(block, locale) {
  if (!block.trim()) return '';
  const { masked: navMasked, expected, restore } = maskNavLinks(block);
  // The shared mask now emits a wordless `0NAV<n>0` sentinel — see the note in
  // article-free-mt.mjs. This script used to re-mask it locally because the old
  // `0NAVLINK<n>0` carried a translatable English word that French MT turned into
  // `0NAVLIEN<n>0`; the fix moved upstream, so the local shield is gone.
  const acr = maskAcronyms(navMasked);
  if (hasNothingToTranslate(acr.masked)) return block;
  const raw = await freeTranslateWithRetry({
    text: acr.masked, sourceLang: 'it', targetLang: locale, fieldType: 'description',
  });
  const out = typeof raw === 'string' ? raw : '';
  if (!out.trim()) throw new Error('MT returned empty');
  let restored = out;
  if (acr.expected > 0) {
    const a = acr.restore(restored);
    if (!a.ok) throw new Error(`acronym sentinel mangled (expected ${acr.expected})`);
    restored = a.text;
  }
  if (expected > 0) {
    const r = restore(restored);
    if (!r.ok) throw new Error(`nav-link sentinel mangled (expected ${expected})`);
    restored = r.text;
  }
  return applyTermFixes(balanceMarkdownMarkers(restored), locale);
}

/**
 * Translate the Italian body block by block. Per-block keeps every heading, list
 * and quote in its own paragraph (structure is preserved by construction) and
 * sidesteps MT length limits on the 1200-word bodies.
 */
async function translateBody(itBody, locale) {
  const blocks = itBody.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out = new Array(blocks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= blocks.length) return;
      out[i] = await translateBlock(blocks[i], locale);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, worker));
  if (out.some((b) => typeof b !== 'string' || !b.trim())) throw new Error('a block failed to translate');
  return out.join('\n\n');
}

async function repairField({ dir, locale, id, key, src, itSrc }) {
  const current = readField(src, id, key);
  const itBody = readField(itSrc, id, key);
  if (!current || !current.includes(MARKER)) return null;
  if (!itBody || !itBody.trim()) throw new Error(`no Italian source for ${key}`);

  const core = await translateBody(itBody, locale);

  // Keep trailing CTA / source blocks the pipeline localizes after translation,
  // unless the fresh translation already points at the same targets.
  const curBlocks = current.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const tail = [];
  for (let i = curBlocks.length - 1; i >= 0 && isTailBlock(curBlocks[i]); i--) tail.unshift(curBlocks[i]);
  const coreTargets = blockTargets(core);
  const keep = tail.filter((b) => {
    const t = blockTargets(b);
    return t.size > 0 && ![...t].some((x) => coreTargets.has(x));
  });

  const next = [core, ...keep].join('\n\n');
  if (next.includes(MARKER)) throw new Error('marker survived repair');
  if (next.trim().split(/\s+/).length < 50) throw new Error('repaired body under 50 words');
  return next;
}

const targets = [];
for (const dir of BODY_DIRS) {
  for (const locale of LOCALES) {
    const d = `${dir}/${locale}`;
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(`${d}/${f}`, 'utf8');
      if (!src.includes(MARKER)) continue;
      targets.push({ dir, locale, id: f.replace(/\.ts$/, ''), path: `${d}/${f}` });
    }
  }
}

console.log(`🔧 ${targets.length} file con "${MARKER}" (locali: ${LOCALES.join(', ')})${APPLY ? '' : ' — DRY RUN'}`);

let repaired = 0; let failed = 0; let fields = 0;
for (const t of targets.slice(0, LIMIT)) {
  // `it` is the SOURCE language here, not the target locale: this script repairs
  // en/de/fr bodies by re-translating from the Italian original, the only copy
  // the `[object Object]` bug never touched (it/ is generated, not translated).
  // Substituting `${t.locale}` would read the corrupted file as its own source.
  const itPath = `${t.dir}/it/${t.id}.ts`; // locale-segment-ok: Italian is the repair source, not a target locale
  if (!existsSync(itPath)) { console.error(`  ❌ ${t.locale}/${t.id}: sorgente IT assente`); failed++; continue; }
  let src = readFileSync(t.path, 'utf8');
  const itSrc = readFileSync(itPath, 'utf8');
  let touched = false;
  try {
    for (const key of BODY_KEYS) {
      const next = await repairField({ dir: t.dir, locale: t.locale, id: t.id, key, src, itSrc });
      if (next === null) continue;
      src = writeField(src, t.id, key, next);
      touched = true; fields++;
    }
    if (!touched) continue;
    if (src.includes(MARKER)) throw new Error('marker still present in file');
    // The rewritten field must still parse back out identically.
    if (APPLY) {
      writeFileSync(t.path, src);
      const check = extractBodies(readFileSync(t.path, 'utf8'), t.id);
      if (Object.values(check).some((v) => String(v).includes(MARKER))) throw new Error('post-write verification failed');
    }
    repaired++;
    console.log(`  ✅ ${t.locale}/${t.id}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${t.locale}/${t.id}: ${err.message}`);
  }
}

console.log(`\n📊 file riparati: ${repaired} | campi: ${fields} | falliti: ${failed}`);
if (!APPLY) console.log('   Dry run — rilancia con --apply per scrivere.');
process.exit(failed > 0 && repaired === 0 ? 1 : 0);
