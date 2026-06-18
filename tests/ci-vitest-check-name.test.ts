import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { VITEST_CHECK_NAME, VITEST_SHARD_NAME_RE } from '../scripts/ci/lib/constants.mjs';

/**
 * Guard per il drift descritto in #1602: il nome del check-run vitest è la
 * source-of-truth in `.github/workflows/tests.yml` (`name:` del job), ma due
 * script CI lo consumano in un filtro `jq` — `auto-merge-eval.mjs` (gate 3:
 * HEAD vitest == success) e `pr-autorebase.mjs` (rileva head orfani a 0 vitest).
 * Se il job viene rinominato senza aggiornare la const, entrambi leggono in
 * silenzio length 0 / conclusion "" → heal ri-dispatcha all'infinito e nessuna
 * PR mergia. Questo test fa fallire la suite (= il gate vitest stesso) prima che
 * il drift raggiunga main, e verifica che gli script usino la const condivisa
 * invece di un literal copy-pasted.
 */

const ROOT = resolve(import.meta.dirname, '..');
const TESTS_YML = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf-8');
const AUTOREBASE = readFileSync(resolve(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf-8');
const AUTO_MERGE_EVAL = readFileSync(resolve(ROOT, 'scripts/ci/auto-merge-eval.mjs'), 'utf-8');

describe('VITEST_CHECK_NAME (#1602 drift guard)', () => {
  it('matcha byte-per-byte il name: del job vitest in tests.yml', () => {
    // Estrae il `name:` del job `vitest:` (può essere quotato o no).
    const m = TESTS_YML.match(/^\s*vitest:\s*\n\s*name:\s*(.+?)\s*$/m);
    expect(m, 'job `vitest:` con `name:` non trovato in tests.yml').toBeTruthy();
    const jobName = (m![1] || '').replace(/^['"]|['"]$/g, '');
    expect(jobName).toBe(VITEST_CHECK_NAME);
  });

  it('è il valore atteso (cattura un rename involontario della const stessa)', () => {
    expect(VITEST_CHECK_NAME).toBe('vitest (unit + integration)');
  });

  it('entrambi gli script importano la const invece di un literal nel filtro jq', () => {
    for (const [name, src] of [
      ['pr-autorebase.mjs', AUTOREBASE],
      ['auto-merge-eval.mjs', AUTO_MERGE_EVAL],
    ] as const) {
      // Tollerante ai co-import dallo STESSO modulo (es. auto-merge-eval.mjs
      // importa anche REDFLAG_IMPORTANT_RE): l'intento è "VITEST_CHECK_NAME viene
      // da constants.mjs", non "è l'UNICO named import". Un match esatto sulla
      // riga rompeva legittimamente all'aggiunta di un secondo import condiviso.
      expect(
        /import\s*\{[^}]*\bVITEST_CHECK_NAME\b[^}]*\}\s*from\s*'\.\/lib\/constants\.mjs'/.test(src),
        `${name} non importa VITEST_CHECK_NAME da './lib/constants.mjs'`,
      ).toBe(true);
      // Nessun literal hardcoded dentro un `select(.name == "...")` (eseguibile).
      expect(
        src.includes('select(.name == "vitest (unit + integration)")'),
        `${name} usa ancora il literal hardcoded in jq invece della const`,
      ).toBe(false);
    }
  });

  // Generalizzazione (feedback backlog-agent #3): non solo i 2 consumer noti —
  // NESSUN nuovo script sotto scripts/ci/ deve reintrodurre il literal. Coglie
  // un futuro helper che copia-incolla "vitest (unit + integration)" invece di
  // importare la const, all'author-time invece che in una follow-up issue.
  it('nessuno script in scripts/ci/ hardcoda il literal vitest check-name (oltre constants.mjs)', () => {
    const CI_DIR = resolve(ROOT, 'scripts/ci');
    // Comment-aware: il literal nei docstring/commenti (es. che DESCRIVONO il
    // check name) è legittimo — solo l'uso ESEGUIBILE è drift. Salta le righe
    // che sono commenti (`//`, `*`, `/*`).
    const isCommentLine = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
    const offenders: string[] = [];
    for (const entry of readdirSync(CI_DIR, { recursive: true, encoding: 'utf-8' })) {
      if (!entry.endsWith('.mjs')) continue;
      if (entry.replace(/\\/g, '/').endsWith('lib/constants.mjs')) continue; // la source-of-truth
      const src = readFileSync(resolve(CI_DIR, entry), 'utf-8');
      const hit = src.split('\n').some((l) => l.includes('vitest (unit + integration)') && !isCommentLine(l));
      if (hit) offenders.push(entry);
    }
    expect(offenders, `script con literal hardcoded ESEGUIBILE (devono importare VITEST_CHECK_NAME): ${offenders.join(', ')}`)
      .toEqual([]);
  });
});

/**
 * Guard analogo per VITEST_SHARD_NAME_RE (#2438): il regex deve matchare il
 * `name:` del job SHARD in tests.yml (`vitest shard ${{ matrix.shard }}/4`).
 * `vitestFailureIsTransientCancellation` lo usa per riaprire gli shard sotto
 * l'aggregatore; un rename del job senza aggiornare il regex farebbe leggere 0
 * shard → l'heal transient non scatterebbe mai (silenzioso, come #1602).
 */
describe('VITEST_SHARD_NAME_RE (#2438 shard-name drift guard)', () => {
  it('matcha il name: del job shard reso da tests.yml per ogni indice della matrice', () => {
    const m = TESTS_YML.match(/^\s*vitest-shard:\s*\n(?:.*\n)*?\s*name:\s*(.+?)\s*$/m);
    expect(m, 'job `vitest-shard:` con `name:` non trovato in tests.yml').toBeTruthy();
    const tpl = (m![1] || '').replace(/^['"]|['"]$/g, '');
    // Estrae il count statico dal template `vitest shard ${{ matrix.shard }}/N`.
    const countMatch = tpl.match(/\}\}\/(\d+)\s*$/);
    expect(countMatch, `count statico /N non trovato in name: "${tpl}"`).toBeTruthy();
    const count = Number(countMatch![1]);
    // Espande il template per ogni shard della matrice e verifica il match.
    for (let i = 1; i <= count; i++) {
      const rendered = tpl.replace(/\$\{\{\s*matrix\.shard\s*\}\}/g, String(i));
      expect(VITEST_SHARD_NAME_RE.test(rendered), `regex non matcha shard "${rendered}"`).toBe(true);
    }
  });

  it('NON matcha il nome dell’aggregatore (i due check-name restano distinti)', () => {
    expect(VITEST_SHARD_NAME_RE.test(VITEST_CHECK_NAME)).toBe(false);
  });
});
