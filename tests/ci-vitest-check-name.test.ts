import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — modulo .mjs senza tipi
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

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
      expect(src, `${name} non importa VITEST_CHECK_NAME`).toContain(
        "import { VITEST_CHECK_NAME } from './lib/constants.mjs'",
      );
      // Nessun literal hardcoded dentro un `select(.name == "...")` (eseguibile).
      expect(
        src.includes('select(.name == "vitest (unit + integration)")'),
        `${name} usa ancora il literal hardcoded in jq invece della const`,
      ).toBe(false);
    }
  });
});
