import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeShardFileIfChanged, writeFileAtomic } from '../scripts/lib/atomic-shard-write.mjs';

// Guards issue #6696 item 2/2: shard writes used to go straight to
// `fs.writeFileSync(file, content)`, which is not atomic — a process killed
// mid-write (OOM/SIGKILL) can leave the shard truncated, and every shard
// reader silently skips an unparseable shard rather than throwing. These
// tests assert the temp+rename contract directly: no partial file is ever
// observable at the destination path, and a mid-write failure never corrupts
// pre-existing content.

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-shard-write-test-'));
  file = path.join(dir, 'part-00.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('writeFileAtomic', () => {
  it('writes the destination with the given content', () => {
    writeFileAtomic(file, 'hello\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello\n');
  });

  it('leaves no temp file behind after a successful write', () => {
    writeFileAtomic(file, 'hello\n');
    expect(fs.readdirSync(dir)).toEqual(['part-00.json']);
  });

  it('never leaves the destination truncated if the write step fails mid-way', () => {
    writeFileAtomic(file, 'original\n');
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('simulated crash mid-write');
    });
    expect(() => writeFileAtomic(file, 'corrupted\n')).toThrow('simulated crash mid-write');
    spy.mockRestore();
    // The destination still holds the OLD content, never a partial write.
    expect(fs.readFileSync(file, 'utf-8')).toBe('original\n');
  });

  it('cleans up the temp file after a failed write', () => {
    writeFileAtomic(file, 'original\n');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated rename failure');
    });
    expect(() => writeFileAtomic(file, 'corrupted\n')).toThrow('simulated rename failure');
    spy.mockRestore();
    expect(fs.readdirSync(dir)).toEqual(['part-00.json']);
  });
});

describe('writeShardFileIfChanged', () => {
  it('writes and returns true when the file does not exist yet', () => {
    expect(writeShardFileIfChanged(file, 'content\n')).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('content\n');
  });

  it('returns false and does not touch the file when content is unchanged', () => {
    writeShardFileIfChanged(file, 'content\n');
    const mtimeBefore = fs.statSync(file).mtimeMs;
    expect(writeShardFileIfChanged(file, 'content\n')).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  it('rethrows a non-ENOENT read error instead of forcing a write', () => {
    fs.mkdirSync(file, { recursive: true });
    expect(() => writeShardFileIfChanged(file, 'content\n')).toThrow();
  });
});
