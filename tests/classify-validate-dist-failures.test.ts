/**
 * The `publish` gate's classification contract (issues #4828, #5128).
 *
 * `publish` — Google Indexing API, IndexNow, GSC submit,
 * previous-slug-winners sync — used to be gated on
 * `needs.validate-dist.result == 'success'`. One red SEO audit therefore
 * sequestered every indexing notification: 18 consecutive runs with
 * `publish: skipped` while the site was live and updated.
 *
 * These tests pin the two properties that keep the new gate honest:
 *   1. DEFAULT-DENY — anything not explicitly classified as a quality gate
 *      blocks. A gate added to the workflow later cannot silently slip
 *      through.
 *   2. FAIL-CLOSED — an unknown/unreadable result set blocks.
 *
 * Together they are why this is not a blind `continue-on-error`.
 */
import { describe, it, expect } from 'vitest';

import {
  QUALITY_GATES,
  classifyFailures,
  evaluateIntegrity,
  parseResultRows,
} from '../scripts/ci/classify-validate-dist-failures.mjs';

describe('validate-dist failure classification', () => {
  it('lets publish run when only quality gates failed — the #5128 case', () => {
    // Exactly what run 30974294824 produced: audit:hreflang red, everything
    // else green, deploy + validate-live both success.
    const v = evaluateIntegrity(['audit:hreflang']);
    expect(v.integrityOk).toBe(true);
    expect(v.quality).toEqual(['audit:hreflang']);
    expect(v.blocking).toEqual([]);
  });

  it('blocks publish when the sitemap validators fail', () => {
    // publish submits the sitemap URL set verbatim to IndexNow + Indexing
    // API. A bad sitemap means pushing dead URLs to Google and Bing.
    for (const gate of [
      'validate:sitemap-pages',
      'validate:sitemap-links',
      'audit:sitemap-canonicals',
    ]) {
      const v = evaluateIntegrity([gate]);
      expect(v.integrityOk, `${gate} must block publish`).toBe(false);
      expect(v.blocking).toContain(gate);
    }
  });

  it('blocks when a structural gate fails alongside a quality one', () => {
    const v = evaluateIntegrity(['audit:hreflang', 'audit:no-dotfile-html']);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['audit:no-dotfile-html']);
    expect(v.quality).toEqual(['audit:hreflang']);
  });

  it('DEFAULT-DENY: an unclassified gate blocks', () => {
    // The property that keeps this from becoming a blanket bypass: a gate
    // added to the workflow tomorrow blocks until someone classifies it.
    const v = evaluateIntegrity(['audit:some-gate-invented-next-quarter']);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['audit:some-gate-invented-next-quarter']);
  });

  it('FAIL-CLOSED: an unavailable result set blocks', () => {
    expect(evaluateIntegrity(null).integrityOk).toBe(false);
    expect(evaluateIntegrity(undefined).integrityOk).toBe(false);
  });

  it('allows publish when nothing failed', () => {
    const v = evaluateIntegrity([]);
    expect(v.integrityOk).toBe(true);
    expect(v.reason).toMatch(/no gate failures/);
  });

  it('keeps the quality allowlist small and explicit', () => {
    // A growing allowlist is how "not a blind continue-on-error" erodes.
    // If this number goes up, it should be a deliberate, reviewed decision.
    //
    // Raised 6 → 14 deliberately when `audit:all` was expanded into
    // `audit:all/<auditor>` (#4828). The bundle used to arrive as ONE opaque
    // name and blocked publish for any of its 12 auditors, cosmetic included.
    // Eight of the twelve are now classified individually.
    //
    // Raised 4 → 5 top-level deliberately for `dist:quality-tests` (issue
    // #5656 item 1): five vitest RUN_DIST_GATES files, newly wired into
    // post-deploy-validate-dist.yml, running for the first time ever against
    // production dist/ — same "page renders and serves" class as
    // content-duplicates/h1-title-duplicates below.
    //
    // Raised 15 → 19 deliberately for #5845 item 6, and this one adds NO new
    // defect class: four of the five files behind `dist:quality-tests` became
    // auditors in scripts/audit-all.mjs, so the same four invariants that were
    // already classified QUALITY under one top-level name now arrive as
    // `audit:all/<name>`. Leaving them off would not have been "keeping the
    // allowlist small" — it would have re-classified four cosmetic gates as
    // deploy-invalidating by default-deny, silently, which is #4828's failure
    // mode. `dist:quality-tests` stays: the fifth file still runs under it.
    //
    // Raised 19 → 21 deliberately for issue #6462 (VISION.md driver D9):
    // `audit:all/breadcrumb-coverage` and `audit:all/information-gain` were
    // registered auditors with NO QUALITY_GATES entry, so default-deny left
    // them deploy-invalidating — despite neither checking anything Google
    // requires for indexing/rich-results. Same defect class as the other
    // `audit:all/*` entries above: a page missing either still serves.
    expect(Object.keys(QUALITY_GATES).length).toBeLessThanOrEqual(21);
    const topLevel = Object.keys(QUALITY_GATES).filter((g) => !g.startsWith('audit:all/'));
    expect(topLevel).toHaveLength(5);
    // Every entry carries a rationale string, not a bare flag.
    for (const [gate, why] of Object.entries(QUALITY_GATES)) {
      expect(String(why).length, `${gate} needs a rationale`).toBeGreaterThan(10);
    }
  });

  it('never classifies a sitemap or dist-integrity gate as quality', () => {
    // Guards the allowlist against future edits that would let publish
    // submit URLs from a dist we know is malformed. Exact names — note
    // `audit:orphan-sitemap-pages` IS quality (the page exists, it is just
    // not internally linked) and must not be confused with
    // `validate:sitemap-pages` (the sitemap lists pages that do not exist).
    const MUST_BLOCK = [
      'validate:sitemap-pages',
      'validate:sitemap-links',
      'audit:sitemap-canonicals',
      'audit:no-dotfile-html',
      'audit:spa-bundle-injection',
    ];
    for (const gate of MUST_BLOCK) {
      expect(QUALITY_GATES, `${gate} must never be allowlisted`).not.toHaveProperty(gate);
      expect(evaluateIntegrity([gate]).integrityOk).toBe(false);
    }
  });
});

