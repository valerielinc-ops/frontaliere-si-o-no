import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * #5130 follow-up — attribute the largest unexplained cost in the build.
 *
 * On run 31036546298 (`build-locale (it)`), `jobs-seo-pages` is 1798 s of a
 * 4062 s Build and `ph:ejp:shell` is its biggest single measured item at
 * 275,773 ms over 178,828 pages. But that timer bracketed the CALL SITE, and
 * its two inner timers only accounted for 23.0 s of it:
 *
 *   ph:ejp:shell        275,773 ms   ← outer, the whole block
 *   ph:ejp:shell:tpl      1,056 ms   ← template literal assembly
 *   ph:ejp:shell:minify  21,970 ms   ← the newline-indent collapse
 *
 * ~253 s had no name. The block also contained `trafficFilter.decideMulti`
 * and `buildSoftLandingThinHtml`, neither of which was timed — and 149,099 of
 * the 178,828 pages (83%) take the thin path, so the second one runs on five
 * pages out of six. This splits the block into `ejp:decide` / `ejp:shell` /
 * `ejp:thin` so the next deploy says which it is, instead of a rewrite being
 * aimed at a guess. (The repo has been burned by that before — see
 * docs/AGENTS-HISTORY.md#unvalidated-perf-claim.)
 *
 * These are source-shape assertions on purpose: the emission loop cannot be
 * exercised without a full SSG build, and the property that matters is
 * structural — the tier decision must be computed from the candidate paths
 * BEFORE the HTML exists, and must be computed exactly once.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');

/** Source with `//` comment lines removed, so prose is never a match. */
const CODE = SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

describe('#5130 — expired soft-landing phases are individually attributable', () => {
  // Since #17486 (2026-11-08) every expired archive page publishes its full
  // body: the thin tier, its traffic decision and the ph:ejp:thin timer are
  // gone by design. The timers that remain must still split the shell build.
  it('emits the phase timers of the full-body path', () => {
    for (const phase of ['ejp:decide', 'ejp:shell']) {
      expect(CODE, phase).toContain(`recordPhase('${phase}'`);
    }
  });

  it('decides the tier BEFORE the HTML is built, and only the full tier exists', () => {
    const decideAt = CODE.indexOf("recordPhase('ejp:decide', __tEjpDecide)");
    const buildAt = CODE.indexOf('const __slFullHtml = buildSoftLandingHtml(');
    expect(decideAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(decideAt).toBeLessThan(buildAt);
    expect(CODE).toContain("const __slAction: 'full' = 'full'");
  });

  it('takes the tier decision exactly once (hoisting must not duplicate it)', () => {
    const actionAssignments = CODE.split(/const __slAction:\s*'full'\s*=/).length - 1;
    expect(actionAssignments).toBe(1);
  });

  it('keeps ph:ejp:shell measuring the HTML build only, so it stays comparable to its sub-timers', () => {
    const buildAt = CODE.indexOf('const __slFullHtml = buildSoftLandingHtml(');
    const shellRecordAt = CODE.indexOf("recordPhase('ejp:shell', __tEjpShell)");
    expect(shellRecordAt).toBeGreaterThan(buildAt);
    // No thin conversion can be swallowed by the shell timer: none runs on expired pages (#17486).
    expect(CODE).not.toContain('buildSoftLandingThinHtml(__slFullHtml, locale)');
  });

  it('the decision timer wraps only the decision, not the build', () => {
    const decideTimerAt = CODE.indexOf('const __tEjpDecide = phaseTimer()');
    const decideRecordAt = CODE.indexOf("recordPhase('ejp:decide', __tEjpDecide)");
    const buildAt = CODE.indexOf('const __slFullHtml = buildSoftLandingHtml(');
    expect(decideTimerAt).toBeGreaterThan(-1);
    expect(decideRecordAt).toBeGreaterThan(decideTimerAt);
    expect(decideRecordAt).toBeLessThan(buildAt);
  });
});

describe('#5130 — the same split is applied to the cluster sibling (AGENTS.md #6)', () => {
  const CLUSTER = fs.readFileSync(
    path.join(REPO_ROOT, 'build-plugins/relatedSearchClustersPlugin.ts'),
    'utf8',
  );
  const CLUSTER_CODE = CLUSTER.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('names the decide and thin phases there too', () => {
    // `render-cluster-page` was 111,523 ms over 80,368 pages as one bucket, and
    // `cluster tier: full=5601 thin=74767` means 93% take the thin path. Same
    // shape as ph:ejp:shell — fixed as a class, not just on the instance that
    // happened to be measured first.
    expect(CLUSTER_CODE).toContain("profileRecord('cluster-decide'");
    expect(CLUSTER_CODE).toContain("profileRecord('cluster-thin'");
  });

  /**
   * The per-context EMIT block: from the render call to the end-of-iteration
   * timer. Scoping matters now that the plugin has a second, legitimate
   * producer — the locale-shard render-skip path decides for contexts this
   * shard does not render (#5242). Counting decisions file-wide would make
   * "exactly once" meaningless; counting them per branch keeps it exact.
   */
  function sliceBetween(from: string, to: string): string {
    const start = CLUSTER_CODE.indexOf(from);
    const end = CLUSTER_CODE.indexOf(to);
    // Fail loudly on a moved anchor instead of silently slicing garbage — a
    // bad slice would otherwise read as "zero decisions", i.e. a green-looking
    // shape assertion that stopped inspecting anything.
    expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
    expect(end, `anchor not found: ${to}`).toBeGreaterThan(start);
    return CLUSTER_CODE.slice(start, end);
  }

  const EMIT_BLOCK = () =>
    sliceBetween('const out = renderClusterPage({', "profileRecord('render-cluster-page'");
  const SKIP_BLOCK = () =>
    sliceBetween('if (!shouldEmitLocale(locale)) {', 'const altKey = familyKeyByCtx.get(ctx)');

  const DECISION_PREPASS = () =>
    sliceBetween('const __tClusterDecide = profileStart();', 'const __tGroupHreflang = profileStart();');

  it('keeps the decision before the thin conversion and each timer on its own phase', () => {
    // The decision moved behind `decideClusterEmission()` (#5242) — it builds
    // the candidate paths and calls `decideMulti` itself — but the property
    // #5130 defends is unchanged: the tier is decided from candidate PATHS
    // before the HTML is touched, and neither timer swallows the other's phase.
    const prepass = DECISION_PREPASS();
    const block = EMIT_BLOCK();
    const decideAt = prepass.indexOf('const emission = decideClusterEmission({');
    const decideRecordAt = prepass.indexOf("profileRecord('cluster-decide'");
    const thinAt = block.indexOf('buildClusterThinHtml(out.html, locale');
    const thinRecordAt = block.indexOf("profileRecord('cluster-thin'");
    expect(decideAt).toBeGreaterThan(-1);
    expect(decideAt).toBeLessThan(decideRecordAt);
    expect(block.indexOf('const __clEmission = emissionByCtx.get(ctx);')).toBeGreaterThan(-1);
    expect(thinAt).toBeGreaterThan(-1);
    expect(thinAt).toBeLessThan(thinRecordAt);
  });

  it('decides once in the prepass and reuses the cached result', () => {
    expect(DECISION_PREPASS().split('decideClusterEmission(').length - 1).toBe(1);
    expect(EMIT_BLOCK().split('decideClusterEmission(').length - 1).toBe(0);
    expect(CLUSTER_CODE.split('.decideMulti(').length - 1).toBe(1);
  });

  it('reuses the prepass decision in the render-skip path', () => {
    // The second producer runs the same decision for the locales this shard
    // does not render. It reads the cached result so it cannot diverge from
    // the owner path while the decision remains timed in the prepass.
    const block = SKIP_BLOCK();
    expect(block.split('decideClusterEmission(').length - 1).toBe(0);
    expect(block).toContain('const __skEmission = emissionByCtx.get(ctx);');
  });
});
