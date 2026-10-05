import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Thin vitest entry point for tests/python/local_mt_translate_batched_test.py,
 * same pattern as tests/local-mt-translate-sentinel.test.ts: the batched Argos
 * engine of scripts/local-mt-translate.py is Python, so its assertions live in
 * a stdlib `unittest` file and this wrapper makes them part of `npm test`.
 */
describe('local-mt-translate.py — batched Argos engine', () => {
  it('python3 tests/python/local_mt_translate_batched_test.py exits 0 (8 unittest cases)', () => {
    const script = path.join(__dirname, 'python', 'local_mt_translate_batched_test.py');
    const proc = spawnSync('python3', [script], { encoding: 'utf-8' });

    if (proc.error) {
      throw new Error(`failed to spawn python3: ${proc.error.message}`);
    }
    expect(proc.status, `stderr:\n${proc.stderr}\nstdout:\n${proc.stdout}`).toBe(0);
    expect(proc.stderr).toMatch(/Ran 8 tests/);
    expect(proc.stderr).toMatch(/\bOK\b/);
  });
});