describe('audit:all bundle expansion (#4828)', () => {
  // `audit:all` runs 12 auditors and reports ONE gate name. Handed to a
  // default-deny classifier that name is unclassifiable, so ANY of the 12
  // going red sequestered publish. Run 31077435060 is the recorded case:
  // audit:all red for h1-title-duplicates + text-html-ratio +
  // no-literal-markdown, every structural auditor green, `publish` skipped.
  const RUN_31077435060_SUB_AUDITS = [
    'audit:all/h1-title-duplicates',
    'audit:all/text-html-ratio',
    'audit:all/no-literal-markdown',
  ];

  it('the opaque bundle name still blocks — the fail-closed fallback', () => {
    // When scripts/audit-all.mjs prints no `failed-audits=` marker (older
    // script, OOM, crash before the summary) the workflow keeps the opaque
    // name. Expansion must never be load-bearing for safety.
    const v = evaluateIntegrity(['audit:all']);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['audit:all']);
    expect(QUALITY_GATES).not.toHaveProperty('audit:all');
  });

  it('lets publish run when only cosmetic sub-auditors failed', () => {
    const v = evaluateIntegrity(RUN_31077435060_SUB_AUDITS);
    expect(v.integrityOk).toBe(true);
    expect(v.blocking).toEqual([]);
    expect(v.quality).toEqual(RUN_31077435060_SUB_AUDITS);
  });

  it('NEGATIVE CASE: a structural sub-auditor still blocks', () => {
    // The four auditors deliberately left off the allowlist. If any of these
    // ever reads as quality, a broken shell or a broken document gets
    // announced to Google — the failure this whole gate exists to prevent.
    const MUST_BLOCK = [
      'audit:all/footer-root-presence',
      'audit:all/jsonld-no-nested-scripts',
      'audit:all/faqpage-validity',
      'audit:all/image-object-license',
    ];
    for (const gate of MUST_BLOCK) {
      expect(QUALITY_GATES, `${gate} must never be allowlisted`).not.toHaveProperty(gate);
      const v = evaluateIntegrity([gate]);
      expect(v.integrityOk, `${gate} must block publish`).toBe(false);
      expect(v.blocking).toContain(gate);
    }
  });

  it('NEGATIVE CASE: one structural sub-auditor overrides many cosmetic ones', () => {
    const v = evaluateIntegrity([
      ...RUN_31077435060_SUB_AUDITS,
      'audit:all/footer-root-presence',
    ]);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['audit:all/footer-root-presence']);
    expect(v.quality).toEqual(RUN_31077435060_SUB_AUDITS);
  });

  it('issue #6462: breadcrumb-coverage and information-gain are quality, not blocking', () => {
    // Neither checks a Google indexing/rich-results requirement (no
    // structured-data mandatory field, no canonical/hreflang, no status
    // code, no broken redirect) — both are opportunistic internal
    // heuristics, same class as text-html-ratio/content-duplicates above.
    const v = evaluateIntegrity(['audit:all/breadcrumb-coverage', 'audit:all/information-gain']);
    expect(v.integrityOk).toBe(true);
    expect(v.blocking).toEqual([]);
    expect(v.quality).toEqual(['audit:all/breadcrumb-coverage', 'audit:all/information-gain']);
  });

  it('DEFAULT-DENY survives inside the namespace', () => {
    // A 13th auditor registered in scripts/audit-all.mjs tomorrow arrives as
    // `audit:all/<new>` and must block until someone classifies it. The
    // prefix is not a wildcard.
    const v = evaluateIntegrity(['audit:all/auditor-added-next-quarter']);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['audit:all/auditor-added-next-quarter']);
  });

  it('NEGATIVE CASE: expansion does not rescue a red sitemap validator', () => {
    // The full failed-gate set of run 31077435060. Even with the bundle
    // expanded, `validate:sitemap-pages` was red (106'276 noindex URLs in
    // sitemaps) and publish must stay blocked: publish submits the sitemap
    // URL set verbatim.
    const v = evaluateIntegrity([
      'validate:sitemap-pages',
      ...RUN_31077435060_SUB_AUDITS,
    ]);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['validate:sitemap-pages']);
  });
});

