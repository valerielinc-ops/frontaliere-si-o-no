/**
 * A missing crawler slice directory must be distinguishable from an empty one
 * (#6781).
 *
 * `listSliceFilePaths`/`listSliceFileNames` answer `[]` to both, which is right
 * for the maintenance scripts and wrong for the newsletter send: after #6776 an
 * absent data/jobs/by-crawler stopped throwing ENOENT into the caller's catch,
 * so the send proceeded with zero jobs and printed no diagnostic at all.
 *
 * Fixtures are built in a temp directory; nothing here reads production data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSliceDirectory,
  listSliceFileNames,
  isSliceFile,
} from '../scripts/lib/crawler-slice-files.mjs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-dir-state-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readSliceDirectory', () => {
  it('reports a missing directory as missing, not as empty', () => {
    const absent = path.join(dir, 'does-not-exist');
    expect(readSliceDirectory(absent)).toEqual({ state: 'missing', files: [] });
    // The distinction the two list helpers cannot make on their own:
    expect(listSliceFileNames(absent)).toEqual([]);
  });

  it('reports an existing directory holding no slice as empty', () => {
    expect(readSliceDirectory(dir)).toEqual({ state: 'empty', files: [] });
  });

  it('reports a directory holding only non-slice files as empty', () => {
    // The scratch files a killed housekeeping run leaves behind are not slices.
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, 'lidl-svizzera-locale-cache.json'), '{}');
    fs.writeFileSync(path.join(dir, 'lidl-svizzera.json.cleanup-tmp.json'), '{}');
    const result = readSliceDirectory(dir);
    expect(result.state).toBe('empty');
    expect(result.files).toEqual([]);
  });

  it('lists the real slices and calls the directory populated', () => {
    fs.writeFileSync(path.join(dir, 'beta.json'), '{"jobs":[]}');
    fs.writeFileSync(path.join(dir, 'alpha.json'), '{"jobs":[]}');
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    const result = readSliceDirectory(dir);
    expect(result.state).toBe('populated');
    // Same predicate and same deterministic order as listSliceFileNames.
    expect(result.files).toEqual(['alpha.json', 'beta.json']);
    expect(result.files.every((f) => isSliceFile(f))).toBe(true);
  });
});

describe('the caller decision this state drives', () => {
  // send-newsletter warns only on 'missing'. Asserting that mapping here keeps
  // the three-way distinction pinned to behaviour rather than to the wording of
  // any one caller's message.
  const warnsOn = (state: string) => state === 'missing';

  it('warns for a missing directory only', () => {
    const absent = path.join(dir, 'gone');
    expect(warnsOn(readSliceDirectory(absent).state)).toBe(true);
    expect(warnsOn(readSliceDirectory(dir).state)).toBe(false);
    fs.writeFileSync(path.join(dir, 'alpha.json'), '{"jobs":[]}');
    expect(warnsOn(readSliceDirectory(dir).state)).toBe(false);
  });
});
