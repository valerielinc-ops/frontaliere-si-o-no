/**
 * The two dist/ BFS audits — `audit-bfs-depth.mjs` and
 * `audit-orphan-pages-in-sitemaps.mjs` — walk the link graph page by page and
 * keep every normalised path they discover in a Map/Set that lives for the
 * whole walk. The paths come out of `extractAnchorHrefs`, i.e. they are regex
 * capture groups, and in V8 a capture of length >= 13 is a SlicedString: a
 * pointer into the parent plus an offset.
 *
 * So each retained 30-char path was pinning the entire HTML document it was
 * scraped from. On the production corpus that is the whole reachable site
 * resident in the heap, which is how run 33928403220 died after ~960 s with
 *
 *     FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out
 *     of memory
 *
 * on BOTH jobs of the BFS chain (issue #7419). `audit-duplicate-meta-
 * description.mjs` hit the identical failure earlier and grew a private
 * flattener; that is now scripts/lib/flat-string.mjs, shared by all of them.
 *
 * WHY A CHILD PROCESS — same reason as duplicate-meta-description-heap.test.ts:
 * measuring retention needs a deterministic collection point, `global.gc` only
 * exists under `--expose-gc`, and vitest.config.ts runs `pool: 'threads'` with
 * no `execArgv`, so `globalThis.gc` is ALWAYS undefined inside the runner. A
 * `gc?.()` here would be a silent no-op and the bound would rest on incidental
 * collection.
 *
 * The `-- dummy` before the flags is not decoration: under `-e` the first
 * post-`--` argument lands in `process.argv[1]`, and both audits read their
 * CLI flags from `process.argv.slice(2)`.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BFS_AUDIT = resolve(REPO_ROOT, 'scripts/audit-bfs-depth.mjs');
const ORPHAN_AUDIT = resolve(REPO_ROOT, 'scripts/audit-orphan-pages-in-sitemaps.mjs');

const PAGES = 400;
const FILLER_BYTES = 40_000;

/** A dist/ whose pages form a chain `/p-0 → /p-1 → … → /p-N`, each one fat. */
function buildChainDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bfs-retention-'));
  const filler = `<p>${'contenuto di riempimento '.repeat(FILLER_BYTES / 25)}</p>`;
  const page = (links: string[]) =>
    `<!doctype html><html lang="it"><head><title>t</title></head><body>${links
      .map((h) => `<a href="${h}">vai</a>`)
      .join('')}${filler}</body></html>`;

  writeFileSync(join(dir, 'index.html'), page(['/pagina-archivio-numero-0/']));
  for (let i = 0; i < PAGES; i++) {
    const sub = join(dir, `pagina-archivio-numero-${i}`);
    mkdirSync(sub, { recursive: true });
    const next = i + 1 < PAGES ? [`/pagina-archivio-numero-${i + 1}/`] : [];
    writeFileSync(join(sub, 'index.html'), page(next));
  }
  return dir;
}

function probe(auditPath: string, call: string, dist: string) {
  // audit-bfs-depth reads its dist root from `--dist=` at module load;
  // audit-orphan takes it as an argument. Both get it, only one uses it.
  const source = `
    const DIST = ${JSON.stringify(dist)};
    const { __test } = await import(${JSON.stringify(auditPath)});
    const settle = () => { for (let i = 0; i < 4; i++) global.gc({ type: 'major', execution: 'sync' }); };
    settle();
    const before = process.memoryUsage().heapUsed;
    const result = await ${call};
    settle();
    const after = process.memoryUsage().heapUsed;
    const paths = result instanceof Map ? [...result.keys()] : [...result.linked];
    process.stdout.write(JSON.stringify({
      perPath: (after - before) / paths.length,
      count: paths.length,
      deepest: result instanceof Map ? Math.max(...result.values()) : null,
      sample: paths.includes('/pagina-archivio-numero-7'),
    }));
  `;
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--input-type=module', '-e', source, '--', 'dummy', `--dist=${dist}`],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(out) as { perPath: number; count: number; deepest: number | null; sample: boolean };
}

describe('BFS audits — a discovered path must not retain the page it was scraped from', () => {
  const cases: Array<[string, string, string]> = [
    ['audit-bfs-depth', BFS_AUDIT, '__test.bfsWithDepth()'],
    ['audit-orphan-pages-in-sitemaps', ORPHAN_AUDIT, '__test.bfsReachableFromHome(DIST)'],
  ];

  for (const [name, path, call] of cases) {
    it(`${name} keeps far less than one page per discovered path`, () => {
      const dist = buildChainDist();
      try {
        const { perPath, count, deepest, sample } = probe(path, call, dist);

        // The walk has to WORK first: every page in the chain reached, and the
        // chain really is deep (a shallow walk would make the bound vacuous).
        expect(count).toBe(PAGES + 1);
        expect(sample).toBe(true);
        if (deepest !== null) expect(deepest).toBe(PAGES);

        // Retaining the parent costs >= FILLER_BYTES per path; a flattened path
        // costs a few hundred bytes. Two orders of magnitude apart, so this
        // bound fires only if the SlicedString comes back.
        expect(
          perPath,
          `retained ${perPath.toFixed(0)} B/path — each path is holding its ~${FILLER_BYTES} B page alive again`,
        ).toBeLessThan(FILLER_BYTES / 8);
      } finally {
        rmSync(dist, { recursive: true, force: true });
      }
    });
  }
});
