import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChannelHealth, recordChannelHealth } from '../scripts/lib/prospector/sources/commoncrawl-careers.mjs';

describe('loadChannelHealth / recordChannelHealth', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commoncrawl-health-'));
    file = path.join(dir, 'web-channel-health.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty history when no file exists yet', () => {
    expect(loadChannelHealth(file)).toEqual([]);
  });

  it('appends a run and marks a healthy run as not an outage', () => {
    recordChannelHealth({ collection: 'CC-MAIN-2026-30', totalPages: 1223, pagesRead: 20, employers: 11 }, file);
    const history = loadChannelHealth(file);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ collection: 'CC-MAIN-2026-30', totalPages: 1223, pagesRead: 20, employers: 11, outage: false });
    expect(typeof history[0].at).toBe('string');
  });

  it('flags a zero-totalPages run as an outage', () => {
    recordChannelHealth({ collection: null, totalPages: 0, pagesRead: 0, employers: 0 }, file);
    expect(loadChannelHealth(file)[0].outage).toBe(true);
  });

  it('keeps history in append order across multiple runs', () => {
    recordChannelHealth({ collection: 'a', totalPages: 100, pagesRead: 5, employers: 2 }, file);
    recordChannelHealth({ collection: 'a', totalPages: 0, pagesRead: 0, employers: 0 }, file);
    const history = loadChannelHealth(file);
    expect(history.map((r) => r.outage)).toEqual([false, true]);
  });

  it('caps history to the most recent 60 runs', () => {
    for (let i = 0; i < 65; i++) {
      recordChannelHealth({ collection: 'a', totalPages: 100, pagesRead: i, employers: 0 }, file);
    }
    const history = loadChannelHealth(file);
    expect(history).toHaveLength(60);
    // Oldest 5 runs (pagesRead 0..4) were evicted.
    expect(history[0].pagesRead).toBe(5);
    expect(history[history.length - 1].pagesRead).toBe(64);
  });

  it('falls back to an empty history for a malformed file', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'not json', 'utf-8');
    expect(loadChannelHealth(file)).toEqual([]);
  });
});
