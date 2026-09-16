import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IncrementalManifest,
} from '../../build-plugins/shared/incrementalManifest.mjs';
import {
  createJobsSeoHtmlReuse,
  htmlHasIndexableRobots,
  htmlReuseCachePath,
  normalizeHtmlForReuse,
  refreshHtmlBuildId,
} from '../../build-plugins/shared/incrementalHtmlReuse.mjs';

const envBefore = {
  JOBS_SEO_REUSE: process.env.JOBS_SEO_REUSE,
  JOBS_SEO_REUSE_VERIFY: process.env.JOBS_SEO_REUSE_VERIFY,
};

afterEach(() => {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-seo-reuse-test-'));
}

function writePreviousManifest(rootDir: string, pagePath: string, kind: string, input: unknown) {
  const manifest = new IncrementalManifest('it');
  manifest.register(pagePath, kind, input);
  manifest.write(rootDir, path.join(rootDir, '.cache', 'incremental-manifest-prev'));
}

function writeCachedHtml(rootDir: string, pagePath: string, html: string) {
  const file = htmlReuseCachePath(rootDir, 'it', pagePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
}

async function createReuse(rootDir: string, verify = false) {
  process.env.JOBS_SEO_REUSE = '1';
  if (verify) process.env.JOBS_SEO_REUSE_VERIFY = '1';
  else delete process.env.JOBS_SEO_REUSE_VERIFY;
  return (await createJobsSeoHtmlReuse(rootDir, ['it']))!;
}

describe('jobs SEO disk HTML reuse', () => {
  it('is disabled unless JOBS_SEO_REUSE=1', async () => {
    const rootDir = fixtureRoot();
    try {
      delete process.env.JOBS_SEO_REUSE;
      expect(await createJobsSeoHtmlReuse(rootDir, ['it'])).toBeNull();
      expect(fs.existsSync(path.join(rootDir, '.cache'))).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('reuses a previous page when kind, input hash, and HTML all match', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/fixture/';
    const input = { jobId: 'job-1', locale: 'it', slug: 'fixture' };
    const html = '<html><head><meta name="robots" content="index,follow"></head><body>fixture</body></html>';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', input);
      writeCachedHtml(rootDir, pagePath, html);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', input, 'active');
      expect(candidate).toMatchObject({ hit: true, html });
      expect(refreshHtmlBuildId('<meta name="ft-build-id" content="old">', '123')).toContain('content="123"');
      reuse.finish(candidate, html);
      expect(reuse.summary().active).toMatchObject({ rendered: 0, reused: 1, mismatches: 0 });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('renders on an input-hash miss and records the reason', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/fixture/';
    try {
      writePreviousManifest(rootDir, pagePath, 'active-job', { value: 'old' });
      writeCachedHtml(rootDir, pagePath, '<html>old</html>');
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'active-job', { value: 'new' }, 'active');
      expect(candidate).toMatchObject({ hit: false, html: null });
      reuse.finish(candidate, '<html>new</html>');
      expect(reuse.summary().active).toMatchObject({
        rendered: 1,
        reused: 0,
        missReasons: { 'input-hash-changed': 1 },
      });
      expect(fs.readFileSync(htmlReuseCachePath(rootDir, 'it', pagePath), 'utf8')).toBe('<html>new</html>');
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('renders on a matching hash when the previous HTML is unavailable', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/missing-html/';
    const input = { value: 'same' };
    try {
      writePreviousManifest(rootDir, pagePath, 'expired-soft-landing', input);
      const reuse = await createReuse(rootDir);
      const candidate = reuse.lookup('it', pagePath, 'expired-soft-landing', input, 'expired-soft-landing');
      expect(candidate).toMatchObject({ hit: false, html: null });
      reuse.finish(candidate, '<html>fresh</html>');
      expect(reuse.summary()['expired-soft-landing']).toMatchObject({
        rendered: 1,
        reused: 0,
        missReasons: { 'html-unavailable': 1 },
      });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('verify mode renders a hit and reports normalized-output mismatches', async () => {
    const rootDir = fixtureRoot();
    const pagePath = '/cerca-lavoro-ticino/verify/';
    const input = { value: 'same' };
    const previousHtml = '<meta name="ft-build-id" content="old"><lastmod>2026-09-16</lastmod><p>old content</p>';
    const currentHtml = '<meta name="ft-build-id" content="new"><lastmod>2026-09-17</lastmod><p>new content</p>';
    try {
      writePreviousManifest(rootDir, pagePath, 'cross-locale-reconciliation', input);
      writeCachedHtml(rootDir, pagePath, previousHtml);
      const reuse = await createReuse(rootDir, true);
      const candidate = reuse.lookup('it', pagePath, 'cross-locale-reconciliation', input, 'cross-locale-reconciliation');
      expect(candidate.hit).toBe(true);
      reuse.finish(candidate, currentHtml);
      expect(reuse.summary()['cross-locale-reconciliation']).toMatchObject({
        rendered: 1,
        reused: 0,
        mismatches: 1,
      });
      expect(normalizeHtmlForReuse(previousHtml)).not.toBe(normalizeHtmlForReuse(currentHtml));
      expect(htmlHasIndexableRobots('<meta name="robots" content="index,follow">')).toBe(true);
      expect(htmlHasIndexableRobots('<meta name="robots" content="noindex,follow">')).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
