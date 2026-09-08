#!/usr/bin/env node
/**
 * check-number-env-fallback.mjs — gate zero-Claude che vieta
 * `Number(process.env.X || N)`.
 *
 * IL DIFETTO (issue #7300 → #7344). L'alternativa sta DENTRO `Number`, quindi
 * si applica solo quando la variabile e' assente o vuota. Se la variabile c'e'
 * ed e' spazzatura — `"8_000"`, `"30s"`, uno spazio, un `${{ }}` non risolto
 * arrivato come `"$VAR"` — il risultato e' `NaN`. `NaN` non lancia: si propaga.
 * Come tetto significa nessun tetto (`n > NaN` e `n < NaN` sono entrambi falsi),
 * come limite di concorrenza `Math.min(NaN, k) === NaN`, come finestra
 * temporale nessuna scadenza che scatti mai. Il codice CONTINUA e riporta
 * successo.
 *
 * Nel repo il costrutto compariva 90 volte, su tetti di spesa
 * (`HERE_MONTHLY_BUDGET`), cap di batch, deadline di run e budget di quota: la
 * PR #7300 ne aveva corretto UNO. Questo gate impedisce che rientri.
 *
 * LA FORMA CORRETTA e' `intFromEnv('X', N)` (`scripts/lib/int-from-env.mjs`),
 * che cade sul default con un `::warning::` quando il valore non e' un intero.
 * `Number(process.env.X) || N` — l'alternativa FUORI — non e' vietata: li' il
 * `NaN` e' falsy e cade sul default per costruzione. E' esattamente la
 * differenza che questo gate misura.
 *
 * Comment-aware: la stessa stringa dentro un commento (queste righe comprese)
 * non e' una violazione.
 *
 * Exit codes: 0 = pulito, 1 = violazioni. `--json` stampa un report macchina.
 * Oltre al fallback dentro `Number`, il gate segnala anche un `const` che legge
 * un env con `Number(...)` senza `||`/`??` quando lo stesso valore governa un
 * `slice`, un `for` o una `concurrency` nel suo blocco locale.
 *
 * Usage: node scripts/ci/check-number-env-fallback.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitGrepNoMatch } from './lib/git-grep.mjs';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');

/**
 * `functions/` e' un artefatto di deploy separato (`firebase deploy --only
 * functions` carica solo quella cartella): non puo' importare `scripts/lib/`,
 * quindi li' il predicato e' scritto a mano e il costrutto vietato non compare
 * comunque. Resta dentro lo scope del gate proprio per questo — se ci rientra,
 * e' una violazione vera.
 */
const GLOBS = ['scripts/**', 'build-plugins/**', 'services/**', 'tests/**', 'functions/**', '.github/**'];

const NUMBER_ENV_FALLBACK_PATTERN = /Number\(\s*process\s*\.\s*env\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$]*|\[\s*(?:'[^']*'|"[^"]*")\s*\])\s*\|\|/;

/** A raw env number is only dangerous when it controls a bounded operation. */
const RAW_NUMBER_ENV_ASSIGNMENT_RE =
  /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*Number\(\s*process\s*\.\s*env\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$]*|\[\s*(?:'[^']*'|"[^"]*")\s*\])\s*\)(?!\s*(?:\|\||\?\?))/g;

/**
 * Remove comments without changing offsets, so regex matches still map to the
 * original line and comments cannot manufacture a violation.
 */
function stripCommentsForNumberEnvGate(source) {
  let out = '';
  let block = false;
  let line = false;
  let quote = '';

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (line) {
      if (c === '\n') {
        line = false;
        out += c;
      } else {
        out += ' ';
      }
      continue;
    }

    if (block) {
      if (c === '*' && next === '/') {
        block = false;
        out += '  ';
        i++;
      } else {
        out += c === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < source.length) out += source[++i];
      else if (c === quote) quote = '';
      continue;
    }

    if (c === '/' && next === '/') {
      line = true;
      out += '  ';
      i++;
    } else if (c === '/' && next === '*') {
      block = true;
      out += '  ';
      i++;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
    } else {
      out += c;
    }
  }
  return out;
}

function escapeNumericEnvIdentifier(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containingNumericEnvBlock(source, index) {
  const stack = [];
  let quote = '';
  for (let i = 0; i < index; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '{') {
      stack.push(i);
    } else if (c === '}') {
      stack.pop();
    }
  }
  if (stack.length === 0) return [0, source.length];

  const start = stack[stack.length - 1] + 1;
  let depth = 1;
  quote = '';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return [start, i];
    }
  }
  return [start, source.length];
}

