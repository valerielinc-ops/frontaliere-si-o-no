// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIB = path.resolve(import.meta.dirname, '../scripts/lib/parallel-tar.sh');
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-tar-'));
  roots.push(root);
  return root;
}

function sh(script: string, args: string[] = []): string {
  return execFileSync('bash', ['-euo', 'pipefail', '-c', `source "$0"; ${script}`, LIB, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeTree(root: string): void {
  // Deep, wide tree: contiguous preorder slices start in the middle of
  // nested directories, which is what made the parallel extraction race.
  for (let s = 0; s < 3; s += 1) {
    for (let c = 0; c < 12; c += 1) {
      for (let p = 0; p < 4; p += 1) {
        const dir = path.join(root, 'dist', `section-${s}`, `comune-${c}`, `page-${p}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), `<p>${s}/${c}/${p}</p>`);
      }
    }
  }
}

function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) { out.push(`${rel}/`); walk(full); }
      else out.push(`${rel} ${fs.readFileSync(full, 'utf8')}`);
    }
  };
  walk(root);
  return out;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('parallel-tar extraction', () => {
  it.each([2, 5, 9])('round-trips a deep tree split into %i parts', (parts) => {
    const root = tempRoot();
    const src = path.join(root, 'src');
    const out = path.join(root, 'out');
    const dest = path.join(root, 'dest');
    writeTree(src);

    sh('ptar_create "$1" "$2" bundle "$3" dist', [src, out, String(parts)]);
    const archives = fs.readdirSync(out).filter((name) => /\.part-\d+\.tar$/u.test(name)).sort()
      .map((name) => path.join(out, name));
    expect(archives).toHaveLength(parts);

    // Later parts start below directories they do not carry themselves.
    const firsts = archives.map((archive) => sh('ptar_first_member "$1"', [archive]));
    expect(firsts[0]).toBe('dist/');
    expect(firsts.slice(1).every((name) => name.split('/').filter(Boolean).length >= 3)).toBe(true);

    sh('ptar_extract "$1" "${@:2}"', [dest, ...archives]);
    expect(listing(dest)).toEqual(listing(src));
  });

  it('creates every later part\'s missing ancestors before the parallel phase', () => {
    const source = fs.readFileSync(LIB, 'utf8');
    const body = source.slice(source.indexOf('ptar_extract() {'));
    const precreate = body.indexOf('mkdir -p -- "$parent"');
    const parallel = body.indexOf('tar -C "$dest" -xf');
    expect(precreate).toBeGreaterThan(0);
    expect(parallel).toBeGreaterThan(precreate);
  });

  it('prints nothing for an empty archive instead of failing the extraction', () => {
    const root = tempRoot();
    const empty = path.join(root, 'empty.tar');
    execFileSync('tar', ['-cf', empty, '-T', '/dev/null']);
    expect(sh('ptar_first_member "$1"', [empty])).toBe('');
    const dest = path.join(root, 'dest');
    sh('ptar_extract "$1" "${@:2}"', [dest, empty, empty]);
    expect(fs.readdirSync(dest)).toEqual([]);
  });
});
