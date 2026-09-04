// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(
  path.resolve(process.cwd(), '.github/workflows/audit-parser-quality.yml'),
  'utf8',
);

describe('Audit Parser Quality workflow observability', () => {
  it('installs declared dependencies before the strict audit imports them', () => {
    expect(workflow).toMatch(/name: Setup Node[\s\S]*?name: Install audit dependencies[\s\S]*?run: npm ci[\s\S]*?name: Run parser quality audit \(strict\)/);
  });

  it('reserves enough job time for the complete source-detail pass', () => {
    expect(workflow).toMatch(/jobs:\n  audit:[\s\S]*?timeout-minutes: (?:[6-9]\d|[1-9]\d{2,})/);
  });

  it('uploads the complete JSON report even when the strict audit fails', () => {
    expect(workflow).toContain('uses: actions/upload-artifact@v7');
    expect(workflow).toMatch(/name: Run parser quality audit \(strict\)[\s\S]*?rm -f data\/parser-quality-report\.json[\s\S]*?node scripts\/audit-parser-quality\.mjs --strict --check-source-details/);
    expect(workflow).toMatch(/name: Upload parser quality report[\s\S]*?if: always\(\) && steps\.parser-audit\.outcome != 'skipped'/);
    expect(workflow).toMatch(/path: data\/parser-quality-report\.json/);
    expect(workflow).toMatch(/if-no-files-found: error/);
  });

  it('reports a timeout cancellation instead of silently skipping the failure reporter', () => {
    expect(workflow).toMatch(/name: Report failure to GitHub Issues[\s\S]*?if: failure\(\) \|\| cancelled\(\)/);
  });
});
