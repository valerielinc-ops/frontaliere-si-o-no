import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  currentOffenders,
  baselineOffenders,
  GATES,
  evaluateGate,
} from '../scripts/cathedral-seo-gates-check.mjs';

/**
 * Issue #5169 — the cathedral SEO gates were inert.
 *
 * `extractCurrent` assumed `offenders` is an ARRAY and fell back to `p.total`;
 * `extractBaseline` read `b.total`. But three of the six audits emit
 * `offenders` as a NUMBER with no `total` key, and every committed baseline
 * stores `totalOffenders`. So `current` was 0, `baseline` was 0, and the
 * verdict was `pass` on every run no matter what `dist/` contained — a gate
 * that costs a 70-minute build and protects nothing.
 *
 * These tests pin the reader against the REAL payload keys the audits emit and
 * the REAL committed baseline files, so a future rename of either side fails
 * here instead of silently disarming the gate again.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

/** The exact `--json` payload shape each audit prints (keys only, values dummy). */
const REAL_PAYLOADS: Record<string, Record<string, unknown>> = {
  // scripts/audit-title-length.mjs MODE_JSON block
  'title-length': {
    scanned: 2220043,
    skippedNoindex: 12,
    missingTitle: 0,
    threshold: 66,
    offenders: 4290,
    byFeature: {},
    byLocale: {},
    worst: [],
  },
  // scripts/audit-text-html-ratio.mjs MODE_JSON block
  'text-html-ratio': {
    scanned: 73133,
    threshold: 10,
    offenders: 6912,
    byFeature: {},
    worst: [],
  },
  // scripts/audit-title-no-disambig-hash.mjs MODE_JSON block
  'title-no-disambig-hash': {
    scanned: 2220043,
    skippedNoindex: 3,
    missingTitle: 0,
    offenders: 539,
    byFeature: {},
    byLocale: {},
    worst: [],
  },
};

describe('#5169 — cathedral gate readers see the numbers the audits actually emit', () => {
  it.each(Object.keys(REAL_PAYLOADS))('%s: a NUMERIC `offenders` is not read as 0', (gateName) => {
    const payload = REAL_PAYLOADS[gateName];
    expect(currentOffenders(payload)).toBe(payload.offenders);
    expect(currentOffenders(payload)).toBeGreaterThan(0);
  });

  it('still accepts an ARRAY `offenders` (the shape the old reader assumed)', () => {
    expect(currentOffenders({ offenders: [{ file: 'a' }, { file: 'b' }] })).toBe(2);
    expect(currentOffenders({ offenders: [] })).toBe(0);
  });

  it('accepts `total` (image-object-license) and `totalOffenders`', () => {
    expect(currentOffenders({ total: 7, files: 3 })).toBe(7);
    expect(currentOffenders({ totalOffenders: 9 })).toBe(9);
  });

  it('THROWS on a payload with no offender count instead of scoring 0', () => {
    // This is the whole point: a silent 0 is what made the gate a no-op.
    expect(() => currentOffenders({ scanned: 100 })).toThrow(/no offender count/);
    expect(() => currentOffenders({})).toThrow(/no offender count/);
    expect(() => currentOffenders(null)).toThrow(/no offender count/);
  });

  it('THROWS on a baseline with no offender count instead of scoring 0', () => {
    expect(() => baselineOffenders({ scanned: 100 })).toThrow(/no offender count/);
    expect(() => baselineOffenders(null)).toThrow(/no offender count/);
  });
});

describe('#5169 — the committed baseline files are readable by the gate', () => {
  const rateBaselines = [
    'data/title-length-baseline.json',
    'data/text-html-ratio-baseline.json',
    'data/title-no-disambig-hash-baseline.json',
  ];

  it.each(rateBaselines)('%s exposes a non-zero offender count', (rel) => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    // The old reader looked for `total`, which none of these files has.
    expect(raw.total).toBeUndefined();
    expect(baselineOffenders(raw)).toBe(raw.totalOffenders);
    expect(baselineOffenders(raw)).toBeGreaterThan(0);
  });

  it('a real payload vs its real baseline no longer compares 0 to 0', () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'data/title-length-baseline.json'), 'utf8'),
    );
    const cur = currentOffenders(REAL_PAYLOADS['title-length']);
    const base = baselineOffenders(baseline);
    expect(cur).toBeGreaterThan(0);
    expect(base).toBeGreaterThan(0);
    // A payload one worse than the baseline must read as a regression.
    const worse = { ...REAL_PAYLOADS['title-length'], offenders: base + 1 };
    expect(currentOffenders(worse) - base).toBe(1);
  });
});

