import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadLedger, appendLedger } from '../scripts/lib/social-post-utils.mjs';
import { parseLedger, selectNextPending } from '../scripts/lib/social-publish-queue.mjs';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempLedger(contents?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-ledger-integrity-'));
  tempRoots.push(root);
  const file = path.join(root, 'instagram-posted.json');
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8');
  return file;
}

describe('social posted ledger integrity', () => {
  it('uses an empty ledger only when the ledger file is absent', () => {
    expect(loadLedger(tempLedger())).toEqual({ schemaVersion: 1, posted: [] });
    expect(parseLedger(null)).toEqual({ schemaVersion: 1, posted: [] });
  });

  it.each([
    ['malformed JSON', '{ not json'],
    ['wrong root shape', '{"schemaVersion":1,"posted":{}}'],
    ['unsupported schema', '{"schemaVersion":2,"posted":[]}'],
    ['row without id', '{"schemaVersion":1,"posted":[{"kind":"article"}]}'],
  ])('rejects %s without resetting posting history', (_label, contents) => {
    const file = tempLedger(contents);
    expect(() => loadLedger(file)).toThrow(/social posted ledger/i);
    expect(() => appendLedger(file, [{ id: 'new-post', kind: 'article' }])).toThrow(/social posted ledger/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
  });

  it('keeps the robot from selecting a queued post when its ledger input is corrupt', () => {
    expect(() => selectNextPending({ pending: [] }, { channel: 'instagram', ledger: '{ not json' }))
      .toThrow(/social posted ledger/i);
  });

  it('parses the committed ledger contract and keeps every posted entry', () => {
    expect(parseLedger(JSON.stringify({ schemaVersion: 1, posted: [{ id: 'already-posted', kind: 'article' }] })))
      .toEqual({ schemaVersion: 1, posted: [{ id: 'already-posted', kind: 'article' }] });
  });
});
