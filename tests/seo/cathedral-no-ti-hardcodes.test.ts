import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const FORBIDDEN = [
  "'cerca-lavoro-ticino'",
  '"cerca-lavoro-ticino"',
  "'find-jobs-ticino'",
  "'jobs-im-tessin'",
  "'trouver-emploi-tessin'",
];

// Allowlist — any line that legitimately references a TI legacy section
// literal. Every TI hardcode below has been audited as either (a) a
// fallback default in a per-plugin SECTION_SLUG table, or (b) a TI-only
// data structure (router slugs, section→label maps, hub-chrome) where
// the literal IS the canonical name for TI.
//
// IMPORTANT: never add a NEW entry here without first confirming the
// hardcode is correct legacy preservation. New canton-aware code should
// import resolveCantonSection() from build-plugins/shared/cantonSection.
const ALLOWLIST = [
  // ── Canton-section helper itself: defines the TI legacy section table ──
  'build-plugins/shared/cantonSection.ts',

  // ── jobsSeoPagesPlugin: sectionByLocale legacy preservation (TI default) ──
  // Lines shifted +3 by the BFS-depth Explore navigator imports added at
  // the top of the file (getJobNursesHubSlug / getJobPartTimeLandingSlug /
  // careClusterSlug). Previous +1 shift from Phase 8(g) imports is included.
  'build-plugins/jobsSeoPagesPlugin.ts:784',
  'build-plugins/jobsSeoPagesPlugin.ts:785',
  'build-plugins/jobsSeoPagesPlugin.ts:786',
  'build-plugins/jobsSeoPagesPlugin.ts:787',
  'build-plugins/jobsSeoPagesPlugin.ts:792',          // jsdoc reference to the legacy slugs

  // ── jobBoardSeo: TI legacy job-board landing paths (kept for legacy entry) ──
  'build-plugins/jobBoardSeo.ts:38',
  'build-plugins/jobBoardSeo.ts:39',
  'build-plugins/jobBoardSeo.ts:40',
  'build-plugins/jobBoardSeo.ts:41',

  // ── Per-plugin SECTION_SLUG fallback tables (TI default for unknown canton) ──
  // Each plugin keeps its own typed Record<locale, string> for performance /
  // bundle-isolation; the values mirror cantonSection.SECTION_LEGACY_TI by design.
  'build-plugins/cityJobsHub.ts:111',
  'build-plugins/cityJobsHub.ts:112',
  'build-plugins/cityJobsHub.ts:113',
  'build-plugins/cityJobsHub.ts:114',
  // Lines shifted +1 by the cantonSeoProse helper import added at the top
  // of the file (May 2026 — text-to-html-ratio gate fix).
  'build-plugins/companyHubBridgePlugin.ts:41',
  'build-plugins/companyHubBridgePlugin.ts:42',
  'build-plugins/companyHubBridgePlugin.ts:43',
  'build-plugins/companyHubBridgePlugin.ts:44',
  'build-plugins/companyHubBridgePlugin.ts:45',
  // Lines shifted +1 by the bridgePageProse helper import added at the
  // top of the file (May 2026 — text-to-html-ratio gate fix).
  'build-plugins/jobOrphanBridgePlugin.ts:84',
  'build-plugins/jobOrphanBridgePlugin.ts:85',
  'build-plugins/jobOrphanBridgePlugin.ts:86',
  'build-plugins/jobOrphanBridgePlugin.ts:87',
  'build-plugins/jobOrphanBridgePlugin.ts:88',
  'build-plugins/jobRecencyPagesPlugin.ts:53',
  'build-plugins/jobRecencyPagesPlugin.ts:54',
  'build-plugins/jobRecencyPagesPlugin.ts:55',
  'build-plugins/jobRecencyPagesPlugin.ts:56',
  'build-plugins/jobSectorLanding.ts:103',
  'build-plugins/jobSectorLanding.ts:104',
  'build-plugins/jobSectorLanding.ts:105',
  'build-plugins/jobSectorLanding.ts:106',
  'build-plugins/legacyRedirectsPlugin.ts:281',
  'build-plugins/legacyRedirectsPlugin.ts:282',
  'build-plugins/legacyRedirectsPlugin.ts:283',
  'build-plugins/legacyRedirectsPlugin.ts:284',
  // Lines shifted +1 by the cantonSeoProse helper import added at the top
  // of the file (May 2026 — text-to-html-ratio gate fix).
  'build-plugins/locationHubBridgePlugin.ts:52',
  'build-plugins/locationHubBridgePlugin.ts:53',
  'build-plugins/locationHubBridgePlugin.ts:54',
  'build-plugins/locationHubBridgePlugin.ts:55',
  'build-plugins/locationHubBridgePlugin.ts:56',
  'build-plugins/orphanQueryLandingPlugin.ts:436',
  'build-plugins/orphanQueryLandingPlugin.ts:437',
  'build-plugins/orphanQueryLandingPlugin.ts:438',
  'build-plugins/orphanQueryLandingPlugin.ts:439',
  'build-plugins/searchConsoleCompat.ts:11',
  'build-plugins/searchConsoleCompat.ts:12',
  'build-plugins/searchConsoleCompat.ts:13',
  'build-plugins/searchConsoleCompat.ts:14',

  // ── seoHubsPlugin: per-locale alternation pulling the TI legacy slug for
  //    the TI hub. Aggregator/per-canton hubs live in a different code path. ──
  //    Lines shift as Phase 7.2 / future per-canton emit blocks grow; we
  //    allowlist a small range around the known stable site.
  // Lines shifted by the cantonSeoProse helper import + block added in
  // buildThinCantonHubHtml (May 2026 — text-to-html-ratio gate fix). Lines
  // shifted again on 2026-05-12 by the BFS-depth `tutti` pagination fix
  // (paginationHtml block in buildThinCantonHubHtml + jobPerLocale plumbing
  // in emitThinCantonHubs), and once more on 2026-05-12 by the flat-ladder
  // navigator added inside renderPagination (BFS-depth closure run
  // 25753701178 — every page-N now lists every other page-N inside a
  // collapsed <details>). Then shifted back -10 on 2026-05-12 when the
  // `tutti/page-N` pagination loop was reverted in emitThinCantonHubs
  // (deploy artifact >1 GB Pages cap + text-html-ratio regression — only
  // page-1 stays as static HTML for non-TI cantons). 2026-05-13: shifted
  // +234 by the `buildHubFaqHtml` helper added to lift text-html-ratio
  // above 10 % on the master-hub `cerca-lavoro-ticino/tutti/page-N`
  // family (5 Q/A pairs × 4 locales × 4 hub kinds). The 4 literals all
  // live on 2 paired template literals (sectors hub + companies hub),
  // each spanning 2 lines.
  'build-plugins/seoHubsPlugin.ts:1650',
  'build-plugins/seoHubsPlugin.ts:1651',
  'build-plugins/seoHubsPlugin.ts:1666',
  'build-plugins/seoHubsPlugin.ts:1667',

  // ── professionLandingsLinksPlugin: TI hub injection targets (intentional —
  //    the prose explicitly references "10 most-searched roles in Ticino"). ──
  'build-plugins/professionLandingsLinksPlugin.ts:207',
  'build-plugins/professionLandingsLinksPlugin.ts:211',
  'build-plugins/professionLandingsLinksPlugin.ts:215',
  'build-plugins/professionLandingsLinksPlugin.ts:219',

  // ── staticPagesPlugin: section→category / section→label maps. These ARE
  //    keyed by the TI legacy section name; they are data, not links. ──
  //    Lines shifted +197 by the BFS-depth non-TI canton deep-navigator
  //    data-prep block added in closeBundle (May 2026, run 25739076601 —
  //    bfs-depth gate fix for the 23 non-TI cathedral cantons). The previous
  //    +129 shift from PR #133 TI hub deep-navigator data-prep is included.
  //    Lines shifted again on 2026-05-12 by the homepage canton-nav helper
  //    (`buildHomepageCantonNavHtml`) added between `injectHomepageSeoContent`
  //    and `injectCalculatorSeoContent` — BFS-depth closure run 25753701178.
  //    Every entry shifts by the same +74 lines (helper block size).
  //    Then shifted again +44 on 2026-05-13 by the cross-section hubs block
  //    appended INSIDE `buildHomepageCantonNavHtml` (azienda-* depth fix
  //    for sitemap-jobs.xml — pulls per-company azienda-* leaves from BFS
  //    depth 5 to depth 4 by anchoring /aziende-che-assumono/tutte/ + the
  //    locale variants directly off `/`).
  'build-plugins/staticPagesPlugin.ts:1212',
  'build-plugins/staticPagesPlugin.ts:1213',
  'build-plugins/staticPagesPlugin.ts:1214',
  'build-plugins/staticPagesPlugin.ts:1215',
  'build-plugins/staticPagesPlugin.ts:1234',
  'build-plugins/staticPagesPlugin.ts:1235',
  'build-plugins/staticPagesPlugin.ts:1769',
  'build-plugins/staticPagesPlugin.ts:1794',
  'build-plugins/staticPagesPlugin.ts:1819',
  'build-plugins/staticPagesPlugin.ts:2087',
  // ── Cross-section hub anchors emitted inside buildHomepageCantonNavHtml
  //    (2026-05-13 BFS-depth fix for sitemap-jobs.xml azienda-* leaves).
  //    Per-locale URL constants reference the TI section slug; the audit
  //    treats them as legitimate URL building blocks rather than rogue
  //    hardcodes. Pattern mirrors the hubChrome.ts allowlist above.
  'build-plugins/staticPagesPlugin.ts:565',
  'build-plugins/staticPagesPlugin.ts:566',
  'build-plugins/staticPagesPlugin.ts:572',
  'build-plugins/staticPagesPlugin.ts:573',
  'build-plugins/staticPagesPlugin.ts:578',
  'build-plugins/staticPagesPlugin.ts:579',
  'build-plugins/staticPagesPlugin.ts:584',
  'build-plugins/staticPagesPlugin.ts:585',

  // ── shared/hubChrome.ts: per-locale hub-chrome registry keyed on TI section name ──
  'build-plugins/shared/hubChrome.ts:106',
  'build-plugins/shared/hubChrome.ts:139',
  'build-plugins/shared/hubChrome.ts:172',
  'build-plugins/shared/hubChrome.ts:205',

  // ── services/router.ts: TI legacy slug entries in the per-locale ROUTER
  //    slug table. These are the URLs the SPA recognises as the TI hub. ──
  'services/router.ts:1037',
  'services/router.ts:1138',
  'services/router.ts:1239',
  'services/router.ts:1340',

  // ── services/relatedSearchClusters.ts: TI default section in resolveSectionSlug. ──
  'services/relatedSearchClusters.ts:64',
  'services/relatedSearchClusters.ts:65',
  'services/relatedSearchClusters.ts:66',
  'services/relatedSearchClusters.ts:67',

  // ── services/analytics-seo.ts: TI section-name whitelist for analytics. ──
  'services/analytics-seo.ts:109',
  'services/analytics-seo.ts:110',
  'services/analytics-seo.ts:111',
  'services/analytics-seo.ts:112',

  // ── newsletter-content: TI section name used to build CTA links in TI-themed
  //    newsletter emails. Newsletter content is TI-targeted. ──
  'services/newsletter-content.mjs:368',

  'tests/',                                          // tests reference literals for verification
];

