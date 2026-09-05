// The `gate:seo-source` reader-discipline guard — issue #5447.
//
// WHAT WENT WRONG
// ───────────────
// `data/jobs.json` is assembled in CI from the crawler slices and has grown by
// more than an order of magnitude since these guards were written. Two files in
// this directory read and re-parsed it inside EVERY `it()`. Decoding a
// several-hundred-MB utf8 string and `JSON.parse`-ing it costs seconds per
// call, and more on the calls that must reclaim the previous multi-GB object
// graph while allocating the next one. `gate:seo-source` runs on the
// post-deploy runner concurrently with three other validators on 4 vCPU — which
// is exactly where "slow" became "past vitest's 15s per-test timeout".
//
// The gate then failed on a TIMEOUT, in
// `cathedral-job-detail-canton.test.ts > non-TI ZH: …`, reporting a timeout
// rather than anything that test asserts. That blocked publish, and the
// reported symptom pointed at the wrong thing.
//
// WHY A GUARD AND NOT JUST THE FIX
// ────────────────────────────────
// The fix (route every read through `tests/helpers/jobsDataset.ts`, which memos
// per test file) is one line per call site, which is precisely why the next
// guard added to this directory will paste `JSON.parse(fs.readFileSync(...))`
// back in — it reads as the obvious thing to write, and stays invisible until
// the dataset grows enough to blow the timeout again.
//
// Note what this guard is NOT: it is not a longer `testTimeout`. Raising the
// bound would hide the next genuine regression in the code under test. The 15s
// limit stays where it is; the redundant work is what goes away.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readJobsDataset } from '../helpers/jobsDataset';
import { SCAN_TEST_TIMEOUT_MS } from '../helpers/distHtmlScan';

const SEO_TESTS_DIR = __dirname;
const SELF = 'jobs-dataset-read-once.test.ts';

/**
 * Every identifier in `src` bound to a path that ends at the jobs dataset —
 * `JOBS_PATH`, `jobsPath`, or whatever the next author calls it.
 *
 * Matching the NAME instead would make the guard evadable by renaming the
 * variable, which is the way a guard stops guarding without anyone noticing.
 */
