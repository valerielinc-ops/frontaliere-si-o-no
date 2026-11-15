// W0-B: AST lint that keeps whole-file read + JSON.parse off the datasets that
// outgrew V8's string limit, and the chunked secret scan for the same files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSource, scanTree } from '../scripts/ci/check-large-dataset-reads.mjs';
import { scanLargeFile } from '../scripts/validate-third-party-secrets.mjs';

const hit = (src: string, file = 'x.mjs') => scanSource(src, file);

describe('check-large-dataset-reads — violations', () => {
  it.each([
    ["direct literal", "const a = JSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));"],
    ["path.join with literals", "const a = JSON.parse(readFileSync(path.join(ROOT, 'data', 'jobs.json'), 'utf-8'));"],
    ["public copy", "const a = JSON.parse(readFileSync(join(root, 'public', 'data', 'jobs.json'), 'utf8'));"],
    ["const path variable", "const JOBS_PATH = join(ROOT, 'data', 'jobs.json');\nconst a = JSON.parse(readFileSync(JOBS_PATH, 'utf8'));"],
    ["two hops of constants", "const DATA = path.join(root, 'data');\nconst P = path.join(DATA, 'jobs.json');\nJSON.parse(fs.readFileSync(P, 'utf8'));"],
    ["template literal", "JSON.parse(fs.readFileSync(`${root}/data/expired-jobs.json`, 'utf8'));"],
    ["string concatenation", "JSON.parse(fs.readFileSync(root + '/data/slug-registry.json', 'utf8'));"],
    ["intermediate variable", "const raw = fs.readFileSync(p, 'utf8');\nconst p = 'data/jobs.json';\nJSON.parse(raw);"],
    ["await readFile", "const a = JSON.parse(await readFile('data/jobs.json', 'utf8'));"],
    ["fs.promises.readFile", "const a = JSON.parse(await fs.promises.readFile(path.join(root, 'data', 'jobs.json')));"],
    [".toString()", "JSON.parse(fs.readFileSync('data/jobs.json').toString());"],
    ["fallback chain", "const P = process.env.JOBS || 'data/jobs.json';\nJSON.parse(fs.readFileSync(P, 'utf8'));"],
    ["snapshot shards", "JSON.parse(readFileSync(path.join(root, 'data', 'jobs-snapshots-history', file), 'utf8'));"],
    ["all-known-job-slugs shard", "JSON.parse(readFileSync(path.join(root, 'data/all-known-job-slugs/part-00.json'), 'utf8'));"],
  ])('flags %s', (_name, src) => {
    const { violations } = hit(src);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBeGreaterThan(0);
  });

  it('flags TypeScript sources with type assertions', () => {
    const { violations } = hit("const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf8')) as Job[];\nconst DATA_JOBS = np.resolve(rootDir, 'data/jobs.json');", 'x.ts');
    expect(violations).toHaveLength(1);
  });
});

describe('check-large-dataset-reads — not violations', () => {
  it.each([
    ['the safe reader', "const jobs = readJsonFile(path.join(root, 'data', 'jobs.json'));"],
    ['the iterator', "for (const j of iterateJsonArrayFile('data/jobs.json')) {}"],
    ['a small file', "JSON.parse(fs.readFileSync(path.join(root, 'data', 'canton-municipalities.json'), 'utf8'));"],
    ['the per-crawler slices', "JSON.parse(readFileSync(path.join(root, 'data', 'jobs', 'by-crawler', f), 'utf8'));"],
    ['a read that is not parsed', "const text = fs.readFileSync('data/jobs.json', 'utf8');"],
    ['JSON.parse of something else', "JSON.parse(await response.text());"],
    ['a similarly named file', "JSON.parse(fs.readFileSync('data/jobs-ai-cache.json', 'utf8'));"],
    ['a same-named variable from another function', "function a() { const raw = readFileSync('data/jobs.json', 'utf8'); return raw.length; }\nfunction b() { const raw = readFileSync('data/other.json', 'utf8'); return JSON.parse(raw); }"],
  ])('%s', (_name, src) => {
    const { violations } = hit(src);
    expect(violations).toEqual([]);
  });

  it('honours an explicit exception that states a reason, on the line or just above', () => {
    expect(hit("// large-dataset-read-ok: 13 MB weekly shard\nJSON.parse(fs.readFileSync('data/jobs-snapshots-history/w.json', 'utf8'));").violations).toEqual([]);
    expect(hit("JSON.parse(fs.readFileSync('data/jobs.json', 'utf8')); // large-dataset-read-ok: fixture").violations).toEqual([]);
  });

  it('does not honour an exception without a reason', () => {
    expect(hit("// large-dataset-read-ok:\nJSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));").violations).toHaveLength(1);
  });
});

describe('check-large-dataset-reads — unresolvable paths are reported, never failed', () => {
  it('puts a bare parameter in `unknown`', () => {
    const { violations, unknown } = hit("function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }");
    expect(violations).toEqual([]);
    expect(unknown).toHaveLength(1);
  });
  it('puts path.join of two parameters in `unknown`', () => {
    const { unknown } = hit("function load(dir, f) { return JSON.parse(readFileSync(path.join(dir, f), 'utf8')); }");
    expect(unknown).toHaveLength(1);
  });
});

describe('check-large-dataset-reads — tree scan', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('reports file and line, and passes a clean tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'large-reads-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'bad.mjs'), "import fs from 'node:fs';\nconst x = JSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));\n");
    fs.writeFileSync(path.join(root, 'scripts', 'good.mjs'), "const x = readJsonFile('data/jobs.json');\n");
    const result = scanTree(root);
    expect(result.violations).toEqual([{ file: 'scripts/bad.mjs', line: 2, path: 'data/jobs.json' }]);
    expect(result.scanned).toBe(2);
    fs.rmSync(path.join(root, 'scripts', 'bad.mjs'));
    expect(scanTree(root).violations).toEqual([]);
  });
});

describe('validate-third-party-secrets — chunked scan of an over-limit file', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('finds a match that straddles a chunk boundary, once, with the right line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-scan-'));
    dirs.push(dir);
    const file = path.join(dir, 'big.json');
    const url = 'https://makeamark.spindox.it/jobs/1';
    const body = `${'a\n'.repeat(40)}x ${url} y\n${'b\n'.repeat(40)}`;
    fs.writeFileSync(file, body);
    const expectedLine = 41;
    for (const chunkBytes of [16, 37, 64, 1000]) {
      const findings = scanLargeFile(file, { chunkBytes, overlapBytes: 48 });
      expect(findings, `chunk ${chunkBytes}`).toHaveLength(1);
      expect(findings[0].line, `chunk ${chunkBytes}`).toBe(expectedLine);
      expect(findings[0].type).toBe('Spindox ATS URL');
    }
  });

  it('reports nothing for a clean file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-scan-'));
    dirs.push(dir);
    const file = path.join(dir, 'clean.json');
    fs.writeFileSync(file, '[{"url":"https://example.org/a"}]\n'.repeat(50));
    expect(scanLargeFile(file, { chunkBytes: 100, overlapBytes: 40 })).toEqual([]);
  });
});
