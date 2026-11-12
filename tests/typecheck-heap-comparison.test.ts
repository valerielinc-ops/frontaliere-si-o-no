import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const gate = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-typecheck-baseline.mjs'), 'utf8');
const comparison = fs.readFileSync(path.join(ROOT, 'scripts/ci/compare-typecheck-heap.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');

describe('typecheck heap comparison contract (#18199)', () => {
  it('lascia il limite heap al runner invece di sovrascriverlo nel processo figlio', () => {
    expect(gate).not.toContain("'--max-old-space-size=12288'");
    expect(gate).toContain('spawnSync(process.execPath, [TSC_BIN');
  });

  it('confronta old e new sullo stesso checkout con cache incrementale azzerata', () => {
    expect(comparison).toContain('OLD_HEAP_MB=12288');
    expect(comparison).toContain('NEW_HEAP_MB=10240');
    expect(comparison).toContain('rm -f "$BUILD_INFO"');
    expect(comparison.match(/npm run typecheck:gate/gu)).toHaveLength(1);
    expect(comparison).toContain('old_status');
    expect(comparison).toContain('new_status');
  });

  it('fallisce se una variante non passa o il nuovo RSS raggiunge il limite runner', () => {
    expect(comparison).toContain('[ "$old_status" -ne 0 ] || [ "$new_status" -ne 0 ]');
    expect(comparison).toContain('[ "$new_peak_mb" -ge "$runner_limit_mb" ]');
    expect(comparison).toContain('/sys/fs/cgroup/memory.max');
    expect(comparison).toContain('/proc/meminfo');
  });

  it('sostituisce il gate ordinario solo per modifiche al contratto heap', () => {
    expect(workflow).toContain('scripts/ci/compare-typecheck-heap.sh');
    expect(workflow).toContain('TYPECHECK_HEAP_COMPARISON');
    expect(workflow).toContain('scripts/ci/check-typecheck-baseline.mjs');
    expect(workflow).toContain('tests/typecheck-heap-comparison.test.ts');
  });
});
