/**
 * Observer for the fold of `gate:dist-quality` into `audit:all` (#5845 item 6).
 *
 * ─── What broke, and what this file is here to keep from coming back ───────
 *
 * `npm run gate:dist-quality` ran five full-corpus vitest scans in ONE worker
 * pool. Run 31891126686 (2026-08-15) measured the ending: 4 of 5 files failed
 * and the pool died `ERR_WORKER_OUT_OF_MEMORY` after 597.95 s under
 * `--max-old-space-size=4096`, against the 3,798,763 HTML files dist/ held on
 * 2026-08-14. Four of those five invariants are now auditors registered in
 * `scripts/audit-all.mjs`, riding the single sampled walk.
 *
 * Three distinct things can silently undo that, and each has its own describe:
 *
 *   1. AN AUDITOR STOPS BEING REACHABLE. A file can exist, be correct, export
 *      a perfect `factory()`, and never be in the REGISTRY — the exact shape
 *      of the orphan-gate class `tests/gate-wiring.test.ts` inventories. So
 *      the reachability assertions do not read `audit-all.mjs`'s text: they
 *      EXECUTE it against a fixture dist/ and read its own verdict line.
 *
 *   2. THE RATE CONVERSION GETS REVERTED. `link-anchor-text` is the one
 *      threshold that had to change shape — an absolute corpus-wide cap of
 *      1100 cannot survive `AUDIT_SAMPLE_RATE=0.25`. A reverted conversion
 *      leaves a gate that still passes and still reports, just ~4x too
 *      permissive. The mutation cases below are chosen so that an
 *      absolute-cap implementation turns them GREEN.
 *
 *   3. THE SAMPLED SEMANTICS OF THE CUMULATIVE GATE GET "FIXED". Someone
 *      notices `duplicate-meta-description` counts group sizes inside a 25 %
 *      slice and scales the threshold by the sample rate to compensate.
 *      `ceil(2 × 0.25) = 1` fails every page that merely HAS a description.
 *      The case below pins the declared behaviour instead.
 *
 * Fixtures are written to a temp dir, never to the repo's dist/: dist/ does
 * not exist in a sparse worktree, and merely creating it flips several
 * `existsSync(DIST)`-guarded suites from "skipped" to "running". For the same
 * reason the child processes get `AUDIT_REPORTS_DIR` pointed at the temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAudits } from '../scripts/lib/audit-runner.mjs';

import {
  createAuditor as createSingleH1Auditor,
  countH1Tags,
  factory as singleH1Factory,
} from '../scripts/audit-single-h1-per-page.mjs';
import {
  createAuditor as createDuplicateSdAuditor,
  factory as duplicateSdFactory,
} from '../scripts/audit-duplicate-structured-data.mjs';
import {
  createAuditor as createAnchorAuditor,
  factory as anchorFactory,
  MAX_ANCHORS_WITHOUT_NAME_RATE,
  MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS,
  REFERENCE_CORPUS_FILES,
} from '../scripts/audit-link-anchor-text.mjs';
import {
  createAuditor as createMetaDescAuditor,
  factory as metaDescFactory,
  MAX_DUPLICATE_PAGES_PER_DESCRIPTION,
} from '../scripts/audit-duplicate-meta-description.mjs';

const ROOT = resolve(__dirname, '..');

/** The four invariants folded out of `gate:dist-quality`. */
const FOLDED = [
  'single-h1-per-page',
  'duplicate-structured-data',
  'link-anchor-text',
  'duplicate-meta-description',
] as const;

/** Feed `html` to an auditor as if it were `dist/<name>`, then report. */
function runOn(auditor: { collect: Function; report: Function }, pages: Array<[string, string]>) {
  for (const [name, html] of pages) auditor.collect(join(ROOT, 'dist', name), html);
  return auditor.report();
}

