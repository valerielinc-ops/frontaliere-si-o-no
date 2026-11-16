import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/audit-img-attributes.mjs');
let tempRoot: string | undefined;

function runAudit(html: string, args: string[] = []) {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'img-attrs-'));
  const dist = path.join(tempRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, 'page.html'), html);

  return spawnSync(process.execPath, [SCRIPT, '--dist', dist, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, AUDIT_REPORTS_DIR: path.join(tempRoot, 'reports') },
  });
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe('img attribute audit', () => {
  it('reports missing width, height, and loading-or-high-priority attributes', () => {
    const result = runAudit('<img src="x">');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing=[width,height,loading|fetchpriority]');
  });

  it('accepts dimensions with lazy loading or high fetch priority', () => {
    const result = runAudit(
      '<img src="x" width="10" height="10" loading="lazy">' +
      '<img src="y" width="10" height="10" fetchpriority="high">',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK:');
  });

  it('applies the original checks to data URI images and images inside noscript', () => {
    const result = runAudit(
      '<img src="data:image/png;base64,AA=="><noscript><img src="x"></noscript>',
      ['--json'],
    );

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.offenders[0].imgIssues).toHaveLength(2);
    expect(report.offenders[0].imgIssues.map((issue: { missing: string[] }) => issue.missing)).toEqual([
      ['width', 'height', 'loading|fetchpriority'],
      ['width', 'height', 'loading|fetchpriority'],
    ]);
  });

  it('accepts a large HTML document when its image markup is valid', () => {
    const result = runAudit(`${'x'.repeat(400_000)}<img src="x" width="10" height="10" loading="lazy">`);

    expect(result.status).toBe(0);
  });

  it('contains no file-size or byte-threshold logic', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/BYTES|budget|weight|KB/i);
  });
});
