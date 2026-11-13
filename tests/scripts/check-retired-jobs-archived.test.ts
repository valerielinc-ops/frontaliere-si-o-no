// @vitest-environment node
/**
 * Observer contract (scripts/ci/check-retired-jobs-archived.mjs): between two
 * revisions, a posting that leaves the active set must be served at head by an
 * active row or by an expired entry WITH a title; an archive record with a
 * title must not vanish. Either gap is a job URL the build turns into the
 * noindex «Offerta non verificata» stub.
 */
import { describe, expect, it } from 'vitest';
import { measureRetiredArchiveCoverage } from '../../scripts/ci/check-retired-jobs-archived.mjs';

type Row = Record<string, any>;
const job = (slug: string, extra: Row = {}): Row => ({ slug, slugByLocale: { it: slug }, title: `T ${slug}`, ...extra });
const map = (entries: Record<string, Row[]>) => new Map(Object.entries(entries));

describe('measureRetiredArchiveCoverage()', () => {
  it('flags a posting that left the active set without an archive record (Locarno shape)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ 'citta-di-locarno': [job('impiegata-ii-50-70'), job('giardiniere')] }),
      baseExpired: map({}),
      headActive: map({ 'citta-di-locarno': [job('giardiniere')] }),
      headExpired: map({}),
    });
    expect(result.retired).toBe(1);
    expect(result.retiredUnarchived.map((row) => row.slug)).toEqual(['impiegata-ii-50-70']);
    expect(result.retiredUnarchivedByCrawler).toEqual({ 'citta-di-locarno': 1 });
  });

  it('accepts a retired posting archived with a title, not one archived without', () => {
    const titled = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('x')] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({ a: [job('x')] }),
    });
    expect(titled.retiredUnarchived).toEqual([]);

    const untitled = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('x')] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({ a: [{ slug: 'x', slugByLocale: { it: 'x' }, title: '', titleByLocale: {} }] }),
    });
    expect(untitled.retiredUnarchived.map((row) => row.slug)).toEqual(['x']);
  });

  it('accepts a renamed posting whose old slug is in its history, and one moved to another crawler', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('old-slug'), job('moved')] }),
      baseExpired: map({}),
      headActive: map({ a: [job('new-slug', { previousSlugs: ['old-slug'] })], b: [job('moved')] }),
      headExpired: map({}),
    });
    expect(result.retiredUnarchived).toEqual([]);
  });

  it('flags an archive that shrinks between two revisions (Rittmeyer shape: 12 records -> [])', () => {
    const records = Array.from({ length: 12 }, (_, n) => job(`sales-engineer-${n}`));
    const result = measureRetiredArchiveCoverage({
      baseActive: map({}),
      baseExpired: map({ 'rittmeyer-ag': records }),
      headActive: map({}),
      headExpired: map({ 'rittmeyer-ag': [] }),
    });
    expect(result.archiveLost).toHaveLength(12);
    expect(result.archiveLostByCrawler).toEqual({ 'rittmeyer-ag': 12 });
  });

  it('does not count an archive record whose posting is active again (ghost reconciliation)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({}),
      baseExpired: map({ a: [job('back-again')] }),
      headActive: map({ a: [job('back-again')] }),
      headExpired: map({ a: [] }),
    });
    expect(result.archiveLost).toEqual([]);
  });

  it('skips a posting held out of publication (never had a public URL)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('held', { heldFromPublication: true })] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({}),
    });
    expect(result.retired).toBe(0);
    expect(result.retiredUnarchived).toEqual([]);
  });
});

// ── CLI on a real (temporary) git history ─────────────────────────────────
// The observer reads slices from git revisions. A slice whose root is neither
// an array nor {jobs: [...]} is malformed, and counting it as empty would
// pass exactly the data the observer cannot judge (review 5884475292).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/ci/check-retired-jobs-archived.mjs';
let repo = '';

function copyClosure(rel: string, seen = new Set<string>()) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = path.join(REPO_ROOT, rel);
  const text = fs.readFileSync(src, 'utf8');
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
  for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/g)) {
    copyClosure(path.relative(REPO_ROOT, path.resolve(path.dirname(src), match[1])), seen);
  }
}

function git(...args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitSlices(active: unknown, expired: unknown, message: string) {
  fs.mkdirSync(path.join(repo, 'data/jobs/by-crawler'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data/jobs/expired/by-crawler'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data/jobs/by-crawler/acme.json'), JSON.stringify(active));
  fs.writeFileSync(path.join(repo, 'data/jobs/expired/by-crawler/acme.json'), JSON.stringify(expired));
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}

function observe(base: string, head: string) {
  return spawnSync(process.execPath, [SCRIPT, '--base', base, '--head', head], { cwd: repo, encoding: 'utf8' });
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-observer-'));
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test Runner');
  git('config', 'user.email', 'test@example.invalid');
  copyClosure(SCRIPT);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('check-retired-jobs-archived CLI', () => {
  it('exits 0 when the retired posting is archived with its title', () => {
    const base = commitSlices({ jobs: [job('kept'), job('gone')] }, [], 'base');
    const head = commitSlices({ jobs: [job('kept')] }, [job('gone')], 'archived');
    const result = observe(base, head);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('retired WITHOUT an archive record with title: 0');
  });

  it('exits 1 when a retired posting has no archive record', () => {
    const base = commitSlices({ jobs: [job('kept'), job('gone')] }, [], 'base again');
    const head = commitSlices({ jobs: [job('kept')] }, [], 'dropped');
    const result = observe(base, head);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('retired acme: gone');
  });

  it('reads an archive split into `<key>.shard-NNN.json` as the archive of `<key>`', () => {
    const shard = path.join(repo, 'data/jobs/expired/by-crawler/acme.shard-001.json');
    const base = commitSlices({ jobs: [job('kept'), job('gone')] }, [], 'base sharded');
    fs.writeFileSync(shard, JSON.stringify([job('gone')]));
    const head = commitSlices({ jobs: [job('kept')] }, [], 'archived into a shard');
    const archived = observe(base, head);
    expect(archived.status, archived.stderr).toBe(0);

    fs.rmSync(shard);
    const lost = observe(head, commitSlices({ jobs: [job('kept')] }, [], 'shard lost'));
    expect(lost.status).toBe(1);
    // Labelled with the crawler key, not the shard file name.
    expect(lost.stdout).toContain('lost acme: gone');
  });

  it('fails closed (exit 2, "cannot read") on a slice with an unsupported root', () => {
    const base = commitSlices({ jobs: [job('kept')] }, [], 'valid');
    const head = commitSlices({ unexpected: [] }, [], 'malformed');
    const result = observe(base, head);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot read acme\.json .*unsupported slice root/);
  });
});
