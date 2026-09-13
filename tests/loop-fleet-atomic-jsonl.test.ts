import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendJsonlSerialized } from '../scripts/lib/loop-fleet-contract.mjs';

describe('serialized atomic loop-fleet JSONL writer', () => {
  it('appends idempotently and rejects a conflicting record without rewriting history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-jsonl-'));
    const file = path.join(dir, 'ledger.jsonl');
    const record = { recordId: 'record-1', value: 'original' };

    expect(appendJsonlSerialized(file, record)).toMatchObject({ appended: true });
    expect(appendJsonlSerialized(file, record)).toMatchObject({ appended: false });
    const beforeConflict = fs.readFileSync(file, 'utf8');
    expect(() => appendJsonlSerialized(file, { ...record, value: 'changed' }))
      .toThrow(/conflicting duplicate/u);
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeConflict);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('fails closed on malformed history and on a contended lock after bounded retries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-jsonl-'));
    const malformed = path.join(dir, 'malformed.jsonl');
    fs.writeFileSync(malformed, '{"recordId":"ok"}\nnot-json\n');
    expect(() => appendJsonlSerialized(malformed, { recordId: 'next' }))
      .toThrow(/invalid JSON at line 2/u);

    const contended = path.join(dir, 'contended.jsonl');
    fs.writeFileSync(`${contended}.lock`, 'live writer\n');
    try {
      expect(() => appendJsonlSerialized(contended, { recordId: 'next' }, {
        maxAttempts: 2,
        retryDelayMs: 0,
        lockStaleMs: 60_000,
      })).toThrow(/bounded attempts/u);
      expect(fs.existsSync(contended)).toBe(false);
    } finally {
      fs.unlinkSync(`${contended}.lock`);
    }
  });
});