describe('#5169 — every gate spec is wired to a reader that can fail loudly', () => {
  it('has exactly the six documented gates, each with both extractors', () => {
    expect(GATES.map((g: { name: string }) => g.name)).toEqual([
      'text-html-ratio',
      'orphan-sitemap-pages',
      'image-object-license',
      'max-bfs-depth',
      'title-length',
      'title-no-disambig-hash',
    ]);
    for (const g of GATES as Array<Record<string, unknown>>) {
      expect(typeof g.extractCurrent, String(g.name)).toBe('function');
      expect(typeof g.extractBaseline, String(g.name)).toBe('function');
    }
  });

  it('orphan-sitemap-pages reads the report file, not the human stdout table', () => {
    const gate = (GATES as Array<Record<string, unknown>>).find(
      (g) => g.name === 'orphan-sitemap-pages',
    )!;
    const extract = gate.extractCurrent as (parsed: unknown, raw: string) => number;
    // The padded `TOTAL` row the old regex tried to parse, with numbers that
    // deliberately do NOT match any report — the reader must ignore stdout.
    const humanTable = 'sitemap-jobs.xml     123456    789   0.6%\nTOTAL   999   42   4.2%\n';
    // The COMMITTED report is stale by construction (it was generated long
    // before this process started), so the reader must refuse it rather than
    // score the gate against it. Same for a missing file.
    expect(() => extract({}, humanTable)).toThrow(/stale|ENOENT|no such file/i);
  });

  it('accepts a report written during this run, and still refuses a stale one', () => {
    const gate = (GATES as Array<Record<string, unknown>>).find(
      (g) => g.name === 'orphan-sitemap-pages',
    )!;
    const extract = gate.extractCurrent as (parsed: unknown, raw: string) => number;
    const reportPath = path.join(REPO_ROOT, 'data/orphan-pages-audit.json');
    const original = fs.existsSync(reportPath) ? fs.readFileSync(reportPath) : null;
    try {
      // Fresh: written "now" — the shape audit-orphan-pages-in-sitemaps writes.
      fs.writeFileSync(
        reportPath,
        JSON.stringify({
          version: 2,
          generatedAt: new Date(Date.now() + 1000).toISOString(),
          totalSitemapUrls: 1000,
          totalOrphans: 137,
          perSitemap: {},
        }),
      );
      expect(extract({}, '')).toBe(137);

      // Stale: a crashed audit left last week's committed copy behind.
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ version: 2, generatedAt: '2020-01-01T00:00:00.000Z', totalOrphans: 0 }),
      );
      expect(() => extract({}, '')).toThrow(/stale/i);

      // Present but shapeless → error, never a silent 0.
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ generatedAt: new Date(Date.now() + 1000).toISOString() }),
      );
      expect(() => extract({}, '')).toThrow(/totalOrphans/);
    } finally {
      if (original === null) fs.rmSync(reportPath, { force: true });
      else fs.writeFileSync(reportPath, original);
    }
  });

  it('importing the script does not run the six audits (main is guarded)', () => {
    // If `main()` fired on import the import above would have spawned audits
    // over dist/ and this suite would take minutes / fail. Assert the guard is
    // present in the source so a refactor cannot quietly remove it.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/cathedral-seo-gates-check.mjs'), 'utf8');
    expect(src).toMatch(/invokedDirectly/);
    expect(src).toMatch(/if \(invokedDirectly\) \{/);
  });

  it('is still executable as a script (node --check passes)', () => {
    execFileSync(process.execPath, [
      '--check',
      path.join(REPO_ROOT, 'scripts/cathedral-seo-gates-check.mjs'),
    ]);
  });
});

