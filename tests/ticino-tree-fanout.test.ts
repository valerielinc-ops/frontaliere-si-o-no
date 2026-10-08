import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HELPER = join(process.cwd(), 'scripts/lib/ticino-tree-fanout.sh');
const PUSH_SCRIPT = join(process.cwd(), 'scripts/lib/push-section-shard.sh');

describe('Ticino shard tree fan-out', () => {
  it('is wired into the section push and disables the incompatible delta path', () => {
    const script = readFileSync(PUSH_SCRIPT, 'utf8');
    expect(script).toContain('source "$(dirname "${BASH_SOURCE[0]}")/ticino-tree-fanout.sh"');
    expect(script).toContain('if [ "$section" = ticino ] && [ "$SHARD_PUSH_MODE" != full ]');
    expect(script).toContain('skipping advisory delta verifier');
    expect(script).toContain('ticino_tree_fanout_stage "$section" "$stage/$sub"');
  });

  it('moves first-level entries into stable buckets and keeps the root index', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ticino-tree-fanout-'));
    const root = join(temp, 'de', 'jobs-im-tessin');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'index.html'), 'section shell');
      mkdirSync(join(root, 'Ir-Job-123'), { recursive: true });
      writeFileSync(join(root, 'Ir-Job-123', 'index.html'), 'job');
      mkdirSync(join(root, 'aa-company'), { recursive: true });
      writeFileSync(join(root, 'aa-company', 'index.html'), 'company');
      writeFileSync(join(root, 'zz-flat.html'), 'flat');

      execFileSync(
        'bash',
        ['-c', 'source "$1" && ticino_tree_fanout_stage ticino "$2"', 'fanout-test', HELPER, root],
        { stdio: 'pipe' },
      );

      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('section shell');
      expect(readFileSync(join(root, '_tree', 'ir', 'Ir-Job-123', 'index.html'), 'utf8')).toBe('job');
      expect(readFileSync(join(root, '_tree', 'aa', 'aa-company', 'index.html'), 'utf8')).toBe('company');
      expect(readFileSync(join(root, '_tree', 'zz', 'zz-flat.html'), 'utf8')).toBe('flat');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('leaves non-Ticino section trees untouched', () => {
    const temp = mkdtempSync(join(tmpdir(), 'non-ticino-tree-'));
    const root = join(temp, 'section');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'entry.html'), 'page');
      execFileSync(
        'bash',
        ['-c', 'source "$1" && ticino_tree_fanout_stage svizzera "$2"', 'fanout-test', HELPER, root],
        { stdio: 'pipe' },
      );
      expect(readFileSync(join(root, 'entry.html'), 'utf8')).toBe('page');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('restores a physical Ticino tree to canonical paths for rehydration', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ticino-tree-unfanout-'));
    const root = join(temp, 'de', 'jobs-im-tessin');
    try {
      mkdirSync(join(root, '_tree', 'ir', 'Ir-Job-123'), { recursive: true });
      mkdirSync(join(root, '_tree', '.w'), { recursive: true });
      writeFileSync(join(root, 'index.html'), 'section shell');
      writeFileSync(join(root, '_tree', 'ir', 'Ir-Job-123', 'index.html'), 'job');
      writeFileSync(join(root, '_tree', '.w', '.well-known'), 'metadata');

      execFileSync(
        'bash',
        ['-c', 'source "$1" && ticino_tree_unfanout_stage ticino "$2"', 'unfanout-test', HELPER, root],
        { stdio: 'pipe' },
      );

      expect(readFileSync(join(root, 'Ir-Job-123', 'index.html'), 'utf8')).toBe('job');
      expect(readFileSync(join(root, '.well-known'), 'utf8')).toBe('metadata');
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('section shell');
      expect(() => readFileSync(join(root, '_tree', 'ir', 'Ir-Job-123', 'index.html'))).toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
