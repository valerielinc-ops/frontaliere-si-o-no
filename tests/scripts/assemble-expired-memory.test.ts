// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleExpiredJobs,
  normalizeAndPersistExpiredSlice,
} from '../../scripts/assemble-jobs-dataset.mjs';
import { collapseDuplicateRouteEntries } from '../../scripts/lib/expired-jobs-archive.mjs';
import { compareExpiredAt } from '../../scripts/lib/compare-expired-at.mjs';
import {
  createExpiredDescriptionSpill,
  withoutDescriptions,
} from '../../scripts/lib/expired-description-spill.mjs';
import { startHeapPhase } from '../../scripts/lib/heap-phase-monitor.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const prose = (tag: string) => `${tag} — «descrizione» lunga è ü   \ud800 `.repeat(30);

function row(id: string, slug: string, day: number, extra: Record<string, unknown> = {}) {
  return {
    companyKey: 'acme-fixture',
    company: 'Acme Fixture',
    title: `Ruolo ${id}`,
    location: 'Lugano',
    url: `https://jobs.example.test/${id}`,
    slug,
    descriptionByLocale: { it: prose(`it-${id}`), de: prose(`de-${id}`) },
    description: prose(`flat-${id}`),
    slugByLocale: { it: slug },
    previousSlugs: [] as string[],
    expiredAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    ...extra,
  };
}

/** Duplicated key across files, a same-posting merge, a route collision, ties. */
function fixtures(): Record<string, unknown[]> {
  return {
    'a.json': [
      row('dup-old', 'dup-slug', 3),
      row('merge', 'merge-new', 9),
      row('collision-1', 'shared-route', 8),
      row('no-timestamp', 'no-timestamp', 1, { expiredAt: '' }),
      row('short', 'short-text', 2, { description: 'breve', descriptionByLocale: {} }),
    ],
    'b.json': [
      row('dup-new', 'dup-slug', 7),
      row('merge', 'merge-old', 4, { previousSlugs: ['merge-new'] }),
      row('collision-2', 'other-slug', 6, { previousSlugs: ['shared-route'] }),
    ],
  };
}

const AGGREGATE = [
  row('from-aggregate', 'aggregate-only', 5),
  row('dup-aggregate', 'dup-slug', 10),
];

function setup(files: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'expired-memory-'));
  roots.push(root);
  const sliceDir = join(root, 'slices');
  mkdirSync(sliceDir);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(sliceDir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  const aggregatePath = join(root, 'expired-jobs.json');
  writeFileSync(aggregatePath, JSON.stringify(AGGREGATE));
  return { sliceDir, aggregatePath };
}

/** The same pipeline with every row held in the heap with its descriptions. */
function referenceAssembly(sliceDir: string, names: string[]) {
  const winners = new Map<string, any>();
  const offer = (entry: any) => {
    const key = `${entry.companyKey || ''}::${entry.slug}`;
    const current = winners.get(key);
    if (!current || compareExpiredAt(entry.expiredAt, current.expiredAt) >= 0) winners.set(key, entry);
  };
  for (const name of names) {
    const path = join(sliceDir, name);
    const entries = JSON.parse(readFileSync(path, 'utf8'));
    normalizeAndPersistExpiredSlice(path, entries, { source: `assemble/${name}` });
    entries.forEach(offer);
  }
  structuredClone(AGGREGATE).forEach(offer);
  return collapseDuplicateRouteEntries(
    [...winners.values()].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)),
    { source: 'reference', repairUnprovenCollisions: true },
  ).entries;
}

describe('assembleExpiredJobs with descriptions parked outside the heap', () => {
  it('returns the same bytes and rewrites the same slices as a full in-heap pass', () => {
    const names = Object.keys(fixtures());
    const reference = setup(fixtures());
    const actual = setup(fixtures());

    const expected = referenceAssembly(reference.sliceDir, names);
    const result = assembleExpiredJobs(actual);

    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(result)).not.toContain('__spilledExpiredField');
    // The fixture really exercises a merge, a duplicate key and a repair.
    expect(result!.length).toBeLessThan(10);
    expect(result!.find((job: any) => job.slug === 'dup-slug')!.url).toContain('dup-aggregate');
    for (const name of names) {
      const written = readFileSync(join(actual.sliceDir, name), 'utf8');
      expect(written).toBe(readFileSync(join(reference.sliceDir, name), 'utf8'));
      expect(written).not.toContain('__spilledExpiredField');
    }
  });

  it('rejects a malformed file before rewriting any slice', () => {
    const files = { ...fixtures(), 'z-malformed.json': '{"not":"an array"}' };
    const input = setup(files);
    const before = readFileSync(join(input.sliceDir, 'a.json'), 'utf8');

    expect(() => assembleExpiredJobs(input)).toThrow(/1 malformed:\n {2}- z-malformed\.json/);
    // a.json holds a row without expiredAt, so processing it would rewrite it.
    expect(readFileSync(join(input.sliceDir, 'a.json'), 'utf8')).toBe(before);
  });
});

describe('expired description spill', () => {
  it('survives a structuredClone and keeps key order', () => {
    const entry = row('clone', 'clone', 1);
    const original = JSON.stringify(entry);
    const spill = createExpiredDescriptionSpill();
    spill.detach(entry);
    expect(JSON.stringify(entry).length).toBeLessThan(original.length / 4);
    const copy = structuredClone(entry);
    spill.restore(copy);
    expect(JSON.stringify(copy)).toBe(original);
  });

  it('drops only the description fields from the ghost-scan copy', () => {
    const entry = row('slim', 'slim', 1);
    const { description, descriptionByLocale, ...rest } = entry;
    expect(withoutDescriptions(entry)).toEqual(rest);
    expect(entry.descriptionByLocale).toBe(descriptionByLocale);
    expect(entry.description).toBe(description);
  });
});

describe('startHeapPhase', () => {
  const MB = 1024 * 1024;
  const run = (usedMb: number[]) => {
    const lines: string[] = [];
    let call = 0;
    const phase = startHeapPhase('fixture', {
      log: (line: string) => lines.push(line),
      heapLimitBytes: 100 * MB,
      readUsage: () => ({ heapUsed: usedMb[Math.min(call++, usedMb.length - 1)] * MB, rss: 200 * MB }),
      GCProfiler: null as any,
    });
    return { lines, phase };
  };
  const warnings = (lines: string[]) => lines.filter((line) => line.includes('⚠️'));

  it('warns once, as soon as a sample passes 75% of the limit', () => {
    const { lines, phase } = run([10, 80, 90, 20]);
    phase.sample('big.json');
    expect(warnings(lines)).toHaveLength(1);
    expect(warnings(lines)[0]).toContain('big.json');
    phase.sample('next.json');
    expect(phase.finish()).toMatchObject({ peakHeapBytes: 90 * MB, warned: true });
    expect(warnings(lines)).toHaveLength(1);
    expect(lines.at(-1)).toContain('peak heap 90 MB (90% of limit)');
  });

  it('stays quiet at 75% and below', () => {
    const { lines, phase } = run([10, 75, 20]);
    phase.sample();
    expect(phase.finish()).toMatchObject({ warned: false });
    expect(warnings(lines)).toHaveLength(0);
  });
});
