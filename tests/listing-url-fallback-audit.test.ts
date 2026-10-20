import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LISTING_URL_FALLBACK_RE,
  auditListingUrlFallback,
  classifyFamily,
  formatMarkdown,
  measureSlice,
  resolveStringConstant,
  scanParserSource,
} from '../scripts/lib/listing-url-fallback-audit.mjs';
import { execFileSync } from 'node:child_process';
import { main, run } from '../scripts/audit-listing-url-fallback.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const workdayParser = `
import { createHash } from 'node:crypto';
// Why not the shared successfactors-client.mjs: comments must not classify.
import { fetchWorkdayJobs } from './ats-clients/workday-client.mjs';
export const ACME_KEY = 'acme';
const BASE = 'https://acme.wd3.myworkdayjobs.com';
const CAREER_URL = \`\${BASE}/Careers\`;
function build(listing) {
  const publicUrl = listing.url || CAREER_URL;
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  return { id: \`acme-\${urlHash}\`, url: publicUrl };
}
`;

const htmlParser = `
export const BETA_KEY = 'beta';
const SEARCH_URL = 'https://jobs.beta.ch/search/';
const publicUrl = listing.url || SEARCH_URL;
`;

describe('listing-url-fallback-audit (#9679)', () => {
  it('uses the exact static predicate of the issue', () => {
    expect(LISTING_URL_FALLBACK_RE.test('const u = listing.url || CAREER_URL;')).toBe(true);
    expect(LISTING_URL_FALLBACK_RE.test('const u = listing.url ||  UMANTIS_LISTING_URL;')).toBe(true);
    expect(LISTING_URL_FALLBACK_RE.test('const u = listing.url || fallback;')).toBe(false);
  });

  it('resolves literal, template and alias constants and refuses to guess the rest', () => {
    const src = `const A = 'https://a.ch';\nconst B = \`\${A}/jobs\`;\nconst C = B;\nconst D = buildUrl();\n`;
    expect(resolveStringConstant(src, 'B')).toBe('https://a.ch/jobs');
    expect(resolveStringConstant(src, 'C')).toBe('https://a.ch/jobs');
    expect(resolveStringConstant(src, 'D')).toBeNull();
    expect(resolveStringConstant(src, 'MISSING')).toBeNull();
  });

  it('classifies by import specifier first and ignores comments', () => {
    expect(classifyFamily(workdayParser)).toBe('workday');
    expect(classifyFamily("// uses myworkdayjobs.com, not us\nimport x from './crawler-template.mjs';")).toBe('custom-html');
    expect(classifyFamily("const FEED = 'https://jobs.acme.com/j2w/feed';")).toBe('successfactors');
  });

  it('scans a parser into key, family, resolved fallback and id strategy', () => {
    expect(scanParserSource('acme-job-parser.mjs', workdayParser)).toEqual({
      parser: 'acme',
      crawlerKey: 'acme',
      family: 'workday',
      fallbackConst: 'CAREER_URL',
      fallbackUrl: 'https://acme.wd3.myworkdayjobs.com/Careers',
      idFromUrl: true,
    });
    expect(scanParserSource('x-job-parser.mjs', 'const u = listing.url;')).toBeNull();
  });

  it('counts fallback emissions, empty URLs and collisions; a fragment is a distinct listing', () => {
    const fallback = 'https://acme.ch/jobs';
    const m = measureSlice([
      { id: 'a', url: 'https://acme.ch/jobs/', applyUrl: 'https://acme.ch/jobs/' },
      { id: 'a', url: 'https://ACME.ch/jobs', applyUrl: 'https://acme.ch/jobs' },
      { id: 'b', url: 'https://acme.ch/jobs#para_1', applyUrl: 'https://acme.ch/jobs#para_1' },
      { id: 'c', url: 'https://acme.ch/jobs/42', applyUrl: 'https://acme.ch/jobs' },
      { id: 'd', url: '' },
    ], fallback);
    expect(m).toEqual({ total: 5, missingDetailUrl: 1, fallbackEmissions: 3, duplicateIds: 1, duplicateUrls: 1 });
  });

  it('aggregates per family and names the lossy parsers', () => {
    const slices: Record<string, object[]> = {
      acme: [
        { id: 'acme-1', url: 'https://acme.wd3.myworkdayjobs.com/Careers/job/1' },
        { id: 'acme-2', url: 'https://acme.wd3.myworkdayjobs.com/Careers' },
      ],
    };
    const report = auditListingUrlFallback(
      [
        { fileName: 'beta-job-parser.mjs', source: htmlParser },
        { fileName: 'acme-job-parser.mjs', source: workdayParser },
        { fileName: 'not-a-parser.mjs', source: workdayParser },
      ],
      (key: string) => slices[key] ?? null,
    );
    expect(report.candidates).toBe(2);
    expect(report.classified).toBe(2);
    expect(report.lossyParsers).toEqual(['acme']);
    expect(report.families.map((f: { family: string }) => f.family)).toEqual(['custom-html', 'workday']);
    expect(report.totals).toMatchObject({ parsers: 2, withSlice: 1, total: 2, fallbackEmissions: 1 });
    expect(formatMarkdown(report)).toContain('| workday | 1 | 1 | 0 | 2 | 0 | 1 | 0 | 0 |');
  });

  describe('CLI', () => {
    let root = '';
    afterEach(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
      root = '';
      vi.restoreAllMocks();
    });

    it('reads data/jobs/by-crawler and fails only on --fail-on-loss when a slice carries the fallback', () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-url-audit-'));
      fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
      fs.mkdirSync(path.join(root, 'data/jobs/by-crawler'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts/lib/acme-job-parser.mjs'), workdayParser);
      fs.writeFileSync(
        path.join(root, 'data/jobs/by-crawler/acme.json'),
        JSON.stringify({ crawlerKey: 'acme', jobs: [{ id: 'acme-1', url: 'https://acme.wd3.myworkdayjobs.com/Careers' }] }),
      );
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(run(['--root', root])).toBe(0);
      expect(run(['--root', root, '--fail-on-loss'])).toBe(1);
      expect(String(out.mock.calls[0][0])).toContain('parser con perdita riproducibile: acme');
    });

    // Review finding on #9719: with --ref, an unreadable ref used to read as
    // "every slice absent", i.e. zero loss and --fail-on-loss exiting 0.
    function gitFixture(sliceText: string) {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-url-audit-git-'));
      fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
      fs.mkdirSync(path.join(root, 'data/jobs/by-crawler'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts/lib/acme-job-parser.mjs'), workdayParser);
      fs.writeFileSync(path.join(root, 'data/jobs/by-crawler/acme.json'), sliceText);
      const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      g('init', '-q');
      g('add', '-A');
      g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', 'fixture');
      // --ref must not read the working tree: drop the materialized slices.
      fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    }

    it('reads slices from a git ref and still flags the loss', () => {
      gitFixture(JSON.stringify({ jobs: [{ id: 'acme-1', url: 'https://acme.wd3.myworkdayjobs.com/Careers' }] }));
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(main(['--root', root, '--ref', 'HEAD', '--fail-on-loss'])).toBe(1);
    });

    it('exits 2 on an unknown ref instead of reporting zero loss', () => {
      gitFixture(JSON.stringify({ jobs: [{ id: 'acme-1', url: 'https://acme.wd3.myworkdayjobs.com/Careers' }] }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(main(['--root', root, '--ref', 'no-such-ref', '--fail-on-loss'])).toBe(2);
      expect(out).not.toHaveBeenCalled();
      expect(String(err.mock.calls[0][0])).toMatch(/git ref not found: no-such-ref/);
    });

    it('exits 2 on an unreadable slice at the ref instead of treating it as absent', () => {
      gitFixture('{ not json');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(main(['--root', root, '--ref', 'HEAD', '--fail-on-loss'])).toBe(2);
    });

    it('refuses to report zero when the slices are not materialized', () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-url-audit-empty-'));
      fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
      expect(() => run(['--root', root])).toThrow(/--ref origin\/main/);
    });
  });

  // Observer on the real parsers: every static candidate must stay measurable.
  // A new `listing.url || X_URL` whose key or fallback URL the audit cannot
  // resolve would silently drop out of the per-family counts.
  it('classifies every static candidate in scripts/lib with a crawler key and a resolved fallback URL', () => {
    const dir = path.join(REPO_ROOT, 'scripts/lib');
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('-job-parser.mjs'))
      .map((fileName) => ({ fileName, source: fs.readFileSync(path.join(dir, fileName), 'utf8') }));
    const report = auditListingUrlFallback(files, () => null);
    const expected = files.filter((f) => LISTING_URL_FALLBACK_RE.test(f.source)).length;

    expect(report.candidates).toBe(expected);
    expect(report.candidates).toBeGreaterThan(0);
    const unresolved = report.rows
      .filter((r: { crawlerKey: string | null; fallbackUrl: string | null }) => !r.crawlerKey || !r.fallbackUrl)
      .map((r: { parser: string }) => r.parser);
    expect(unresolved).toEqual([]);
    // Franklin publishes a per-vacancy anchor now; it must not regress to the idiom.
    expect(report.rows.map((r: { parser: string }) => r.parser)).not.toContain('franklin-university');
  });
});
