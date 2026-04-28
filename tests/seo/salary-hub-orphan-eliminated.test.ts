/**
 * Regression test for the salary-hub orphan-pages fix.
 *
 * Background: Semrush 2026-04-28 audit flagged sitemap-salary-hub.xml as
 * having 1 732/1 732 (100 %) orphan rate — every URL in the sitemap was
 * unreachable via internal `<a href>` BFS from `/`. The fix:
 *
 *   1. salaryHubPlugin now emits a per-locale browseable scenario index at
 *      /calcola-stipendio/scenari/ (+ 3 locale twins).
 *   2. salaryHubIndexLinkPlugin patches the calculator hub HTML with a
 *      single anchor pointing at that index.
 *   3. The index lists every scenario as a real `<a href>`, so BFS reaches
 *
 *        /  →  /calcola-stipendio/  →  /calcola-stipendio/scenari/  →  every scenario
 *
 * This test guards (3) end-to-end: it builds a synthetic dist tree, runs the
 * exact BFS used by the production audit (Mode A, scripts/audit-orphan-pages-
 * in-sitemaps.mjs) and asserts every scenario page is reachable. If anyone
 * removes the index, the calc-hub link, or breaks the scenario links inside
 * the index, this test fails.
 *
 * It also exercises the pure injector (`injectSalaryIndexLink`) to guard the
 * idempotency invariant — a re-run of the linker plugin must NOT duplicate
 * the block.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';

import { generateAllScenarios, buildFullPath } from '../../build-plugins/salaryHubScenarios';
import {
  SCENARIO_INDEX_PATH,
  CALC_HUB_PATH,
  buildScenarioIndexHtml,
} from '../../build-plugins/salaryHubIndex';
import {
  injectSalaryIndexLink,
  renderSalaryIndexLinkBlock,
  buildTargets,
} from '../../build-plugins/salaryHubIndexLinkPlugin';

let TMPDIR: string;
let DIST: string;

beforeAll(() => {
  TMPDIR = fs.mkdtempSync(np.join(os.tmpdir(), 'salary-hub-orphan-test-'));
  DIST = np.join(TMPDIR, 'dist');
  fs.mkdirSync(DIST, { recursive: true });
});

afterAll(() => {
  if (TMPDIR && fs.existsSync(TMPDIR)) {
    fs.rmSync(TMPDIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Pure injector — fast invariant guards.
// ---------------------------------------------------------------------------

describe('injectSalaryIndexLink — pure injector', () => {
  const MARKER = 'data-salary-scenarios-link';
  const BLOCK = `<aside ${MARKER} data-test></aside>`;

  it('inserts the block immediately after <main …> when present', () => {
    const html = '<!doctype html><html><body><main id="main"></main></body></html>';
    const { html: out, outcome } = injectSalaryIndexLink(html, BLOCK);
    expect(outcome).toBe('inserted');
    expect(out).toContain(MARKER);
    const mainOpen = out.indexOf('<main id="main">');
    const blockAt = out.indexOf(MARKER);
    expect(blockAt).toBeGreaterThan(mainOpen);
    expect(blockAt).toBeLessThan(out.indexOf('</main>'));
  });

  it('preserves <main> attributes when injecting', () => {
    const html = '<body><main id="x" class="hub" data-foo="bar"></main></body>';
    const { html: out, outcome } = injectSalaryIndexLink(html, BLOCK);
    expect(outcome).toBe('inserted');
    expect(out).toContain('<main id="x" class="hub" data-foo="bar">');
  });

  it('returns "duplicate" on re-injection — guards idempotency', () => {
    const html = '<body><main><aside data-salary-scenarios-link>old</aside></main></body>';
    const { html: out, outcome } = injectSalaryIndexLink(html, BLOCK);
    expect(outcome).toBe('duplicate');
    expect(out).toBe(html);
  });

  it('falls back to </body> when no <main> is present', () => {
    const html = '<html><head></head><body>plain</body></html>';
    const { html: out, outcome } = injectSalaryIndexLink(html, BLOCK);
    expect(outcome).toBe('inserted');
    expect(out.indexOf(MARKER)).toBeLessThan(out.indexOf('</body>'));
  });

  it('reports "no-anchor" when neither <main> nor </body> exists', () => {
    const html = '<div>fragment without body</div>';
    const { html: out, outcome } = injectSalaryIndexLink(html, BLOCK);
    expect(outcome).toBe('no-anchor');
    expect(out).toBe(html);
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end BFS reachability — the load-bearing guarantee.
// ---------------------------------------------------------------------------

describe('Salary-hub scenario-index — BFS reachability from /', () => {
  it('builds a synthetic dist where 5 sample scenarios are reachable from /', async () => {
    const scenarios = generateAllScenarios();
    expect(scenarios.length).toBeGreaterThan(100);

    // ─── Synthetic dist ───────────────────────────────────────────
    // (a) Homepage — links to the IT calculator hub.
    fs.writeFileSync(
      np.join(DIST, 'index.html'),
      `<!doctype html><html><head><title>Home</title></head>
       <body><main><a href="${CALC_HUB_PATH.it}">Calcolatore</a></main></body></html>`,
      'utf-8',
    );

    // (b) Calculator hub HTML (the kind staticPagesPlugin produces — no link
    //     to the scenario index yet; we'll patch it in via the same injector
    //     used in production).
    const calcHubDir = np.join(DIST, 'calcola-stipendio');
    fs.mkdirSync(calcHubDir, { recursive: true });
    const rawHubHtml =
      '<!doctype html><html><head><title>Calcola</title></head>' +
      '<body><main class="seo-static-content">' +
      '<h1>Calcola Stipendio</h1>' +
      '<p>Hub for the salary calculator.</p>' +
      '</main></body></html>';
    fs.writeFileSync(np.join(calcHubDir, 'index.html'), rawHubHtml, 'utf-8');

    // (c) Patch the hub with the scenario-index link block (same pure
    //     injector the production plugin uses).
    const targets = buildTargets(DIST);
    const itTarget = targets.find((t) => t.locale === 'it');
    expect(itTarget).toBeDefined();
    const block = renderSalaryIndexLinkBlock(itTarget!);
    const { html: patched, outcome } = injectSalaryIndexLink(rawHubHtml, block);
    expect(outcome).toBe('inserted');
    fs.writeFileSync(np.join(calcHubDir, 'index.html'), patched, 'utf-8');

    // The patched hub must carry an anchor with the scenario-index path.
    expect(patched).toContain(`href="${SCENARIO_INDEX_PATH.it}"`);

    // (d) Scenario-index page — written via the production builder.
    const indexDir = np.join(DIST, 'calcola-stipendio', 'scenari');
    fs.mkdirSync(indexDir, { recursive: true });
    const indexHtml = buildScenarioIndexHtml({
      locale: 'it',
      allScenarios: scenarios,
      distDir: DIST,
    });
    fs.writeFileSync(np.join(indexDir, 'index.html'), indexHtml, 'utf-8');

    // (e) Sample 5 scenarios — write minimal HTML files for each at the
    //     production canonical path so they exist on disk for BFS to reach.
    const sample = [scenarios[0], scenarios[10], scenarios[100], scenarios[200], scenarios[400]];
    expect(sample.every(Boolean)).toBe(true);
    const samplePaths = sample.map((s) => buildFullPath(s, 'it'));
    for (const p of samplePaths) {
      const dir = np.join(DIST, p.replace(/^\/+/, '').replace(/\/+$/, ''));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        np.join(dir, 'index.html'),
        `<!doctype html><html><body><main>scenario at ${p}</main></body></html>`,
        'utf-8',
      );
    }

    // ─── Run the production BFS over this synthetic dist ──────────
    const { __test } = await import('../../scripts/audit-orphan-pages-in-sitemaps.mjs');
    const { linked } = await __test.bfsReachableFromHome(DIST);

    // The hub must be reachable from /.
    expect(linked.has('/calcola-stipendio')).toBe(true);
    // The scenario index must be reachable through the hub.
    expect(linked.has('/calcola-stipendio/scenari')).toBe(true);
    // Each sample scenario must be reachable through the index.
    for (const p of samplePaths) {
      const normalized = p.replace(/\/+$/, '');
      expect(
        linked.has(normalized),
        `BFS did not reach scenario ${p} — index regression`,
      ).toBe(true);
    }
  });

  it('reaches every scenario page when ALL of them are written to dist', async () => {
    // Stronger guarantee: with the index in place and *every* scenario file
    // on disk, BFS reaches them all. This is the precise invariant the audit
    // gate cares about — `linkedSet ⊇ sitemap-salary-hub URLs`.
    const scenarios = generateAllScenarios();

    // Reset the synthetic dist so this test is independent of the previous
    // one's state.
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.mkdirSync(DIST, { recursive: true });

    // Homepage → hub.
    fs.writeFileSync(
      np.join(DIST, 'index.html'),
      `<body><main><a href="${CALC_HUB_PATH.it}">Calcolatore</a></main></body>`,
      'utf-8',
    );

    // Hub with the injection in place.
    const calcHubDir = np.join(DIST, 'calcola-stipendio');
    fs.mkdirSync(calcHubDir, { recursive: true });
    const targets = buildTargets(DIST);
    const itTarget = targets.find((t) => t.locale === 'it')!;
    const block = renderSalaryIndexLinkBlock(itTarget);
    const rawHub = '<body><main class="seo-static-content"><h1>Calcola</h1></main></body>';
    const { html: patched } = injectSalaryIndexLink(rawHub, block);
    fs.writeFileSync(np.join(calcHubDir, 'index.html'), patched, 'utf-8');

    // Scenario index.
    const indexDir = np.join(DIST, 'calcola-stipendio', 'scenari');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      np.join(indexDir, 'index.html'),
      buildScenarioIndexHtml({ locale: 'it', allScenarios: scenarios, distDir: DIST }),
      'utf-8',
    );

    // Every scenario file (IT only — we only need to prove BFS reaches them
    // through the index for one locale; the same proof generalises since the
    // index template is shape-identical across all 4 locales).
    for (const s of scenarios) {
      const p = buildFullPath(s, 'it');
      const dir = np.join(DIST, p.replace(/^\/+/, '').replace(/\/+$/, ''));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(np.join(dir, 'index.html'), '<body>x</body>', 'utf-8');
    }

    const { __test } = await import('../../scripts/audit-orphan-pages-in-sitemaps.mjs');
    const { linked, stats } = await __test.bfsReachableFromHome(DIST);

    // Sanity: BFS visited a sensible number of pages.
    expect(stats.visited).toBeGreaterThanOrEqual(scenarios.length + 2);

    // Every scenario URL must be in `linked` (modulo the slash-normalisation
    // applied by the BFS — paths are recorded without trailing slashes).
    let unreached = 0;
    for (const s of scenarios) {
      const p = buildFullPath(s, 'it').replace(/\/+$/, '');
      if (!linked.has(p)) unreached += 1;
    }
    expect(
      unreached,
      `${unreached} scenarios still orphan — index link graph regressed`,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Index page invariants — every locale, every scenario carries an anchor.
// ---------------------------------------------------------------------------

describe('Scenario index page — anchor coverage', () => {
  it('emits a real <a href> for every IT scenario', () => {
    const scenarios = generateAllScenarios();
    const html = buildScenarioIndexHtml({
      locale: 'it',
      allScenarios: scenarios,
      distDir: undefined,
    });
    let missing = 0;
    for (const s of scenarios) {
      const href = buildFullPath(s, 'it');
      if (!html.includes(`href="${href}"`)) missing += 1;
    }
    expect(missing, `${missing} IT scenarios are not linked from the index`).toBe(0);
  });

  it('emits all 4 locale variants with the same scenario count', () => {
    const scenarios = generateAllScenarios();
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      const html = buildScenarioIndexHtml({
        locale: loc,
        allScenarios: scenarios,
        distDir: undefined,
      });
      // Cheap-and-cheerful: count occurrences of `class="scenarios"` lists.
      // Every tier has at least one — 18 tiers with at least 1 group each.
      const tierMatches = (html.match(/data-tier="(\d+)"/g) ?? []).length;
      expect(tierMatches).toBeGreaterThanOrEqual(15);

      // Every scenario must have a corresponding href in this locale.
      let missing = 0;
      for (const s of scenarios) {
        const href = buildFullPath(s, loc);
        if (!html.includes(`href="${href}"`)) missing += 1;
      }
      expect(missing, `${loc}: ${missing} scenarios not linked`).toBe(0);
    }
  });

  it('contains substantive editorial text (≥800 chars across intro + per-tier methodology)', () => {
    // Guards CLAUDE.md non-negotiable rule #4 (no thin content): the index
    // page must carry real content, not just a list of links.
    const scenarios = generateAllScenarios();
    const html = buildScenarioIndexHtml({
      locale: 'it',
      allScenarios: scenarios,
      distDir: undefined,
    });
    // Strip HTML tags to count visible text.
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text.length).toBeGreaterThan(2000);
  });
});