// P1-E fix: parse grep output into (path, line, content) tuples and
// match against allowlist with EXACT boundary, not startsWith — otherwise
// `:772` matches `:7720`, `:7721`, …
function parseGrepLine(line: string): { path: string; lineNo: number; content: string } | null {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return null;
  return { path: m[1], lineNo: parseInt(m[2], 10), content: m[3] };
}

function isAllowlisted(entry: { path: string; lineNo: number }): boolean {
  for (const allow of ALLOWLIST) {
    // "path:line" form — exact match
    if (allow.includes(':')) {
      const [allowPath, allowLine] = allow.split(':');
      if (entry.path === allowPath && entry.lineNo === parseInt(allowLine, 10)) return true;
    }
    // "path/" or "path" form — prefix match on path only (e.g. "tests/")
    else if (entry.path.startsWith(allow)) return true;
  }
  return false;
}

describe('cathedral — no TI URL hardcodes outside allowlist (P1-E boundary-safe)', () => {
  for (const literal of FORBIDDEN) {
    it(`literal ${literal} appears only in allowlisted locations`, () => {
      const cmd = `grep -rn -F ${JSON.stringify(literal)} build-plugins/ services/ scripts/lib/ || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      const offenders = out.split('\n').filter(Boolean)
        .map(parseGrepLine).filter((e): e is NonNullable<typeof e> => e !== null)
        .filter((entry) => !isAllowlisted(entry))
        .map((e) => `${e.path}:${e.lineNo}: ${e.content}`);
      expect(offenders, `Unallowlisted hardcodes for ${literal}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
