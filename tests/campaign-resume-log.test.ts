// The shared campaign resume log — issue #5415 §3.6, AGENTS.md #6.
//
// Both the weekly newsletter and the daily brief used to carry their own copy
// of "read the sent list, arrayUnion into it, filter the pool", and both copies
// had the same two defects: one array in one 1 MiB document, and marking only
// after the send loop, so a crash partway through re-sent to everyone already
// served. This is that mechanism, once — with a fake Firestore standing in for
// the two things that matter: what gets read back, and WHEN it gets written.
import { describe, expect, it, vi } from 'vitest';

import {
  chunkDocId,
  createResumeWriter,
  fetchAlreadySent,
  markSent,
  resumeChunkState,
} from '@/scripts/lib/campaignResumeLog.mjs';
import { filterUnsentSubscribers } from '@/scripts/send-newsletter.mjs';

/** Minimal Firestore double: document-id range reads and arrayUnion merges. */
function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, any>>(Object.entries(seed));
  const writes: string[] = [];

  const collection = () => ({
    _range: { start: '', end: '' },
    where(_field: unknown, op: string, value: string) {
      if (op === '>=') this._range.start = value;
      if (op === '<') this._range.end = value;
      return this;
    },
    orderBy() { return this; },
    async get() {
      const ids = [...docs.keys()]
        .filter((id) => id >= this._range.start && id < this._range.end)
        .sort();
      return { docs: ids.map((id) => ({ id, data: () => docs.get(id) })) };
    },
    doc(id: string) {
      return {
        async set(payload: Record<string, any>, opts: { merge?: boolean }) {
          writes.push(id);
          const existing = opts?.merge ? docs.get(id) ?? {} : {};
          const merged: Record<string, any> = { ...existing };
          for (const [key, value] of Object.entries(payload)) {
            if (value && typeof value === 'object' && '__arrayUnion' in value) {
              merged[key] = [...(existing[key] ?? []), ...(value as any).__arrayUnion];
            } else {
              merged[key] = value;
            }
          }
          docs.set(id, merged);
        },
      };
    },
  });

  return {
    collection: () => ({ doc: () => ({ collection }) }),
    __docs: docs,
    __writes: writes,
  } as any;
}

// firebase-admin/firestore is mocked at the module level so arrayUnion and
// FieldPath.documentId() are inspectable values rather than opaque sentinels.
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { arrayUnion: (...values: string[]) => ({ __arrayUnion: values }) },
  FieldPath: { documentId: () => '__name__' },
}));

const OPTS = { campaignId: 'daily-brief-2026-08-08', field: 'emails' };

describe('reading the log back', () => {
  it('collects every chunk of the campaign, and nothing from another one', async () => {
    const db = fakeDb({
      'daily-brief-2026-08-08': { emails: ['a@x.it', 'b@x.it'] },
      'daily-brief-2026-08-08--2': { emails: ['c@x.it'] },
      'daily-brief-2026-08-09': { emails: ['tomorrow@x.it'] },
      'newsletter-2026-W32': { sentEmails: ['weekly@x.it'] },
    });

    const { sent, chunkSizes } = await fetchAlreadySent(db, OPTS);
    expect([...sent].sort()).toEqual(['a@x.it', 'b@x.it', 'c@x.it']);
    expect(chunkSizes).toEqual([2, 1]);
  });

  it('reads the field name the caller asks for, so the two channels keep their own', async () => {
    const db = fakeDb({ 'newsletter-2026-W32': { sentEmails: ['weekly@x.it'] } });
    const { sent } = await fetchAlreadySent(db, { campaignId: 'newsletter-2026-W32', field: 'sentEmails' });
    expect([...sent]).toEqual(['weekly@x.it']);
    // The brief's key on the same document finds nothing — no silent crossover.
    const other = await fetchAlreadySent(db, { campaignId: 'newsletter-2026-W32', field: 'emails' });
    expect(other.sent.size).toBe(0);
  });

  it('reports an untouched campaign as empty rather than failing', async () => {
    const { sent, chunkSizes } = await fetchAlreadySent(fakeDb(), OPTS);
    expect(sent.size).toBe(0);
    expect(chunkSizes).toEqual([]);
  });
});

