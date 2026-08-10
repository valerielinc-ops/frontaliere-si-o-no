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

const SEO_TESTS_DIR = __dirname;
const SELF = 'jobs-dataset-read-once.test.ts';

/** A `readFileSync(...)` call whose argument names the jobs dataset. */
const DIRECT_READ_RX = /readFileSync\s*\(\s*[^)]*(?:JOBS_PATH|jobsPath|jobs\.json)/;

describe('gate:seo-source — the jobs dataset is read through the shared memo', () => {
  it('no test in tests/seo/ reads data/jobs.json directly', () => {
    const offenders = fs
      .readdirSync(SEO_TESTS_DIR)
      .filter((f) => /\.(test|spec)\.tsx?$/.test(f) && f !== SELF)
      .filter((f) => DIRECT_READ_RX.test(fs.readFileSync(path.join(SEO_TESTS_DIR, f), 'utf8')));

    expect(
      offenders,
      `these files read data/jobs.json directly instead of via tests/helpers/jobsDataset.ts:\n` +
        `${offenders.map((f) => `  tests/seo/${f}`).join('\n')}\n` +
        'Each read re-decodes the whole dataset; doing it per `it()` is what timed out gate:seo-source (#5447).',
    ).toEqual([]);
  });

  // The guard above is only worth its runtime if the helper it points at
  // actually memoizes — otherwise it enforces a rename, not a behaviour.
  it('the shared reader parses a given path once', () => {
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
