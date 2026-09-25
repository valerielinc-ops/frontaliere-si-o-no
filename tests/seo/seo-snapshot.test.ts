/**
 * Tests for the F.1 / F.3 / H.10 SEO monitoring scripts.
 *
 * These tests exercise the `.mjs` scripts in --dry-run mode only — they
 * must never hit the network. We spawn each script as a child process,
 * using an isolated working directory, and assert the expected files are
 * created with the expected JSON / Markdown shape.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_DIR = path.join(REPO_ROOT, 'scripts', 'seo');

const SNAPSHOT_SCRIPT = path.join(SCRIPT_DIR, 'semrush-snapshot.mjs');
const SITE_AUDIT_SCRIPT = path.join(SCRIPT_DIR, 'semrush-site-audit.mjs');
const REPORT_SCRIPT = path.join(SCRIPT_DIR, 'generate-weekly-report.mjs');

function runNodeScript(scriptPath: string, args: string[], cwd: string) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      // Ensure we never accidentally hit the network in tests.
      SEMRUSH_API_KEY: '',
      SEMRUSH_PROJECT_ID: '',
    },
    encoding: 'utf-8',
  });
}

function isoDate(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

/**
 * Create a minimal repo-like workspace containing only what the scripts
 * need. The scripts resolve paths relative to __dirname (scripts/seo/),
 * so we copy the scripts into <tmp>/scripts/seo/ and let them write to
 * <tmp>/data/... and <tmp>/docs/... .
 */
function makeWorkspace(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-snap-test-'));
  fs.mkdirSync(path.join(tmp, 'scripts', 'seo'), { recursive: true });
  fs.copyFileSync(SNAPSHOT_SCRIPT, path.join(tmp, 'scripts', 'seo', 'semrush-snapshot.mjs'));
  fs.copyFileSync(SITE_AUDIT_SCRIPT, path.join(tmp, 'scripts', 'seo', 'semrush-site-audit.mjs'));
  fs.copyFileSync(REPORT_SCRIPT, path.join(tmp, 'scripts', 'seo', 'generate-weekly-report.mjs'));
  return tmp;
}

describe('scripts/seo/semrush-snapshot.mjs (F.1)', () => {
  let ws: string;
  beforeAll(() => {
    ws = makeWorkspace();
  });
  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('exits 0 in --dry-run and writes both dated + latest snapshots', () => {
    const result = runNodeScript(path.join(ws, 'scripts', 'seo', 'semrush-snapshot.mjs'), ['--dry-run'], ws);
    expect(result.status).toBe(0);
    const today = isoDate();
    const datedPath = path.join(ws, 'data', 'seo-snapshots', `${today}.json`);
    const latestPath = path.join(ws, 'data', 'seo-snapshots', 'latest.json');
    expect(fs.existsSync(datedPath)).toBe(true);
    expect(fs.existsSync(latestPath)).toBe(true);

    const raw = fs.readFileSync(datedPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.domain).toBe('frontaliereticino.ch');
    expect(parsed.date).toBe(today);
    expect(parsed.reason).toBe('dry-run');
    expect(parsed).toHaveProperty('domainRanks');
    expect(parsed).toHaveProperty('topKeywords');
    expect(parsed).toHaveProperty('competitors');
  });
});

describe('scripts/seo/semrush-site-audit.mjs (H.10)', () => {
  let ws: string;
  beforeAll(() => {
    ws = makeWorkspace();
  });
  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('exits 0 in --dry-run and writes snapshot + diff report', () => {
    const result = runNodeScript(path.join(ws, 'scripts', 'seo', 'semrush-site-audit.mjs'), ['--dry-run'], ws);
    expect(result.status).toBe(0);
    const today = isoDate();
    const snapshotPath = path.join(ws, 'data', 'seo-snapshots', `site-audit-${today}.json`);
    const reportPath = path.join(ws, 'reports', `site-audit-diff-${today}.md`);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);

    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    expect(snap.version).toBe(1);
    expect(snap.date).toBe(today);
    expect(snap).toHaveProperty('qualityScore');
    expect(snap).toHaveProperty('errors');
    expect(Array.isArray(snap.issues)).toBe(true);

    const md = fs.readFileSync(reportPath, 'utf-8');
    expect(md).toContain('# Site Audit Diff');
    expect(md).toContain(today);
  });
});

