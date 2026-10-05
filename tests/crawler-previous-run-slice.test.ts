// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetPreviousRunSlices,
  previousRunSliceJobs,
  recordPreviousRunSlice,
} from '../scripts/lib/crawler-previous-run-slice.mjs';

let dir = '';

function writeSlice(name: string, jobs: object[]) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ crawlerKey: name, jobs }));
  return file;
}

beforeEach(() => {
  _resetPreviousRunSlices();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'previous-run-slice-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('crawler-previous-run-slice', () => {
  it('keeps the slice as first recorded, even after the file is overwritten (the seed)', () => {
    const file = writeSlice('sta.json', [{ id: 'online' }]);
    expect(recordPreviousRunSlice(file)).toBe(true);
    writeSlice('sta.json', [{ id: 'online' }, { id: 'arrival' }]);
    // A second record (the seed after the runner's first read) is ignored.
    expect(recordPreviousRunSlice(file)).toBe(false);
    expect(previousRunSliceJobs(file)).toEqual([{ id: 'online' }]);
  });

  it('returns null for a slice this process never recorded, so the caller reads the file', () => {
    const file = writeSlice('sta.json', [{ id: 'online' }]);
    expect(previousRunSliceJobs(file)).toBeNull();
  });

  it('records a missing slice as empty: the previous run published nothing for that key', () => {
    const file = path.join(dir, 'new-crawler.json');
    expect(recordPreviousRunSlice(file)).toBe(true);
    writeSlice('new-crawler.json', [{ id: 'arrival' }]);
    expect(previousRunSliceJobs(file)).toEqual([]);
  });

  it('does not record an unreadable slice, so jobs already online are never treated as new', () => {
    const unreadable = path.join(dir, 'broken.json');
    fs.mkdirSync(unreadable);
    expect(recordPreviousRunSlice(unreadable)).toBe(false);
    expect(previousRunSliceJobs(unreadable)).toBeNull();
  });

  it('falls back to the file when the recorded text does not parse', () => {
    const file = path.join(dir, 'garbled.json');
    fs.writeFileSync(file, '{ not json');
    expect(recordPreviousRunSlice(file)).toBe(true);
    expect(previousRunSliceJobs(file)).toBeNull();
  });

  it('falls back to the file when the recorded JSON is not a slice, never to an empty prior', () => {
    // Acceptance input of the review on #11582: `{"jobs":"bad"}` would
    // otherwise read as "the previous run published nothing" and hold back
    // jobs that are already online.
    for (const [name, text] of [
      ['bad-jobs.json', '{"jobs":"bad"}'],
      ['no-jobs.json', '{"crawlerKey":"sta"}'],
      ['null.json', 'null'],
      ['number.json', '42'],
    ]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      expect(recordPreviousRunSlice(file)).toBe(true);
      expect(previousRunSliceJobs(file)).toBeNull();
    }
  });

  it('keeps an empty jobs array as an empty prior: that slice really had no jobs', () => {
    const file = writeSlice('empty.json', []);
    recordPreviousRunSlice(file);
    expect(previousRunSliceJobs(file)).toEqual([]);
  });

  it('accepts a bare array slice', () => {
    const file = path.join(dir, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'online' }]));
    recordPreviousRunSlice(file);
    expect(previousRunSliceJobs(file)).toEqual([{ id: 'online' }]);
  });

  it('hands every reader its own parse, so a mutation never leaks into the record', () => {
    const file = writeSlice('sta.json', [{ id: 'online' }]);
    recordPreviousRunSlice(file);
    const first = previousRunSliceJobs(file) as Array<Record<string, unknown>>;
    first[0].translationHoldSince = 'mutated';
    first.push({ id: 'pushed' });
    expect(previousRunSliceJobs(file)).toEqual([{ id: 'online' }]);
  });

  it('keys the record by the resolved path: a relative and an absolute path are the same slice, another directory is not', () => {
    const file = writeSlice('sta.json', [{ id: 'online' }]);
    recordPreviousRunSlice(path.relative(process.cwd(), file));
    expect(previousRunSliceJobs(file)).toEqual([{ id: 'online' }]);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'previous-run-slice-other-'));
    try {
      expect(previousRunSliceJobs(path.join(otherDir, 'sta.json'))).toBeNull();
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