function jobsPathBindings(src: string): string[] {
  const names: string[] = [];
  // Anchored on the DATASET, not forwards from a `const`/`let`/`var` keyword:
  // keyword-anchoring missed `const dataPath: string = …` outright, because
  // what follows the identifier is `:` and not `=`.
  //
  // Within the statement holding the path, EVERY binding is collected, not the
  // nearest one. Three revisions of this function tried to pick the single
  // right binding and three reviews found a shape where the pick was wrong:
  // `const a = 1, dataPath = …` (nearest-from-the-left picks `a`),
  // `const p = fn(() => '…jobs.json')` (an arrow's `=` ends a backwards walk),
  // `const p = fn(a = 1, '…jobs.json')` (a nested assignment does the same).
  // Picking is the bug. Over-collecting is safe: the extra names are bound in
  // this same statement, and a name only matters if it then shows up as a
  // whole word inside a `readFileSync(...)` argument list.
  //
  // `=(?!=|>)` is the assignment operator only — never `==`, `===` or `=>`.
  const BIND = /([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?\s*=(?!=|>)/g;
  const rx = /jobs\.json/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) {
    // Bounded by the previous statement, not by a fixed character window: a
    // long or multi-line `path.join(...)` overflows any constant you pick,
    // and the binding then disappears with no signal. No preceding `;` —
    // first statement of the file — gives `-1 + 1 = 0`, i.e. from the top.
    const head = src.slice(src.lastIndexOf(';', m.index) + 1, m.index);
    let bind: RegExpExecArray | null;
    BIND.lastIndex = 0;
    while ((bind = BIND.exec(head)) !== null) names.push(bind[1]);
  }
  return names;
}

/** Regex-escape an identifier before it goes into an alternation. `$` is legal
 *  in a JS name and is an anchor in a pattern; unescaped it silently breaks it. */
const escRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A `readFileSync(...)` on the dataset: the path spelled inline, or any local
 * binding that resolves to it. `JOBS_PATH`/`jobsPath` stay in the alternation
 * as a floor for the case where the binding is imported rather than declared
 * here, so the guard degrades to name-matching instead of to nothing.
 */
function readsDatasetDirectly(src: string): boolean {
  const names = ['JOBS_PATH', 'jobsPath', ...jobsPathBindings(src)];
  // `\b…\b` around the names: without it a binding captured as `a` matches the
  // `a` inside `readFileSync(dataPath, …)` and the guard fires on a substring
  // — right answer, wrong reason, and a false positive waiting for the first
  // short variable name in the directory.
  const rx = new RegExp(
    `readFileSync\\s*\\(\\s*[^)]*(?:jobs\\.json|\\b(?:${names.map(escRx).join('|')})\\b)`,
  );
  return rx.test(src);
}

describe('gate:seo-source — the jobs dataset is read through the shared memo', () => {
  it('no test in tests/seo/ reads data/jobs.json directly', () => {
    const offenders = fs
      .readdirSync(SEO_TESTS_DIR)
      .filter((f) => /\.(test|spec)\.tsx?$/.test(f) && f !== SELF)
      .filter((f) => readsDatasetDirectly(fs.readFileSync(path.join(SEO_TESTS_DIR, f), 'utf8')));

    expect(
      offenders,
      `these files read data/jobs.json directly instead of via tests/helpers/jobsDataset.ts:\n` +
        `${offenders.map((f) => `  tests/seo/${f}`).join('\n')}\n` +
        'Each read re-decodes the whole dataset; doing it per `it()` is what timed out gate:seo-source (#5447).',
    ).toEqual([]);
  });

  // A guard that only recognises today's variable names is evaded by renaming
  // one, which is the quiet way a guard stops guarding.
  it('recognises the read regardless of what the path variable is called', () => {
    expect(
      readsDatasetDirectly(
        [
          "const dataPath = path.join(REPO_ROOT, 'data', 'jobs.json');",
          "const jobs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
        ].join('\n'),
      ),
      'a renamed binding still resolves to the dataset',
    ).toBe(true);

    // Inline path, no binding at all.
    expect(readsDatasetDirectly("fs.readFileSync(path.join(R, 'data', 'jobs.json'), 'utf8')")).toBe(true);

    // The two forms a reviewer found slipping past the keyword-anchored
    // version of this function (#5503): an explicit type annotation, and a
    // second declarator on the same statement.
    expect(
      readsDatasetDirectly(
        [
          "const dataPath: string = path.join(REPO_ROOT, 'data', 'jobs.json');",
          "const jobs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
        ].join('\n'),
      ),
      'a type annotation must not hide the binding',
    ).toBe(true);
    expect(
      readsDatasetDirectly(
        [
          "const a = 1, dataPath = path.join(REPO_ROOT, 'data', 'jobs.json');",
          "const jobs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
        ].join('\n'),
      ),
      'the declarator holding the path is the one that must be captured',
    ).toBe(true);

    // …and it stays quiet on the things that are fine: merely naming the
    // dataset, reading a DIFFERENT file, and the sanctioned call itself.
    expect(readsDatasetDirectly('// data/jobs.json is assembled in CI')).toBe(false);
    expect(readsDatasetDirectly("const src = fs.readFileSync(PLUGIN_PATH, 'utf8');")).toBe(false);
    expect(readsDatasetDirectly('const jobs = readJobsDataset<Job>(JOBS_PATH);')).toBe(false);

    // An arrow function between the assignment and the path puts a literal
    // `=` in the way of the backwards walk (#5504 review).
    expect(
      readsDatasetDirectly(
        [
          "const dataPath = getPath(() => 'data/jobs.json');",
          "const jobs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
        ].join('\n'),
      ),
      'an arrow function must not end the walk back to the binding',
    ).toBe(true);

    // A `$` in the name is legal in JS and is an anchor in a pattern: it must
    // be escaped before interpolation, or the alternation breaks silently.
    expect(
      readsDatasetDirectly(
        [
          "const data$Path = path.join(REPO_ROOT, 'data', 'jobs.json');",
          "const jobs = JSON.parse(fs.readFileSync(data$Path, 'utf8'));",
        ].join('\n'),
      ),
      'a `$` in the binding name must not break the alternation',
    ).toBe(true);

    // An assignment nested in the argument list, before the path — the third
    // shape where picking a single "nearest" binding picked the wrong one.
    expect(
      readsDatasetDirectly(
        [
          "const dataPath = someFn(a = 1, 'data/jobs.json');",
          "const jobs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
        ].join('\n'),
      ),
      'a nested assignment must not displace the real binding',
    ).toBe(true);

    // First statement of the file: there is no preceding `;` to bound the
    // walk-back, and it must read from the top rather than find nothing.
    expect(
      readsDatasetDirectly(
        [
          "const dataPath = '/repo/data/jobs.json'",
          "const jobs = JSON.parse(fs.readFileSync(dataPath, 'utf8'))",
        ].join('\n'),
      ),
      'a binding with no preceding statement must still be found',
    ).toBe(true);

    // A short binding name must not match as a SUBSTRING of an unrelated
    // argument: `n` inside `readFileSync(fixtureName, …)` is not a dataset read.
    expect(
      readsDatasetDirectly(
        ["const n = 'x/jobs.json';", "const s = fs.readFileSync(fixtureName, 'utf8');"].join('\n'),
      ),
      'the binding must match as a whole identifier, not a substring',
    ).toBe(false);
  });

  // The guard above is only worth its runtime if the helper it points at
  // actually memoizes — otherwise it enforces a rename, not a behaviour.
  it('the shared reader parses a given path once', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-memo-'));
    const fixture = path.join(dir, 'jobs.json');
    fs.writeFileSync(fixture, JSON.stringify([{ slug: 'a' }]));

    const first = readJobsDataset<{ slug: string }>(fixture);
    expect(first).toEqual([{ slug: 'a' }]);

    // Change the file on disk: a second parse would pick the new content up,
    // the memo hands back the array identity it already returned.
    fs.writeFileSync(fixture, JSON.stringify([{ slug: 'b' }]));
    expect(readJobsDataset<{ slug: string }>(fixture)).toBe(first);

    // …and an absent path is `null` rather than a throw, which is what every
    // call site's offline-skip depends on.
    expect(readJobsDataset(path.join(dir, 'absent.json'))).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
