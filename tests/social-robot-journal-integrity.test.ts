// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { emptyJournal, fileJournalStore, parseJournal } from '../scripts/social-robot/lib/cadence.mjs';

const dirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-robot-journal-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('social robot journal integrity', () => {
  it('uses an empty journal only when the file has never been created', () => {
    const store = fileJournalStore(tempDir());
    expect(store.load()).toEqual(emptyJournal());
  });

  it.each([
    ['malformed JSON', '{broken'],
    ['unsupported schema', JSON.stringify({ schemaVersion: 2, attempts: [], pausedUntil: {} })],
    ['invalid root', JSON.stringify([])],
    ['malformed attempt', JSON.stringify({ schemaVersion: 1, attempts: [null], pausedUntil: {} })],
    ['attempt missing its queue id', JSON.stringify({
      schemaVersion: 1,
      attempts: [{ channel: 'instagram', at: '2026-10-20T12:00:00.000Z', outcome: 'published' }],
      pausedUntil: {},
    })],
    ['non-canonical attempt timestamp', JSON.stringify({
      schemaVersion: 1,
      attempts: [{ channel: 'instagram', queueId: 'item-1', at: '0', outcome: 'published' }],
      pausedUntil: {},
    })],
    ['unsupported channel', JSON.stringify({
      schemaVersion: 1,
      attempts: [{ channel: 'instgram', queueId: 'item-1', at: '2026-10-20T12:00:00.000Z', outcome: 'published' }],
      pausedUntil: {},
    })],
    ['invalid pause map', JSON.stringify({ schemaVersion: 1, attempts: [], pausedUntil: [] })],
  ])('rejects %s instead of resetting duplicate protection', (_label, raw) => {
    expect(() => parseJournal(raw)).toThrow();
  });

  it('does not read a corrupt journal as a first run', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'journal.json'), '{broken');

    expect(() => fileJournalStore(dir).load()).toThrow(/Malformed social robot journal JSON/);
  });

  it('round-trips the full valid attempt history', () => {
    const dir = tempDir();
    const store = fileJournalStore(dir);
    const journal = {
      schemaVersion: 1,
      attempts: [{
        channel: 'instagram',
        queueId: 'article-2026-10-20',
        at: '2026-10-20T12:00:00.000Z',
        outcome: 'published',
        confirmDispatched: false,
        ledgerEntries: [{ id: 'article-slug', kind: 'article' }],
      }],
      pausedUntil: { tiktok: '2026-10-20T23:00:00.000Z' },
    };

    store.save(journal);

    expect(store.load()).toEqual(journal);
  });
});
