// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = 'https://frontaliereticino.ch';
const SCRIPT = path.resolve(process.cwd(), 'scripts/validate-sitemap-links.mjs');

describe('validate:sitemap-links report scale', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('records a full walk even when the audit pool exports a sample rate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-sitemap-links-'));
    roots.push(root);
    const dist = path.join(root, 'dist');
    const reports = path.join(root, 'reports');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, 'sitemap-jobs-test.xml'),
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${BASE_URL}/missing-job/</loc></url></urlset>\n`,
    );

    expect(() => execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      env: {
        ...process.env,
        AUDIT_SAMPLE_RATE: '0.25',
        AUDIT_REPORTS_DIR: reports,
      },
      stdio: 'pipe',
    })).toThrow();

    const report = JSON.parse(fs.readFileSync(path.join(reports, 'validate-sitemap-links.json'), 'utf8'));
    expect(report.sampleRate).toBe(1);
    expect(report.offendersTotal).toBe(1);
    expect(report.offendersTotalExtrapolated).toBe(1);
  });
});
