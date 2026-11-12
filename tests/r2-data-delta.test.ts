import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DELTA = path.join(ROOT, 'scripts/ci/prepare-r2-data-delta.mjs');

function run(args: string[]): string {
  return execFileSync(process.execPath, [DELTA, ...args], { encoding: 'utf8' });
}

describe('R2 data-prefix manifest delta', () => {
  it('bootstraps fully, then checkpoints only changed and added objects', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-data-delta-'));
    try {
      const source = path.join(workspace, 'data');
      const previous = path.join(workspace, 'previous.json');
      const candidate = path.join(workspace, 'candidate.json');
      const changed = path.join(workspace, 'changed.txt');
      const completed = path.join(workspace, 'completed.txt');
      fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(source, 'a.json'), '{"a":1}');
      fs.writeFileSync(path.join(source, 'nested/b.json'), '{"b":1}');

      const cold = run([source, previous, changed, candidate]);
      expect(cold).toContain('mode=full previous=missing');
      expect(fs.readFileSync(changed, 'utf8')).toBe('a.json\nnested/b.json\n');
      fs.writeFileSync(completed, fs.readFileSync(changed));
      run(['record-progress', candidate, previous, changed, completed, previous, source, 'complete']);

      fs.writeFileSync(path.join(source, 'a.json'), '{"a":2}');
      fs.writeFileSync(path.join(source, 'nested/c.json'), '{"c":1}');
      fs.rmSync(path.join(source, 'nested/b.json'));

      const delta = run([source, previous, changed, candidate]);
      expect(delta).toContain('mode=delta previous=valid');
      expect(fs.readFileSync(changed, 'utf8')).toBe('a.json\nnested/c.json\n');

      fs.writeFileSync(completed, 'a.json\n');
      run(['record-progress', candidate, previous, changed, completed, previous, source, 'partial']);
      const partial = JSON.parse(fs.readFileSync(previous, 'utf8')) as {
        prefix: string;
        files: Array<{ path: string; sha256: string }>;
      };
      expect(partial.prefix).toBe('data');
      expect(partial.files.map((file) => file.path)).toEqual(['a.json', 'nested/b.json']);
      expect(partial.files.find((file) => file.path === 'a.json')?.sha256).toMatch(/^[a-f0-9]{64}$/);

      const resumed = run([source, previous, changed, candidate]);
      expect(resumed).toContain('mode=delta previous=valid');
      expect(fs.readFileSync(changed, 'utf8')).toBe('nested/c.json\n');
      fs.writeFileSync(completed, 'nested/c.json\n');
      run(['record-progress', candidate, previous, changed, completed, previous, source, 'complete']);
      const published = JSON.parse(fs.readFileSync(previous, 'utf8')) as {
        files: Array<{ path: string }>;
      };
      expect(published.files.map((file) => file.path)).toEqual(['a.json', 'nested/b.json', 'nested/c.json']);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('refuses to checkpoint an object whose source changed after hashing', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-data-delta-unverified-'));
    try {
      const source = path.join(workspace, 'data');
      const previous = path.join(workspace, 'previous.json');
      const candidate = path.join(workspace, 'candidate.json');
      const changed = path.join(workspace, 'changed.txt');
      const completed = path.join(workspace, 'completed.txt');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'a.json'), '{"a":1}');
      run([source, previous, changed, candidate]);
      fs.writeFileSync(completed, 'a.json\n');
      fs.writeFileSync(path.join(source, 'a.json'), '{"a":2}');

      expect(() => run([
        'record-progress', candidate, previous, changed, completed, previous, source, 'partial',
      ])).toThrow();
      expect(fs.existsSync(previous)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('refuses to mark the candidate complete while changed objects lack checkpoints', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-data-delta-incomplete-'));
    try {
      const source = path.join(workspace, 'data');
      const previous = path.join(workspace, 'previous.json');
      const candidate = path.join(workspace, 'candidate.json');
      const changed = path.join(workspace, 'changed.txt');
      const completed = path.join(workspace, 'completed.txt');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'a.json'), '{"a":1}');
      run([source, previous, changed, candidate]);
      fs.writeFileSync(completed, '');

      expect(() => run([
        'record-progress', candidate, previous, changed, completed, previous, source, 'complete',
      ])).toThrow(/has no verified checkpoint/);
      expect(fs.existsSync(previous)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('enforces the whole-phase deadline before writing a candidate manifest', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-data-delta-deadline-'));
    try {
      const source = path.join(workspace, 'data');
      const previous = path.join(workspace, 'previous.json');
      const candidate = path.join(workspace, 'candidate.json');
      const changed = path.join(workspace, 'changed.txt');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'a.json'), '{"a":1}');

      let failure: { stderr?: Buffer | string } | undefined;
      try {
        execFileSync(process.execPath, [DELTA, source, previous, changed, candidate], {
          encoding: 'utf8',
          env: { ...process.env, R2_DATA_DEADLINE_EPOCH_MS: '1' },
        });
      } catch (error) {
        failure = error as { stderr?: Buffer | string };
      }

      expect(failure?.stderr?.toString()).toContain('R2 data phase exceeded its total limit');
      expect(fs.existsSync(candidate)).toBe(false);
      expect(fs.existsSync(changed)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