describe('scripts/seo/generate-weekly-report.mjs (F.3)', () => {
  let ws: string;
  beforeAll(() => {
    ws = makeWorkspace();
  });
  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('emits a "No data" template when no snapshots exist', () => {
    const result = runNodeScript(path.join(ws, 'scripts', 'seo', 'generate-weekly-report.mjs'), [], ws);
    expect(result.status).toBe(0);
    const reportPath = path.join(ws, 'docs', 'seo-reports', `week-${weekKey()}.md`);
    expect(fs.existsSync(reportPath)).toBe(true);
    const md = fs.readFileSync(reportPath, 'utf-8');
    expect(md).toMatch(/No SEMrush snapshots available yet/);
  });

  it('produces a delta report when two snapshots exist', () => {
    const dir = path.join(ws, 'data', 'seo-snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const earlier = {
      version: 1,
      domain: 'frontaliereticino.ch',
      date: '2026-04-07',
      domainRanks: { it: { Rk: 120000, Ot: 5000 }, ch: null },
      topKeywords: {
        it: [
          { Ph: 'frontaliere ticino', Po: '4', Tr: '100' },
          { Ph: 'permesso g', Po: '15', Tr: '50' },
        ],
        ch: [],
      },
      competitors: { it: [], ch: [] },
    };
    const latest = {
      version: 1,
      domain: 'frontaliereticino.ch',
      date: '2026-04-14',
      domainRanks: { it: { Rk: 115000, Ot: 5500 }, ch: null },
      topKeywords: {
        it: [
          { Ph: 'frontaliere ticino', Po: '2', Tr: '150' },
          { Ph: 'calcolo stipendio svizzera', Po: '9', Tr: '80' },
        ],
        ch: [],
      },
      competitors: { it: [], ch: [] },
    };
    fs.writeFileSync(path.join(dir, '2026-04-07.json'), JSON.stringify(earlier));
    fs.writeFileSync(path.join(dir, '2026-04-14.json'), JSON.stringify(latest));

    const result = runNodeScript(path.join(ws, 'scripts', 'seo', 'generate-weekly-report.mjs'), [], ws);
    expect(result.status).toBe(0);
    const reportPath = path.join(ws, 'docs', 'seo-reports', `week-${weekKey()}.md`);
    const md = fs.readFileSync(reportPath, 'utf-8');
    expect(md).toContain('Database: IT');
    expect(md).toContain('Top 3');
    expect(md).toContain('Top 10');
    expect(md).toContain('frontaliere ticino');
    // Gained keyword should appear in "New keywords"
    expect(md).toContain('calcolo stipendio svizzera');
    // Lost keyword should appear in "Lost keywords"
    expect(md).toContain('permesso g');
  });
});

describe('script presence / shape', () => {
  it('all three scripts exist and use ESM exports', () => {
    for (const p of [SNAPSHOT_SCRIPT, SITE_AUDIT_SCRIPT, REPORT_SCRIPT]) {
      expect(fs.existsSync(p)).toBe(true);
      const raw = fs.readFileSync(p, 'utf-8');
      expect(raw).toMatch(/^#!/);
      expect(raw).toContain('export ');
    }
  });

  it('workflow YAML exists and wires all three scripts + rebase-retry loop', () => {
    const wf = path.join(REPO_ROOT, '.github', 'workflows', 'semrush-weekly-snapshot.yml');
    expect(fs.existsSync(wf)).toBe(true);
    const raw = fs.readFileSync(wf, 'utf-8');
    expect(raw).toContain('semrush-snapshot.mjs');
    expect(raw).toContain('semrush-site-audit.mjs');
    expect(raw).toContain('generate-weekly-report.mjs');
    expect(raw).toContain('0 6 * * 1');
    expect(raw).toContain('rebase');
    expect(raw).toContain('SEMRUSH_API_KEY');
  });
});
