/**
 * CLI di sola lettura della diagnosi PROMOTE (#9680).
 *
 * Il valore dello script e' che la sua misura non possa mentire: su un file
 * candidati assente deve fallire (exit 2), non stampare "0 bloccati" come se
 * fosse un'osservazione — in un worktree sparse `data/` spesso non c'e'.
 * I fixture vivono in `os.tmpdir()`: il test non legge ne' scrive dati tracciati.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'prospect-promote-diagnosis.mjs');

const good = (day: number, over: Record<string, unknown> = {}) => ({
  at: `2026-08-${String(10 + day).padStart(2, '0')}T03:00:00Z`,
  verdict: 'good',
  score: 0.97,
  sampled: 4,
  reachableRate: 1,
  titleMatchRate: 1,
  contentfulRate: 1,
  locationSourceRate: 1,
  distinctRate: 1,
  jobLikeRate: 1,
  logoFound: true,
  vacancyCount: 6,
  ...over,
});

const candidate = (key: string, history: Record<string, unknown>[], status = 'promoted') => ({
  key, status, crawlerKey: key, vacancyCount: 6, validationHistory: history,
});

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fixture(candidates: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'promote-diagnosis-'));
  const file = path.join(dir, 'candidates.json');
  writeFileSync(file, JSON.stringify({ version: 1, candidates }));
  return { dir, file };
}

describe('prospect-promote-diagnosis', () => {
  it('riproduce partizione e tally per predicato con le soglie di produzione', () => {
    const { dir, file } = fixture({
      ready: candidate('ready', [good(0), good(1)]),
      waiting: candidate('waiting', [good(0)]),
      noLocation: candidate('no-location', [good(0), good(1, { locationSourceRate: 0.2 })]),
      lowScore: candidate('low-score', [good(0), good(1, { score: 0.4, locationSourceRate: 0.1 })]),
      discovered: candidate('discovered', [good(0)], 'discovered'),
    });
    const r = run([`--candidates=${file}`, `--root=${dir}`]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.gate).toEqual({ minRuns: 2, minDistinctDays: 2 });
    expect(out.promoted).toBe(4);
    expect(out.promotable).toBe(1);
    expect(out.blocked).toBe(3);
    expect(out.stabilityOnly).toBe(1);
    expect(out.other).toBe(2);
    expect(out.stabilityOnlyKeys).toEqual(['waiting']);
    expect(out.failedChecks).toEqual({ sourceBackedLocation: 2, score: 1 });
    expect(out.unattributed).toEqual([]);
  });

  it('fallisce con exit 2 se il file dei candidati manca, invece di contare zero', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'promote-diagnosis-'));
    const r = run([`--candidates=${path.join(dir, 'assente.json')}`, `--root=${dir}`]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/candidati illeggibili/);
  });

  it('fallisce con exit 2 su un file senza il campo candidates', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'promote-diagnosis-'));
    const file = path.join(dir, 'candidates.json');
    writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(run([`--candidates=${file}`, `--root=${dir}`]).status).toBe(2);
  });
});
