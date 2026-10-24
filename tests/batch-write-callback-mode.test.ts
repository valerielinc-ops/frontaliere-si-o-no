import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_WRITE_CALLBACK_ENV, flushWrites, isCallbackWriteEnabled } from '../build-plugins/batchWrite';

const previous = process.env[BUILD_WRITE_CALLBACK_ENV];
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-write-cb-'));
  roots.push(root);
  return root;
}

function writesUnder(root: string) {
  return [
    { filePath: path.join(root, 'de', 'jobs-im-tessin', 'a', 'index.html'), content: '<!doctype html><p>Grenzgänger – €</p>' },
    { filePath: path.join(root, 'de', 'jobs-im-tessin', 'a.html'), content: '<!doctype html><p>Grenzgänger – €</p>' },
    { filePath: path.join(root, 'cerca-lavoro-ticino', 'b', 'index.html'), content: 'x'.repeat(70_000) },
  ];
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return out;
}

describe('flushWrites — BUILD_WRITE_CALLBACK', () => {
  afterEach(() => {
    if (previous === undefined) delete process.env[BUILD_WRITE_CALLBACK_ENV];
    else process.env[BUILD_WRITE_CALLBACK_ENV] = previous;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses only an explicit 1', () => {
    expect(isCallbackWriteEnabled({})).toBe(false);
    expect(isCallbackWriteEnabled({ [BUILD_WRITE_CALLBACK_ENV]: 'true' })).toBe(false);
    expect(isCallbackWriteEnabled({ [BUILD_WRITE_CALLBACK_ENV]: '1' })).toBe(true);
  });

  it('writes the same bytes as the promise path', async () => {
    delete process.env[BUILD_WRITE_CALLBACK_ENV];
    const promiseRoot = tmpRoot();
    expect(await flushWrites(writesUnder(promiseRoot), 2)).toBe(3);

    process.env[BUILD_WRITE_CALLBACK_ENV] = '1';
    const callbackRoot = tmpRoot();
    expect(await flushWrites(writesUnder(callbackRoot), 2)).toBe(3);

    expect(snapshot(callbackRoot)).toEqual(snapshot(promiseRoot));
  });

  it('still rejects on a write error', async () => {
    process.env[BUILD_WRITE_CALLBACK_ENV] = '1';
    const root = tmpRoot();
    // A directory where the file should go makes writeFile fail with EISDIR.
    const target = path.join(root, 'page', 'index.html');
    fs.mkdirSync(target, { recursive: true });
    await expect(flushWrites([{ filePath: target, content: 'x' }], 1)).rejects.toThrow();
  });
});
