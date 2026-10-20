import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMopupSlice } from '../scripts/local-mt-mopup.mjs';
import { _resetDenylistCache } from '../scripts/lib/slug-preservation-guard.mjs';

describe('local-mt-mopup slice persistence', () => {
  it('uses the shared writer boundary to preserve slugs while updating translations', () => {
    const root = mkdtempSync(join(tmpdir(), 'mopup-slice-write-'));
    try {
      const sliceDir = join(root, 'data/jobs/by-crawler');
      const slicePath = join(sliceDir, 'acme.json');
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(root, 'data/prev-slug-restore-denylist.json'), '{"entries":[]}\n');
      _resetDenylistCache();
      writeFileSync(slicePath, `${JSON.stringify({
        crawlerKey: 'acme',
        jobs: [{
          id: 'acme-123',
          url: 'https://example.ch/jobs/123456',
          slug: 'old-italian-route',
          slugByLocale: { it: 'old-italian-route', en: 'old-english-route' },
          previousSlugs: [],
          previousSlugsByLocale: {},
        }],
      }, null, 2)}\n`);

      writeMopupSlice(slicePath, {
        crawlerKey: 'acme',
        jobs: [{
          id: 'acme-123',
          url: 'https://example.ch/jobs/123456',
          slug: 'new-italian-route',
          slugByLocale: { it: 'new-italian-route' },
          titleByLocale: { it: 'Nuovo titolo' },
          previousSlugs: [],
          previousSlugsByLocale: {},
        }],
      });

      const written = JSON.parse(readFileSync(slicePath, 'utf8'));
      expect(written.jobs[0].titleByLocale.it).toBe('Nuovo titolo');
      expect(written.jobs[0].previousSlugs).toContain('old-italian-route');
      expect(written.jobs[0].previousSlugsByLocale.it).toContain('old-italian-route');
      expect(written.jobs[0].previousSlugsByLocale.en).toContain('old-english-route');
    } finally {
      _resetDenylistCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