describe('verdict-job availability sentinel (#4828)', () => {
  it('NEGATIVE CASE: the classifier-unavailable sentinel blocks', () => {
    // Emitted by the workflow when the classifier cannot run at all. Before
    // this sentinel existed the step died BEFORE writing to $GITHUB_OUTPUT, so
    // `integrity_ok` reached the caller EMPTY (run 31055982487,
    // MODULE_NOT_FOUND). Empty also blocks, but attributes to nothing — and
    // note the loss came from never writing the value, not from the job's
    // colour: a failed job's outputs DO cross the boundary (probe 31081857672).
    const v = evaluateIntegrity(['__CLASSIFIER_UNAVAILABLE__']);
    expect(v.integrityOk).toBe(false);
    expect(v.blocking).toEqual(['__CLASSIFIER_UNAVAILABLE__']);
    expect(QUALITY_GATES).not.toHaveProperty('__CLASSIFIER_UNAVAILABLE__');
  });

  it('NEGATIVE CASE: a gate job that died outside its gate step blocks', () => {
    for (const s of ['__UNKNOWN__', '__UNKNOWN__:postbuild', '__UNKNOWN__:bfs']) {
      expect(evaluateIntegrity([s]).integrityOk, `${s} must block`).toBe(false);
    }
  });
});

describe('gate result parsing', () => {
  it('reads the workflow\'s `<name> <secs> rc=<code>` rows', () => {
    const rows = [
      'audit:hreflang                              12.30 rc=1',
      'validate:sitemap-pages                       4.10 rc=0',
      'audit:all                                 1200.00 rc=0',
    ].join('\n');
    expect(parseResultRows(rows)).toEqual(['audit:hreflang']);
  });

  it('treats an unparseable row as undecidable (fails closed downstream)', () => {
    // The workflow's own summary loop routes a missing rc into FAIL. A row
    // we cannot even name has to block rather than be dropped silently.
    expect(parseResultRows('audit:hreflang   12.30')).toBeNull();
    expect(evaluateIntegrity(parseResultRows('garbage')).integrityOk).toBe(false);
  });

  it('ignores blank lines', () => {
    expect(parseResultRows('\n\nvalidate:sitemap-links 1.00 rc=0\n\n')).toEqual([]);
  });
});

describe('classifyFailures', () => {
  it('trims and drops empties', () => {
    const { blocking, quality } = classifyFailures([' audit:hreflang ', '', '  ']);
    expect(quality).toEqual(['audit:hreflang']);
    expect(blocking).toEqual([]);
  });
});
