// @vitest-environment node
/**
 * Expired archive slices grow with every retired posting (PR 18389 archives
 * every row a slice write retires). coop-ticino's slice was 83,6 MB on
 * 2026-11-12, close to GitHub's 100 MB hard limit. The writer must refuse a
 * slice past the push-safety ceiling (scripts/lib/assert-file-size-ceiling.mjs,
 * 90 MB) with its own message BEFORE writing it, never as a rejected push.
 *
 * Everything runs in a temporary directory: no tracked file is written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  archiveRemovedJobsToSlice,
  assertExpiredSliceSize,
} from '../../scripts/lib/expired-jobs-archive.mjs';
import {
  assertByteSizeCeiling,
  FileSizeCeilingError,
} from '../../scripts/lib/assert-file-size-ceiling.mjs';
import { EXPIRED_SLICE_SIZE_LIMIT_BYTES, sizeLimitForPath } from '../../scripts/lib/related-search-output-limit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MB = 1024 * 1024;
const dirs: string[] = [];

function tmpExpiredDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-ceiling-'));
  dirs.push(root);
  const dir = path.join(root, 'data', 'jobs', 'expired', 'by-crawler');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const job = (n: number, description = 'Descrizione breve.') => ({
  slug: `addetto-vendita-${n}-coop-lugano`,
  slugByLocale: { it: `addetto-vendita-${n}-coop-lugano` },
  title: `Addetto vendita ${n}`,
  company: 'Coop',
  companyKey: 'coop-ticino',
  url: `https://jobs.coop.invalid/${n}`,
  description,
  descriptionByLocale: { it: description },
});

describe('expired slice push-safety ceiling', () => {
  it('maps expired slices to the 90 MB ceiling and leaves the other limits as they were', () => {
    expect(EXPIRED_SLICE_SIZE_LIMIT_BYTES).toBe(90 * MB);
    expect(sizeLimitForPath('data/jobs/expired/by-crawler/coop-ticino.json')).toBe(90 * MB);
    expect(sizeLimitForPath('/tmp/x/data/jobs/expired/by-crawler/roche.json')).toBe(90 * MB);
    expect(sizeLimitForPath('data/related-search-candidates.json')).toBe(90 * MB);
    expect(sizeLimitForPath('data/related-search-enriched.json')).toBe(50 * MB);
    expect(sizeLimitForPath('data/jobs/by-crawler/coop-ticino.json')).toBe(50 * MB);
  });

  it('throws a clear FileSizeCeilingError past the ceiling', () => {
    expect(() => assertByteSizeCeiling('data/jobs/expired/by-crawler/coop-ticino.json', 90 * MB)).not.toThrow();
    let error: unknown;
    try {
      assertByteSizeCeiling('data/jobs/expired/by-crawler/coop-ticino.json', 95 * MB);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FileSizeCeilingError);
    expect((error as FileSizeCeilingError).code).toBe('FILE_SIZE_CEILING');
    expect((error as Error).message).toMatch(/coop-ticino\.json would be 95\.0 MB, exceeding the 90 MB push-safety ceiling/);
  });

  it('measures the bytes writeJsonAtomic writes for the array', () => {
    const dir = tmpExpiredDir();
    const slicePath = path.join(dir, 'coop-ticino.json');
    const entries = [job(1), job(2)];
    expect(() => assertExpiredSliceSize(slicePath, entries)).not.toThrow();
    // ~1 MB description x 95 rows: past the 90 MB ceiling.
    const big = 'x'.repeat(MB);
    expect(() => assertExpiredSliceSize(slicePath, Array.from({ length: 95 }, (_, n) => job(n, big))))
      .toThrow(FileSizeCeilingError);
  });

  it('archiveRemovedJobsToSlice never writes a file past the ceiling: a full monolith overflows into a shard', () => {
    // Since the sharded store (scripts/lib/expired-slice-store.mjs) a monolith
    // past the 45 MB shard target stops growing: the 15 new rows land in
    // `<key>.shard-001.json` instead of pushing `<key>.json` to ~95 MB.
    const dir = tmpExpiredDir();
    const slicePath = path.join(dir, 'coop-ticino.json');
    const big = 'x'.repeat(MB);
    // ~1 MB per row (descriptionByLocale.it): an ~80 MB monolith, under the
    // ceiling but past the shard target, like coop-ticino on 2026-11-12.
    const existing = Array.from({ length: 80 }, (_, n) => ({
      ...job(n, big),
      description: 'Descrizione breve.',
      expiredAt: new Date().toISOString(),
    }));
    fs.writeFileSync(slicePath, `${JSON.stringify(existing, null, 2)}\n`);
    const slugsOf = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ slug: string }>)
      .map((row) => row.slug).sort();
    const before = slugsOf(slicePath);

    expect(archiveRemovedJobsToSlice(
      Array.from({ length: 15 }, (_, n) => job(100 + n, big)),
      'coop-ticino',
      { dir },
    )).toBe(15);
    // The monolith keeps exactly its rows (the writer may only re-sort them).
    expect(slugsOf(slicePath)).toEqual(before);
    expect(slugsOf(path.join(dir, 'coop-ticino.shard-001.json'))).toHaveLength(15);
    for (const name of fs.readdirSync(dir)) {
      expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(EXPIRED_SLICE_SIZE_LIMIT_BYTES);
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['coop-ticino.json', 'coop-ticino.shard-001.json']);
  }, 120_000);

  it('archiveRemovedJobsToSlice refuses a row no file can hold and leaves the slice on disk untouched', () => {
    const dir = tmpExpiredDir();
    const slicePath = path.join(dir, 'coop-ticino.json');
    fs.writeFileSync(slicePath, `${JSON.stringify([{ ...job(1), expiredAt: new Date().toISOString() }], null, 2)}\n`);
    const before = fs.readFileSync(slicePath, 'utf8');
    // descriptionByLocale.it is archived: one ~91 MB row.
    expect(() => archiveRemovedJobsToSlice([job(2, 'x'.repeat(91 * MB))], 'coop-ticino', { dir }))
      .toThrow(FileSizeCeilingError);
    expect(fs.readFileSync(slicePath, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['coop-ticino.json']);

    // A small addition still goes through.
    const smallDir = tmpExpiredDir();
    expect(archiveRemovedJobsToSlice([job(1)], 'coop-ticino', { dir: smallDir })).toBe(1);
  }, 120_000);

  it('keeps the CLI contract (exit 1 on an oversize file, 0 otherwise)', () => {
    const dir = tmpExpiredDir();
    const slicePath = path.join(dir, 'coop-ticino.json');
    fs.writeFileSync(slicePath, '[]\n');
    fs.truncateSync(slicePath, 91 * MB);
    const cli = path.join(REPO_ROOT, 'scripts', 'lib', 'assert-file-size-ceiling.mjs');
    const over = spawnSync(process.execPath, [cli, slicePath], { encoding: 'utf8' });
    expect(over.status).toBe(1);
    expect(over.stderr).toMatch(/is 91\.0 MB, exceeding the 90 MB push-safety ceiling/);
    fs.truncateSync(slicePath, 3);
    expect(spawnSync(process.execPath, [cli, slicePath], { encoding: 'utf8' }).status).toBe(0);
  });
});