describe('#5169 — the gate replays the deployed dist instead of rebuilding it', () => {
  const wf = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/cathedral-seo-gates-check.yml'),
    'utf8',
  );
  /** Strip `#` comments so a mention in prose is not mistaken for a real step. */
  const active = wf
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('never runs its own SSG build (that is what the OOM-killer kept killing)', () => {
    expect(active).not.toMatch(/build-dist-multi-locale-merged/);
    expect(active).not.toMatch(/npm run build:ci/);
    expect(active).not.toMatch(/seo-build-data-prep/);
  });

  it('downloads the deploy run github-pages artifact and rehydrates the shards', () => {
    expect(active).toMatch(/github-pages/);
    expect(active).toMatch(/rehydrate-locale-shards\.sh/);
    expect(active).toMatch(/rehydrate-section-shards\.sh/);
  });

  it('asserts dist/ is complete BEFORE the gates run, so a degraded rehydrate cannot file a bogus regression', () => {
    const assertAt = active.indexOf('node scripts/ci/assert-dist-complete.mjs');
    // The RUN of the checker, not the `paths:` trigger that names the same file.
    const gatesAt = active.indexOf('node scripts/cathedral-seo-gates-check.mjs');
    expect(assertAt).toBeGreaterThan(-1);
    expect(gatesAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(gatesAt);
  });

  it('has the actions:read permission the cross-run artifact download needs', () => {
    expect(active).toMatch(/actions:\s*read/);
  });

  it('the OOM-ing composite action is gone and nothing references it any more', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, '.github/actions/build-dist-multi-locale-merged'))).toBe(
      false,
    );
    const wfDir = path.join(REPO_ROOT, '.github/workflows');
    for (const name of fs.readdirSync(wfDir)) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
      const body = fs.readFileSync(path.join(wfDir, name), 'utf8');
      expect(body, `${name} still USES the deleted action`).not.toMatch(
        /uses:\s*\.\/\.github\/actions\/build-dist-multi-locale-merged/,
      );
    }
  });

  it('keeps every referenced helper on disk', () => {
    for (const rel of [
      'scripts/ci/assert-dist-complete.mjs',
      'scripts/lib/rehydrate-locale-shards.sh',
      'scripts/lib/rehydrate-section-shards.sh',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });
});

/**
 * Issue #5528 — the title-length gate false-failed on organic volume growth.
 *
 * audit-title-length.mjs (and audit-text-html-ratio.mjs, and
 * audit-title-no-disambig-hash.mjs) already run a composition-shift-aware
 * ratchet internally (scripts/lib/mixAdjustedRateGate.mjs) and encode the
 * verdict in their own `--json` exit code. evaluateGate() used to ignore that
 * exit code entirely and re-derive `regressed`/`pass` from a raw
 * current-vs-baseline OFFENDER COUNT comparison — exactly the
 * composition-shift-BLIND check mixAdjustedRateGate.mjs exists to replace.
 * On 2026-08-10 dist/'s blog-post population grew between the baseline and a
 * run, so the raw count grew with it (4290 -> 4647) even though
 * audit-title-length.mjs's own rate-adjusted check reported no regression —
 * and the naive wrapper comparison opened issue #5528 anyway.
 *
 * `usesOwnRatchet: true` makes evaluateGate() trust the audit's exit code for
 * gates that already compute this correctly. These tests spawn a fake audit
 * (a `node -e` one-liner) so the exact 2026-08-10 numbers can be pinned
 * without needing a real dist/ build.
 */
/**
 * Issue #5830 — the live cathedral-seo-gates-check.yml run after the heap fix
 * (#5820/#5553) still reported `orphan-sitemap-pages: status=error current=?
 * baseline=?`. Root cause: evaluateGate() bailed out with a generic "Could
 * not parse audit output as JSON" error BEFORE ever calling extractCurrent —
 * audit-orphan-pages-in-sitemaps.mjs prints a human table (no braces/brackets)
 * to stdout, so `tryParseJson(result.stdout)` always returns null for this
 * gate, and the freshness-checked report-file reader added for #5169
 * (readable via `extract({}, ...)` directly, see above) was dead code on the
 * real evaluateGate() path. `readsOwnReport: true` on the gate spec now tells
 * evaluateGate() to skip that early bail and call extractCurrent regardless.
 * These tests spawn a real child process (unlike the direct `extract(...)`
 * calls above) so they exercise the exact code path the live run takes.
 */
