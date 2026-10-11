// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/recover-conflict-marker-slices.mjs');

describe('conflict-marker recovery slug preservation (#12498)', () => {
  it('banks previousSlugs from both conflict sides before rewriting an active slice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recover-slice-slugs-'));
    try {
      const sliceDir = join(dir, 'data/jobs/by-crawler');
      const slicePath = join(sliceDir, 'acme.json');
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(slicePath, `{
  "crawlerKey": "acme",
  "assembledAt": "2026-10-10T00:00:00.000Z",
  "jobs": [{
    "id": "acme-123",
    "url": "https://example.ch/jobs/123456",
    "slug": "current-route",
    "slugByLocale": { "it": "current-route" },
${'<'.repeat(7)} HEAD
    "previousSlugs": ["old-route"],
    "previousSlugsByLocale": { "it": ["old-route"] },
${'='.repeat(7)}
    "previousSlugs": ["new-route"],
    "previousSlugsByLocale": { "it": ["new-route"] },
${'>'.repeat(7)} stale-writer
    "lastUpdatedAt": "2026-10-10T00:00:00.000Z"
  }]
}\n`.replace(/\n/gu, '\r\n'));

      execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });

      const recovered = JSON.parse(readFileSync(slicePath, 'utf8'));
      expect(recovered.jobs[0].previousSlugs).toContain('old-route');
      expect(recovered.jobs[0].previousSlugsByLocale.it).toContain('old-route');
      expect(recovered.jobs[0].previousSlugs).toContain('new-route');
      expect(recovered.jobs[0].previousSlugsByLocale.it).toContain('new-route');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
