import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCursor, saveCursor, mergeEventsIntoSlice } from '../scripts/lib/crawl-checkpoint.mjs';

describe('loadCursor / saveCursor', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-checkpoint-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 when no checkpoint file exists yet', () => {
    expect(loadCursor('guidle', dir)).toBe(0);
  });

  it('persists and reloads the cursor', () => {
    saveCursor('guidle', 42, '2026-07-02T00:00:00.000Z', dir);
    expect(loadCursor('guidle', dir)).toBe(42);
  });

  it('keys checkpoints independently per source', () => {
    saveCursor('guidle', 10, '2026-07-02T00:00:00.000Z', dir);
    saveCursor('myswitzerland', 20, '2026-07-02T00:00:00.000Z', dir);
    expect(loadCursor('guidle', dir)).toBe(10);
    expect(loadCursor('myswitzerland', dir)).toBe(20);
  });

  it('falls back to 0 for a malformed checkpoint file', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'guidle.json'), 'not json', 'utf-8');
    expect(loadCursor('guidle', dir)).toBe(0);
  });

  it('falls back to 0 for a negative or non-integer nextIndex', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'guidle.json'), JSON.stringify({ nextIndex: -1 }), 'utf-8');
    expect(loadCursor('guidle', dir)).toBe(0);
  });
});

describe('mergeEventsIntoSlice', () => {
  let dir: string;
  let slicePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-checkpoint-slice-'));
    slicePath = path.join(dir, 'guidle.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new slice when none exists yet', () => {
    const total = mergeEventsIntoSlice({
      slicePath,
      sourceKey: 'guidle',
      sourceName: 'Guidle',
      freshEvents: [{ id: 'guidle:a', startDate: '2099-01-01' }],
      goneIds: [],
      crawledAt: '2026-07-02T00:00:00.000Z',
    });
    expect(total).toBe(1);
    const written = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    expect(written.events).toHaveLength(1);
    expect(written.sourceKey).toBe('guidle');
  });

  it('upserts fresh events into an existing slice without dropping untouched ones', () => {
    mergeEventsIntoSlice({
      slicePath,
      sourceKey: 'guidle',
      sourceName: 'Guidle',
      freshEvents: [
        { id: 'guidle:a', title: 'old title', startDate: '2099-01-01' },
        { id: 'guidle:b', startDate: '2099-01-01' },
      ],
      goneIds: [],
      crawledAt: '2026-07-02T00:00:00.000Z',
    });

    const total = mergeEventsIntoSlice({
      slicePath,
      sourceKey: 'guidle',
      sourceName: 'Guidle',
      freshEvents: [{ id: 'guidle:a', title: 'new title', startDate: '2099-01-01' }],
      goneIds: [],
      crawledAt: '2026-07-03T00:00:00.000Z',
    });

    expect(total).toBe(2);
    const written = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    const byId = Object.fromEntries(written.events.map((e: any) => [e.id, e]));
    expect(byId['guidle:a'].title).toBe('new title'); // updated
    expect(byId['guidle:b']).toBeDefined(); // survived, untouched this run
  });

  it('drops ids explicitly marked gone', () => {
    mergeEventsIntoSlice({
      slicePath,
      sourceKey: 'guidle',
      sourceName: 'Guidle',
      freshEvents: [{ id: 'guidle:a', startDate: '2099-01-01' }],
      goneIds: [],
      crawledAt: '2026-07-02T00:00:00.000Z',
    });

    const total = mergeEventsIntoSlice({
      slicePath,
      sourceKey: 'guidle',
      sourceName: 'Guidle',
      freshEvents: [],
      goneIds: ['guidle:a'],
      crawledAt: '2026-07-03T00:00:00.000Z',
    });

    expect(total).toBe(0);
  });

  it('prunes events whose last relevant date has already passed', () => {
    mergeEventsIntoSlice({
      slicePath,
      sourceKey: 'guidle',
      sourceName: 'Guidle',
      freshEvents: [
        { id: 'guidle:past', startDate: '2020-01-01' },
        { id: 'guidle:future', startDate: '2099-01-01' },
        { id: 'guidle:ongoing', startDate: '2020-01-01', endDate: '2099-01-01' },
      ],
      goneIds: [],
      crawledAt: '2026-07-02T00:00:00.000Z',
    });

    const written = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    const ids = written.events.map((e: any) => e.id);
    expect(ids).toContain('guidle:future');
    expect(ids).toContain('guidle:ongoing');
    expect(ids).not.toContain('guidle:past');
  });

  it('recovers from a corrupt existing slice by starting fresh instead of crashing', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(slicePath, 'not json', 'utf-8');

    const total = mergeEventsIntoSlice({
      slicePath,
      sourceKey: 'guidle',
      sourceName: 'Guidle',
      freshEvents: [{ id: 'guidle:a', startDate: '2099-01-01' }],
      goneIds: [],
      crawledAt: '2026-07-02T00:00:00.000Z',
    });

    expect(total).toBe(1);
  });
});
