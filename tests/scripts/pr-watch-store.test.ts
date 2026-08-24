/**
 * pr-watch-store.mjs — the persisted watch list that keeps a session from
 * ending while a PR it opened has not reached a terminal state.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  storePath,
  readEntries,
  writeEntries,
  addEntry,
  removeEntry,
  extractPrRef,
  STORE_REL_PATH,
} from '../../scripts/ci/lib/pr-watch-store.mjs';

describe('extractPrRef — pulled out of raw text, not a structured field', () => {
  it('finds owner/repo/number in a plain PR URL', () => {
    expect(extractPrRef('https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6318')).toEqual({
      owner: 'valerielinc-ops',
      repo: 'frontaliere-si-o-no',
      number: 6318,
    });
  });

  it('finds it inside a larger JSON blob, quoted', () => {
    const text = '{"tool_response":{"stdout":"https://github.com/o/r/pull/42\\n"}}';
    expect(extractPrRef(text)).toEqual({ owner: 'o', repo: 'r', number: 42 });
  });

  it('returns null when there is no PR URL', () => {
    expect(extractPrRef('gh pr list --repo o/r')).toBeNull();
    expect(extractPrRef('')).toBeNull();
    expect(extractPrRef(undefined as unknown as string)).toBeNull();
  });
});

describe('addEntry / removeEntry — pure list operations', () => {
  const base = { owner: 'o', repo: 'r', number: 1, openedAt: '2026-08-24T00:00:00.000Z' };

  it('adds a new entry', () => {
    expect(addEntry([], base)).toEqual([base]);
  });

  it('does not duplicate an entry for the same owner/repo/number', () => {
    const dup = { ...base, openedAt: 'later' };
    expect(addEntry([base], dup)).toEqual([base]); // original kept, not overwritten
  });

  it('treats a different number as a distinct entry', () => {
    const other = { ...base, number: 2 };
    expect(addEntry([base], other)).toHaveLength(2);
  });

  it('removes only the matching entry', () => {
    const other = { ...base, number: 2 };
    expect(removeEntry([base, other], { owner: 'o', repo: 'r', number: 1 })).toEqual([other]);
  });

  it('removeEntry is a no-op when nothing matches', () => {
    expect(removeEntry([base], { owner: 'o', repo: 'r', number: 99 })).toEqual([base]);
  });
});

describe('readEntries / writeEntries — file round-trip, and tolerance of a bad file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an empty list when the file does not exist — never crashes the caller', () => {
    expect(readEntries(dir)).toEqual([]);
  });

  it('round-trips what it writes', () => {
    const entries = [{ owner: 'o', repo: 'r', number: 1, openedAt: 'x' }];
    writeEntries(dir, entries);
    expect(readEntries(dir)).toEqual(entries);
    expect(fs.existsSync(storePath(dir))).toBe(true);
    expect(storePath(dir)).toBe(path.join(dir, STORE_REL_PATH));
  });

  it('drops malformed entries instead of throwing (a corrupt append must not blind the gate)', () => {
    fs.mkdirSync(path.dirname(storePath(dir)), { recursive: true });
    fs.writeFileSync(storePath(dir), JSON.stringify([{ owner: 'o' }, { owner: 'o', repo: 'r', number: 1 }]));
    expect(readEntries(dir)).toEqual([{ owner: 'o', repo: 'r', number: 1 }]);
  });

  it('reads an empty list from a file that is not valid JSON at all', () => {
    fs.mkdirSync(path.dirname(storePath(dir)), { recursive: true });
    fs.writeFileSync(storePath(dir), '{not json');
    expect(readEntries(dir)).toEqual([]);
  });
});
