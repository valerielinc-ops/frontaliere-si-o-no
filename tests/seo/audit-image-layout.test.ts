import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAuditor, findImageLayoutIssues } from '../../scripts/audit-image-layout.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

describe('audit:image-layout', () => {
  it('reports every missing CLS-relevant image attribute', () => {
    const issues = findImageLayoutIssues('<img src="/hero.webp" alt="hero">');
    expect(issues).toEqual([{
      tag: '<img src="/hero.webp" alt="hero">',
      missing: ['width', 'height', 'loading|fetchpriority=high'],
    }]);
  });

  it('accepts dimensions plus either loading or high fetch priority', () => {
    expect(findImageLayoutIssues('<img src="/a.webp" width="10" height="20" loading="lazy">')).toEqual([]);
    expect(findImageLayoutIssues('<img src="/b.webp" width=10 height=20 fetchpriority="high">')).toEqual([]);
  });

  it('fails the standalone replay with a missing-attribute diagnostic', () => {
    const tempRoot = mkdtempSync(join('/tmp', 'frontaliere-image-layout-'));
    const dist = join(tempRoot, 'dist');
    const reports = join(tempRoot, 'reports');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html><body><img src="/bad.webp"></body></html>');

    const run = spawnSync(
      process.execPath,
      ['scripts/audit-image-layout.mjs', `--dist=${dist}`],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AUDIT_REPORTS_DIR: reports } },
    );

    try {
      expect(run.status).toBe(1);
      expect(`${run.stdout}\n${run.stderr}`).toContain('missing=[width,height,loading|fetchpriority=high]');
      expect(`${run.stdout}\n${run.stderr}`).toContain('dist/index.html');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('is represented in the unified auditor contract', () => {
    const audit = createAuditor();
    audit.collect(join(ROOT, 'dist', 'index.html'), '<img src="/bad.webp">');
    const result = audit.report();
    expect(result.passed).toBe(false);
    expect(result.offenders[0].feature).toBe('image-layout');
    expect(result.offenders[0].issues[0].missing).toEqual(['width', 'height', 'loading|fetchpriority=high']);
  });
});
