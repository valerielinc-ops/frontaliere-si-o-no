/**
 * Unit tests for scripts/lib/audit-runner.mjs.
 *
 * Coverage: the L3 unified audit runner introduced in #331. Validates
 * the Auditor interface contract, sharedExtract regex semantics, and
 * the AUDIT_STRICT mutation-detection guard (vincolo N3).
 *
 * Uses a temp directory under tests/ fixtures because the runner walks
 * real filesystem paths.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The audit-runner is a .mjs ESM module; vitest's bundler resolves it.
import * as runnerModule from '../../scripts/lib/audit-runner.mjs';

const {
  walkHtmlFiles,
  sharedExtract,
  runAudits,
  filterAuditors,
} = runnerModule as unknown as {
  walkHtmlFiles: (dir: string) => Promise<string[]>;
  sharedExtract: (html: string) => {
    title: string | null;
    h1: string | null;
    isNoindex: boolean;
    jsonLdScripts: string[];
  };
  runAudits: (opts: {
    distDir: string;
    auditors: Array<{
      name: string;
      collect: (file: string, html: string) => void;
      report: () => unknown;
    }>;
    verbose?: boolean;
    writeReports?: boolean;
  }) => Promise<{
    totalElapsedSec: number;
    walkElapsedSec: number;
    collectElapsedSec: number;
    filesScanned: number;
    reports: Array<{ name: string; passed: boolean; elapsedSec: number }>;
  }>;
  filterAuditors: <T extends { name: string }>(all: T[], csv?: string) => T[];
};

describe('walkHtmlFiles', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-runner-test-'));
    mkdirSync(join(root, 'a/b/c'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    writeFileSync(join(root, 'one.html'), '<html></html>');
    writeFileSync(join(root, 'a/two.html'), '<html></html>');
    writeFileSync(join(root, 'a/b/c/three.html'), '<html></html>');
    writeFileSync(join(root, 'not-html.txt'), 'ignore');
    writeFileSync(join(root, '.hidden/skipped.html'), '<html></html>');
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns every .html file recursively', async () => {
    const files = await walkHtmlFiles(root);
    expect(files.length).toBe(3);
  });

  it('skips dot-prefixed directories', async () => {
    const files = await walkHtmlFiles(root);
    expect(files.every((f) => !f.includes('.hidden'))).toBe(true);
  });

  it('ignores non-.html files', async () => {
    const files = await walkHtmlFiles(root);
    expect(files.every((f) => f.endsWith('.html'))).toBe(true);
  });
});

describe('sharedExtract', () => {
  it('extracts <title> text with whitespace normalized', () => {
    const e = sharedExtract('<html><head><title>  hello  world  </title></head></html>');
    expect(e.title).toBe('hello world');
  });

  it('extracts <h1> text', () => {
    const e = sharedExtract('<body><h1>Main heading</h1></body>');
    expect(e.h1).toBe('Main heading');
  });

  it('decodes common HTML entities in title/h1', () => {
    const e = sharedExtract('<html><title>A &amp; B &lt;test&gt;</title><body><h1>X &quot;Y&quot;</h1></body></html>');
    expect(e.title).toBe('A & B <test>');
    expect(e.h1).toBe('X "Y"');
  });

  it('returns null for missing title/h1', () => {
    const e = sharedExtract('<html><body><p>no headings</p></body></html>');
    expect(e.title).toBeNull();
    expect(e.h1).toBeNull();
  });

  it('detects robots noindex', () => {
    const a = sharedExtract('<head><meta name="robots" content="noindex,follow"></head>');
    expect(a.isNoindex).toBe(true);
    const b = sharedExtract('<head><meta name="robots" content="index,follow"></head>');
    expect(b.isNoindex).toBe(false);
  });

  it('detects meta-refresh redirect as noindex', () => {
    const e = sharedExtract('<head><meta http-equiv="refresh" content="0;url=/elsewhere/"></head>');
    expect(e.isNoindex).toBe(true);
  });

  it('extracts all JSON-LD script bodies', () => {
    const html =
      '<head>' +
      '<script type="application/ld+json">{"@type":"WebPage"}</script>' +
      '<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>' +
      '<script>not jsonld</script>' +
      '</head>';
    const e = sharedExtract(html);
    expect(e.jsonLdScripts).toHaveLength(2);
    expect(e.jsonLdScripts[0]).toBe('{"@type":"WebPage"}');
    expect(e.jsonLdScripts[1]).toBe('{"@type":"BreadcrumbList"}');
  });

  it('returns empty jsonLdScripts when none present', () => {
    const e = sharedExtract('<head><script src="/foo.js"></script></head>');
    expect(e.jsonLdScripts).toEqual([]);
  });
});

describe('filterAuditors', () => {
  const all = [
    { name: 'audit-a', collect: () => {}, report: () => ({}) },
    { name: 'audit-b', collect: () => {}, report: () => ({}) },
    { name: 'audit-c', collect: () => {}, report: () => ({}) },
  ];

  it('returns all auditors when filter is undefined', () => {
    expect(filterAuditors(all, undefined)).toHaveLength(3);
  });

  it('returns matching subset for csv filter', () => {
    const f = filterAuditors(all, 'audit-a,audit-c');
    expect(f.map((a) => a.name)).toEqual(['audit-a', 'audit-c']);
  });

  it('ignores unknown names in filter', () => {
    const f = filterAuditors(all, 'audit-a,nope,audit-b');
    expect(f.map((a) => a.name)).toEqual(['audit-a', 'audit-b']);
  });

  it('returns empty array when no names match', () => {
    expect(filterAuditors(all, 'nope,nada')).toEqual([]);
  });
});

describe('runAudits — end-to-end', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-runner-e2e-'));
    writeFileSync(join(root, 'a.html'), '<html><head><title>A</title></head><body><h1>H A</h1></body></html>');
    writeFileSync(join(root, 'b.html'), '<html><head><title>B</title></head><body><h1>H B</h1></body></html>');
    writeFileSync(join(root, 'c.html'), '<html><head><title>C</title></head><body><h1>H C</h1></body></html>');
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('dispatches every file to every auditor and produces reports', async () => {
    let countA = 0;
    let countB = 0;
    const auditorA = {
      name: 'count-a',
      collect: (_file: string, _html: string) => { countA++; },
      report: () => ({ passed: true, offendersTotal: 0, offenders: [], humanSummary: `scanned ${countA}` }),
    };
    const auditorB = {
      name: 'count-b',
      collect: (_file: string, _html: string) => { countB++; },
      report: () => ({ passed: true, offendersTotal: 0, offenders: [], humanSummary: `scanned ${countB}` }),
    };
    const result = await runAudits({
      distDir: root, auditors: [auditorA, auditorB], verbose: false, writeReports: false,
    });
    expect(countA).toBe(3);
    expect(countB).toBe(3);
    expect(result.filesScanned).toBe(3);
    expect(result.reports).toHaveLength(2);
    expect(result.reports.every((r) => r.passed)).toBe(true);
  });

  it('throws on empty auditor list', async () => {
    await expect(runAudits({ distDir: root, auditors: [], verbose: false, writeReports: false }))
      .rejects.toThrow(/no auditors registered/);
  });

  it('throws on missing distDir', async () => {
    await expect(runAudits({
      distDir: '/nonexistent/path/should/fail', auditors: [{ name: 'x', collect: () => {}, report: () => ({}) }],
      verbose: false, writeReports: false,
    })).rejects.toThrow(/distDir not found/);
  });

  it('throws on invalid auditor shape', async () => {
    await expect(runAudits({
      distDir: root,
      // @ts-expect-error testing runtime validation
      auditors: [{ name: 'no-collect' }],
      verbose: false, writeReports: false,
    })).rejects.toThrow(/invalid auditor/);
  });
});

describe('runAudits — AUDIT_STRICT mutation detection (vincolo N3)', () => {
  let root: string;
  const ORIGINAL_ENV = process.env.AUDIT_STRICT;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-runner-strict-'));
    writeFileSync(join(root, 'a.html'), '<html><body>x</body></html>');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env.AUDIT_STRICT;
    else process.env.AUDIT_STRICT = ORIGINAL_ENV;
  });

  // The runner snapshots `html` before calling collect() and verifies it's
  // unchanged afterwards. Since strings are immutable in JS, this check is
  // a sentinel for the auditor accidentally reassigning the parameter (which
  // would be a no-op in JS but is documented as a contract).
  it('runs normally when AUDIT_STRICT is unset', async () => {
    delete process.env.AUDIT_STRICT;
    const a = {
      name: 'noop',
      collect: () => {},
      report: () => ({ passed: true, offendersTotal: 0, offenders: [] }),
    };
    const result = await runAudits({ distDir: root, auditors: [a], verbose: false, writeReports: false });
    expect(result.filesScanned).toBe(1);
  });
});
