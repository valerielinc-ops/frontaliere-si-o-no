import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * #5587 item1 — thin vitest entry point for tests/python/local_mt_translate_sentinel_test.py.
 *
 * scripts/local-mt-translate.py is a Python worker (Argos Translate), not
 * JS — the sentinel/segmentation logic it needs exercising lives in Python,
 * so the actual assertions live in that file (stdlib `unittest`, no pytest
 * dependency this repo doesn't otherwise have). This wrapper just makes it
 * discoverable by `npm test` / `vitest run` like every other regression here,
 * the same pattern scripts/local-mt-mopup.mjs already uses to shell out to
 * this same script in production (spawnSync, not an HTTP call).
 *
 * Before this test, scripts/local-mt-translate.py had ZERO references to
 * ZQX/sentinel/truecase and nothing exercised it — the gender-trigraph guard
 * (#5562) was proven on the Node side (mask/restore) and on the OTHER two
 * translation writers (the HTTP cascade, the local pipeline) but never on
 * this one, despite this tier producing "the BULK of the mop-up-translated
 * corpus" per its own header. See the Python file's module docstring for
 * exactly what these tests do and do not prove — the real-Argos corruption
 * risk stays genuinely unverified (no models installed here) and is not
 * papered over.
 */
describe('local-mt-translate.py — sentinel masking survives the wrapper (#5587 item1)', () => {
  it('python3 tests/python/local_mt_translate_sentinel_test.py exits 0 (7 unittest cases)', () => {
    const script = path.join(__dirname, 'python', 'local_mt_translate_sentinel_test.py');
    const proc = spawnSync('python3', [script], { encoding: 'utf-8' });

    if (proc.error) {
      throw new Error(`failed to spawn python3: ${proc.error.message}`);
    }
    expect(proc.status, `stderr:\n${proc.stderr}\nstdout:\n${proc.stdout}`).toBe(0);
    // unittest prints its tally to stderr ("Ran N tests ... OK").
    expect(proc.stderr).toMatch(/Ran 7 tests/);
    expect(proc.stderr).toMatch(/\bOK\b/);
  });
});
