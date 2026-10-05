/**
 * RETRANS-FLAG — a crawler run must not raise `needsRetranslation` on a record
 * whose source text did not change and whose translations are complete.
 *
 * Fixtures are real slice records (anonymised: company, ids, URLs) taken from
 * three "Auto-update crawler group" commits of 2026-09-26, one per class:
 *   - source-unchanged   title/description/sourceLang byte-identical
 *   - source-formal-only one trailing space removed from the description
 *   - source-changed     the title became a different role (translations
 *                        still hold the OLD title in every locale)
 * In all three the crawler flipped the record from unflagged to flagged, and
 * translate-pending's own predicate calls every `after` complete.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetRetranslationBaselines,
  dropSpuriousRetranslationFlags,
  getRetranslationBaseline,
  recordRetranslationBaseline,
  retranslationSourceHash,
  snapshotRetranslationBaseline,
} from '../scripts/lib/crawler-retranslation-baseline.mjs';
import { isIncomplete } from '../scripts/lib/translation-incomplete.mjs';
import { seedCrawlerSlicesFromDataJobs } from '../scripts/lib/dedicated-crawler-common.mjs';

type Job = Record<string, any>;
type Pair = { case: string; before: Job; after: Job };

const PAIRS: Pair[] = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'crawler-retranslation-flag', 'real-pairs.json'),
  'utf8',
));
const pair = (name: string): Pair => {
  const found = PAIRS.find((p) => p.case === name);
  if (!found) throw new Error(`fixture case missing: ${name}`);
  return structuredClone(found);
};

beforeEach(() => _resetRetranslationBaselines());

describe('fixture premises (what the crawler wrote on 2026-09-26)', () => {
  it.each(['source-unchanged', 'source-formal-only', 'source-changed'])(
    '%s: flag raised by the crawler on a record translate-pending calls complete',
    (name) => {
      const { before, after } = pair(name);
      expect(before.needsRetranslation).toBeUndefined();
      expect(after.needsRetranslation).toBe(true);
      // If this ever flips, the fixture no longer isolates the source-text rule.
      expect(isIncomplete(after)).toBe(false);
    },
  );
});

describe('retranslationSourceHash', () => {
  it('ignores formatting-only rewrites of the same words', () => {
    const { before, after } = pair('source-formal-only');
    expect(after.description).not.toBe(before.description);
    expect(retranslationSourceHash(after)).toBe(retranslationSourceHash(before));
  });

  it('changes when the wording of the source changes', () => {
    const { before, after } = pair('source-changed');
    expect(retranslationSourceHash(after)).not.toBe(retranslationSourceHash(before));
  });

  it('changes when only the source language is re-derived', () => {
    const { before } = pair('source-unchanged');
    expect(retranslationSourceHash({ ...before, sourceLang: 'fr' }))
      .not.toBe(retranslationSourceHash(before));
  });

  it('uses Italian source slots when sourceLang is absent', () => {
    const { before: fixtureBefore, after: fixtureAfter } = pair('source-unchanged');
    const before = structuredClone(fixtureBefore);
    const after = structuredClone(fixtureAfter);
    delete before.sourceLang;
    delete after.sourceLang;
    delete before.title;
    delete after.title;
    delete before.description;
    delete after.description;
    after.titleByLocale.it = `${after.titleByLocale.it} aggiornata`;

    expect(Object.keys(after.titleByLocale)).toEqual(expect.arrayContaining(['it', 'en', 'de', 'fr']));
    expect(Object.keys(after.descriptionByLocale)).toEqual(expect.arrayContaining(['it', 'en', 'de', 'fr']));
    expect(isIncomplete(after)).toBe(false);
    expect(retranslationSourceHash(after)).not.toBe(retranslationSourceHash(before));
  });
});

describe('dropSpuriousRetranslationFlags', () => {
  it('drops the flag raised on an unchanged, complete record', () => {
    const { before, after } = pair('source-unchanged');
    const report = dropSpuriousRetranslationFlags([after], [before], { isIncomplete });
    expect(after.needsRetranslation).toBeUndefined();
    expect(report).toMatchObject({ flagged: 1, dropped: 1 });
  });

  it('drops the flag when the source change is formatting only', () => {
    const { before, after } = pair('source-formal-only');
    const report = dropSpuriousRetranslationFlags([after], [before], { isIncomplete });
    expect(after.needsRetranslation).toBeUndefined();
    expect(report.dropped).toBe(1);
  });

  it('keeps the flag when the source text really changed, complete translations or not', () => {
    const { before, after } = pair('source-changed');
    const report = dropSpuriousRetranslationFlags([after], [before], { isIncomplete });
    expect(after.needsRetranslation).toBe(true);
    expect(report).toMatchObject({ dropped: 0, keptSourceChanged: 1 });
  });

  it('keeps a changed Italian source flag when sourceLang is absent', () => {
    const { before: fixtureBefore, after: fixtureAfter } = pair('source-unchanged');
    const before = structuredClone(fixtureBefore);
    const after = structuredClone(fixtureAfter);
    delete before.sourceLang;
    delete after.sourceLang;
    delete before.title;
    delete after.title;
    delete before.description;
    delete after.description;
    after.titleByLocale.it = `${after.titleByLocale.it} aggiornata`;

    expect(isIncomplete(after)).toBe(false);
    const report = dropSpuriousRetranslationFlags([after], [before], { isIncomplete });
    expect(after.needsRetranslation).toBe(true);
    expect(report).toMatchObject({ dropped: 0, keptSourceChanged: 1 });
  });

  it('keeps the flag when the translations are incomplete', () => {
    const { before, after } = pair('source-unchanged');
    const target = Object.keys(after.descriptionByLocale).find((l) => l !== after.sourceLang)!;
    after.descriptionByLocale[target] = '';
    const report = dropSpuriousRetranslationFlags([after], [before], { isIncomplete });
    expect(after.needsRetranslation).toBe(true);
    expect(report.keptIncomplete).toBe(1);
  });

  it('never clears a flag the previous run had already stored', () => {
    const { before, after } = pair('source-unchanged');
    const report = dropSpuriousRetranslationFlags(
      [after], [{ ...before, needsRetranslation: true }], { isIncomplete },
    );
    expect(after.needsRetranslation).toBe(true);
    expect(report.keptAlreadyFlagged).toBe(1);
  });

  it('keeps the flag of a record the previous run did not have', () => {
    const { after } = pair('source-unchanged');
    const report = dropSpuriousRetranslationFlags([after], [], { isIncomplete });
    expect(after.needsRetranslation).toBe(true);
    expect(report.keptNoBaseline).toBe(1);
  });

  it('matches by url when the stable id is absent', () => {
    const { before, after } = pair('source-unchanged');
    delete after.id;
    dropSpuriousRetranslationFlags([after], snapshotRetranslationBaseline([before]), { isIncomplete });
    expect(after.needsRetranslation).toBeUndefined();
  });

  it('requires the completeness verdict to be injected', () => {
    expect(() => dropSpuriousRetranslationFlags([], [], {} as any)).toThrow(TypeError);
  });
});

describe('baseline = the slice the previous run committed', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrans-baseline-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seedAndRead = (key: string, committed: Job[], merged: Job[]) => {
    const sliceDir = path.join(root, 'data', 'jobs', 'by-crawler');
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, `${key}.json`), JSON.stringify({ jobs: committed }));
    const dataJobsPath = path.join(root, 'scratch.json');
    fs.writeFileSync(dataJobsPath, JSON.stringify(merged.map((j) => ({ ...j, companyKey: key }))));
    seedCrawlerSlicesFromDataJobs(root, [key], dataJobsPath);
    return JSON.parse(fs.readFileSync(path.join(sliceDir, `${key}.json`), 'utf8')).jobs as Job[];
  };

  it('the seed records the committed slice before overwriting it, so a real change stays visible', () => {
    const { before, after } = pair('source-changed');
    const seeded = seedAndRead('acme', [before], [after]);
    // The seed really replaced the slice with this run's merged text…
    expect(seeded[0].title).toBe(after.title);
    // …and the baseline still describes the previous run.
    const baseline = getRetranslationBaseline('acme');
    expect(baseline?.get(`id:${before.id}`)?.hash).toBe(retranslationSourceHash(before));
    const flagged = structuredClone(after);
    const report = dropSpuriousRetranslationFlags([flagged], baseline, { isIncomplete });
    expect(flagged.needsRetranslation).toBe(true);
    expect(report.keptSourceChanged).toBe(1);
  });

  it('with the seed-recorded baseline an unchanged, complete record loses the crawler flag', () => {
    const { before, after } = pair('source-unchanged');
    seedAndRead('acme', [before], [after]);
    const report = dropSpuriousRetranslationFlags([after], getRetranslationBaseline('acme'), { isIncomplete });
    expect(after.needsRetranslation).toBeUndefined();
    expect(report.dropped).toBe(1);
  });

  it('first record per crawler wins: a later read of the seeded slice does not replace it', () => {
    const { before, after } = pair('source-changed');
    expect(recordRetranslationBaseline('acme', [before])).toBe(true);
    seedAndRead('acme', [before], [after]);
    expect(recordRetranslationBaseline('acme', [after])).toBe(false);
    const flagged = structuredClone(after);
    dropSpuriousRetranslationFlags([flagged], getRetranslationBaseline('acme'), { isIncomplete });
    expect(flagged.needsRetranslation).toBe(true);
  });
});

describe('wiring in the crawler slice writer', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const fnBody = (src: string, signature: string) => {
    const start = src.indexOf(signature);
    expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('\nexport ', start + signature.length);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it('readExistingCrawlerJobs records the committed slice as baseline', () => {
    const body = fnBody(read('scripts/assemble-jobs-dataset.mjs'), 'export function readExistingCrawlerJobs(');
    expect(body).toMatch(/recordRetranslationBaseline\(crawlerKey, jobs\)/);
  });

  it('writeJobsCrawlerSlice drops spurious flags AFTER its own word-list quality gate', () => {
    const body = fnBody(read('scripts/assemble-jobs-dataset.mjs'), 'export function writeJobsCrawlerSlice(');
    const gate = body.indexOf('if (needsFlag) { job.needsRetranslation = true;');
    const drop = body.indexOf('dropSpuriousRetranslationFlags(jobs, baseline, { isIncomplete })');
    const persist = body.indexOf('writeJson(slicePath, payload');
    expect(gate).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(gate);
    expect(persist).toBeGreaterThan(drop);
    expect(body).toMatch(/options\.retranslationBaseline \?\? getRetranslationBaseline\(crawlerKey\)/);
  });

  it('translate-pending and the slice writer share ONE completeness predicate', () => {
    expect(read('scripts/relocalize-pending-jobs.mjs'))
      .toContain("import { isIncomplete } from './lib/translation-incomplete.mjs';");
    expect(read('scripts/assemble-jobs-dataset.mjs'))
      .toContain("import { isIncomplete } from './lib/translation-incomplete.mjs';");
    expect(read('scripts/relocalize-pending-jobs.mjs')).not.toMatch(/export function isIncomplete\(/);
  });
});
