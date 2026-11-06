import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const gitMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: gitMock }));
import {
  addLedgerRecordToIndex,
  createLedgerIndexState,
  ledgerIndexEntry,
  ledgerIndexLifecycleEvent,
  ledgerIndexRecordCount,
  ledgerLifecycleConflictDigest,
  ledgerFileOid,
  loadLedgerIndexForWriter,
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

function gitBlobOid(file: string) {
  const content = fs.readFileSync(file);
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
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

  it('appends index deltas and manifest updates without rewriting historical entries', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-index-append-'));
    const state = createLedgerIndexState();
    const firstFile = path.join(ledgerDir, 'loop-observations-run-1.jsonl');
    setLedgerIndexFile(state, path.basename(firstFile));
    addLedgerRecordToIndex(state, { type: 'observation', file: firstFile, record: observation('record-1') });
    writeLedgerIndex(ledgerDir, state);
    const historicalIndex = fs.readFileSync(path.join(ledgerDir, 'ledger-record-index.jsonl'), 'utf8');

    const reloaded = readLedgerIndex(ledgerDir);
    const secondFile = path.join(ledgerDir, 'loop-observations-run-2.jsonl');
    setLedgerIndexFile(reloaded, path.basename(secondFile));
    addLedgerRecordToIndex(reloaded, { type: 'observation', file: secondFile, record: observation('record-2') });
    setLedgerIndexFile(reloaded, path.basename(secondFile), 'b'.repeat(40));
    writeLedgerIndex(ledgerDir, reloaded);

    const nextIndex = fs.readFileSync(path.join(ledgerDir, 'ledger-record-index.jsonl'), 'utf8');
    expect(nextIndex.startsWith(historicalIndex)).toBe(true);
    const manifest = fs.readFileSync(path.join(ledgerDir, 'ledger-record-index-manifest.jsonl'), 'utf8');
    expect(manifest).toContain('"file":"loop-observations-run-2.jsonl"');
    expect(readLedgerIndex(ledgerDir).manifest.get('loop-observations-run-2.jsonl')).toBe('b'.repeat(40));
    expect(ledgerIndexEntry(readLedgerIndex(ledgerDir), 'observation', 'record-2')).not.toBeNull();
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

  it('round-trips lifecycle projections while ignoring retry capture metadata', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-index-lifecycle-'));
    const state = createLedgerIndexState();
    const file = path.join(ledgerDir, 'lifecycle-events-run-1.jsonl');
    const event = {
      recordId: 'lifecycle-1',
      candidateId: 'candidate-1',
      eventType: 'pr_opened',
      occurredAt: '2026-11-04T12:00:00.000Z',
      recordedAt: '2026-11-04T12:01:00.000Z',
      execution: { runId: '1', sha: 'a'.repeat(40) },
    };
    addLedgerRecordToIndex(state, { type: 'lifecycle', file, record: event });
    writeLedgerIndex(ledgerDir, state);

    const reloaded = readLedgerIndex(ledgerDir);
    const entry = ledgerIndexEntry(reloaded, 'lifecycle', event.recordId);
    expect(ledgerIndexLifecycleEvent(entry)).toEqual({
      recordId: event.recordId,
      candidateId: event.candidateId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
    });
    expect(entry?.conflictDigest).toBe(ledgerLifecycleConflictDigest({
      ...event,
      recordedAt: '2026-11-04T12:02:00.000Z',
      execution: { runId: '2', sha: 'b'.repeat(40) },
    }));
  });

  it('keeps bulk tracked-ledger Git reads above the child-process default', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-index-large-list-'));
    try {
      const ledgerDir = path.join(repo, 'data', 'loop-fleet', 'ledger');
      fs.mkdirSync(ledgerDir, { recursive: true });
      const trackedPaths = Array.from({ length: 17_000 }, (_, index) => (
        `data/loop-fleet/ledger/loop-observations-run-${String(index).padStart(10, '0')}.jsonl`
      ));
      const trackedOutput = `${trackedPaths.join('\0')}\0`;
      expect(Buffer.byteLength(trackedOutput)).toBeGreaterThan(1024 * 1024);

      gitMock.mockImplementation((_command: string, args: string[], options?: {
        input?: string;
        maxBuffer?: number;
      }) => {
        if (args.includes('rev-parse')) return `${repo}\n`;
        if (args.includes('ls-files')) {
          if ((options?.maxBuffer ?? 1024 * 1024) < Buffer.byteLength(trackedOutput)) {
            const error = new Error('spawnSync git ENOBUFS');
            (error as NodeJS.ErrnoException).code = 'ENOBUFS';
            throw error;
          }
          return trackedOutput;
        }
        if (args.includes('--stdin-paths')) {
          expect(options?.maxBuffer).toBeGreaterThan(1024 * 1024);
          const inputs = String(options?.input || '').trim().split('\n').filter(Boolean);
          return `${inputs.map(() => 'a'.repeat(40)).join('\n')}\n`;
        }
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      });

      const result = loadLedgerIndexForWriter(ledgerDir);
      expect(result.trackedFileOids?.size).toBe(trackedPaths.length);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects an unstaged rewrite of an indexed tracked shard', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-index-worktree-'));
    try {
      const ledgerDir = path.join(repo, 'data', 'loop-fleet', 'ledger');
      fs.mkdirSync(ledgerDir, { recursive: true });
      const shard = path.join(ledgerDir, 'loop-observations-run-1.jsonl');
      fs.writeFileSync(shard, '{"recordId":"one"}\n');
      let batchedHashCalls = 0;
      gitMock.mockImplementation((_command: string, args: string[], options?: { input?: string }) => {
        if (args.includes('rev-parse')) return `${repo}\n`;
        if (args.includes('ls-files')) return 'data/loop-fleet/ledger/loop-observations-run-1.jsonl\0';
        if (args.includes('hash-object')) {
          if (args.includes('--stdin-paths')) {
            batchedHashCalls += 1;
            return `${gitBlobOid(path.join(repo, String(options?.input).trim()))}\n`;
          }
          return `${gitBlobOid(path.join(repo, args[args.length - 1]))}\n`;
        }
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      });

      const indexedOid = ledgerFileOid(ledgerDir, shard);
      expect(indexedOid).toMatch(/^[0-9a-f]{40,64}$/u);
      const state = createLedgerIndexState();
      setLedgerIndexFile(state, shard, indexedOid);
      writeLedgerIndex(ledgerDir, state);

      fs.appendFileSync(shard, '{"recordId":"two"}\n');

      expect(() => loadLedgerIndexForWriter(ledgerDir)).toThrow(
        'ledger file loop-observations-run-1.jsonl changed after it was indexed',
      );
      expect(batchedHashCalls).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
