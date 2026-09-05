/**
 * Regression: F2/F5/F6 build-plugin render functions must each contain
 * exactly one `adSlotHtml(...)` call.
 *
 * Why this exists: the GA4↔AdSense link analysis on 2026-04-28 showed
 * €0/30d revenue on these page types because the rendered HTML had no
 * `<ins class="adsbygoogle">` slots. Once added, regressions are easy
 * (e.g. someone refactors the render and drops the adSlotHtml call).
 * This test guards against silent revenue loss.
 *
 * The assertion is over the SOURCE TEXT — not the rendered HTML — because
 * the full render pipeline needs Firebase Remote Config, gigabyte-sized
 * datasets, and IO that are out-of-scope for a fast regression test. We
 * scope the search to each `function ${name}(` … next `function ` boundary
 * so we exactly match plan Step 2 ("inject … in the page render functions").
 *
 * If a render function legitimately needs zero ad slots, the fix is to
 * update this list — DO NOT silently remove the slot to make the test pass
 * (CLAUDE.md non-negotiable rule #1).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { infeedAdListItemHtml, infeedAdGridBlockHtml, endOfContentMultiplexHtml } from '../../build-plugins/lib/adSlotHtml';
import { AD_SLOTS } from '../../services/adsenseSlots';
import { renderProfessionBelowFloorBridge } from '../../build-plugins/shared/professionJobsFloor';
import type { AnyProfessionId } from '../../build-plugins/professionLandingsData';

const ROOT = path.resolve(__dirname, '..', '..');

interface Spec {
  file: string;
  fn: string;
  expectedSlot: 'JOBLIST_END_MULTIPLEX' | 'ARTICLE_END_MULTIPLEX';
}

const SPECS: Spec[] = [
  // F5 weekly-employers — 3 render funcs, JOBLIST slot
  { file: 'build-plugins/weeklyEmployersPlugin.ts', fn: 'renderTopHubPage', expectedSlot: 'JOBLIST_END_MULTIPLEX' },
  { file: 'build-plugins/weeklyEmployersPlugin.ts', fn: 'renderWeeklyEmployersPage', expectedSlot: 'JOBLIST_END_MULTIPLEX' },
  { file: 'build-plugins/weeklyEmployersPlugin.ts', fn: 'renderCompanyCityPage', expectedSlot: 'JOBLIST_END_MULTIPLEX' },
  // F2 health-premiums — 3 render funcs, ARTICLE slot
  { file: 'build-plugins/healthPremiumsLandingPlugin.ts', fn: 'renderLeafPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/healthPremiumsLandingPlugin.ts', fn: 'renderCantonHubPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/healthPremiumsLandingPlugin.ts', fn: 'renderRootHubPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  // F6 fuel-daily — 5 render funcs, ARTICLE slot
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderArchive', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderStationPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderItalianCityPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  { file: 'build-plugins/fuelDailyPagesPlugin.ts', fn: 'renderItalianStationPage', expectedSlot: 'ARTICLE_END_MULTIPLEX' },
];

// Plugins where the inject is in a non-`render*` helper or inline string —
// we just check at file scope that a single call to adSlotHtml is present per
// ad-eligible page-template. Pre-existing test pattern above for `render*`
// boundaries doesn't fit `borderWaitPagesPlugin` (3 inline templates),
// `orphanQueryLandingPlugin` (1 inline `bodyHtml`), `marketReportPlugin`
// (1 inline `bodyHtml`), or `jobMarketSnapshotPlugin` (3 inline templates).
interface FileSpec {
  file: string;
  expectedCount: number;
  expectedSlot: 'JOBLIST_END_MULTIPLEX' | 'ARTICLE_END_MULTIPLEX';
}

const FILE_SPECS: FileSpec[] = [
  // F8 border-wait — 3 page templates (per-crossing detail / global hub / today archive)
  { file: 'build-plugins/borderWaitPagesPlugin.ts', expectedCount: 3, expectedSlot: 'ARTICLE_END_MULTIPLEX' },
  // F3b orphan-query landing — 1 page template
  { file: 'build-plugins/orphanQueryLandingPlugin.ts', expectedCount: 1, expectedSlot: 'JOBLIST_END_MULTIPLEX' },
  // F4 job-market snapshot — 3 page templates (current / archive / per-sector)
  { file: 'build-plugins/jobMarketSnapshotPlugin.ts', expectedCount: 3, expectedSlot: 'JOBLIST_END_MULTIPLEX' },
  // Mercato lavoro Ticino market report (1 hub page)
  { file: 'build-plugins/marketReportPlugin.ts', expectedCount: 1, expectedSlot: 'ARTICLE_END_MULTIPLEX' },
];

const AUTO_ADS_ENABLED_FILES = [
  'build-plugins/borderWaitPagesPlugin.ts',
  'build-plugins/fuelDailyPagesPlugin.ts',
  'build-plugins/healthPremiumsLandingPlugin.ts',
];

/**
 * Extract the source body of a top-level render function by scanning from
 * `function <name>(` (or `export function <name>(`) to the next top-level
 * `function ` declaration. Good enough for these plugins; they don't nest
 * `function` keywords inside the render bodies (they use arrow callbacks).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const opener = new RegExp(`(?:^|\\n)(?:export\\s+)?function\\s+${fnName}\\s*[<(]`);
  const start = source.search(opener);
  if (start === -1) return '';
  const rest = source.slice(start + 1);
  const nextFnIdx = rest.search(/\n(?:export\s+)?function\s+\w+\s*[<(]/);
  return nextFnIdx === -1 ? rest : rest.slice(0, nextFnIdx);
}

describe('SEO static-page ad slots — regression guard', () => {
  for (const spec of SPECS) {
    it(`${spec.file} :: ${spec.fn} contains exactly one adSlotHtml('${spec.expectedSlot}') call`, () => {
      const filePath = path.join(ROOT, spec.file);
      const src = fs.readFileSync(filePath, 'utf8');
      const body = extractFunctionBody(src, spec.fn);
      expect(body, `Could not locate function ${spec.fn} in ${spec.file}`).not.toBe('');

      const calls = body.match(/adSlotHtml\(\s*['"][A-Z_]+['"]\s*\)/g) ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(spec.expectedSlot);
    });
  }

  it('helper imports the centralized adSlotHtml from build-plugins/lib/adSlotHtml', () => {
    const files = Array.from(new Set([...SPECS.map(s => s.file), ...FILE_SPECS.map(s => s.file)]));
    for (const file of files) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // adSlotHtml must come from the centralized helper. Allow co-imports in
      // the same `{ … }` (e.g. `infeedAdListItemHtml`) — the gate only requires
      // adSlotHtml to be imported from './lib/adSlotHtml', not that it be alone.
      expect(src, `${file} must import adSlotHtml from './lib/adSlotHtml'`)
        .toMatch(/import\s*\{[^}]*\badSlotHtml\b[^}]*\}\s*from\s*['"]\.\/lib\/adSlotHtml['"]/);
    }
  });

  for (const fs_ of FILE_SPECS) {
    it(`${fs_.file} contains exactly ${fs_.expectedCount} adSlotHtml('${fs_.expectedSlot}') call(s)`, () => {
      const src = fs.readFileSync(path.join(ROOT, fs_.file), 'utf8');
      const calls = src.match(/adSlotHtml\(\s*['"][A-Z_]+['"]\s*\)/g) ?? [];
      expect(calls).toHaveLength(fs_.expectedCount);
      for (const c of calls) {
        expect(c).toContain(fs_.expectedSlot);
      }
    });
  }

  it('keeps Auto Ads enabled on utility pages with proven ad inventory gaps', () => {
    for (const file of AUTO_ADS_ENABLED_FILES) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(src, `${file} should not opt utility SEO pages out of Auto Ads`)
        .not.toContain('disableAutoAds: true');
    }
  });

  // Issue #3054 (follow-up of PR #3035, "in-feed ad every 3 cards among
  // related jobs"): the adversarial concern was that ADSENSE_LOADER_CONTENT
  // (build-plugins/constants.ts) calls `adsbygoogle.push({})` once per
  // `ins.adsbygoogle:not([data-adsbygoogle-status])` in DOM order, so a new
  // in-feed injection point (the related-jobs section) could shift which
  // push() lands on which visual slot. It can't: push({}) takes no argument,
  // so it never carries slot identity — AdSense's own script reads the ad
  // config straight off each <ins>'s own data-ad-* attributes at render
  // time. The push loop only needs COUNT parity (guaranteed by the live
  // `document.querySelectorAll` it runs after the whole page, including any
  // related-section <ins> tags, has rendered) — never DOM-order identity.
  // This test guards the precondition: every in-feed <ins> emitted by the
  // shared helper (used at all in-feed call sites, including the
  // related-jobs one added in #3035) always carries its own explicit
  // `data-ad-slot`, so no reordering or new injection point can misroute
  // one slot's config onto another <ins>.
  it('in-feed <ins> tags always carry an explicit data-ad-slot (push({}) binds by count, never by DOM-order identity)', () => {
    const expectedSlot = AD_SLOTS.JOBLIST_INFEED_DESKTOP.slot;
    for (const html of [infeedAdListItemHtml(), infeedAdGridBlockHtml()]) {
      expect(html).toContain('class="adsbygoogle"');
      expect(html).toContain(`data-ad-slot="${expectedSlot}"`);
    }
  });
});

// Issue #4485: end-of-content multiplex on the static SSG "family" landings
// that previously ran Auto Ads only. Guards two invariants:
//  1. The account-safety GATE — the slot is emitted ONLY on index,follow
//     pages. A manual ad on a thin/noindex bridge page is an MFA signal that
//     risks account-level action, so `endOfContentMultiplexHtml({indexable:false})`
//     MUST return ''. This is a real behavioral test on the helper (no build
//     pipeline needed), the by-construction guarantee every family relies on.
//  2. Revenue regression — each family plugin keeps its `endOfContentMultiplexHtml`
//     call(s), mirroring the SPECS/FILE_SPECS guard for the older families. A
//     refactor that silently drops the call would re-open the same €0/30d gap.
describe('SEO SSG-family end-of-content multiplex (#4485)', () => {
  it('SSG_END_MULTIPLEX is an autorelaxed (multiplex) unit with a CLS-reserving min-height', () => {
    const cfg = AD_SLOTS.SSG_END_MULTIPLEX;
    expect(cfg.format).toBe('autorelaxed');
    expect(cfg.placeholderMinHeight).toBeGreaterThanOrEqual(300);
  });

  it('emits nothing on non-indexable (thin/noindex) pages — MFA-safety gate', () => {
    expect(endOfContentMultiplexHtml({ indexable: false })).toBe('');
  });

  it('emits the SSG_END_MULTIPLEX <ins> with reserved min-height on indexable pages', () => {
    const html = endOfContentMultiplexHtml({ indexable: true });
    expect(html).toContain('class="adsbygoogle"');
    expect(html).toContain(`data-ad-slot="${AD_SLOTS.SSG_END_MULTIPLEX.slot}"`);
    expect(html).toContain('data-ad-format="autorelaxed"');
    expect(html).toContain(`min-height:${AD_SLOTS.SSG_END_MULTIPLEX.placeholderMinHeight}px`);
    expect(html).toContain('aria-label="advertisement"');
  });

  // Per-family call-count guard. The 6 families named in #4485 plus the sibling
  // families that shared the same "Auto Ads only" gap (AGENTS.md rule #6 —
  // fix the whole class in one PR): exchange-rate, employer-profile and the
  // two profession×canton plugins. Counts match the number of index,follow
  // render templates per plugin.
  const FAMILY_SPECS: Array<{ file: string; count: number }> = [
    // 7 render templates since #7329: the overflow ladder page
    // (`renderOverflowLadderPage`, `<bucket>/page-N/`) is an index,follow
    // surface like the other six, so it carries the slot too.
    { file: 'build-plugins/eventsSeoPagesPlugin.ts', count: 7 },
    { file: 'build-plugins/careerLandingsPlugin.ts', count: 1 },
    { file: 'build-plugins/costOfLivingLandingsPlugin.ts', count: 1 },
    { file: 'build-plugins/comparisonsHubPlugin.ts', count: 1 },
    // 2 render templates since #5008: the hub page and the per-question page.
    { file: 'build-plugins/faqHubPlugin.ts', count: 2 },
    { file: 'build-plugins/frontalierePillarPlugin.ts', count: 1 },
    { file: 'build-plugins/exchangeRatePagesPlugin.ts', count: 2 },
    { file: 'build-plugins/employerProfilePagesPlugin.ts', count: 1 },
    { file: 'build-plugins/salaryProfessionCantonPages.ts', count: 1 },
    { file: 'build-plugins/professionCantonLandings.ts', count: 1 },
    { file: 'build-plugins/healthFacilitiesPlugin.ts', count: 1 },
    // Issue #4528 (rollout part 2 of #4485) — preexisting SSG families.
    // professionCityLandings.ts and salaryStatsChCantonPages.ts excluded:
    // both already modified by in-flight PR #4525 (overlap-file guard).
    { file: 'build-plugins/nursingLandingsPlugin.ts', count: 1 },
    { file: 'build-plugins/professionLandingsPlugin.ts', count: 1 },
    { file: 'build-plugins/sectionPagesPlugin.ts', count: 1 },
    { file: 'build-plugins/annualReportPlugin.ts', count: 1 },
    { file: 'build-plugins/borderMunicipalityPagesPlugin.ts', count: 1 },
    { file: 'build-plugins/frSalaireNetLandingPlugin.ts', count: 1 },
    { file: 'build-plugins/borderWaitMapPlugin.ts', count: 1 },
    { file: 'build-plugins/relatedSearchClustersPlugin.ts', count: 2 },
  ];

  for (const spec of FAMILY_SPECS) {
    it(`${spec.file} calls endOfContentMultiplexHtml ${spec.count}× and imports it from './lib/adSlotHtml'`, () => {
      const src = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
      const calls = src.match(/endOfContentMultiplexHtml\(\s*\{/g) ?? [];
      expect(calls).toHaveLength(spec.count);
      expect(src, `${spec.file} must import endOfContentMultiplexHtml from './lib/adSlotHtml'`)
        .toMatch(/import\s*\{[^}]*\bendOfContentMultiplexHtml\b[^}]*\}\s*from\s*['"]\.\/lib\/adSlotHtml['"]/);
    });
  }

  // The below-floor / thin bridge emitters must NEVER hardcode an indexable
  // multiplex: they render noindex pages, so the only permissible call form is
  // one gated on a variable (`{ indexable }`), never `{ indexable: true }`
  // inside those functions. Guard that no bridge function contains the slot.
  it('below-floor bridge emitters carry no end-of-content multiplex', () => {
    const bridges: Array<{ file: string; fn: string }> = [
      { file: 'build-plugins/salaryProfessionCantonPages.ts', fn: 'renderBelowFloorBridge' },
      // #5322 moved the profession below-floor bridge OUT of
      // professionCantonLandings.ts and into a shared module, because the
      // legacy Ticino family (professionLandingsPlugin.ts) had to stop
      // reimplementing the floor and start consuming the same one. Guarding
      // the single shared producer therefore covers BOTH emitters at once —
      // strictly more than the per-canton-only guard this replaced.
      { file: 'build-plugins/shared/professionJobsFloor.ts', fn: 'renderProfessionBelowFloorBridge' },
      { file: 'build-plugins/employerProfilePagesPlugin.ts', fn: 'emitEmployerBelowFloorBridge' },
    ];
    for (const { file, fn } of bridges) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const body = extractFunctionBody(src, fn);
      expect(body, `Could not locate ${fn} in ${file}`).not.toBe('');
      expect(body, `${fn} (noindex bridge) must not emit a manual multiplex`)
        .not.toContain('endOfContentMultiplexHtml');
    }
  });

  // Belt to the source-scan's braces. The scan above is deliberately textual
  // for the RENDER functions (see the file header: the full pipeline needs
  // Remote Config and gigabyte datasets), but the shared profession bridge is
  // a pure function of three plain arguments — so here we can assert the thing
  // we actually care about, the EMITTED HTML, instead of a proxy for it. That
  // survives any future move of the function between files, which is exactly
  // what broke when #5322 extracted it.
  it('the shared profession below-floor bridge emits no ad markup, for either consumer', () => {
    const cases: Array<{ consumer: string; cantonKey: string; id: AnyProfessionId }> = [
      // professionCantonLandings.ts — /lavoro-{canton}-{role}/
      { consumer: 'per-canton', cantonKey: 'ZH', id: 'infermiere' },
      // professionLandingsPlugin.ts — legacy /lavoro-ticino-{role}/ (#5322)
      { consumer: 'legacy TI', cantonKey: 'TI', id: 'cameriere' },
    ];
    for (const { consumer, cantonKey, id } of cases) {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const html = renderProfessionBelowFloorBridge(locale, cantonKey, id);
        expect(html, `${consumer} ${locale} bridge must be noindex`)
          .toContain('noindex,follow');
        expect(html, `${consumer} ${locale} bridge must carry no AdSense slot`)
          .not.toContain('adsbygoogle');
        // `.slot` — AD_SLOTS entries are config OBJECTS, and passing the object
        // to a string `toContain` would assert nothing.
        expect(html, `${consumer} ${locale} bridge must not carry the SSG end multiplex slot`)
          .not.toContain(AD_SLOTS.SSG_END_MULTIPLEX.slot);
      }
    }
  });
});

// Issue #4528: rollout part 2 — the SAME end-of-content multiplex helper
// extended to the ~10 pre-existing content families that PR #4521 (issue #4485)
// audited as still Auto-Ads-only. Same MFA-safety gate (shared helper, already
// covered above), same per-family call-count + import guard, same below-floor
// bridge exclusion. A refactor that silently drops any of these calls re-opens
// the display-vs-multiplex RPM gap on that family.
describe('SEO SSG-family end-of-content multiplex — rollout 2 (#4528)', () => {
  // Counts match the number of index,follow render templates per plugin.
  // relatedSearchClustersPlugin has two (cluster page + paginated hub page);
  // every other family has a single render path.
  const FAMILY_SPECS_2: Array<{ file: string; count: number }> = [
    { file: 'build-plugins/nursingLandingsPlugin.ts', count: 1 },
    { file: 'build-plugins/professionLandingsPlugin.ts', count: 1 },
    { file: 'build-plugins/professionCityLandings.ts', count: 1 },
    { file: 'build-plugins/sectionPagesPlugin.ts', count: 1 },
    { file: 'build-plugins/salaryStatsChCantonPages.ts', count: 1 },
    { file: 'build-plugins/annualReportPlugin.ts', count: 1 },
    { file: 'build-plugins/borderMunicipalityPagesPlugin.ts', count: 1 },
    { file: 'build-plugins/frSalaireNetLandingPlugin.ts', count: 1 },
    { file: 'build-plugins/borderWaitMapPlugin.ts', count: 1 },
    { file: 'build-plugins/relatedSearchClustersPlugin.ts', count: 2 },
  ];

  for (const spec of FAMILY_SPECS_2) {
    it(`${spec.file} calls endOfContentMultiplexHtml ${spec.count}× and imports it from './lib/adSlotHtml'`, () => {
      const src = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
      const calls = src.match(/endOfContentMultiplexHtml\(\s*\{/g) ?? [];
      expect(calls).toHaveLength(spec.count);
      expect(src, `${spec.file} must import endOfContentMultiplexHtml from './lib/adSlotHtml'`)
        .toMatch(/import\s*\{[^}]*\bendOfContentMultiplexHtml\b[^}]*\}\s*from\s*['"]\.\/lib\/adSlotHtml['"]/);
    });
  }

  // #4479 — Swiss minimum-wage landings: the shared renderPage emits the
  // end-of-content multiplex ONLY on the hub (index) page (gated on
  // index,follow). One call site in the source → count 1.
  it('build-plugins/minimumWageLandingsPlugin.ts calls endOfContentMultiplexHtml 1× and imports it from \'./lib/adSlotHtml\'', () => {
    const src = fs.readFileSync(path.join(ROOT, 'build-plugins/minimumWageLandingsPlugin.ts'), 'utf8');
    const calls = src.match(/endOfContentMultiplexHtml\(\s*\{/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(src, 'minimumWageLandingsPlugin.ts must import endOfContentMultiplexHtml from \'./lib/adSlotHtml\'')
      .toMatch(/import\s*\{[^}]*\bendOfContentMultiplexHtml\b[^}]*\}\s*from\s*['"]\.\/lib\/adSlotHtml['"]/);
  });

  // The two rollout-2 families that also emit a noindex below-floor bridge must
  // keep that bridge free of any manual multiplex (same MFA invariant as the
  // #4485 bridges above).
  it('rollout-2 below-floor bridge emitters carry no end-of-content multiplex', () => {
    const bridges: Array<{ file: string; fn: string }> = [
      { file: 'build-plugins/professionCityLandings.ts', fn: 'renderBelowFloorBridge' },
      { file: 'build-plugins/relatedSearchClustersPlugin.ts', fn: 'renderClusterBelowFloorBridge' },
    ];
    for (const { file, fn } of bridges) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const body = extractFunctionBody(src, fn);
      expect(body, `Could not locate ${fn} in ${file}`).not.toBe('');
      expect(body, `${fn} (noindex bridge) must not emit a manual multiplex`)
        .not.toContain('endOfContentMultiplexHtml');
    }
  });
});
