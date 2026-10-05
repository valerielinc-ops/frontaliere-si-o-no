#!/usr/bin/env node
/**
 * check-parser-contract.mjs — lint statico a ratchet sui parser dei crawler
 * (issue 11674).
 *
 * IL DIFETTO. Nessun gate di CI valutava il codice di un parser toccato dal
 * diff: ~600 `scripts/lib/*-job-parser.mjs` e ~600 `scripts/update-*-jobs.mjs`
 * contro poche decine di test scritti a mano e senza invarianti comuni;
 * `audit-parser-quality` gira dopo il merge sui dati live e
 * `run-related-tests` seleziona per grafo di import, quindi un parser senza
 * test non fa girare niente. Lo stesso 🔴 del revisore e' tornato su PR
 * diverse per le stesse forme, che qui diventano regole:
 *
 *   R1 data-di-crawl     `new Date()`/`Date.now()` come `datePosted`/`postedDate`,
 *                         anche tramite un normalizzatore di data che ripiega
 *                         su oggi (PR 9452, 10186).
 *   (R2 indirizzo-vuoto, `postalCode`/`streetAddress` emessi `''`, PR 10427 e
 *   10425, e' stata misurata e tolta: `buildJobPostingSchema` in
 *   `build-plugins/shared/jobPostingSchema.ts` completa gia' un indirizzo vuoto
 *   con un default coerente con la localita' (Non-Negotiable #3), e i `''`
 *   del campione erano guardie volute contro il CAP della sede su un'altra
 *   citta' (issue 9852). Il numero resta libero per non rinumerare le altre.)
 *   R3 scadenza-grezza   `validThrough:` letto da un campo della sorgente
 *                         (`detail.x`, `row.x`, `jsonLd.x` ...) senza
 *                         normalizzatore (PR 11281). Il valore gia' passato
 *                         da un parser (`parsed.x`, una variabile locale) no:
 *                         nel campione erano quasi tutti propagazioni.
 *   R4 data-candidati    argomento di `sourcePostingDateFields` che e' una
 *                         catena `||` o un campo `start*`, invece di
 *                         `sourcePostingDateCandidatesFields` (PR 11297, 11281).
 *   R5 corpo-senza-soglia `description =` assegnata da un estrattore in un file
 *                         che non importa la soglia di `source-body-floor.mjs`
 *                         e il cui runner non passa da
 *                         `runStandardCrawlerPipeline`, che la applica prima
 *                         di scrivere (PR 10333).
 *
 * RATCHET. `scripts/ci/parser-contract-baseline.json` conta le violazioni
 * esistenti per file e regola. Un file nuovo con una violazione, o un
 * conteggio che sale, fa fallire; un conteggio che scende deve essere
 * registrato (`--update-baseline`), cosi' la baseline puo' solo scendere.
 *
 * ECCEZIONE. Sulla riga della violazione (o sulla riga sopra):
 *   `// parser-contract-ok R<n>: <motivo di almeno 8 caratteri>`
 *
 * Solo analisi statica del testo: nessuna rete, nessun import dei parser.
 *
 * Usage:
 *   node scripts/ci/check-parser-contract.mjs [--files a,b] [--json]
 *   node scripts/ci/check-parser-contract.mjs --update-baseline
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { hasMarkerInComment, isRegexLiteralStart } from '../lib/inline-comment-marker.mjs';

export const PARSER_PATH_RE = /^scripts\/(?:lib\/[^/]+-job-parser|update-[^/]+-jobs)\.mjs$/;
export const BASELINE_PATH = 'scripts/ci/parser-contract-baseline.json';

export const RULES = {
  R1: 'data-di-crawl come datePosted/postedDate',
  R3: 'validThrough senza normalizzatore',
  R4: 'sourcePostingDateFields con catena || o campo start*',
  R5: 'description da estrattore senza meetsSourceBodyFloor',
};

const MAX_EXPRESSION_LINES = 8;

// ---------------------------------------------------------------------------
// Lexer: una vista `masked` della sorgente con gli stessi offset (unita'
// UTF-16) e gli stessi a-capo: commenti sostituiti da spazi, contenuto di
// stringhe, template e regex sostituito da `x` (i delimitatori restano: `''`
// resta `''`). Serve a cercare le forme e a contare parentesi e virgole
// senza farsi ingannare da commenti e testo.
// ---------------------------------------------------------------------------
export function lexSource(source) {
  const src = String(source ?? '');
  const masked = src.split('');
  const blank = (i) => { if (src[i] !== '\n') masked[i] = ' '; };
  const mask = (i) => { if (i < src.length && src[i] !== '\n') masked[i] = 'x'; };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { blank(i); i += 1; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j += 1) blank(j);
      i = stop - 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (src[j] === '\\') { mask(j); mask(j + 1); j += 1; continue; }
        if (src[j] === c) break;
        if (c !== '`' && src[j] === '\n') break;
        mask(j);
      }
      i = j;
      continue;
    }
    if (c === '/') {
      const lineStart = src.lastIndexOf('\n', i - 1) + 1;
      const lineEnd = src.indexOf('\n', i);
      const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
      if (isRegexLiteralStart(line, i - lineStart)) {
        let j = i + 1;
        let inClass = false;
        for (; j < src.length && src[j] !== '\n'; j += 1) {
          if (src[j] === '\\') { mask(j); mask(j + 1); j += 1; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          mask(j);
        }
        i = j;
      }
    }
  }
  return { masked: masked.join('') };
}

const lineOfOffset = (starts, offset) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
};

const CONTINUATION_START = /^\s*(?:\|\||\?\?|&&|\?(?!\.)|:|\.|\+)/;
const CONTINUATION_END = /(?:\|\||\?\?|&&|\?|:|=|\(|\[|\+|,)\s*$/;

/**
 * Testo dell'espressione che comincia a `offset` (nella vista `masked`):
 * si ferma a `,` `;` o a una parentesi chiusa a profondita' 0, oppure a un
 * a-capo a profondita' 0 che non prosegue con un operatore.
 * Ritorna `{ text, end, terminator }`.
 */
