/**
 * review-findings.mjs — identità stabile, classe e igiene dei finding di review.
 *
 * Misure del 19-09 su 220 review del sito:
 *   - 7 casi `## LGTM` → 🔴 Important sulla stessa PR senza nessun cambio di
 *     codice in mezzo (es. #9238: LGTM 12:35, poi un solo merge di main, poi 2
 *     Important nuovi su righe che nessuno aveva toccato);
 *   - 9 🔴 identici ripetuti parola per parola su review consecutive;
 *   - 9 review con `\n` letterali nel body o righe `Fix di ``: ok` con
 *     l'anchor vuoto, che il parser del gate leggeva come conferme valide.
 *
 * La causa comune è che l'identità di un finding era il suo anchor
 * `path:Lline`: una riga che si sposta (rebase, merge di main, fix altrove nel
 * file) produce un id nuovo, quindi lo stesso rilievo risulta «nuovo», non si
 * deduplica e non si lascia confermare. Qui l'identità è
 * `(path, simbolo, classe)`, invariante alla numerazione delle righe:
 *
 *   - `path`    — il primo path citato, normalizzato;
 *   - `simbolo` — il primo identificatore in backtick che non è un path
 *                 (`parseFoo()`, `NONCODE_RE`, `--no-thin`), altrimenti la
 *                 prosa del problema normalizzata;
 *   - `classe`  — dichiarata dal reviewer fra parentesi quadre subito dopo il
 *                 marker (`🔴 Important: [regression] ...`), altrimenti `other`.
 *
 * Il modulo è puro: non importa `review-gate.mjs` (che invece importa lui) e
 * riceve i finding già parsati, così non esiste una seconda copia del parser.
 */
import { createHash } from 'node:crypto';
// `stripFencedBlocks` esiste già, esportato, in `followup-resolution-match.mjs`
// e gestisce anche le fence annidate e i marcatori di lunghezza diversa:
// riusarlo invece di riscriverlo tiene una sola copia della regola (AGENTS.md
// #6), che è esattamente ciò che questo modulo esiste per garantire altrove.
import { stripFencedBlocks } from '../followup-resolution-match.mjs';

/** Classi dichiarabili. Solo `regression` ha semantica per il gate. */
export const FINDING_CLASSES = Object.freeze([
  'regression',
  'correctness',
  'contract',
  'funnel',
  'process',
  'other',
]);

export const REGRESSION_CLASS = 'regression';

// Il tag sta DOPO i due punti: `IMPORTANT_MARKER_RE` del gate pretende
// `🔴 Important` seguito subito da `:`/`—`/`-`, quindi un tag infilato prima
// del separatore rende il finding invisibile al parser.
const CLASS_TAG_RE = /🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]\s*\[\s*([a-z-]{3,20})\s*\]/iu;
const PATH_LIKE_RE = /^(?:\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+$/u;
const EXTENSION_RE = /\.(?:cjs|css|html|js|json|md|mjs|rules|sh|ts|tsx|txt|toml|yaml|yml|jsx)$/u;
const BACKTICK_RE = /`([^`\n]{1,120})`/gu;
const MARKER_RE = /(?:🔴|🟡|🟣|❓)[^\n]*/u;

/**
 * Classe dichiarata dal reviewer. Assente o sconosciuta → `other`: una classe
 * inventata non deve comprare l'eccezione riservata a `regression`.
 */
export function findingDeclaredClass(text) {
  const match = CLASS_TAG_RE.exec(String(text || ''));
  if (!match) return 'other';
  const declared = match[1].toLowerCase();
  return FINDING_CLASSES.includes(declared) ? declared : 'other';
}

export function isRegressionFinding(finding) {
  return findingDeclaredClass(finding?.text ?? finding) === REGRESSION_CLASS;
}

function normalizeProse(text) {
  const first = MARKER_RE.exec(String(text || ''));
  const line = first ? first[0] : String(text || '').split(/\r?\n/u)[0] || '';
  return line
    .replace(CLASS_TAG_RE, ' ')
    // Tolgo marker, anchor e punteggiatura: resta la frase del problema, che è
    // ciò che un reviewer ripete identico quando rialza lo stesso rilievo.
    .replace(/🔴|🟡|🟣|❓/gu, ' ')
    .replace(/\b(?:Important|Nit|Pre-existing|q)\b\s*[:—-]?/giu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .slice(0, 12)
    .join(' ');
}

/**
 * Primo simbolo in backtick che non è un path. Un finding senza simbolo ricade
 * sulla prosa normalizzata: due rilievi diversi sullo stesso file restano
 * distinti, lo stesso rilievo riformulato marginalmente collassa.
 */
export function findingSymbol(text) {
  const source = String(text || '');
  BACKTICK_RE.lastIndex = 0;
  for (const match of source.matchAll(BACKTICK_RE)) {
    const token = match[1].trim();
    if (!token) continue;
    const bare = token.replace(/[:#]L?\d+(?:[-–]\d+)?$/u, '');
    if (PATH_LIKE_RE.test(bare) || EXTENSION_RE.test(bare)) continue;
    if (/^PR body\b/iu.test(bare)) continue;
    return bare.replace(/\s+/gu, ' ');
  }
  return '';
}

function primaryPath(finding) {
  const citations = Array.isArray(finding?.citations) ? finding.citations : [];
  const withPath = citations.find((citation) => citation?.path);
  if (withPath) return String(withPath.path).replace(/^\.\//u, '');
  const anchor = /`?PR body[:#]L?\d+/iu.exec(String(finding?.text || ''));
  return anchor ? 'PR body' : '';
}

