import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildJunkRetirementHtml, junkRetirementWrites } from '../../build-plugins/relatedSearchClustersPlugin';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SOFT404_SCRIPT = join(REPO_ROOT, 'scripts', 'validate-soft404.mjs');
const CONSOLIDATED_SCRIPT = join(REPO_ROOT, 'scripts', 'validate-sitemap-pages.mjs');
const tempRoots: string[] = [];

const urlset = (loc: string | string[]) => {
  const locs = Array.isArray(loc) ? loc : [loc];
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    locs.map((entry) => `<url><loc>${entry}</loc></url>`).join('') +
    '</urlset>\n';
};

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
  it('skips external shard hosts when a local sitemap URL is also present', () => {
    const root = fixture();
    const localUrl = 'https://frontaliereticino.ch/eventi/local/';
    writeFileSync(
      join(root, 'dist', 'sitemap-eventi.xml'),
      urlset([
        'https://frontaliereticino.ch/articoli-frontaliere/guida-frontaliere/',
        'https://www.frontaliereticino.ch/articoli-frontaliere/guida-frontaliere/',
        'https://origin-articoli-it.frontaliereticino.ch/articoli-frontaliere/guida-frontaliere/',
        localUrl,
      ]),
    );
    mkdirSync(join(root, 'dist', 'eventi', 'local'), { recursive: true });
    writeFileSync(join(root, 'dist', 'eventi', 'local', 'index.html'), healthyHtml());

    const result = run(root, SOFT404_SCRIPT);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain('3 sitemap URL(s) skipped');
  });

  it('fails when every discovered sitemap URL is served by an external shard', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'dist', 'sitemap-eventi.xml'),
      urlset('https://frontaliereticino.ch/articoli-frontaliere/guida-frontaliere/'),
    );

    const result = run(root, SOFT404_SCRIPT);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('Empty soft-404 population');
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

  it('passes a minimal noindex retirement bridge served through its flat fallback', () => {
    const root = fixture();
    const retirementPath = '/cerca-lavoro-svizzera/ricerca-cookie-bern/';
    const [, flat] = junkRetirementWrites(retirementPath, buildJunkRetirementHtml('it'));
    writeFileSync(
      join(root, 'dist', 'sitemap-eventi.xml'),
      urlset(`https://frontaliereticino.ch${retirementPath}`),
    );
    const flatPath = join(root, 'dist', flat.rel);
    mkdirSync(dirname(flatPath), { recursive: true });
    writeFileSync(flatPath, flat.html);

    const result = run(root, SOFT404_SCRIPT);
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(0);
    expect(output).toContain('Checked 1 pages');
    expect(output).not.toContain('Sitemap URL has noindex');
    expect(output).not.toContain('Thin content');
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
    expect(source).toContain('REDIRECT_STUB_MARKER');
    expect(body).toContain('eligiblePages');
  });
});