/**
 * Find raw Number(process.env.X) assignments that control a local bound.
 * This deliberately stays syntactic: it does not follow values across files
 * or through functions. The helper is exported so fixture tests prove both
 * the positive rule and its false-positive boundary.
 */
export function findRawNumberEnvBoundViolations(source, file = '<fixture>') {
  const code = stripCommentsForNumberEnvGate(String(source ?? ''));
  const violations = [];
  let match;

  while ((match = RAW_NUMBER_ENV_ASSIGNMENT_RE.exec(code))) {
    const variable = match[1];
    const escaped = escapeNumericEnvIdentifier(variable);
    const [scopeStart, scopeEnd] = containingNumericEnvBlock(code, match.index);
    const compactNumericEnvScope = code.slice(scopeStart, scopeEnd).replace(/\s+/g, ' ');
    const usedAsBound = [
      new RegExp(`\\.\\s*slice\\s*\\([^)]*\\b${escaped}\\b`),
      new RegExp(`\\bfor\\s*\\([^)]*\\b${escaped}\\b[^)]*\\)`),
      new RegExp(`\\bconcurrency\\b\\s*[:=]\\s*\\b${escaped}\\b`, 'i'),
    ].some((pattern) => pattern.test(compactNumericEnvScope));

    if (!usedAsBound) continue;
    const line = code.slice(0, match.index).split('\n').length;
    const content = String(source).split('\n')[line - 1]?.trim() || '';
    violations.push({ file, line, content });
  }
  return violations;
}

/**
 * La riga contiene il costrutto vietato in CODICE (non in un commento)?
 * Pura → testabile.
 */
export function lineHasNumberEnvFallback(line) {
  const s = String(line ?? '');
  const trimmed = s.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('#')) return false;
  const code = s.split('//')[0];
  return NUMBER_ENV_FALLBACK_PATTERN.test(code);
}

/**
 * `[[:space:]]` e non `\s`. `git grep -E` usa il regex engine della piattaforma:
 * `\s` e' un'estensione GNU che su Linux (i runner CI) funziona e su macOS
 * (BSD) **non matcha niente**. La prima versione di questo gate lo usava e
 * rendeva `0 violazioni` in locale mentre in CI ne trovava 5 — cioe' proprio il
 * verde vacuo che questo gate esiste per impedire, in questo gate. La classe
 * POSIX e' l'unica forma che significa la stessa cosa sui due sistemi.
 */
const GIT_GREP_PATTERN = 'Number\\([[:space:]]*process[[:space:]]*\\.[[:space:]]*env';

/**
 * CONTROLLO POSITIVO. `tests/int-from-env.test.ts` contiene per mestiere il
 * costrutto vietato, nelle due spaziature che il pattern deve coprire
 * (`Number(process.env.X || 8000)` e `Number( process.env.FOO_MS || 120_000 )`).
 * Se la ricerca NON lo trova, l'albero non e' pulito: e' la ricerca a non aver
 * guardato — motore di regex, pathspec o invocazione.
 *
 * Serve perche' un pattern rotto e un albero pulito producono lo stesso identico
 * output, ed e' gia' successo A QUESTO GATE: la prima versione usava `\s`, che
 * `git grep -E` risolve come estensione GNU su Linux e non risolve affatto su
 * macOS. In locale rendeva `0 violazioni`, in CI ne trovava 5. Un gate che si
 * spegne in silenzio e' peggio di nessun gate, perche' lo si legge come verde.
 *
 * `check-client-lookbehind.mjs` documenta di NON poter avere questo controllo
 * («no guaranteed-present token exists»); qui il token esiste, quindi c'e'.
 */