describe('newsletter pre-filter', () => {
  it('removes already-sent recipients before per-recipient work, case-insensitively', () => {
    const subscribers = [
      { email: 'Keep@x.it' },
      { email: 'sent@x.it' },
      { email: 'new@x.it' },
    ];

    expect(filterUnsentSubscribers(subscribers, new Set(['SENT@X.IT']))).toEqual([
      { email: 'Keep@x.it' },
      { email: 'new@x.it' },
    ]);
  });

  it('does not mutate the subscriber list or treat an empty resume as a filter', () => {
    const subscribers = [{ email: 'a@x.it' }];
    expect(filterUnsentSubscribers(subscribers, new Set())).toEqual(subscribers);
    expect(subscribers).toEqual([{ email: 'a@x.it' }]);
  });
});

describe('where the next append goes', () => {
  it('starts at the first chunk when nothing has been written', () => {
    expect(resumeChunkState([])).toEqual({ index: 1, count: 0 });
  });

  it('continues the last chunk rather than reopening a full one', () => {
    expect(resumeChunkState([4000, 1200])).toEqual({ index: 2, count: 1200 });
  });

  it('opens a new chunk when the last one is already at capacity', () => {
    expect(resumeChunkState([4000])).toEqual({ index: 2, count: 0 });
  });

  it('keeps the first chunk on the bare campaign id, so old logs stay readable', () => {
    expect(chunkDocId('daily-brief-2026-08-08', 1)).toBe('daily-brief-2026-08-08');
    expect(chunkDocId('daily-brief-2026-08-08', 3)).toBe('daily-brief-2026-08-08--3');
  });
});

describe('appending', () => {
  it('rolls into a new document before a chunk could exceed its cap', async () => {
    const db = fakeDb();
    const state = resumeChunkState([]);
    await markSent(db, { ...OPTS, chunkMax: 3 }, ['a', 'b'], state);
    await markSent(db, { ...OPTS, chunkMax: 3 }, ['c', 'd'], state);

    expect(db.__docs.get('daily-brief-2026-08-08').emails).toEqual(['a', 'b']);
    expect(db.__docs.get('daily-brief-2026-08-08--2').emails).toEqual(['c', 'd']);
    // …and the split is invisible on the way back out.
    const { sent } = await fetchAlreadySent(db, OPTS);
    expect([...sent].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('appends to an existing chunk instead of replacing it', async () => {
    const db = fakeDb({ 'daily-brief-2026-08-08': { emails: ['old@x.it'] } });
    await markSent(db, OPTS, ['new@x.it'], resumeChunkState([1]));
    expect(db.__docs.get('daily-brief-2026-08-08').emails).toEqual(['old@x.it', 'new@x.it']);
  });

  it('carries the caller\'s extra fields', async () => {
    const db = fakeDb();
    await markSent(db, { ...OPTS, extraFields: { lastRunAt: 'now' } }, ['a'], resumeChunkState([]));
    expect(db.__docs.get('daily-brief-2026-08-08').lastRunAt).toBe('now');
  });

  it('writes nothing for an empty batch', async () => {
    const db = fakeDb();
    await markSent(db, OPTS, [], resumeChunkState([]));
    expect(db.__writes).toEqual([]);
  });
});

describe('the buffered writer', () => {
  // The defect it exists to close: everything recorded only after the loop
  // means a crash at email 3.000 of 4.000 loses all 3.000.
  it('flushes during the run, not only at the end', async () => {
    const db = fakeDb();
    const writer = createResumeWriter(db, OPTS, resumeChunkState([]), { flushEvery: 3 });

    for (const email of ['a', 'b']) await writer.record(email);
    expect(db.__writes).toEqual([]); // still buffered

    await writer.record('c');
    expect(db.__docs.get('daily-brief-2026-08-08').emails).toEqual(['a', 'b', 'c']);

    // A crash here would still lose 'd' — but only 'd'.
    await writer.record('d');
    await writer.flush();
    expect(db.__docs.get('daily-brief-2026-08-08').emails).toEqual(['a', 'b', 'c', 'd']);
    expect(writer.count()).toBe(4);
  });

  it('is a no-op to flush twice', async () => {
    const db = fakeDb();
    const writer = createResumeWriter(db, OPTS, resumeChunkState([]));
    await writer.record('a');
    await writer.flush();
    await writer.flush();
    expect(db.__docs.get('daily-brief-2026-08-08').emails).toEqual(['a']);
    expect(db.__writes).toHaveLength(1);
  });
});
