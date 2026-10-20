import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORPHAN_PAGES_AUDIT_REPORT,
  orphanPagesAuditReportPath,
} from '../../scripts/lib/orphan-pages-report-path.mjs';

const ROOT = path.join(os.tmpdir(), 'fake-repo-root');

describe('orphanPagesAuditReportPath', () => {
  it('defaults to the tracked report under the repo root', () => {
    expect(orphanPagesAuditReportPath(ROOT, {})).toBe(path.join(ROOT, DEFAULT_ORPHAN_PAGES_AUDIT_REPORT));
  });

  it('keeps an absolute override as is', () => {
    const abs = path.join(os.tmpdir(), 'elsewhere', 'report.json');
    expect(orphanPagesAuditReportPath(ROOT, { ORPHAN_PAGES_AUDIT_REPORT: abs })).toBe(abs);
  });

  it('resolves a relative override against the repo root, not the current directory', () => {
    // Writer and reader used to disagree here: the writer joined the value to the
    // repo root, the reader resolved it against process.cwd().
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'some-other-cwd'));
    try {
      expect(orphanPagesAuditReportPath(ROOT, { ORPHAN_PAGES_AUDIT_REPORT: 'tmp/report.json' }))
        .toBe(path.join(ROOT, 'tmp', 'report.json'));
    } finally {
      spy.mockRestore();
    }
  });

  it('is the resolution both the audit writer and the gate reader use', async () => {
    const { readFileSync } = await import('node:fs');
    const writer = readFileSync(path.join(__dirname, '../../scripts/audit-orphan-pages-in-sitemaps.mjs'), 'utf8');
    const reader = readFileSync(path.join(__dirname, '../../scripts/cathedral-seo-gates-check.mjs'), 'utf8');
    expect(writer).toContain('orphanPagesAuditReportPath(ROOT)');
    expect(reader).toContain('orphanPagesAuditReportPath(PROJECT_ROOT)');
    expect(reader).not.toMatch(/path\.resolve\(process\.env\.ORPHAN_PAGES_AUDIT_REPORT\)/);
  });
});