const CANARY_FILE = 'tests/int-from-env.test.ts';

function gitGrep(pattern) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-nE', pattern, '--', ...GLOBS],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split('\n').filter(Boolean);
  } catch (e) {
    // Stessa disciplina di check-client-lookbehind: exit 1 senza output e' il
    // solo no-match legittimo; qualunque altro esito rilancia, cosi' il gate
    // fallisce forte invece di rendere [] su un albero che non ha ispezionato.
    if (isGitGrepNoMatch(e)) return [];
    throw e;
  }
}

function gitGrepLines() {
  const hits = gitGrep(GIT_GREP_PATTERN);
  if (!hits.some((h) => {
    if (!h.startsWith(`${CANARY_FILE}:`)) return false;
    const content = h.replace(/^[^:]+:\d+:/, '');
    return lineHasNumberEnvFallback(content);
  })) {
    throw new Error(
      `check-number-env-fallback: il controllo positivo non ha trovato il costrutto in ${CANARY_FILE}, `
      + 'dove c\'e\' di sicuro. La ricerca non ha guardato l\'albero (pathspec, motore di regex o '
      + 'invocazione): zero violazioni qui NON significa pulito.',
    );
  }
  return hits;
}

export function findViolations() {
  const violations = [];
  const rawCandidateFiles = new Set();
  for (const hit of gitGrepLines()) {
    const m = hit.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineno, content] = m;
    rawCandidateFiles.add(file);
    // `.yml` incluso: lo script inline di `actions/github-script` e' JavaScript
    // eseguito, con lo stesso identico guasto (misurato:
    // `.github/workflows/job-title-locale-audit.yml` calcolava la soglia di
    // allarme con questo costrutto). Escluderlo avrebbe lasciato fuori dal
    // gate una meta' del reporting.
    if (!/\.(mjs|cjs|js|ts|tsx|ya?ml)$/.test(file)) continue;
    // Stessa esenzione di check-client-lookbehind: un test PUO' scrivere
    // l'antipattern, e' il suo mestiere documentarlo.
    if (file.includes('.test.') || file.includes('.spec.')) continue;
    // E questo file scrive il costrutto nei propri messaggi d'errore. Senza
    // l'esenzione il gate sarebbe rosso per sempre, il che lo renderebbe
    // inutile — la sua correttezza e' pinnata da tests/int-from-env.test.ts.
    if (file === 'scripts/ci/check-number-env-fallback.mjs') continue;
    if (lineHasNumberEnvFallback(content)) violations.push({ file, line: Number(lineno), content: content.trim() });
  }

  for (const file of rawCandidateFiles) {
    if (file.includes('.test.') || file.includes('.spec.')) continue;
    if (file === 'scripts/ci/check-number-env-fallback.mjs') continue;
    const source = readFileSync(file, 'utf8');
    violations.push(...findRawNumberEnvBoundViolations(source, file));
  }

  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

function main() {
  const violations = findViolations();
  if (JSON_OUT) console.log(JSON.stringify({ violations }, null, 2));

  if (violations.length === 0) {
    if (!JSON_OUT) console.log('✓ check-number-env-fallback: nessun fallback numerico non validato nel codice.');
    process.exit(0);
  }

  if (!JSON_OUT) {
    console.error(
      `✗ check-number-env-fallback: ${violations.length} occorrenza/e di lettura numerica non validata — `
      + 'un valore non numerico o non positivo si propaga in silenzio (issue #7344/#884):\n',
    );
    for (const v of violations) console.error(`  - ${v.file}:${v.line}  ${v.content.slice(0, 110)}`);
    console.error(
      "\nFix: intFromEnv('X', N) da scripts/lib/int-from-env.mjs. Dove l'import non e' possibile "
      + '(functions/ e\' un bundle di deploy separato) ripeti il predicato a mano e dillo nel commento.',
    );
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