function page(body: string, head = ''): string {
  return `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

// ─── 1. Reachability: executed, not read ─────────────────────────────────────

describe('the four folded invariants are reachable from audit-all\'s REGISTRY', () => {
  let dir: string;
  let cleanDist: string;
  let dirtyDist: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fold-dist-'));
    cleanDist = join(dir, 'clean');
    dirtyDist = join(dir, 'dirty');
    mkdirSync(cleanDist, { recursive: true });
    mkdirSync(dirtyDist, { recursive: true });

    // A page with no defect any of the four flags: one <h1>, one JSON-LD
    // block, every anchor named and descriptive, a unique description.
    const healthy = (n: number) =>
      page(
        `<h1>Pagina ${n}</h1><a href="/x${n}">Confronta i salari in Ticino ${n}</a>` +
          `<script type="application/ld+json">{"@type":"FAQPage"}</script>`,
        `<meta name="description" content="Descrizione unica numero ${n}">`,
      );
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(cleanDist, `ok-${i}.html`), healthy(i), 'utf8');
      writeFileSync(join(dirtyDist, `ok-${i}.html`), healthy(i), 'utf8');
    }

    // One page per invariant, each carrying exactly one real defect.
    writeFileSync(join(dirtyDist, 'two-h1.html'), page('<h1>Uno</h1><h1>Due</h1>'), 'utf8');
    writeFileSync(
      join(dirtyDist, 'two-faq.html'),
      page(
        '<h1>Uno</h1>' +
          '<script type="application/ld+json">{"@type":"FAQPage"}</script>' +
          '<script type="application/ld+json">{"@type":"FAQPage"}</script>',
      ),
      'utf8',
    );
    writeFileSync(join(dirtyDist, 'nameless-anchor.html'), page('<h1>Uno</h1><a href="/y"><span></span></a>'), 'utf8');
    // Three pages sharing one description → over MAX_DUPLICATE_PAGES_PER_DESCRIPTION.
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(dirtyDist, `dup-desc-${i}.html`),
        page('<h1>Uno</h1>', '<meta name="description" content="Calcolatore stipendio frontaliere">'),
        'utf8',
      );
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * The four factories, driven through the REAL runner over a fixture dist.
   *
   * WHY NOT SPAWN `scripts/audit-all.mjs` HERE. That was the first version and
   * it is red in every sparse worktree: audit-all's REGISTRY also imports
   * audit-title-length / audit-text-html-ratio, which import
   * scripts/lib/professionLandingsSections.mjs, which imports
   * `data/profession-landing-routes.json` — and `data/` (1.7 GB) is excluded
   * from a sparse checkout, so the child exits ERR_MODULE_NOT_FOUND before
   * any auditor runs. A test that is green only in CI is the class this repo
   * already carries one of (tests/noindex-builders.test.ts) and does not need
   * a second. Registry membership is asserted separately, below.
   */
  async function run(dist: string) {
    const reports = await runAudits({
      distDir: dist,
      auditors: [singleH1Factory(), duplicateSdFactory(), anchorFactory(), metaDescFactory()],
      verbose: false,
      // MUST stay false: writeAuditReport's default destination is under
      // dist/ at the repo root, and merely creating that directory flips the
      // existsSync(DIST)-guarded suites from "skipped" to "running".
      writeReports: false,
    });
    return {
      failed: reports.reports.filter((r: { passed: boolean }) => !r.passed).map((r: { name: string }) => r.name),
      byName: new Map(reports.reports.map((r: { name: string }) => [r.name, r])),
      filesScanned: reports.filesScanned,
    };
  }

  it('a healthy fixture dist is GREEN for all four', async () => {
    const { failed, filesScanned } = await run(cleanDist);
    expect(filesScanned).toBe(4);
    expect(failed, 'these auditors flagged a page with no defect').toEqual([]);
  });

  it('a fixture dist with one real defect per invariant is RED for all four', async () => {
    const { failed } = await run(dirtyDist);
    for (const name of FOLDED) {
      expect(
        failed,
        `${name} did not flag its own offender fixture — the auditor runs but does not gate`,
      ).toContain(name);
    }
  });

  it('all four are registered in audit-all\'s REGISTRY under their own reported name', () => {
    // Text, deliberately: importing audit-all.mjs would run main() (it calls
    // it at module scope) and pull the data/-reading auditors described above.
    // Non-vacuous because the name asserted is not a literal in this file's
    // expectation but the one the auditor itself reports at runtime.
    const src = readFileSync(join(ROOT, 'scripts', 'audit-all.mjs'), 'utf8');
    const registry = /const REGISTRY = \[([\s\S]*?)\n\];/.exec(src)?.[1];
    expect(registry, 'the REGISTRY array is no longer parseable out of audit-all.mjs').toBeTruthy();

    const live = [singleH1Factory(), duplicateSdFactory(), anchorFactory(), metaDescFactory()];
    expect(live.map((a) => a.name).sort()).toEqual([...FOLDED].sort());

    for (const auditor of live) {
      const file = `./audit-${auditor.name}.mjs`;
      expect(src, `audit-all.mjs does not import ${file}`).toContain(`from '${file}'`);
      expect(
        registry,
        `'${auditor.name}' is not in audit-all's REGISTRY — the auditor exists, is correct, ` +
          'and never runs. That is the orphan-gate class tests/gate-wiring.test.ts inventories.',
      ).toContain(`name: '${auditor.name}'`);
    }
  });

  it('every folded auditor keeps its QUALITY classification after the move', async () => {
    // Before the fold these four failed under the single gate name
    // `dist:quality-tests`, classified QUALITY. As `audit:all/<name>` they are
    // new names to the classifier, and everything unlisted is deploy-blocking
    // by default-deny — so an omission here does not fail loudly, it quietly
    // starts sequestering `publish` for a cosmetic defect (#4828's failure
    // mode, re-entering through the bundle).
    const { QUALITY_GATES } = await import('../scripts/ci/classify-validate-dist-failures.mjs');
    for (const name of FOLDED) {
      expect(Object.keys(QUALITY_GATES)).toContain(`audit:all/${name}`);
    }
    expect(Object.keys(QUALITY_GATES)).toContain('dist:quality-tests');
  });

  it('each folded auditor has a standalone npm script, like every registered sibling', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of FOLDED) {
      expect(pkg.scripts[`audit:${name}`], `audit:${name} is not an npm script`).toContain(
        `scripts/audit-${name}.mjs`,
      );
    }
    // The fifth file stays in the vitest gate, and RUN_DIST_GATES=1 must stay
    // set on that line: it is the only setter of the switch the four vitest
    // mirrors read, and tests/gate-wiring.test.ts's empty `unsetTestSwitches`
    // baseline depends on it.
    expect(pkg.scripts['gate:dist-quality']).toContain('RUN_DIST_GATES=1');
    expect(pkg.scripts['gate:dist-quality']).toContain('related-search-clusters-emitted.test.ts');
    for (const stale of [
      'tests/dist-single-h1-per-page.test.ts',
      'tests/dist-duplicate-structured-data.test.ts',
      'tests/dist-link-anchor-text.test.ts',
      'tests/dist-duplicate-meta-description.test.ts',
    ]) {
      expect(
        pkg.scripts['gate:dist-quality'],
        `${stale} is back in gate:dist-quality — it now runs TWICE, and the vitest ` +
          'copy is the half that OOM\'d (run 31891126686).',
      ).not.toContain(stale);
    }
  });
});

