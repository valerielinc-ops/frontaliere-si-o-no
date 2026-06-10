#!/usr/bin/env node
/**
 * check-hardcoded-locale-segments.mjs — guard contro l'antipattern i18n-naming
 * (zero-Claude, deterministico). Escalation lessons-harvester #1529.
 *
 * Perché (reviewer-finding/i18n-naming, 11 occorrenze/14gg, 🔴 ricorrente):
 * gli agent hardcodano un segmento lingua (`/de/`, `/fr/`, `/it/`, `/en/`) come
 * STRINGA LETTERALE dentro una URL/path costruita dinamicamente (crawler,
 * build-plugin, componenti) invece di usare la variabile locale
 * (`perLocaleSlug[locale]`, `${locale}`, ecc.). Risultato: rotto su qualsiasi
 * locale/tenant != DE. Esempi: #1498 (`${base}/de/job/${hash}`), #1508, #1513.
 * La regola prosa AGENTS.md #6 NON lo previene → serve un gate strutturale che
 * fallisca la CI PRIMA che la PR raggiunga la review.
 *
 * Cosa flagga: un segmento `/de|fr|it|en/` letterale dentro una stringa che è
 * COSTRUITA DINAMICAMENTE (contiene un'interpolazione `${...}` o è concatenata
 * con `+`), nei file `scripts/**`, `build-plugins/**`, `components/**`.
 * Esclusi: `services/locales/**`, `docs/**`, file di test.
 *
 * Precisione (anti-falso-positivo): una URL/path statica con un solo segmento
 * lingua hardcoded NON è di per sé un bug — i portali esterni dei datori di
 * lavoro vivono davvero su `/en/...`, e le liste hreflang emettono
 * deliberatamente `/de/...` per la riga `hreflang="de"`. Per questo il guard usa
 * la stessa convenzione baseline degli `audit-*` del repo: tutte le occorrenze
 * ESISTENTI (già revisionate) stanno in una baseline committata; la CI fallisce
 * SOLO su occorrenze NUOVE non presenti in baseline e non annotate. Una nuova
 * riga `${BASE_URL}/de/...` introdotta da un fixer → non in baseline → CI rossa
 * → l'autore deve usare `${locale}` oppure giustificare con il commento inline
 * `// locale-segment-ok: <motivo>` sulla stessa riga (o quella precedente).
 *
 * Uso:
 *   node scripts/ci/check-hardcoded-locale-segments.mjs            # gate (exit 1 su nuove violazioni)
 *   node scripts/ci/check-hardcoded-locale-segments.mjs --list     # stampa tutte le occorrenze correnti
 *   node scripts/ci/check-hardcoded-locale-segments.mjs --write-baseline  # rigenera baseline (richiede review)
 *
 * Exit: 0 = clean (nessuna nuova violazione); 1 = nuove violazioni; 2 = errore d'uso.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = path.join(ROOT, 'data', 'hardcoded-locale-segments-baseline.json');

const SCAN_DIRS = ['scripts', 'build-plugins', 'components'];
const SCAN_EXT = new Set(['.mjs', '.js', '.ts', '.tsx']);

// Esclusioni: locale chunk files (è la loro funzione contenere i segmenti),
// docs, test, e questo guard stesso (i propri esempi nei commenti).
const EXCLUDE_PREFIXES = ['services/locales/', 'docs/'];
const EXCLUDE_RE = [
  /(^|\/)tests?\//, // qualsiasi cartella test
  /\.test\.[tj]sx?$/, // file *.test.*
  /\.spec\.[tj]sx?$/, // file *.spec.*
  /(^|\/)__tests__\//,
  /(^|\/)__fixtures__\//,
  /scripts\/ci\/check-hardcoded-locale-segments\.mjs$/, // self
];

// Segmento lingua letterale dentro una stringa quotata (', ", `).
// Cattura la stringa intera per poter verificare dinamicità + path-likeness.
const STRING_WITH_SEG = /(["'`])((?:[^"'`\\]|\\.)*?\/(?:de|fr|it|en)\/(?:[^"'`\\]|\\.)*?)\1/g;

// Il segmento lingua deve essere preceduto, nel literal, dall'inizio-stringa,
// da uno `${...}` o da un host/path — cioè essere un VERO segmento di path, non
// una `/de/` qualsiasi annegata in una frase di prosa o in un blob HTML/markdown.
// `(?:^|...)/de/` con prima un confine di path (`/`, `}`, o inizio).
const PATH_SEG = /(?:^|\$\{[^}]*\}|[A-Za-z0-9._~:-])\/(?:de|fr|it|en)\//;
// La stringa nel complesso deve sembrare una URL/path: inizia con `/`, con
// `http`, con `${...}` (base var) o contiene `://`. Esclude prose/log/HTML-blob.
const URLISH = /^(?:\/(?!\/)|\.{0,2}\/|https?:|\$\{)|:\/\//;

// Allowlist inline: `// locale-segment-ok: <motivo>` sulla stessa riga o sulla
// riga immediatamente precedente disinnesca il flag (richiede un motivo).
const INLINE_OK = /locale-segment-ok:/;

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      walk(full, acc);
    } else if (e.isFile()) {
      if (!SCAN_EXT.has(path.extname(e.name))) continue;
      if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) continue;
      if (EXCLUDE_RE.some((re) => re.test(rel))) continue;
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * È una costruzione dinamica? Una stringa con `${...}` è un template literal
 * interpolato. In più consideriamo dinamica anche la riga che concatena la
 * stringa con `+ <ident>` o `<ident> +` adiacente (path costruito a pezzi).
 */
