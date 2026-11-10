import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFFLOAD = path.join(ROOT, 'scripts/offload-generated-images-cdn.mjs');

describe('deferred job OG image offload', () => {
  it('rewrites deferred job metadata to the archive card that is in the publish stage', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'job-og-fallback-offload-'));
    try {
      const stageDir = path.join(workspace, 'staged');
      const distDir = path.join(stageDir, 'dist');
      const archivePath = path.join(distDir, 'og/jobs/archive-landing-card.webp');
      const pagePath = path.join(distDir, 'jobs/deferred-job.html');
      const deferredMetadataPath = path.join(workspace, '.cache/og-jobs/.deferred-fallbacks.json');
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.mkdirSync(path.dirname(pagePath), { recursive: true });
      fs.mkdirSync(path.dirname(deferredMetadataPath), { recursive: true });
      fs.writeFileSync(archivePath, await sharp({
        create: { width: 1, height: 1, channels: 3, background: '#0F2557' },
      }).webp().toBuffer());
      fs.writeFileSync(pagePath,
        '<html><head><meta charset="utf-8"><meta property="og:image" content="https://frontaliereticino.ch/og/jobs/deferred-job.webp?v=v11-test"></head><body></body></html>');
      fs.writeFileSync(deferredMetadataPath, JSON.stringify(['deferred-job']));
      expect(fs.statSync(archivePath).size).toBeGreaterThan(0);

      execFileSync(process.execPath, [OFFLOAD], {
        cwd: stageDir,
        env: {
          ...process.env,
          CDN_BASE: 'https://cdn.example.test',
          OFFLOAD_CDN_WORKERS: '2',
          JOB_OG_DEFERRED_FALLBACKS_FILE: deferredMetadataPath,
        },
        stdio: 'pipe',
      });

      const html = fs.readFileSync(pagePath, 'utf8');
      expect(html).toContain('https://cdn.example.test/og/jobs/archive-landing-card.webp?v=v11-test');
      expect(html).not.toContain('https://cdn.example.test/og/jobs/deferred-job.webp');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
