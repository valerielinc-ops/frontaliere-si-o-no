/**
 * The rotating sample is now applied INSIDE the dist walk instead of after it
 * (scripts/lib/audit-runner.mjs). This file exists to pin the one property
 * that makes that a memory fix and not a coverage change: the set of files a
 * sampled run scans must be EXACTLY the set the post-hoc `sampleFiles()`
 * would have produced, for every rate and every salt.
 *
 * Why it changed — post-deploy run 32261742920: the walk found 3'904'613 HTML
 * files, a rate=0.25 run wanted 976'903 of them, and the other ~2.93M path
 * strings were built and immediately dropped inside the same 4 GB heap that
 * then died with `FATAL ERROR: Ineffective mark-compacts near heap limit` at
 * 45 % of collect. `audit:all` reached the failure classifier as an opaque,
 * unclassified name and — by design, fail-closed — sequestered `publish`.
 *
 * The walk still VISITS every file, so the reported on-disk total stays true;
 * it just stops retaining what the sample rejects.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAudits, walkHtmlFiles, sampleFiles } from '../../scripts/lib/audit-runner.mjs';

function makeDist(sections = 8, pagesPerSection = 9): { root: string; total: number } {
  const root = mkdtempSync(join(tmpdir(), 'audit-runner-inwalk-'));
  let total = 0;
  for (let a = 0; a < sections; a++) {
    for (let b = 0; b < pagesPerSection; b++) {
      const d = join(root, `sezione-${a}`, `una-pagina-con-slug-lungo-${b}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'index.html'), `<html><head></head><body>${a}-${b}</body></html>`);
      total++;
    }
    // A flat `<x>.html` sibling too — the walk must keep treating both shapes alike.
    writeFileSync(join(root, `sezione-${a}`, 'flat.html'), '<html></html>');
    total++;
  }
  return { root, total };
}

/** Records exactly which files the runner handed to collect(). */
function recordingAuditor() {
  const seen: string[] = [];
  return {
    seen,
    auditor: {
      name: 'recorder',
      collect(file: string) {
        seen.push(file);
      },
      report() {
        return { passed: true, offendersTotal: 0, offenders: [] };
      },
    },
  };
}

describe('audit-runner — in-walk sampling equals post-hoc sampling', () => {
  const { root, total } = makeDist();

  for (const [rate, salt] of [
    [0.25, 0],
    [0.25, 1],
    [0.25, 2],
    [0.25, 3],
    [0.25, 9],
    [0.5, 5],
    [0.5, 6],
  ] as const) {
    it(`scans the identical file set at rate=${rate} salt=${salt}`, async () => {
      const expected = sampleFiles(await walkHtmlFiles(root), root, rate, salt).sampled;

      const { seen, auditor } = recordingAuditor();
      const res = await runAudits({
        distDir: root,
        auditors: [auditor as never],
        verbose: false,
        writeReports: false,
        sampleRate: rate,
        sampleSalt: salt,
      });

      expect([...seen].sort()).toEqual([...expected].sort());
      expect(res.filesScanned).toBe(expected.length);
      // The rejected files are never RETAINED, but they are still VISITED:
      // the on-disk total the report quotes must stay the true one.
      expect(res.sampling?.filesOnDisk).toBe(total);
    });
  }

  it('scans everything, and reports no sampling, at rate=1', async () => {
    const { seen, auditor } = recordingAuditor();
    const res = await runAudits({
      distDir: root,
      auditors: [auditor as never],
      verbose: false,
      writeReports: false,
      sampleRate: 1,
      sampleSalt: 3,
    });
    expect(seen.length).toBe(total);
    expect(res.sampling).toBeNull();
  });

  it('leaves the bare walkHtmlFiles(dir) contract untouched for its 27 other callers', async () => {
    const files = await walkHtmlFiles(root);
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBe(total);
    expect(files.every((f) => f.endsWith('.html'))).toBe(true);
  });
});