describe('#5830 — evaluateGate() must not swallow a readsOwnReport gate before extractCurrent runs', () => {
  const fakeReportGate = (overrides = {}) => ({
    name: 'fake-report-gate',
    // Mimics audit-orphan-pages-in-sitemaps.mjs: a human table, no JSON, on stdout.
    cmd: ['node', '-e', 'process.stdout.write("Mode: x\\nTOTAL   10   2   20.0%\\n");'],
    auditCmd: 'npm run fake-report-gate',
    rebaselineCmd: 'npm run fake-report-gate:rebaseline',
    baselineFile: null,
    readsOwnReport: true,
    extractCurrent: () => 2,
    extractBaseline: () => 0,
    notes: 'fake gate for #5830 regression test',
    ...overrides,
  });

  it('calls extractCurrent (readsOwnReport) even though stdout is not JSON', async () => {
    const entry = await evaluateGate(fakeReportGate());
    expect(entry.status).not.toBe('error');
    expect(entry.current).toBe(2);
  });

  it('still surfaces extractCurrent\'s own error (e.g. a stale/missing report) instead of the generic parse message', async () => {
    const entry = await evaluateGate(
      fakeReportGate({
        extractCurrent: () => {
          throw new Error('data/orphan-pages-audit.json is stale');
        },
      }),
    );
    expect(entry.status).toBe('error');
    expect(entry.error).toMatch(/stale/);
    expect(entry.error).not.toMatch(/Could not parse audit output as JSON/);
  });

  it('a gate WITHOUT readsOwnReport still bails with the generic parse error on non-JSON stdout (no regression)', async () => {
    const entry = await evaluateGate(
      fakeReportGate({
        readsOwnReport: false,
        extractCurrent: () => {
          throw new Error('should never be called');
        },
      }),
    );
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('Could not parse audit output as JSON.');
  });

  it('the real orphan-sitemap-pages gate spec is marked readsOwnReport', () => {
    const gate = (GATES as Array<Record<string, unknown>>).find(
      (g) => g.name === 'orphan-sitemap-pages',
    )!;
    expect(gate.readsOwnReport).toBe(true);
  });
});

describe('#5528 — usesOwnRatchet trusts the audit exit code, not a raw count delta', () => {
  const fakeGate = (overrides) => ({
    name: 'fake-gate',
    cmd: ['node', '-e', overrides.script],
    auditCmd: 'npm run fake-gate',
    rebaselineCmd: 'npm run fake-gate:rebaseline',
    baselineFile: null,
    extractCurrent: (parsed) => Number(parsed.offenders),
    extractBaseline: () => 4290,
    notes: 'fake gate for #5528 regression tests',
    ...overrides,
  });

  it('usesOwnRatchet + exit 0 is NOT regressed even though current (4647) > baseline (4290)', async () => {
    const entry = await evaluateGate(
      fakeGate({
        usesOwnRatchet: true,
        script: 'console.log(JSON.stringify({ offenders: 4647 })); process.exit(0);',
      }),
    );
    expect(entry.current).toBe(4647);
    expect(entry.baseline).toBe(4290);
    expect(entry.delta).toBe(357);
    expect(entry.status).toBe('pass');
  });

  it('usesOwnRatchet + exit 1 IS regressed, even when the raw count went DOWN', async () => {
    const entry = await evaluateGate(
      fakeGate({
        usesOwnRatchet: true,
        script: 'console.log(JSON.stringify({ offenders: 1 })); process.exit(1);',
      }),
    );
    expect(entry.current).toBe(1);
    expect(entry.status).toBe('regressed');
  });

  it('usesOwnRatchet + exit 0 + current BELOW baseline still surfaces as an improvement', async () => {
    const entry = await evaluateGate(
      fakeGate({
        usesOwnRatchet: true,
        script: 'console.log(JSON.stringify({ offenders: 100 })); process.exit(0);',
      }),
    );
    expect(entry.status).toBe('improved');
  });

  it('WITHOUT usesOwnRatchet, the exact same #5528 payload false-fails — pins the bug this fix removes', async () => {
    const entry = await evaluateGate(
      fakeGate({
        usesOwnRatchet: false,
        script: 'console.log(JSON.stringify({ offenders: 4647 })); process.exit(0);',
      }),
    );
    expect(entry.current).toBe(4647);
    expect(entry.status).toBe('regressed');
  });

  it('exactly the four gates with their own composition-aware ratchet are marked usesOwnRatchet', () => {
    const flagged = GATES.filter((g) => g.usesOwnRatchet === true)
      .map((g) => g.name)
      .sort();
    expect(flagged).toEqual([
      'max-bfs-depth',
      'text-html-ratio',
      'title-length',
      'title-no-disambig-hash',
    ]);
    // orphan-sitemap-pages doesn't pass `--baseline` at all (its underlying
    // script doesn't even accept the flag) — the wrapper's raw comparison is
    // the ONLY check for it, so it must stay off this list. image-object-license
    // is zero-tolerance and has no ratchet to defer to either. max-bfs-depth
    // DOES pass --baseline to a script with its own rate ratchet
    // (evaluateBfsGate()) and is flagged above, not here.
    const notFlagged = GATES.filter((g) => g.usesOwnRatchet !== true)
      .map((g) => g.name)
      .sort();
    expect(notFlagged).toEqual(['image-object-license', 'orphan-sitemap-pages']);
  });
});
