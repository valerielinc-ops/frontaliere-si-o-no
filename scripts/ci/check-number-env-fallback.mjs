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
 *
 * Usage: node scripts/ci/check-number-env-fallback.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
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

const BAD_RE = /Number\(\s*process\.env\.[A-Za-z_0-9]+\s*\|\|/;

/**
 * La riga contiene il costrutto vietato in CODICE (non in un commento)?
 * Pura → testabile.
 */
export function lineHasNumberEnvFallback(line) {
  const s = String(line ?? '');
  const trimmed = s.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('#')) return false;
  const code = s.split('//')[0];
  return BAD_RE.test(code);
}

function gitGrepLines() {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-nE', 'Number\\(\\s*process\\.env\\.[A-Za-z_0-9]+\\s*\\|\\|', '--', ...GLOBS],
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

export function findViolations() {
  const violations = [];
  for (const hit of gitGrepLines()) {
    const m = hit.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineno, content] = m;
    if (!/\.(mjs|cjs|js|ts|tsx)$/.test(file)) continue;
    if (lineHasNumberEnvFallback(content)) violations.push({ file, line: Number(lineno), content: content.trim() });
  }
  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

function main() {
  const violations = findViolations();
  if (JSON_OUT) console.log(JSON.stringify({ violations }, null, 2));

  if (violations.length === 0) {
    if (!JSON_OUT) console.log('✓ check-number-env-fallback: nessun Number(process.env.X || N) nel codice.');
    process.exit(0);
  }

  if (!JSON_OUT) {
    console.error(
      `✗ check-number-env-fallback: ${violations.length} occorrenza/e di Number(process.env.X || N) — `
      + 'un valore non numerico diventa NaN e si propaga in silenzio (issue #7344):\n',
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
