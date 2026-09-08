import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SOFT404_SCRIPT = join(REPO_ROOT, 'scripts', 'validate-soft404.mjs');
const CONSOLIDATED_SCRIPT = join(REPO_ROOT, 'scripts', 'validate-sitemap-pages.mjs');
const tempRoots: string[] = [];

const urlset = (loc: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  `<url><loc>${loc}</loc></url></urlset>\n`;

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'soft404-validation-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'dist'), { recursive: true });
  return root;
}

function run(root: string, script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function healthyHtml(): string {
  return `<html><head><meta name="robots" content="index, follow"></head><body>` +
    `<p>${'contenuto editoriale verificato '.repeat(40)}</p></body></html>`;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('soft-404 page retirement validation', () => {
  it('does not fail when every sitemap URL is served by an external shard', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'dist', 'sitemap-eventi.xml'),
      urlset('https://frontaliereticino.ch/articoli-frontaliere/guida-frontaliere/'),
    );

    const result = run(root, SOFT404_SCRIPT);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain('served from an external shard');
  });

  it('resolves a flat HTML page when the directory index is absent', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'dist', 'sitemap-eventi.xml'),
      urlset('https://frontaliereticino.ch/eventi/flat-only/'),
    );
    mkdirSync(join(root, 'dist', 'eventi'), { recursive: true });
    writeFileSync(join(root, 'dist', 'eventi', 'flat-only.html'), healthyHtml());

    const result = run(root, SOFT404_SCRIPT);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 1 pages');
  });

  it('does not print a green verdict after warn-only population failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'soft404-validation-empty-'));
    tempRoots.push(root);

    const result = run(root, SOFT404_SCRIPT, ['--warn-only']);
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(0);
    expect(output).toContain('Empty soft-404 population');
    expect(output).toContain('validation incomplete');
    expect(output).not.toMatch(/✅ (?:No blocking errors|No soft-404 indicators found)/);
  });
});

describe('consolidated soft-404 sub-check', () => {
  it('guards the external-page exclusion at the actual runValidateSoft404 boundary', () => {
    const source = readFileSync(CONSOLIDATED_SCRIPT, 'utf8');
    const start = source.indexOf('function runValidateSoft404()');
    const end = source.indexOf('// ── 4) validate-content-quality', start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('isExternallyServedUrl(url)');
    expect(body).toContain('eligiblePages');
  });
});