export function expressionAt(masked, offset) {
  let depth = 0;
  let lines = 0;
  for (let i = offset; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return { text: masked.slice(offset, i), end: i, terminator: c };
      depth -= 1;
    } else if ((c === ',' || c === ';') && depth === 0) {
      return { text: masked.slice(offset, i), end: i, terminator: c };
    } else if (c === '\n') {
      lines += 1;
      if (lines >= MAX_EXPRESSION_LINES) return { text: masked.slice(offset, i), end: i, terminator: '\n' };
      if (depth === 0) {
        const before = masked.slice(offset, i);
        const nextEnd = masked.indexOf('\n', i + 1);
        const nextLine = masked.slice(i + 1, nextEnd === -1 ? masked.length : nextEnd);
        if (!CONTINUATION_END.test(before) && !CONTINUATION_START.test(nextLine)) {
          return { text: before, end: i, terminator: '\n' };
        }
      }
    }
  }
  return { text: masked.slice(offset), end: masked.length, terminator: '' };
}

/**
 * Trova le emissioni di un campo: `campo: valore` come proprieta' di un
 * oggetto e `campo = valore` come assegnazione (`const`/`let`/`var`, `obj.campo`
 * o istruzione a inizio riga). Esclude il ramo di un ternario (`? campo :`),
 * i default di un pattern/parametro (`{ campo = '' }`) e i confronti.
 */
function* fieldEmissions(masked, fieldSource, { property = true, assignment = true } = {}) {
  const re = new RegExp(`(?<![\\w$])(${fieldSource})\\s*(:|=(?![=>]))`, 'g');
  for (const match of masked.matchAll(re)) {
    const anchor = match.index;
    const valueStart = anchor + match[0].length;
    const lineStart = masked.lastIndexOf('\n', anchor - 1) + 1;
    const prefix = masked.slice(lineStart, anchor);
    const before = prefix.trimEnd();
    const prev = before.at(-1) || '';
    if (match[2] === ':') {
      if (!property) continue;
      // Proprieta' di un oggetto: preceduta da `{`, `,` o da inizio riga.
      if (prev && prev !== '{' && prev !== ',') continue;
      // `case campo:` o etichette: non sono emissioni.
      if (/\bcase\s*$/.test(before)) continue;
      const expr = expressionAt(masked, valueStart);
      yield { anchor, valueStart, kind: 'property', field: match[1], ...expr };
    } else {
      if (!assignment) continue;
      const declared = /\b(?:const|let|var)\s*$/.test(before);
      const member = prev === '.';
      const statement = before === '' || /[;{}]$/.test(before);
      if (!declared && !member && !statement) continue;
      // `obj.campo = x` deve avere un oggetto davanti al punto (non `...campo`).
      if (member && /\.\.\.$/.test(before)) continue;
      const expr = expressionAt(masked, valueStart);
      // Una riga che inizia con `campo = x,` e' un default di pattern o di
      // parametro, non un'assegnazione: legge, non emette.
      if (statement && !member && expr.terminator === ',') continue;
      if (statement && !member && expr.terminator === '}' && !declared) continue;
      yield { anchor, valueStart, kind: declared ? 'declaration' : 'assignment', field: match[1], ...expr };
    }
  }
}

