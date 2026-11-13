// @vitest-environment node
/**
 * Sharded expired archive (scripts/lib/expired-slice-store.mjs).
 *
 * coop-ticino's expired slice was 83.6 MB on 2026-11-12 and grows ~1.54 MiB
 * a day: the 90 MB writer ceiling would stop the crawler within a week. The
 * archive of a crawler is now `<key>.json` + `<key>.shard-NNN.json`; these
 * tests pin the contract every reader and writer relies on:
 *   - the writer appends to the last file and opens a new shard at the target;
 *   - the reader returns the rows of the monolith and every shard, in order;
 *   - the offline split loses no row and keeps the order;
 *   - no file the writer produces is above the ceiling.
 *
 * Everything runs in a temporary directory: no tracked file is written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXPIRED_SLICE_SHARD_TARGET_BYTES,
  expiredRowBytes,
  expiredSliceFileName,
  expiredSliceKeyOf,
  expiredSliceNamesForKey,
  listExpiredSliceFiles,
  listExpiredSliceKeys,
  readExpiredSliceRows,
  readExpiredSliceShards,
  splitExpiredSliceMonolith,
  writeExpiredSliceRows,
} from '../../scripts/lib/expired-slice-store.mjs';
import { archiveRemovedJobsToSlice, readExpiredSlice } from '../../scripts/lib/expired-jobs-archive.mjs';
import { FileSizeCeilingError } from '../../scripts/lib/assert-file-size-ceiling.mjs';
import { EXPIRED_SLICE_SIZE_LIMIT_BYTES } from '../../scripts/lib/related-search-output-limit.mjs';
import { listJobsSeoExpiredSliceFiles } from '../../build-plugins/shared/jobsSeoDeterministicInputs';

const MB = 1024 * 1024;
const dirs: string[] = [];

function tmpExpiredDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-store-'));
  dirs.push(root);
  const dir = path.join(root, 'data', 'jobs', 'expired', 'by-crawler');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const entry = (n: number, description = 'Descrizione breve.') => ({
  slug: `addetto-vendita-${n}-coop-lugano`,
  slugByLocale: { it: `addetto-vendita-${n}-coop-lugano` },
  title: `Addetto vendita ${n}`,
  company: 'Coop',
  companyKey: 'coop-ticino',
  description,
  expiredAt: daysAgo(n % 50),
});

const writeRaw = (dir: string, name: string, rows: unknown[]) => {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(rows, null, 2)}\n`);
};

const filesOf = (dir: string) => fs.readdirSync(dir).sort();

describe('expired slice naming', () => {
  it('names shards next to the monolith and maps them back to the crawler key', () => {
    expect(expiredSliceFileName('coop-ticino')).toBe('coop-ticino.json');
    expect(expiredSliceFileName('coop-ticino', 1)).toBe('coop-ticino.shard-001.json');
    expect(expiredSliceKeyOf('coop-ticino.shard-012.json')).toBe('coop-ticino');
    expect(expiredSliceKeyOf('coop-ticino.json')).toBe('coop-ticino');
    // Scratch companions are not slices.
    expect(expiredSliceKeyOf('coop-ticino-locale-cache.json')).toBeNull();
    expect(expiredSliceKeyOf('coop-ticino.json.cleanup-tmp.json')).toBeNull();
    expect(expiredSliceNamesForKey(
      ['coop-ticino.shard-002.json', 'coop-ticino-x.json', 'coop-ticino.json', 'coop-ticino.shard-001.json'],
      'coop-ticino',
    )).toEqual(['coop-ticino.json', 'coop-ticino.shard-001.json', 'coop-ticino.shard-002.json']);
    // Past shard-999 the index keeps growing and the order stays numeric.
    expect(expiredSliceFileName('coop-ticino', 1000)).toBe('coop-ticino.shard-1000.json');
    expect(expiredSliceNamesForKey(['coop-ticino.shard-1000.json', 'coop-ticino.shard-999.json'], 'coop-ticino'))
      .toEqual(['coop-ticino.shard-999.json', 'coop-ticino.shard-1000.json']);
  });

  it('keeps the 45 MB target well under the 90 MB ceiling', () => {
    expect(EXPIRED_SLICE_SHARD_TARGET_BYTES).toBe(45 * MB);
    expect(EXPIRED_SLICE_SHARD_TARGET_BYTES * 2).toBeLessThanOrEqual(EXPIRED_SLICE_SIZE_LIMIT_BYTES);
  });

  it('predicts exactly the bytes writeJsonAtomic writes', () => {
    const rows = [entry(1), entry(2, 'àèìòù “quoted”\nline'), entry(3)];
    const exact = Buffer.byteLength(`${JSON.stringify(rows, null, 2)}\n`);
    expect(3 + rows.reduce((sum, row) => sum + expiredRowBytes(row), 0)).toBe(exact);
  });
});

describe('expired slice reader', () => {
  it('returns the monolith and every shard of a crawler, in index order, and nothing else', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1), entry(2)]);
    writeRaw(dir, 'coop-ticino.shard-002.json', [entry(5)]);
    writeRaw(dir, 'coop-ticino.shard-001.json', [entry(3), entry(4)]);
    writeRaw(dir, 'coop-ticino-locale-cache.json', [entry(99)]);
    writeRaw(dir, 'roche.json', [entry(100)]);

    expect(readExpiredSliceRows('coop-ticino', { dir }).map((row) => row.slug)).toEqual(
      [1, 2, 3, 4, 5].map((n) => entry(n).slug),
    );
    expect(readExpiredSlice('coop-ticino', { dir })).toHaveLength(5);
    expect(listExpiredSliceKeys({ dir })).toEqual(['coop-ticino', 'roche']);
    expect(readExpiredSliceRows('missing', { dir })).toEqual([]);
    // The build-side lister (jobsSeoPagesPlugin's slice augmentation) sees
    // every shard as a plain array file, without any change to the plugin.
    expect(listJobsSeoExpiredSliceFiles(dir)).toEqual([
      'coop-ticino.json',
      'coop-ticino.shard-001.json',
      'coop-ticino.shard-002.json',
      'roche.json',
    ]);
  });

  it('fails closed on an unreadable file instead of reading it as empty', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1)]);
    fs.writeFileSync(path.join(dir, 'coop-ticino.shard-001.json'), '{"not":"an array"}\n');
    expect(() => readExpiredSliceRows('coop-ticino', { dir })).toThrow(/not an array/);
    // The tolerant read used by crawlers for lookups still degrades to [].
    expect(readExpiredSlice('coop-ticino', { dir })).toEqual([]);
  });
});

describe('expired slice writer', () => {
  it('keeps a small archive in its monolith', () => {
    const dir = tmpExpiredDir();
    const result = writeExpiredSliceRows('coop-ticino', [entry(1), entry(2)], { dir });
    expect(result.written).toEqual(['coop-ticino.json']);
    expect(filesOf(dir)).toEqual(['coop-ticino.json']);
  });

  it('appends to the last file and opens a new shard at the target', () => {
    const dir = tmpExpiredDir();
    const rows = Array.from({ length: 4 }, (_, n) => entry(n));
    const target = 3 + expiredRowBytes(rows[0]) * 2 + 10; // two rows per file
    writeExpiredSliceRows('coop-ticino', rows.slice(0, 2), { dir, shardTargetBytes: target });
    expect(filesOf(dir)).toEqual(['coop-ticino.json']);

    const monolithBefore = fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8');
    const result = writeExpiredSliceRows(
      'coop-ticino',
      [rows[3], rows[2], ...rows.slice(0, 2)],
      { dir, shardTargetBytes: target },
    );
    expect(result.written).toEqual(['coop-ticino.shard-001.json']);
    expect(filesOf(dir)).toEqual(['coop-ticino.json', 'coop-ticino.shard-001.json']);
    // The full file is never rewritten for an append.
    expect(fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8')).toBe(monolithBefore);
    expect(readExpiredSliceRows('coop-ticino', { dir }).map((row) => row.slug)).toEqual(
      [0, 1, 3, 2].map((n) => entry(n).slug),
    );

    // One more row: shard-001 is full, shard-002 opens.
    writeExpiredSliceRows('coop-ticino', [entry(4), ...readExpiredSliceRows('coop-ticino', { dir })], {
      dir,
      shardTargetBytes: target,
    });
    expect(filesOf(dir)).toEqual(['coop-ticino.json', 'coop-ticino.shard-001.json', 'coop-ticino.shard-002.json']);
    for (const name of filesOf(dir)) {
      expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(target);
    }
  });

  it('updates a row in the file that holds it and removes collapsed rows there', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1), entry(2)]);
    writeRaw(dir, 'coop-ticino.shard-001.json', [entry(3), entry(4)]);
    const updated = { ...entry(1), title: 'Addetto vendita 1 (aggiornato)' };
    const result = writeExpiredSliceRows('coop-ticino', [entry(3), updated, entry(2)], { dir });
    expect(result.written.sort()).toEqual(['coop-ticino.json', 'coop-ticino.shard-001.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8')).map((row: any) => row.title))
      .toEqual(['Addetto vendita 1 (aggiornato)', 'Addetto vendita 2']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'coop-ticino.shard-001.json'), 'utf8')).map((row: any) => row.slug))
      .toEqual([entry(3).slug]);
  });

  it('detects in-place mutations of the rows it was handed', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1)]);
    const shards = readExpiredSliceShards('coop-ticino', { dir });
    shards[0].rows[0].title = 'mutated';
    expect(writeExpiredSliceRows('coop-ticino', shards[0].rows, { dir, existing: shards }).written)
      .toEqual(['coop-ticino.json']);
    expect(readExpiredSliceRows('coop-ticino', { dir })[0].title).toBe('mutated');
    expect(writeExpiredSliceRows('coop-ticino', readExpiredSliceRows('coop-ticino', { dir }), { dir }).written)
      .toEqual([]);
  });

  it('never leaves a file above the ceiling: a file an update would overflow spills into the open shard', () => {
    const dir = tmpExpiredDir();
    const rows = Array.from({ length: 6 }, (_, n) => entry(n));
    const rowBytes = expiredRowBytes(rows[0]);
    const ceiling = 3 + rowBytes * 3 + 10;
    writeRaw(dir, 'coop-ticino.json', rows.slice(0, 3));
    const grown = rows.slice(0, 3).map((row) => ({ ...row, description: `${row.description} ${'y'.repeat(40)}` }));
    writeExpiredSliceRows('coop-ticino', [...grown, ...rows.slice(3)], {
      dir,
      shardTargetBytes: ceiling,
      hardCeilingBytes: ceiling,
    });
    for (const name of filesOf(dir)) {
      expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(ceiling);
    }
    expect(new Set(readExpiredSliceRows('coop-ticino', { dir }).map((row) => row.slug)))
      .toEqual(new Set(rows.map((row) => row.slug)));
  });

  it('re-places rows spilled from several files in canonical file order, never reversed', () => {
    const dir = tmpExpiredDir();
    const [A, B, C, D] = [1, 2, 3, 4].map((n) => entry(n));
    writeRaw(dir, 'coop-ticino.json', [A, B]);
    writeRaw(dir, 'coop-ticino.shard-001.json', [C, D]);
    const rowBytes = expiredRowBytes(A);
    // Each file can hold one row: both tails (B, D) spill, and each spilled
    // row needs its own new shard.
    const ceiling = 3 + rowBytes + 1;
    const result = writeExpiredSliceRows('coop-ticino', [A, B, C, D], {
      dir,
      shardTargetBytes: ceiling,
      hardCeilingBytes: ceiling,
    });
    expect(result.files.map((file) => file.name)).toEqual([
      'coop-ticino.json',
      'coop-ticino.shard-001.json',
      'coop-ticino.shard-002.json',
      'coop-ticino.shard-003.json',
    ]);
    // A and C stay where they were; the spilled tails keep their order B, D
    // (the reversed placement read back as A, C, D, B).
    expect(readExpiredSliceRows('coop-ticino', { dir }).map((row) => row.slug))
      .toEqual([A, C, B, D].map((row) => row.slug));
    for (const name of filesOf(dir)) {
      expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(ceiling);
    }
  });

  it('fails before any write when the archive directory cannot be listed (EIO/EACCES), and treats only ENOENT as empty', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1)]);
    const before = fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8');
    const realReaddir = fs.readdirSync;
    for (const code of ['EIO', 'EACCES']) {
      const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        if (String(target) === dir) throw Object.assign(new Error(`${code}: simulated`), { code });
        return (realReaddir as any)(target, ...rest);
      }) as typeof fs.readdirSync);
      expect(() => writeExpiredSliceRows('coop-ticino', [entry(2)], { dir })).toThrow(code);
      expect(() => readExpiredSliceRows('coop-ticino', { dir })).toThrow(code);
      spy.mockRestore();
    }
    expect(filesOf(dir)).toEqual(['coop-ticino.json']);
    expect(fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8')).toBe(before);
    expect(readExpiredSliceRows('coop-ticino', { dir: path.join(dir, 'absent') })).toEqual([]);
  });

  it('refuses a single row the ceiling cannot hold and writes nothing', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1)]);
    const before = fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8');
    expect(() => writeExpiredSliceRows('coop-ticino', [entry(1), entry(2, 'x'.repeat(2000))], {
      dir,
      hardCeilingBytes: 1500,
    })).toThrow(FileSizeCeilingError);
    expect(filesOf(dir)).toEqual(['coop-ticino.json']);
    expect(fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8')).toBe(before);
  });
});

describe('archiveRemovedJobsToSlice on a sharded archive', () => {
  it('dedups against every shard and archives new rows into the open shard', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1)]);
    writeRaw(dir, 'coop-ticino.shard-001.json', [entry(2)]);
    const monolithBefore = fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8');

    // Slug 2 already lives in shard-001: only slug 3 is new.
    const removed = [entry(2), entry(3)].map(({ expiredAt, ...job }) => ({ ...job, url: `https://jobs.coop.invalid/${job.slug}` }));
    expect(archiveRemovedJobsToSlice(removed, 'coop-ticino', { dir })).toBe(1);

    const rows = readExpiredSliceRows('coop-ticino', { dir });
    expect(rows.map((row) => row.slug).sort()).toEqual([1, 2, 3].map((n) => entry(n).slug).sort());
    expect(fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8')).toBe(monolithBefore);
    expect(filesOf(dir)).toEqual(['coop-ticino.json', 'coop-ticino.shard-001.json']);
  });

  it('stops growing a monolith past the target: new rows open a shard below the ceiling', () => {
    const dir = tmpExpiredDir();
    const big = 'x'.repeat(MB);
    // 46 x ~2 MB rows (description + descriptionByLocale) = ~92 MB would be
    // over the ceiling as one file; the monolith alone is ~46 MB, past target.
    const existing = Array.from({ length: 23 }, (_, n) => ({ ...entry(n, big), descriptionByLocale: { it: big } }));
    writeRaw(dir, 'coop-ticino.json', existing);
    const monolithBefore = fs.statSync(path.join(dir, 'coop-ticino.json')).size;
    expect(monolithBefore).toBeGreaterThan(EXPIRED_SLICE_SHARD_TARGET_BYTES);

    const removed = Array.from({ length: 23 }, (_, n) => ({
      ...entry(100 + n, big),
      descriptionByLocale: { it: big },
      url: `https://jobs.coop.invalid/${100 + n}`,
    }));
    expect(archiveRemovedJobsToSlice(removed, 'coop-ticino', { dir })).toBe(23);
    expect(fs.statSync(path.join(dir, 'coop-ticino.json')).size).toBe(monolithBefore);
    for (const file of listExpiredSliceFiles('coop-ticino', { dir })) {
      expect(fs.statSync(file.path).size).toBeLessThanOrEqual(EXPIRED_SLICE_SIZE_LIMIT_BYTES);
    }
    expect(readExpiredSliceRows('coop-ticino', { dir })).toHaveLength(46);
  }, 120_000);
});

describe('route collapse across shards (collapseDuplicateRouteEntries on every file of a crawler)', () => {
  // Two archive records holding the same route, one in the monolith and one
  // in a shard. The writer hands ALL rows of the crawler to the collapse, so
  // the same rules apply whatever file each record lives in.
  const holder = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug,
    slugByLocale: { it: slug },
    previousSlugs: ['shared-route-coop-lugano'],
    previousSlugsByLocale: { it: ['shared-route-coop-lugano'] },
    title: `Titolo ${slug}`,
    company: 'Coop',
    companyKey: 'coop-ticino',
    expiredAt: daysAgo(3),
    ...extra,
  });

  it('collapses two identity-less records that share a route even when they sit in different files', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [holder('alpha-coop-lugano')]);
    writeRaw(dir, 'coop-ticino.shard-001.json', [holder('beta-coop-lugano', { expiredAt: daysAgo(4) })]);
    archiveRemovedJobsToSlice([], 'coop-ticino', { dir });
    const rows = readExpiredSliceRows('coop-ticino', { dir });
    expect(rows).toHaveLength(1);
    const routes = new Set(rows.flatMap((row: any) => [row.slug, ...(row.previousSlugs || [])]));
    for (const slug of ['alpha-coop-lugano', 'beta-coop-lugano', 'shared-route-coop-lugano']) expect(routes.has(slug)).toBe(true);
  });

  it('refuses to merge a record that names its posting with one that names none, across files too', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [holder('alpha-coop-lugano', { sourceIdentity: 'url:https://jobs.coop.invalid/alpha' })]);
    writeRaw(dir, 'coop-ticino.shard-001.json', [holder('beta-coop-lugano')]);
    archiveRemovedJobsToSlice([], 'coop-ticino', { dir });
    expect(readExpiredSliceRows('coop-ticino', { dir }).map((row: any) => row.slug).sort())
      .toEqual(['alpha-coop-lugano', 'beta-coop-lugano']);
    expect(filesOf(dir)).toEqual(['coop-ticino.json', 'coop-ticino.shard-001.json']);
  });
});

describe('offline split of a monolith', () => {
  it('loses no row and keeps the order', () => {
    const dir = tmpExpiredDir();
    const rows = Array.from({ length: 25 }, (_, n) => entry(n, `descrizione ${'z'.repeat(n * 7)}`));
    writeRaw(dir, 'coop-ticino.json', rows);
    const before = readExpiredSliceRows('coop-ticino', { dir });
    const target = 3 + rows.slice(0, 8).reduce((sum, row) => sum + expiredRowBytes(row), 0);

    const result = splitExpiredSliceMonolith('coop-ticino', { dir, shardTargetBytes: target });

    expect(result.rows).toBe(25);
    expect(filesOf(dir)).not.toContain('coop-ticino.json');
    expect(result.files.length).toBeGreaterThan(1);
    const after = readExpiredSliceRows('coop-ticino', { dir });
    expect(after).toEqual(before);
    for (const file of listExpiredSliceFiles('coop-ticino', { dir })) {
      expect(fs.statSync(file.path).size).toBeLessThanOrEqual(target);
    }
    // A writer after the split keeps every row where it is.
    expect(writeExpiredSliceRows('coop-ticino', after, { dir, shardTargetBytes: target }).written).toEqual([]);
  });

  it('is transactional: a failure after the first shard is staged leaves the monolith alone, never monolith + shards', () => {
    const rows = Array.from({ length: 25 }, (_, n) => entry(n, `descrizione ${'z'.repeat(n * 7)}`));
    const target = 3 + rows.slice(0, 8).reduce((sum, row) => sum + expiredRowBytes(row), 0);
    for (const failAt of ['staged', 'monolith-moved', 'committed']) {
      const dir = tmpExpiredDir();
      writeRaw(dir, 'coop-ticino.json', rows);
      const before = fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8');
      const seen: string[] = [];
      expect(() => splitExpiredSliceMonolith('coop-ticino', {
        dir,
        shardTargetBytes: target,
        onStep: (step: string, name: string) => {
          seen.push(`${step}:${name}`);
          // Readers never see the monolith next to a committed shard.
          const visible = listExpiredSliceFiles('coop-ticino', { dir }).map((file) => file.name);
          expect(visible.includes('coop-ticino.json') && visible.length > 1).toBe(false);
          if (step === failAt) throw new Error(`injected failure at ${step}`);
        },
      })).toThrow(`injected failure at ${failAt}`);
      expect(seen[0]).toMatch(/^staged:coop-ticino\.shard-001\.json$/);
      // Rolled back: exactly the original monolith, no staged or partial file.
      expect(filesOf(dir)).toEqual(['coop-ticino.json']);
      expect(fs.readFileSync(path.join(dir, 'coop-ticino.json'), 'utf8')).toBe(before);
    }

    // Without a failure the split completes and no scratch file is left.
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', rows);
    splitExpiredSliceMonolith('coop-ticino', { dir, shardTargetBytes: target });
    expect(filesOf(dir).every((name) => /^coop-ticino\.shard-\d{3}\.json$/.test(name))).toBe(true);
    expect(readExpiredSliceRows('coop-ticino', { dir })).toEqual(rows);
  });

  it('refuses to split an archive that already has shards', () => {
    const dir = tmpExpiredDir();
    writeRaw(dir, 'coop-ticino.json', [entry(1)]);
    writeRaw(dir, 'coop-ticino.shard-001.json', [entry(2)]);
    expect(() => splitExpiredSliceMonolith('coop-ticino', { dir })).toThrow(/shards already exist/);
  });
});
