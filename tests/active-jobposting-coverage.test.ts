import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createActiveJobPostingCoverage,
  htmlHasActiveJobPosting,
  htmlIsIndexable,
} from '../scripts/lib/active-jobposting-coverage.mjs';
import { runActiveJobPostingCoverageGate } from '../scripts/ci/assert-active-jobposting-coverage.mjs';

const posting = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Infermiere","datePosted":"2026-10-20"}</script>';
const minifiedPosting = '<script type=application/ld+json>{"@context":"https://schema.org","@graph":[{"@type":"JobPosting","datePosted":"2026-10-20T08:00:00Z"}]}</script>';
const breadcrumb = '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>';
const page = (head: string, robots = 'index, follow') => `<!doctype html><html><head><meta name="robots" content="${robots}">${head}</head><body></body></html>`;

describe('active JobPosting coverage', () => {
  it('recognises JobPosting in quoted, minified and @graph JSON-LD, and rejects pages without it', () => {
    expect(htmlHasActiveJobPosting(page(posting))).toBe(true);
    expect(htmlHasActiveJobPosting(page(minifiedPosting))).toBe(true);
    expect(htmlHasActiveJobPosting(page(breadcrumb))).toBe(false);
    expect(htmlHasActiveJobPosting(page('<script type="application/ld+json">{"@type":"JobPosting"</script>'))).toBe(false);
    expect(htmlHasActiveJobPosting(page('<script type="application/ld+json">{"@type":"JobPosting","datePosted":""}</script>'))).toBe(false);
    expect(htmlHasActiveJobPosting(page('<script type="application/ld+json">{"@type":"JobPosting","datePosted":{}}</script>'))).toBe(false);
    expect(htmlHasActiveJobPosting(page('<script type="application/ld+json">{"@type":"JobPosting","datePosted":true}</script>'))).toBe(false);
    expect(htmlHasActiveJobPosting(page('<script type="application/ld+json">{"@type":"JobPosting","datePosted":"not-a-date"}</script>'))).toBe(false);
    expect(htmlHasActiveJobPosting(page('<script type="application/ld+json">{"@type":"JobPosting","datePosted":"2026-02-30"}</script>'))).toBe(false);
  });

  it('reads robots meta in quoted and unquoted form', () => {
    expect(htmlIsIndexable(page(posting))).toBe(true);
    expect(htmlIsIndexable(page(posting, 'noindex,follow'))).toBe(false);
    expect(htmlIsIndexable('<meta name=robots content=noindex,follow>')).toBe(false);
  });

  it('throws on a single active page without JobPosting, printing the rate', () => {
    const coverage = createActiveJobPostingCoverage();
    coverage.record('it', '/cerca-lavoro-zurigo/a/', page(posting));
    coverage.record('it', '/cerca-lavoro-zurigo/b/', page(breadcrumb));
    expect(coverage.summary()).toMatchObject({ pages: 2, withJobPosting: 1 });
    expect(() => coverage.assertComplete('test')).toThrow(/1 active job detail page\(s\) emitted without JobPosting[\s\S]*\/cerca-lavoro-zurigo\/b\//);
  });

  it('passes when every page carries JobPosting and keeps the page list only on request', () => {
    const lean = createActiveJobPostingCoverage();
    lean.record('it', '/a/', page(posting));
    expect(() => lean.assertComplete('test')).not.toThrow();
    expect(lean.sidecar()).toMatchObject({ total: 1, pages: [] });
    const kept = createActiveJobPostingCoverage({ keepPages: true });
    kept.record('en', '/en/a/', page(posting, 'noindex'));
    expect(kept.sidecar()).toMatchObject({ total: 1, pages: [{ locale: 'en', path: '/en/a/', indexable: false }] });
  });

  it('fails closed when the active population is non-empty but no page was recorded', () => {
    const coverage = createActiveJobPostingCoverage({ keepPages: true, expectedTotal: 1 });
    expect(() => coverage.assertComplete('test')).toThrow(/active population mismatch/);
    expect(coverage.sidecar()).toMatchObject({ expectedTotal: 1, total: 0, pages: [] });
  });
});

describe('post-build JobPosting gate', () => {
  function fixture(pages: Record<string, string | null>, sidecarOverride?: object) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobposting-gate-'));
    const dist = path.join(root, 'dist');
    for (const [pagePath, html] of Object.entries(pages)) {
      if (html === null) continue;
      fs.mkdirSync(path.join(dist, pagePath), { recursive: true });
      fs.writeFileSync(path.join(dist, pagePath, 'index.html'), html);
    }
    const list = Object.keys(pages).map((p) => ({ locale: 'it', path: p, indexable: true }));
    const sidecarPath = path.join(root, 'sidecar.json');
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecarOverride ?? { version: 1, total: list.length, pages: list }));
    return { root, dist, sidecarPath };
  }
  function run(args: { distDir: string, sidecarPath?: string }) {
    const errors: string[] = [];
    const logs: string[] = [];
    const status = runActiveJobPostingCoverageGate({ ...args, log: (l: string) => logs.push(l), error: (l: string) => errors.push(l) });
    return { status, errors, logs };
  }

  it('passes when every recorded page still carries JobPosting', () => {
    const f = fixture({ '/cerca-lavoro-ticino/a/': page(posting), '/en/find-jobs-ticino/a/': page(minifiedPosting) });
    try {
      const result = run({ distDir: f.dist, sidecarPath: f.sidecarPath });
      expect(result.status).toBe(0);
      expect(result.logs.join('\n')).toContain('rate=100.000%');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('fails on a page that lost JobPosting and on an absent page', () => {
    const f = fixture({ '/cerca-lavoro-ticino/a/': page(breadcrumb), '/cerca-lavoro-ticino/b/': null });
    try {
      const result = run({ distDir: f.dist, sidecarPath: f.sidecarPath });
      expect(result.status).toBe(1);
      expect(result.errors.join('\n')).toContain('/cerca-lavoro-ticino/a/');
      expect(result.errors.join('\n')).toContain('1 active job detail page(s) recorded by the build are absent');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('fails when the sidecar is missing, unreadable or truncated: nothing checked is never green', () => {
    const f = fixture({ '/a/': page(posting) }, { total: 5, pages: [{ locale: 'it', path: '/a/' }] });
    try {
      expect(run({ distDir: f.dist }).status).toBe(2);
      expect(run({ distDir: f.dist, sidecarPath: path.join(f.root, 'missing.json') }).status).toBe(2);
      expect(run({ distDir: f.dist, sidecarPath: f.sidecarPath }).status).toBe(2);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('fails an empty sidecar without an independent active-population count', () => {
    const f = fixture({}, { version: 1, total: 0, pages: [] });
    try {
      const result = run({ distDir: f.dist, sidecarPath: f.sidecarPath });
      expect(result.status).toBe(2);
      expect(result.errors.join('\n')).toContain('independent active-population count');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('fails when the sidecar population count disagrees with recorded pages', () => {
    const f = fixture({ '/a/': page(posting) }, { version: 1, expectedTotal: 2, total: 1, pages: [{ locale: 'it', path: '/a/' }] });
    try {
      const result = run({ distDir: f.dist, sidecarPath: f.sidecarPath });
      expect(result.status).toBe(2);
      expect(result.errors.join('\n')).toContain('population mismatch');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});
