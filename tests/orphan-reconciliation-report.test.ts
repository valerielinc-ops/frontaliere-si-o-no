import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReport,
  summarizeLedger,
  appendHistory,
  HISTORY_FILE,
  HISTORY_MAX_ROWS,
} from '../scripts/report-orphan-reconciliation.mjs';
import { writeOrphanEnriched } from '../scripts/lib/orphan-enriched-store.mjs';
import { writeAllKnownJobSlugs } from '../scripts/lib/all-known-job-slugs-store.mjs';

/**
 * The measure that makes "green but reconciling nothing" visible (#4248).
 *
 * The workflow being red was never the expensive part — it was that the
 * pipeline computed every soft landing and then had `git push` throw them away,
 * for three weeks, with nothing anywhere counting the loss. `pendingSlugs` /
 * `pendingImpressions` are that count: what this run computed minus what `main`
 * already has. They must be non-zero when work has not landed and drop to zero
 * once it has, or the report is decoration.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
});

function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-recon-'));
  tmpDirs.push(d);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: d, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '--allow-empty', '-q', '-m', 'root');
  return d;
}

function commitAll(root: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'data'], { cwd: root, stdio: 'ignore' });
}

const orphan = (slug: string, locale: string, impressions: number): Record<string, unknown> => ({
  slug,
  locale,
  path: `/cerca-lavoro-ticino/${slug}/`,
  totalImpressions: impressions,
  totalClicks: Math.floor(impressions / 10),
  queries: impressions > 0 ? [{ query: slug, clicks: 1, impressions }] : [],
});

const registryOf = (...slugs: string[]): Record<string, Record<string, string>> =>
  Object.fromEntries(slugs.map((s) => [s, { it: `/cerca-lavoro-ticino/${s}` }]));

describe('orphan reconciliation report — the backlog measure', () => {
  it('sums a slug GSC exposure across its locale records', () => {
    const bySlug = summarizeLedger([
      orphan('a', 'it', 100),
      orphan('a', 'de', 40),
      orphan('b', 'it', 7),
    ]);
    expect(bySlug.get('a')).toEqual({ impressions: 140, clicks: 14 });
    expect(bySlug.get('b')?.impressions).toBe(7);
  });

  it('reports zero backlog when every orphan is already on main', () => {
    const root = mkRepo();
    writeOrphanEnriched([orphan('a', 'it', 100), orphan('b', 'it', 5)], root);
    writeAllKnownJobSlugs(registryOf('a', 'b'), root);
    commitAll(root);

    const r = buildReport(root);
    expect(r.orphanSlugs).toBe(2);
    expect(r.orphanImpressions).toBe(105);
    expect(r.pendingSlugs).toBe(0);
    expect(r.pendingImpressions).toBe(0);
  });

  it('counts slugs and impressions this run computed but main does NOT have', () => {
    const root = mkRepo();
    // What main has: one orphan, already landed.
    writeOrphanEnriched([orphan('landed', 'it', 10)], root);
    writeAllKnownJobSlugs(registryOf('landed'), root);
    commitAll(root);

    // What this run just computed: two more orphans with real GSC traffic,
    // not yet pushed. This is the state that was permanent from 2026-07-17.
    writeOrphanEnriched(
      [orphan('landed', 'it', 10), orphan('fresh-a', 'it', 2372), orphan('fresh-b', 'de', 500)],
      root,
    );
    writeAllKnownJobSlugs(registryOf('landed', 'fresh-a', 'fresh-b'), root);

    const r = buildReport(root);
    expect(r.orphanSlugs).toBe(3);
    expect(r.pendingSlugs).toBe(2);
    // The business number: impressions still landing on a 404.
    expect(r.pendingImpressions).toBe(2872);
  });

  it('counts an orphan absent from the registry entirely as pending', () => {
    const root = mkRepo();
    writeOrphanEnriched([orphan('a', 'it', 10)], root);
    writeAllKnownJobSlugs(registryOf('a'), root);
    commitAll(root);

    // Discovered now, never added to the registry: main cannot serve it.
    writeOrphanEnriched([orphan('a', 'it', 10), orphan('unmapped', 'it', 999)], root);

    const r = buildReport(root);
    expect(r.pendingSlugs).toBe(1);
    expect(r.pendingImpressions).toBe(999);
  });

  it('drops the backlog to zero once the work is committed', () => {
    const root = mkRepo();
    writeOrphanEnriched([orphan('a', 'it', 42)], root);
    writeAllKnownJobSlugs(registryOf('a'), root);
    expect(buildReport(root).pendingSlugs).toBe(1);

    commitAll(root);
    expect(buildReport(root).pendingSlugs).toBe(0);
  });

  it('omits the backlog columns rather than inventing them without git', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-recon-nogit-'));
    tmpDirs.push(root);
    writeOrphanEnriched([orphan('a', 'it', 1)], root);
    writeAllKnownJobSlugs(registryOf('a'), root);

    const r = buildReport(root);
    expect(r.orphanSlugs).toBe(1);
    expect(r.pendingSlugs).toBeUndefined();
  });
});

describe('orphan reconciliation report — history series', () => {
  it('appends a row and keeps the earlier ones', () => {
    const root = mkRepo();
    appendHistory({ at: '2026-08-01T00:00:00Z', orphanSlugs: 10, pendingSlugs: 900 }, root);
    const doc = appendHistory({ at: '2026-08-02T00:00:00Z', orphanSlugs: 11, pendingSlugs: 3 }, root);

    expect(doc.entries.length).toBe(2);
    expect(doc.entries[0].pendingSlugs).toBe(900);
    expect(doc.entries[1].pendingSlugs).toBe(3);

    const onDisk = JSON.parse(fs.readFileSync(path.join(root, HISTORY_FILE), 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries.length).toBe(2);
  });

  it('caps the series so the committed file stays a small diff', () => {
    const root = mkRepo();
    let doc;
    for (let i = 0; i < HISTORY_MAX_ROWS + 25; i++) {
      doc = appendHistory({ at: `row-${i}`, orphanSlugs: i }, root);
    }
    expect(doc!.entries.length).toBe(HISTORY_MAX_ROWS);
    // Oldest rows are the ones dropped.
    expect(doc!.entries[doc!.entries.length - 1].at).toBe(`row-${HISTORY_MAX_ROWS + 24}`);
  });

  it('starts a fresh series instead of throwing on a corrupt history file', () => {
    const root = mkRepo();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, HISTORY_FILE), '{ not json');
    const doc = appendHistory({ at: 'x', orphanSlugs: 1 }, root);
    expect(doc.entries.length).toBe(1);
  });
});