/** Rimuove le liste di argomenti delle chiamate il cui nome soddisfa `nameRe`. */
function dropCallArguments(text, nameRe) {
  let out = text;
  for (let guard = 0; guard < 20; guard += 1) {
    const re = /([A-Za-z_$][\w$]*)\s*\(/g;
    let changed = false;
    for (const m of out.matchAll(re)) {
      if (!nameRe.test(m[1])) continue;
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < out.length; i += 1) {
        if (out[i] === '(') depth += 1;
        else if (out[i] === ')') { depth -= 1; if (depth === 0) { close = i; break; } }
      }
      if (close === -1) break;
      const inner = out.slice(open + 1, close);
      if (!inner.trim()) continue;
      out = `${out.slice(0, open + 1)}${' '.repeat(inner.length)}${out.slice(close)}`;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return out;
}

const NOW_RE = /\bnew\s+Date\s*\(\s*\)|\bDate\s*\.\s*now\s*\(\s*\)/;
// Helper di provenienza che ricevono `now` come riferimento per scartare le
// date future: li' `new Date()` non e' il valore emesso.
const PROVENANCE_HELPER_RE = /(?:PostingDates?\w*|^resolveReportedPostingDate|^withLegacyPostingDay|^compareValidatedPostingDates)$/;

// Normalizzatori di una data di scadenza: qualunque chiamata il cui nome
// dichiara una conversione di data. Un valore grezzo (`raw.deadline`,
// `x || ''`) non ne contiene nessuna. `.slice(0, 10)` di un timestamp ISO e'
// accettato come normalizzazione: tronca, non lascia passare il testo libero
// che il revisore ha segnalato (PR 11281).
const DATE_NORMALIZER_RE = /\b(?:\w*(?:[Nn]ormali[sz]e|[Ii]so|ISO|[Pp]arse|[Ff]ormat|[Dd]ate|[Dd]eadline|[Ee]xpir|[Vv]alidThrough)\w*)\s*\(|\.(?:slice|substring)\(\s*0\s*,\s*10\s*\)/;
// Solo un campo letto da un oggetto della sorgente: `parsed.x`, `job.x`,
// `prev.x` o una variabile locale sono di solito gia' normalizzati a monte.
const RAW_SOURCE_READ_RE = /(?<![\w$.])(?:raw\w*|row|rows\[[^\]]*\]|jsonLd|ld|posting|listing|detail|details|item|entry|record|rec|hit|vacancy|node|api\w*|data|meta|info|req|res|response|payload|attributes|fields)\s*\??\.\s*[A-Za-z_$]/;

// R4: una catena `a || b` fra due campi letti dalla sorgente, di cui almeno
// uno e' una data: il primo valore non vuoto ma non valido scarta il secondo.
const CHAIN_OPERAND = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]*\])*`;
const DATEISH_SEGMENT_RE = /^(?:date|publi|posted|created|online|Date|Publi|Posted|Created)|(?:Date|DATE|Published|Posted|Created|Since|At|_on|_at|_date)$/;
export function hasDateCandidateChain(arg) {
  const re = new RegExp(`(${CHAIN_OPERAND})\\s*(?:\\|\\||\\?\\?)\\s*(?=(${CHAIN_OPERAND}))`, 'g');
  for (const m of arg.matchAll(re)) {
    const left = m[1];
    const right = m[2];
    const lastSegment = (chain) => chain.split(/\??\./).at(-1);
    // `postedDate || datePosted` rilegge la coppia che sourcePostingDateFields
    // scrive sempre uguale: non e' una scelta fra candidati.
    const pair = new Set([lastSegment(left), lastSegment(right)]);
    if (pair.size === 2 && pair.has('postedDate') && pair.has('datePosted')) continue;
    if (DATEISH_SEGMENT_RE.test(lastSegment(left)) || DATEISH_SEGMENT_RE.test(lastSegment(right))) return true;
  }
  return false;
}
const START_FIELD_RE = new RegExp(`^\\s*(?:${CHAIN_OPERAND}\\??\\.)?start[\\w$]*\\s*$`, 'i');

/** Nome della funzione che racchiude `offset` (dichiarazione o arrow assegnata). */
function enclosingFunctionName(masked, offset) {
  const head = masked.slice(0, offset);
  const re = /(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;
  let last = null;
  for (const m of head.matchAll(re)) last = { name: m[1] || m[2], index: m.index };
  if (!last) return '';
  // La funzione racchiude l'offset se la prima `{` dopo l'intestazione non e'
  // gia' stata chiusa prima dell'offset.
  const open = masked.indexOf('{', last.index);
  if (open === -1 || open > offset) return '';
  let depth = 0;
  for (let i = open; i < offset; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') { depth -= 1; if (depth === 0) return ''; }
  }
  return last.name;
}

// La soglia di parole alla fonte, importata direttamente
// (`source-body-floor.mjs`) o tramite gli helper di `stored-source-body.mjs`
// che la applicano prima di scrivere, oppure la pipeline standard di
// `crawler-template.mjs` (`runStandardCrawlerPipeline`), che filtra con
// `meetsSourceBodyFloor` prima di scrivere la slice.
const SOURCE_FLOOR_IMPORT_RE = /\bimport\s*\{[^}]*\b(?:meetsSourceBodyFloor|sourceBodyWordCount|MIN_SOURCE_BODY_WORDS|collectThinSourceJobsForQuarantine|keepStoredSourceBodies(?:ByKey)?|drop(?:Failed|Unreadable)SourceJobsWithoutValidBody)\b[^}]*\}\s*from\b/;
const STANDARD_PIPELINE_RE = /\brunStandardCrawlerPipeline\s*\(/;
// Una soglia di parole scritta a mano (`const MIN_DESCRIPTION_WORDS = 50`):
// e' una soglia, anche se duplicata invece che importata.
const LOCAL_WORD_FLOOR_RE = /\bconst\s+MIN_[A-Z_]*WORDS\s*=/;
export function hasBodyFloor(text) {
  const { masked } = lexSource(text);
  return SOURCE_FLOOR_IMPORT_RE.test(masked) || STANDARD_PIPELINE_RE.test(masked) || LOCAL_WORD_FLOOR_RE.test(masked);
}
// Un estrattore: chiamata o valore letto dalla sorgente, non un letterale.
const LITERAL_ONLY_RE = /^\s*(?:(['"`])x*\1|null|undefined|\[\s*\]|\{\s*\}|0)\s*;?\s*$/;
const EXTRACTOR_RE = /[A-Za-z_$][\w$]*\s*\(|[A-Za-z_$][\w$]*\s*(?:\.|\?\.|\[)|^\s*(?:await\s+)?[A-Za-z_$][\w$]*\s*$/;

/**
 * Scansiona una sorgente di parser. Ritorna le violazioni con riga 1-based.
 * @returns {{ rule: string, line: number, text: string }[]}
 */
export function scanParserSource(source, file = '', { centralBodyFloor = false } = {}) {
  const original = String(source ?? '');
  const { masked } = lexSource(original);
  const originalLines = original.split('\n');
  const starts = [0];
  for (let i = 0; i < original.length; i += 1) if (original[i] === '\n') starts.push(i + 1);
  const found = [];
  const seen = new Set();
  const push = (rule, offset) => {
    const lineIndex = lineOfOffset(starts, offset);
    const key = `${rule}:${lineIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    const exemption = `parser-contract-ok\\s+${rule}\\s*:\\s*\\S.{7,}`;
    if (hasMarkerInComment(originalLines[lineIndex], exemption)) return;
    if (lineIndex > 0 && /^\s*\/\//.test(originalLines[lineIndex - 1])
      && hasMarkerInComment(originalLines[lineIndex - 1], exemption)) return;
    found.push({ rule, line: lineIndex + 1, text: originalLines[lineIndex].trim().slice(0, 160), file });
  };

  // R1 — data di crawl come data di pubblicazione.
  for (const emission of fieldEmissions(masked, 'datePosted|postedDate')) {
    const value = dropCallArguments(emission.text, PROVENANCE_HELPER_RE);
    if (NOW_RE.test(value)) push('R1', emission.anchor);
  }
  // R1 — normalizzatore di data che ripiega su oggi: `return new Date()...`
  // dentro una funzione il cui nome parla di data di pubblicazione.
  for (const match of masked.matchAll(/\breturn\b/g)) {
    const expr = expressionAt(masked, match.index + 'return'.length);
    if (!/^\s*(?:new\s+Date\s*\(\s*\)|Date\s*\.\s*now\s*\(\s*\))/.test(expr.text)
      && !/[?:]\s*(?:new\s+Date\s*\(\s*\)|Date\s*\.\s*now\s*\(\s*\))/.test(expr.text)) continue;
    const name = enclosingFunctionName(masked, match.index);
    if (/[Pp]osted|[Pp]ublish|[Pp]ublication|Date(?:Iso|ISO)?$|^date$/.test(name)
      && !/^(?:now|today|crawl|scrap|fetch|run|generated|updated|last|expir|deadline|validThrough|end|start)/i.test(name)) {
      push('R1', match.index);
    }
  }

  // R3 — validThrough grezzo.
  for (const emission of fieldEmissions(masked, 'validThrough')) {
    const value = emission.text;
    if (!value.trim()) continue;
    if (DATE_NORMALIZER_RE.test(value)) continue;
    if (!RAW_SOURCE_READ_RE.test(value)) continue;
    if (/^\s*(?:(['"`])\1|null|undefined)\s*$/.test(value)) continue;
    push('R3', emission.anchor);
  }

  // R4 — sourcePostingDateFields con una catena o con una data di inizio.
  for (const match of masked.matchAll(/(?<![\w$])sourcePostingDateFields\s*\(/g)) {
    const arg = expressionAt(masked, match.index + match[0].length).text;
    if (hasDateCandidateChain(arg) || START_FIELD_RE.test(arg)) push('R4', match.index);
  }

  // R5 — corpo della vacancy senza soglia di parole alla fonte: solo il
  // percorso che scrive il corpo senza passare da nessuna soglia (ne' propria
  // ne' del runner, vedi `hasCentralBodyFloor`).
  if (!centralBodyFloor && !SOURCE_FLOOR_IMPORT_RE.test(masked) && !STANDARD_PIPELINE_RE.test(masked)
    && !LOCAL_WORD_FLOOR_RE.test(masked)) {
    for (const emission of fieldEmissions(masked, 'description', { property: false })) {
      const value = emission.text;
      if (!value.trim() || LITERAL_ONLY_RE.test(value)) continue;
      if (!EXTRACTOR_RE.test(value)) continue;
      push('R5', emission.anchor);
    }
  }

  return found.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Il runner (`scripts/update-<x>-jobs.mjs`) che consuma un parser di `scripts/lib/`. */
export function companionRunner(file) {
  const m = /^scripts\/lib\/(.+)-job-parser\.mjs$/.exec(file);
  return m ? `scripts/update-${m[1]}-jobs.mjs` : null;
}

/**
 * Il corpo scritto da questo file passa da una soglia di parole? Vero se il
 * file stesso o il suo runner la importano o chiamano la pipeline standard. `read(file)` ritorna il testo o lancia (file assente).
 */
export function hasCentralBodyFloor(file, source, read) {
  if (hasBodyFloor(source)) return true;
  const runner = companionRunner(file);
  if (!runner) return false;
  try {
    return hasBodyFloor(read(runner));
  } catch {
    return false;
  }
}

/** Scansione di un file nel suo contesto (runner compagno compreso). */
export function scanParserFile(file, source, read) {
  return scanParserSource(source, file, { centralBodyFloor: hasCentralBodyFloor(file, source, read) });
}

export function countByRule(violations) {
  const counts = {};
  for (const v of violations) counts[v.rule] = (counts[v.rule] || 0) + 1;
  return counts;
}

/**
 * Confronta i conteggi attuali di un file con la sua voce di baseline.
 * `baselineEntry` undefined = file nuovo: ogni violazione fallisce.
 * @returns {{ regressions: object[], improvements: object[] }}
 */
export function compareFile(file, violations, baselineEntry) {
  const counts = countByRule(violations);
  const regressions = [];
  const improvements = [];
  const rules = new Set([...Object.keys(counts), ...Object.keys(baselineEntry || {})]);
  for (const rule of [...rules].sort()) {
    const now = counts[rule] || 0;
    const allowed = baselineEntry?.[rule] || 0;
    if (now > allowed) {
      regressions.push({ file, rule, allowed, now, lines: violations.filter((v) => v.rule === rule) });
    } else if (now < allowed) {
      improvements.push({ file, rule, allowed, now });
    }
  }
  return { regressions, improvements };
}

export function formatRegression(regression) {
  const header = regression.allowed
    ? ` (baseline ${regression.allowed}, ora ${regression.now})`
    : '';
  return regression.lines
    .map((v) => `parser-contract ${v.rule} ${RULES[v.rule]}: ${regression.file}:${v.line}${header}\n    ${v.text}`)
    .join('\n');
}

export function listParserFiles(root) {
  const out = [];
  for (const name of readdirSync(path.join(root, 'scripts'))) {
    const rel = `scripts/${name}`;
    if (PARSER_PATH_RE.test(rel)) out.push(rel);
  }
  for (const name of readdirSync(path.join(root, 'scripts/lib'))) {
    const rel = `scripts/lib/${name}`;
    if (PARSER_PATH_RE.test(rel)) out.push(rel);
  }
  return out.sort();
}

export function readBaseline(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, BASELINE_PATH), 'utf8')).files || {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

export function buildBaseline(root, files = listParserFiles(root)) {
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const out = {};
  for (const file of files) {
    const counts = countByRule(scanParserFile(file, read(file), read));
    if (Object.keys(counts).length) out[file] = Object.fromEntries(Object.entries(counts).sort());
  }
  return out;
}

export function writeBaseline(root, files) {
  const totals = {};
  for (const entry of Object.values(files)) {
    for (const [rule, n] of Object.entries(entry)) totals[rule] = (totals[rule] || 0) + n;
  }
  const doc = {
    description: 'Ratchet di scripts/ci/check-parser-contract.mjs: violazioni ammesse per file e regola. Puo\' solo scendere (--update-baseline).',
    totals: Object.fromEntries(Object.entries(totals).sort()),
    files,
  };
  writeFileSync(path.join(root, BASELINE_PATH), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/**
 * Valuta i file contro la baseline. `files` assenti dal disco sono ignorati
 * (cancellazioni). Ritorna regressioni e miglioramenti non registrati.
 */
export function checkParserContract(root, { files, baseline = readBaseline(root), readFile } = {}) {
  const whole = !files;
  if (whole) files = listParserFiles(root);
  const read = readFile || ((file) => readFileSync(path.join(root, file), 'utf8'));
  const regressions = [];
  const improvements = [];
  for (const file of files) {
    if (!PARSER_PATH_RE.test(file)) continue;
    let source;
    try {
      source = read(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const result = compareFile(file, scanParserFile(file, source, read), baseline[file]);
    regressions.push(...result.regressions);
    improvements.push(...result.improvements);
  }
  // Una voce per un file che non esiste piu' va tolta: altrimenti un file
  // ricreato con lo stesso nome erediterebbe le violazioni ammesse.
  if (whole) {
    const present = new Set(files);
    for (const [file, entry] of Object.entries(baseline)) {
      if (present.has(file)) continue;
      for (const [rule, allowed] of Object.entries(entry)) improvements.push({ file, rule, allowed, now: 0 });
    }
  }
  return { regressions, improvements };
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (argv.includes('--update-baseline')) {
    const doc = writeBaseline(root, buildBaseline(root));
    console.log(`parser-contract: baseline aggiornata (${Object.keys(doc.files).length} file) ${JSON.stringify(doc.totals)}`);
    return 0;
  }
  const filesArg = argv.find((a) => a.startsWith('--files='))?.slice('--files='.length)
    ?? (argv.includes('--files') ? argv[argv.indexOf('--files') + 1] : undefined);
  const files = filesArg ? filesArg.split(',').map((f) => f.trim()).filter(Boolean) : undefined;
  const { regressions, improvements } = checkParserContract(root, files ? { files } : {});
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ regressions, improvements }, null, 2));
  } else {
    for (const r of regressions) console.error(formatRegression(r));
    for (const i of improvements) {
      console.error(`parser-contract baseline da abbassare: ${i.file} ${i.rule} ${i.allowed} -> ${i.now} (node ${path.relative(root, fileURLToPath(import.meta.url))} --update-baseline)`);
    }
    if (regressions.length) {
      console.error(`\nparser-contract: ${regressions.length} regressioni. Correggi la riga o, se la forma e' voluta, annotala con // parser-contract-ok R<n>: <motivo>.`);
    }
  }
  return regressions.length || improvements.length ? 1 : 0;
}

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
