import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addLedgerRecordToIndex,
  createLedgerIndexState,
  ledgerIndexEntry,
  ledgerIndexRecordCount,
  readLedgerIndex,
  setLedgerIndexFile,
  writeLedgerIndex,
} from '../scripts/lib/loop-fleet-ledger-index.mjs';

function observation(recordId: string, value = 'ok') {
  return {
    recordType: 'observation',
    recordId,
    value,
  };
}

describe('loop-fleet durable ledger index', () => {
  it('round-trips canonical record digests and keeps reordered records idempotent', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-index-'));
    const state = createLedgerIndexState();
    const file = path.join(ledgerDir, 'loop-observations-run-1.jsonl');
    setLedgerIndexFile(state, path.basename(file));
    addLedgerRecordToIndex(state, {
      type: 'observation',
      file,
      record: { ...observation('record-1'), nested: { first: 1, second: 2 } },
    });
    writeLedgerIndex(ledgerDir, state);

    const reloaded = readLedgerIndex(ledgerDir);
    addLedgerRecordToIndex(reloaded, {
      type: 'observation',
      file,
      record: { ...observation('record-1'), nested: { second: 2, first: 1 } },
    });

    expect(ledgerIndexRecordCount(reloaded, 'observation')).toBe(2);
    expect(ledgerIndexEntry(reloaded, 'observation', 'record-1')?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('fails closed when the same record id has different content', () => {
    const state = createLedgerIndexState();
    addLedgerRecordToIndex(state, {
      type: 'observation',
      file: 'loop-observations-run-1.jsonl',
      record: observation('record-1'),
    });

    expect(() => addLedgerRecordToIndex(state, {
      type: 'observation',
      file: 'loop-observations-run-2.jsonl',
      record: observation('record-1', 'changed'),
    })).toThrow(/conflicting duplicate/u);
  });
});