/**
 * Id stabile di un finding: sha256 di `path\0simbolo\0classe`, 12 esadecimali.
 * NON contiene la riga: è questo che lo rende invariante a un rebase o a un
 * merge di main, i due eventi che producevano i duplicati misurati.
 */
export function stableFindingId(finding) {
  const path = primaryPath(finding);
  const text = String(finding?.text || finding?.line || '');
  const symbol = findingSymbol(text) || normalizeProse(text);
  const klass = findingDeclaredClass(text);
  return createHash('sha256')
    .update(`${path}\u0000${symbol}\u0000${klass}`)
    .digest('hex')
    .slice(0, 12);
}

/** Deduplica per id stabile conservando il primo esemplare di ogni id. */
export function dedupeFindingsById(findings) {
  const seen = new Set();
  const unique = [];
  for (const finding of findings || []) {
    const id = stableFindingId(finding);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(finding);
  }
  return unique;
}

// ── Igiene del body ────────────────────────────────────────────────────────
//
// Un body malformato non è un verdetto: il parser lo scarta invece di leggerne
// finding o conferme. Le due forme misurate il 19-09:
//   - `\n` letterali (il reviewer ha emesso la stringa JSON invece del testo):
//     il gate vede UNA riga sola, quindi niente finding e niente `## LGTM`
//     riconoscibile, ma il body «sembra» una review;
//   - `Fix di ``: ok` con anchor vuoto: chiude per silenzio qualunque finding
//     aperto, perché il confronto avviene su una stringa vuota.

const LITERAL_NEWLINE_RE = /\\n/gu;
const EMPTY_FIX_ANCHOR_RE = /^\s*(?:[-*]\s*)?Fix di\s+(?:``|`\s+`|)\s*:\s*ok\b/imu;

/**
 * Difetti strutturali che rendono il body illeggibile come verdetto.
 * Restituisce un elenco di codici, vuoto quando il body è utilizzabile.
 */
export function reviewBodyDefects(body) {
  const raw = String(body || '');
  const defects = [];
  const outsideFences = stripFencedBlocks(raw);
  const literalNewlines = (outsideFences.match(LITERAL_NEWLINE_RE) || []).length;
  // Una sola occorrenza può essere prosa legittima («la regex `\n` ...»); tre
  // o più fuori da un blocco di codice, con il body su pochissime righe, sono
  // la serializzazione sbagliata osservata.
  const realLines = outsideFences.split(/\r?\n/u).filter((line) => line.trim()).length;
  if (literalNewlines >= 3 && realLines <= Math.max(3, literalNewlines / 3)) {
    defects.push('literal-newline');
  }
  if (EMPTY_FIX_ANCHOR_RE.test(outsideFences)) defects.push('empty-fix-anchor');
  return defects;
}

export function isMalformedReviewBody(body) {
  return reviewBodyDefects(body).length > 0;
}

// ── 🔴 nuovi su righe non cambiate ─────────────────────────────────────────