// ─── 2. The rate conversion, pinned by mutation ──────────────────────────────

describe('link-anchor-text: the absolute cap really became a rate', () => {
  it('the rate is DERIVED from the two documented constants, not a magic number', () => {
    expect(MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS).toBe(1100);
    expect(REFERENCE_CORPUS_FILES).toBe(3_798_763);
    expect(MAX_ANCHORS_WITHOUT_NAME_RATE).toBeCloseTo(1100 / 3_798_763, 12);
    // Equivalence, stated as the arithmetic it is: at the corpus size the
    // absolute cap was written against, the two thresholds fire together.
    expect(Math.round(MAX_ANCHORS_WITHOUT_NAME_RATE * REFERENCE_CORPUS_FILES)).toBe(
      MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS,
    );
  });

  it('reports a rate threshold, not a count', () => {
    const r = runOn(createAnchorAuditor(), [['a.html', page('<a href="/x">Testo</a>')]]);
    expect(r.threshold).toEqual({ metric: 'rate', value: MAX_ANCHORS_WITHOUT_NAME_RATE, comparator: '<=' });
  });

  it('MUTATION: a small corpus dense in offenders is RED — an absolute cap would pass it', () => {
    // 1000 pages, 5 unnamed anchors. Rate 5e-3, ~17x the cap → must FAIL.
    // Under the pre-fold `offending > 1100` the same input is 5 < 1100 → PASS.
    // Revert the conversion and this assertion is the one that goes green.
    const auditor = createAnchorAuditor();
    const pages: Array<[string, string]> = [];
    for (let i = 0; i < 995; i++) pages.push([`ok-${i}.html`, page(`<a href="/x">Descrizione ${i}</a>`)]);
    for (let i = 0; i < 5; i++) pages.push([`bad-${i}.html`, page('<a href="/y"><span></span></a>')]);
    const r = runOn(auditor, pages);
    expect(r.passed).toBe(false);
    expect(r.extra.filesScanned).toBe(1000);
    expect(r.extra.unnamedAnchors).toBe(5);
    expect(r.extra.unnamedAnchorRate).toBeCloseTo(0.005, 6);
    expect(r.humanSummary).toContain('>');
  });

  it('MUTATION: the verdict does not move when the corpus doubles at equal density', () => {
    // The property an absolute cap does NOT have. Same defect density, two
    // corpus sizes, one verdict — this is what makes the gate survive both
    // AUDIT_SAMPLE_RATE=0.25 and organic dist/ growth.
    const density = (files: number, bad: number) => {
      const pages: Array<[string, string]> = [];
      for (let i = 0; i < files - bad; i++) pages.push([`ok-${i}.html`, page(`<a href="/x">Testo ${i}</a>`)]);
      for (let i = 0; i < bad; i++) pages.push([`bad-${i}.html`, page('<a href="/y"><span></span></a>')]);
      return runOn(createAnchorAuditor(), pages);
    };
    const small = density(4000, 1); // rate 2.5e-4 — just under the cap
    const large = density(8000, 2); // identical rate on twice the corpus
    expect(small.passed).toBe(true);
    expect(large.passed).toBe(true);
    expect(large.extra.unnamedAnchorRate).toBeCloseTo(small.extra.unnamedAnchorRate, 12);
  });

  it('the artifact says which number the verdict was taken on', () => {
    // writeAuditReport derives the report's `offendersTotal` from the offender
    // ARRAY, which this auditor must truncate (millions of unnamed anchors are
    // possible). A reader who takes that field for the count reads the sample
    // size — the "topOffenders depista" trap. The true count must be stated,
    // and the truncation must be flagged.
    const pages: Array<[string, string]> = [];
    for (let i = 0; i < 200; i++) pages.push([`bad-${i}.html`, page('<a href="/y"><span></span></a>')]);
    const r = runOn(createAnchorAuditor(), pages);
    expect(r.extra.offendersTotalTrue).toBe(200);
    expect(r.offenders.length).toBeLessThan(r.extra.offendersTotalTrue);
    expect(r.extra.offendersListTruncated).toBe(true);
  });

  it('a run that scanned nothing invents no verdict in either direction', () => {
    const r = createAnchorAuditor().report();
    expect(r.extra.filesScanned).toBe(0);
    expect(r.extra.unnamedAnchorRate).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('the non-descriptive half stays zero-tolerance and needs no denominator', () => {
    const r = runOn(createAnchorAuditor(), [['a.html', page('<a href="/x">leggi tutto</a>')]]);
    expect(r.passed).toBe(false);
    expect(r.extra.nonDescriptiveTotal).toBe(1);
    // Named anchors with real text are not offenders of either half.
    const ok = runOn(createAnchorAuditor(), [['a.html', page('<a href="/x">Stipendi in Ticino</a>')]]);
    expect(ok.passed).toBe(true);
  });

  it('an accessible name from aria-label / alt / svg title still counts as named', () => {
    const r = runOn(createAnchorAuditor(), [
      ['a.html', page('<a href="/x" aria-label="Vai ai salari"><span></span></a>')],
      ['b.html', page('<a href="/y"><img src="/i.png" alt="Grafico salari"></a>')],
      ['c.html', page('<a href="/z"><svg role="img"><title>Salari</title></svg></a>')],
    ]);
    expect(r.extra.unnamedAnchors).toBe(0);
    expect(r.passed).toBe(true);
  });
});

// ─── 3. The cumulative gate's declared sampling semantics ────────────────────

describe('duplicate-meta-description: sampled group sizes, declared', () => {
  const dup = (n: number): Array<[string, string]> =>
    Array.from({ length: n }, (_, i) => [
      `p-${i}.html`,
      page('<h1>x</h1>', '<meta name="description" content="Calcolatore stipendio frontaliere">'),
    ]);

  it('flags a group larger than the threshold, within the scanned set', () => {
    const r = runOn(createMetaDescAuditor(), dup(MAX_DUPLICATE_PAGES_PER_DESCRIPTION + 1));
    expect(r.passed).toBe(false);
    expect(r.offenders[0].metric).toBe(3);
  });

  it('MUTATION: the threshold is NOT scaled by the sample rate', () => {
    // Scaling it (`ceil(2 × 0.25) = 1`) is the tempting "fix" for the recall
    // loss and it fails every page that merely HAS a description. A group of
    // exactly 2 must stay green at any sample rate.
    for (const sampleRate of [1, 0.25, 0.1]) {
      const r = runOn(createMetaDescAuditor({ sampleRate }), dup(MAX_DUPLICATE_PAGES_PER_DESCRIPTION));
      expect(r.passed, `a 2-page group went red at sampleRate=${sampleRate}`).toBe(true);
      expect(r.threshold.value).toBe(MAX_DUPLICATE_PAGES_PER_DESCRIPTION);
    }
  });

  it('states the recall it loses when sampling is on, and says so in the report', () => {
    const sampled = runOn(createMetaDescAuditor({ sampleRate: 0.25 }), dup(3));
    expect(sampled.extra.samplingSemantics).toMatch(/no false positives/i);
    expect(sampled.extra.samplingSemantics).toMatch(/recall/i);
    expect(sampled.extra.samplingSemantics).toMatch(/not proof/i);
    const full = runOn(createMetaDescAuditor({ sampleRate: 1 }), dup(3));
    expect(full.extra.samplingSemantics).toMatch(/corpus-exact/i);
  });

  it('the by-design duplicate allowlist is honoured', () => {
    const r = runOn(
      createMetaDescAuditor(),
      Array.from({ length: 5 }, (_, i) => [
        `e-${i}.html`,
        page('<h1>x</h1>', '<meta name="description" content="Pagina non trovata — 404">'),
      ]),
    );
    expect(r.passed).toBe(true);
  });

  it('reads a quote-stripped description, which is the shape dist/ actually has', () => {
    // dist-shrink.mjs's removeAttributeQuotes is why the pre-fix local reader
    // saw 200/200 job pages as "missing" (PR #478 / issue #5412).
    const r = runOn(createMetaDescAuditor(), [
      ['a.html', '<html><head><meta name=description content="Stessa riga"></head><body></body></html>'],
      ['b.html', '<html><head><meta name=description content="Stessa riga"></head><body></body></html>'],
      ['c.html', '<html><head><meta name=description content="Stessa riga"></head><body></body></html>'],
    ]);
    expect(r.passed).toBe(false);
    expect(r.offenders[0].metric).toBe(3);
  });
});

// ─── 4. The two per-page invariants that needed no conversion ────────────────

describe('single-h1-per-page: per-page, zero tolerance, denominator-free', () => {
  it('one <h1> passes, two fail, and the count is reported', () => {
    expect(runOn(createSingleH1Auditor(), [['a.html', page('<h1>Uno</h1>')]]).passed).toBe(true);
    const bad = runOn(createSingleH1Auditor(), [['a.html', page('<h1>Uno</h1><h1>Due</h1>')]]);
    expect(bad.passed).toBe(false);
    expect(bad.offenders[0].metric).toBe(2);
  });

  it('the verdict for one page does not depend on how many others were scanned', () => {
    // The property that makes sampling free for this invariant: recall drops,
    // correctness does not. Same offender, two corpus sizes, same verdict.
    const withNoise = (n: number) => {
      const pages: Array<[string, string]> = [['bad.html', page('<h1>Uno</h1><h1>Due</h1>')]];
      for (let i = 0; i < n; i++) pages.push([`ok-${i}.html`, page('<h1>Solo uno</h1>')]);
      return runOn(createSingleH1Auditor(), pages);
    };
    expect(withNoise(1).passed).toBe(false);
    expect(withNoise(500).passed).toBe(false);
    expect(withNoise(1).offenders.length).toBe(withNoise(500).offenders.length);
    expect(withNoise(500).threshold).toEqual({ metric: 'count', value: 0, comparator: '<=' });
  });

  it('h1 inside script / template / comments is not an h1 (mirror parity)', () => {
    expect(countH1Tags('<h1>a</h1><script><h1>b</h1></script>')).toBe(1);
    expect(countH1Tags('<h1>a</h1><template><h1>b</h1></template>')).toBe(1);
    expect(countH1Tags('<h1>a</h1><!-- <h1>b</h1> -->')).toBe(1);
    expect(countH1Tags('<h1 class="x">a</h1><h1>b</h1>')).toBe(2);
  });
});

describe('duplicate-structured-data: per-page, zero tolerance', () => {
  const ld = (type: string) => `<script type="application/ld+json">{"@type":"${type}"}</script>`;

  it('two FAQPage blocks on one page fail; one passes', () => {
    expect(runOn(createDuplicateSdAuditor(), [['a.html', page(ld('FAQPage'))]]).passed).toBe(true);
    const bad = runOn(createDuplicateSdAuditor(), [['a.html', page(ld('FAQPage') + ld('FAQPage'))]]);
    expect(bad.passed).toBe(false);
    expect(bad.offenders[0]).toMatchObject({ type: 'FAQPage', metric: 2 });
  });

  it('a type outside UNIQUE_TYPES is tolerated, and malformed JSON is not an offender', () => {
    // Widening UNIQUE_TYPES would block a deploy on pre-existing offenders;
    // an unparseable block is a different (separately gated) defect.
    expect(runOn(createDuplicateSdAuditor(), [['a.html', page(ld('Organization') + ld('Organization'))]]).passed).toBe(true);
    const broken = '<script type="application/ld+json">{ not json</script>';
    expect(runOn(createDuplicateSdAuditor(), [['a.html', page(broken + broken)]]).passed).toBe(true);
  });

  it('the same two blocks split across two pages are not a duplicate', () => {
    const r = runOn(createDuplicateSdAuditor(), [
      ['a.html', page(ld('FAQPage'))],
      ['b.html', page(ld('FAQPage'))],
    ]);
    expect(r.passed).toBe(true);
    expect(r.extra.filesScanned).toBe(2);
  });
});
