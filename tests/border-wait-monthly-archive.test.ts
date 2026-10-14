// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactBorderWaitArchiveDay, readBorderWaitArchive, writeBorderWaitArchive } from '../scripts/lib/border-wait-monthly-archive.mjs';
import { generateBorderWaitArchives } from '../build-plugins/borderWaitPagesPlugin';
const today = new Date();
const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
const previousDay = new Date(monthStart.getTime() - 86400000).toISOString().slice(0, 10);
const now = today.toISOString().slice(0, 10);
const row = (date = previousDay, avg = 12) => ({ date, perCrossing: { gaggiolo: Array.from({ length: 24 }, () => ({ avg, min: 0, max: 20, samples: 3 })) } });

describe('durable border-wait monthly facts', () => {
  it('keeps only observed hourly means for archive crossings, including zero', () => {
    const compact = compactBorderWaitArchiveDay({ ...row(previousDay, 0), privateData: 'discard', perCrossing: { ...row(previousDay, 0).perCrossing, unrelated: [{ avg: 999 }] } });
    expect(compact.perCrossing.gaggiolo[0]).toEqual({ avg: 0 });
    expect(Object.keys(compact.perCrossing)).toEqual(['gaggiolo']);
    expect(compact).not.toHaveProperty('privateData');
    expect(compactBorderWaitArchiveDay({ date: previousDay, perCrossing: {} })).toBeNull();
  });

  it('retains closed months after daily files disappear, without archiving the current month', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'border-archive-'));
    const history = path.join(root, 'history'); const archive = path.join(root, 'archive');
    fs.mkdirSync(history);
    try {
      const old = path.join(history, `${previousDay}.json`);
      fs.writeFileSync(old, JSON.stringify(row()));
      fs.writeFileSync(path.join(history, `${now}.json`), JSON.stringify(row(now)));
      expect(writeBorderWaitArchive(history, archive, now)).toBe(1);
      expect(writeBorderWaitArchive(history, archive, now)).toBe(0);
      fs.unlinkSync(old);
      writeBorderWaitArchive(history, archive, now);
      expect(readBorderWaitArchive(archive)).toEqual([compactBorderWaitArchiveDay(row())]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves archive rendering and lets the rolling snapshot replace overlapping dates once', () => {
    const day = row(); const compact = compactBorderWaitArchiveDay(day);
    const rawPages = generateBorderWaitArchives({ history: [day], today });
    expect(generateBorderWaitArchives({ history: [compact], today })).toEqual(rawPages);
    expect(generateBorderWaitArchives({ history: [compact, row(previousDay, 9)], today })).toEqual(generateBorderWaitArchives({ history: [row(previousDay, 9)], today }));
    expect(Object.keys(rawPages)).toHaveLength(20);
  });
});