function isDynamic(literal, line) {
  if (/\$\{/.test(literal)) return true;
  // concatenazione: la riga contiene la stringa seguita/preceduta da `+`
  // legato a un identificatore (non solo a un'altra stringa letterale).
  if (/\+\s*[A-Za-z_$]/.test(line) || /[A-Za-z_$\])]\s*\+\s*["'`]/.test(line)) {
    // ma solo se il `+` non è puramente fra letterali statici
    return true;
  }
  return false;
}

/**
 * Una riga è in violazione se contiene un literal di tipo URL/path costruito
 * dinamicamente con un segmento lingua hardcoded, e NON è disinnescata da un
 * commento `// locale-segment-ok:` su questa riga o sulla precedente.
 * Funzione PURA (esportata) → testabile senza filesystem.
 */
export function lineHasViolation(line, prevLine = '') {
  STRING_WITH_SEG.lastIndex = 0;
  let m;
  let matched = false;
  while ((m = STRING_WITH_SEG.exec(line))) {
    const literal = m[2];
    if (!isDynamic(literal, line)) continue;
    // Path-likeness: scarta prose / HTML-blob / log dove `/de/` è incidentale.
    if (!URLISH.test(literal.trim())) continue;
    if (!PATH_SEG.test(literal)) continue;
    matched = true;
  }
  if (!matched) return false;
  if (INLINE_OK.test(line) || INLINE_OK.test(prevLine)) return false;
  return true;
}

export function collect() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
  files.sort();
  const findings = [];
  for (const rel of files) {
    let src;
    try {
      src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const prev = i > 0 ? lines[i - 1] : '';
      if (lineHasViolation(lines[i], prev)) findings.push(`${rel}:${i + 1}`);
    }
  }
  return findings;
}

function loadBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    return new Set(Array.isArray(raw.allowed) ? raw.allowed : []);
  } catch {
    return new Set();
  }
}

export function main() {
  const args = process.argv.slice(2);
  const findings = collect();

  if (args.includes('--list')) {
    process.stdout.write(findings.join('\n') + (findings.length ? '\n' : ''));
    return 0;
  }

  if (args.includes('--write-baseline')) {
    const payload = {
      _comment:
        'Occorrenze NOTE di segmenti lingua (/de|fr|it|en/) in URL/path dinamiche, ' +
        'già revisionate come legittime (portali esterni, liste hreflang, branch per-locale). ' +
        'Il guard fallisce la CI su NUOVE occorrenze non in questa lista. ' +
        'Rigenera SOLO dopo review umana: node scripts/ci/check-hardcoded-locale-segments.mjs --write-baseline',
      allowed: findings,
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
    process.stderr.write(`baseline scritta: ${findings.length} occorrenze → ${path.relative(ROOT, BASELINE_PATH)}\n`);
    return 0;
  }

  const baseline = loadBaseline();
  const newViolations = findings.filter((f) => !baseline.has(f));
  // Stale baseline entries (occorrenza rimossa/spostata): non sono un errore,
  // ma le segnaliamo come warning così la baseline si può ripulire.
  const stale = [...baseline].filter((b) => !findings.includes(b));

  if (newViolations.length === 0) {
    if (stale.length) {
      process.stderr.write(
        `::warning::check-hardcoded-locale-segments: ${stale.length} voci baseline stantie ` +
          `(occorrenza rimossa/spostata). Rigenera con --write-baseline per ripulire.\n`
      );
    }
    return 0;
  }

  process.stderr.write(
    '\n❌ check-hardcoded-locale-segments: segmento lingua (/de|fr|it|en/) HARDCODED ' +
      'in URL/path costruita dinamicamente.\n\n' +
      'Usa la variabile locale (`${locale}` / `perLocaleSlug[locale]`) invece del ' +
      'letterale: il path è rotto su ogni locale != quello hardcoded (reviewer 🔴 i18n-naming).\n' +
      'Se il segmento è davvero fisso e legittimo (portale esterno, riga hreflang ' +
      'esplicita, branch per-locale), annota la riga con `// locale-segment-ok: <motivo>`.\n\n' +
      'Violazioni:\n'
  );
  for (const v of newViolations) process.stderr.write(`  ${v}\n`);
  process.stderr.write(`\n${newViolations.length} nuova/e violazione/i.\n`);
  return 1;
}

// Esegui il gate solo come entrypoint CLI, non quando importato dai test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