function citedLines(finding) {
  return (Array.isArray(finding?.citations) ? finding.citations : [])
    .filter((citation) => citation?.path && Number.isInteger(Number(citation.line)) && Number(citation.line) > 0)
    .map((citation) => ({ path: String(citation.path).replace(/^\.\//u, ''), line: Number(citation.line) }));
}

/**
 * I 🔴 di questa review che sono NUOVI (id stabile mai visto prima) e che
 * puntano solo a righe non toccate dall'ultima review: il codice che
 * descrivono è esattamente quello già giudicato, quindi il rilievo o valeva
 * anche allora o non vale adesso. Il reviewer che ne è davvero convinto lo
 * dichiara `🔴 Important: [regression] ...` e passa.
 *
 * `changedLines` è una Map path → Set(numeri di riga) del delta dall'ultima
 * review. `null`/assente = delta non calcolabile → nessuna declassazione: su
 * un dato mancante si tiene il finding, non lo si butta.
 */
export function unchangedLineImportants({ findings, priorFindingIds, changedLines } = {}) {
  if (!(changedLines instanceof Map)) return [];
  const known = priorFindingIds instanceof Set
    ? priorFindingIds
    : new Set(Array.isArray(priorFindingIds) ? priorFindingIds : []);
  const stale = [];
  for (const finding of findings || []) {
    const id = stableFindingId(finding);
    if (known.has(id)) continue;
    if (isRegressionFinding(finding)) continue;
    const anchors = citedLines(finding);
    // Senza un anchor di riga non si può dimostrare che la riga non è
    // cambiata: il finding resta bloccante.
    if (anchors.length === 0) continue;
    const touched = anchors.some(({ path, line }) => {
      const lines = changedLines.get(path);
      return lines instanceof Set ? lines.has(line) : false;
    });
    // Un path assente dalla Map non è «non cambiato»: potrebbe non essere
    // stato confrontato affatto. Declasso solo se OGNI path citato è presente
    // nella Map (quindi confrontato) e nessuna riga citata è fra quelle mosse.
    const allCompared = anchors.every(({ path }) => changedLines.has(path));
    if (!touched && allCompared) stale.push({ ...finding, stableId: id });
  }
  return stale;
}

/**
 * Delta riga-per-riga fra due commit, nel formato che `unchangedLineImportants`
 * si aspetta. `diffFn(from, to)` deve restituire un patch unificato.
 * Ritorna `null` quando il diff non è ottenibile: il chiamante deve trattarlo
 * come «non calcolabile», mai come «niente è cambiato».
 */
export function changedLinesFromPatch(patch) {
  if (typeof patch !== 'string') return null;
  const map = new Map();
  let path = null;
  let newLine = 0;
  for (const line of patch.split(/\r?\n/u)) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/u.exec(line);
    if (header) {
      path = header[1] === '/dev/null' ? null : header[1];
      if (path && !map.has(path)) map.set(path, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path) continue;
    if (line.startsWith('+')) {
      map.get(path).add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) continue;
    if (line.startsWith(' ')) newLine += 1;
  }
  return map;
}

// ── Ledger passato al reviewer ─────────────────────────────────────────────

/**
 * Elenco deterministico dei finding già emessi con il loro stato, da mettere
 * nel bundle. `open` = ancora da chiudere, `confirmed` = già confermato con
 * `Fix di ...: ok`. Il reviewer riceve gli id stabili, quindi può riportare un
 * rilievo aperto senza riscriverlo e non ha motivo di duplicarne uno chiuso.
 */
export function renderFindingsLedger({ open = [], confirmed = [] } = {}) {
  const lines = [];
  const uniqueOpen = dedupeFindingsById(open);
  const openIds = new Set(uniqueOpen.map(stableFindingId));
  const uniqueConfirmed = dedupeFindingsById(confirmed)
    .filter((finding) => !openIds.has(stableFindingId(finding)));
  if (uniqueOpen.length === 0 && uniqueConfirmed.length === 0) {
    return 'Nessun finding Important storico: questa è la prima review utile.';
  }
  lines.push('Ogni voce porta il suo id stabile `(path, simbolo, classe)`, invariante alla riga.');
  lines.push('Riporta un `open` con lo STESSO id e testo; non rialzare un `confirmed`.');
  lines.push('');
  for (const finding of uniqueOpen) {
    lines.push(`- \`${stableFindingId(finding)}\` **open** — ${firstLine(finding)}`);
  }
  for (const finding of uniqueConfirmed) {
    lines.push(`- \`${stableFindingId(finding)}\` **confirmed-fixed** — ${firstLine(finding)}`);
  }
  return lines.join('\n');
}

function firstLine(finding) {
  return String(finding?.line || finding?.text || '')
    .split(/\r?\n/u)[0]
    .trim()
    .slice(0, 300);
}
