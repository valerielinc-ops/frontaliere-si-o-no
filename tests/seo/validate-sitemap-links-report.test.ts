// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = 'https://frontaliereticino.ch';
const SCRIPT = path.resolve(process.cwd(), 'scripts/validate-sitemap-links.mjs');
const NODE = ['/usr/local/bin/node', '/usr/bin/node', process.execPath]
  .find((candidate) => fs.existsSync(candidate)) ?? process.execPath;

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

    expect(() => execFileSync(NODE, [SCRIPT], {
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

  it('checks only the owned locale and carries the route set through extraction', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-locale-sitemap-'));
    roots.push(root);
    const dist = path.join(root, 'dist');
    fs.mkdirSync(path.join(dist, 'de', 'good'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'de', 'good', 'index.html'), '<!doctype html><title>good</title>');
    fs.writeFileSync(
      path.join(dist, 'sitemap-jobs-test.xml'),
      [
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        '<url><loc>' + BASE_URL + '/de/good/</loc><xhtml:link rel="alternate" hreflang="de" href="' + BASE_URL + '/de/good/"/><xhtml:link rel="alternate" hreflang="en" href="' + BASE_URL + '/en/foreign/"/></url>',
        '<url><loc>' + BASE_URL + '/de/missing/</loc></url>',
        '<url><loc>' + BASE_URL + '/en/foreign/</loc></url>',
        '</urlset>',
      ].join(''),
    );
    const manifest = path.join(root, 'locale-sitemap-manifest.json');

    const {
      collectOwnedLocaleEntries,
      verifyLocaleManifest,
      writeLocaleManifest,
    } = await import(SCRIPT);
    const initial = collectOwnedLocaleEntries('de', dist);
    expect(initial.missing.map((entry: { url: string }) => entry.url)).toEqual([
      BASE_URL + '/de/missing/',
    ]);
    expect(fs.existsSync(manifest)).toBe(false);

    fs.mkdirSync(path.join(dist, 'de', 'missing'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'de', 'missing', 'index.html'), '<!doctype html><title>missing</title>');
    const complete = collectOwnedLocaleEntries('de', dist);
    expect(complete.missing).toEqual([]);
    writeLocaleManifest(manifest, 'de', complete.entries);

    const entries = JSON.parse(fs.readFileSync(manifest, 'utf8')).entries;
    expect(entries.map((entry: { url: string }) => entry.url)).toEqual([
      BASE_URL + '/de/good/',
      BASE_URL + '/de/missing/',
    ]);

    fs.copyFileSync(manifest, path.join(dist, 'locale-sitemap-manifest.json'));
    fs.rmSync(path.join(dist, 'de', 'good', 'index.html'));
    fs.writeFileSync(path.join(dist, 'de', 'good.html'), '<!doctype html><title>good flat</title>');
    expect(verifyLocaleManifest(path.join(dist, 'locale-sitemap-manifest.json'), 'de', dist).errors).toEqual([]);
  });
});
