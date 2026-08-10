/**
 * healthFacilitiesLinksPlugin.ts — internal-links injector for the
 * health-facilities hub (epic #4455 / sub #4458).
 *
 * After both {@link nursingLandingsPlugin} and {@link healthFacilitiesPlugin}
 * have flushed, this walks the 3 nursing landings × 4 locales and injects a
 * "facilities hiring near you" block linking to the ABOVE-FLOOR facilities
 * (never a below-floor bridge — acceptance criterion #4458). This is the
 * "viceversa" direction of the bidirectional wiring: the facility pages
 * already link back to the nursing/profession funnel via their own render.
 *
 * The landing → facility relevance is region-aware: the Ticino landing
 * (`healthcare-ticino`) leads with TI facilities, the OSS landing leads with
 * facilities that have care-assistant openings, and all lists fill up to a cap
 * with the highest-demand facilities nationwide.
 *
 * Reuses the shared injector + build-signal barrier pattern of
 * {@link professionLandingsLinksPlugin} so behaviour can't drift.
 *
 * ── Second injection target: the HTML sitemap page (issue #5434) ───────────
 *
 * The "near you" block above is a CURATED shortlist and it is capped
 * ({@link MAX_FACILITY_LINKS} = 24 per landing). That cap was a page-weight
 * decision, but because the three landings were the family's ONLY inbound
 * links it silently doubled as a reachability threshold, and the union of
 * `pickFacilities()` over the three landing ids is at most the first 48
 * entries of the ranked list (`nurses` = even indices, `oss` = odd indices,
 * `healthcare-ticino` ⊆ the same head). Everything ranked 49th or lower was
 * emitted, put in `sitemap-health-facilities.xml`, and linked from nowhere.
 *
 * Measured on run 31369964810 (job `validate-dist-postbuild-bfs`, build
 * 727a13f3, `offendersList` read from the job log — the artifact's
 * `topOffenders` is capped at 100 global entries and contains none of these):
 *
 *   sitemap-health-facilities.xml   total 428   reached 192   atDepthGtMax 380
 *
 * 428 = 107 facilities × 4 locales, and the 380 split into exactly two sets,
 * both reproduced by equality rather than modelled:
 *
 *   236 = 59 facilities × 4 locales, depth `unreachable`
 *         → ranked 49+, no inbound link at all. 59 + 48 = 107.
 *   144 = the other 48 facilities × the 3 NON-default locales, at depth
 *         5 / 7 / 9 → they hang off the nursing landings, which are
 *         themselves offenders in en/de/fr (`sitemap-nursing.xml`: 7 of 12
 *         over budget, `/de/pflegehilfe-jobs-schweiz/` at depth 8). The 48
 *         IT twins are all inside the budget, which is why the aggregate
 *         count hid the split.
 *
 * Neither half is fixable by a bigger cap: the first needs a link that does
 * not exist, the second needs a SHORTER path. Both are what the HTML sitemap
 * page is for — it is on every page's nav, the standard injection target of
 * six sibling `*LinksPlugin.ts` files, and in the same measurement every
 * family that uses it sits at 0 offenders (employer-profiles 498 @ deepest 3,
 * profession-cantons 940 @ 4, salary-hub 1768 @ 4, weekly-employers 460 @ 3,
 * comuni-fiscale 70 @ 4, bfs-salary 36 @ 4, professions, profession-cities,
 * publisher-ads, salary-profession-cantons). The one exception,
 * `sitemap-salary-stats.xml` at 75/96, is the locale-nav anchor #5509 had
 * already fixed after that build was cut.
 *
 * So this plugin now injects a SECOND, uncapped block — every facility in
 * `emitted`, one compact anchor each — into the four HTML sitemap pages:
 *
 *   it → /mappa-del-sito/      en → /en/site-map/
 *   de → /de/seitenplan/       fr → /fr/plan-du-site/
 *
 * The near-you block stays exactly as it was: it is editorial ranking, and
 * after this change it is no longer the family's crawl surface, so it can be
 * re-ranked or re-capped without orphaning anything.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import {
  nursingLandingsFlushed,
  healthFacilitiesFlushed,
  staticPagesFlushed,
  type EmittedFacility,
} from './shared/buildSignals';
import { SITE_MAP_PAGE_DIR } from './shared/siteMapPageDir';
import {
  NURSING_LANDING_IDS,
  NURSING_LOCALES,
  buildNursingLandingPath,
  type NursingLandingId,
  type NursingLocale,
} from './nursingLandingsData';
import {
  buildHealthFacilityPath,
  getHealthFacility,
  type HealthFacilityLocale,
} from './healthFacilitiesData';
import { FACILITY_INDEX_BLOCK, NEAR_YOU_BLOCK } from './healthFacilitiesCopy';

// Idempotency marker. Stale-block note (reviewer adversarial check, PR
// #4514): a landing HTML carrying this marker from a PREVIOUS build with a
// different facility list cannot occur in practice — production dist/ is
// always built from scratch (CI monolith + per-locale shards both start
// empty), and dev/watch builds run with FAST_BUILD=1 where the whole SEO
// plugin block (including nursingLandingsPlugin, the producer of the target
// HTML) is skipped. Within one build the producer always re-renders the
// landing fresh, so the marker can only be absent when this injector runs.
const MARKER = 'data-health-facility-links';
/**
 * Marker of the complete index on the HTML sitemap page. Distinct from
 * {@link MARKER} on purpose — the two blocks live on different pages, and
 * `injectBlockAfterMain` keys idempotency on the marker, so sharing one would
 * make whichever ran second a silent no-op if a page ever carried both.
 */
const INDEX_MARKER = 'data-health-facility-index';
/**
 * Cap of the CURATED near-you shortlist only.
 *
 * Was 8. Raising it to 24 was not enough and could never have been: with three
 * landing ids taking disjoint slices of one ranked list, the union is bounded
 * at 2 × MAX_FACILITY_LINKS no matter how the slices are drawn, while the
 * emitted family keeps growing with the job corpus. Reachability is now the
 * sitemap-page index's job (see the file header), which has no cap; this
 * number is free to move on page-weight grounds alone.
 */
const MAX_FACILITY_LINKS = 24;

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rank the above-floor facilities for a given nursing landing id.
 *
 * `nurses` and `oss` used to both take the identical top-N by liveCount, so
 * across all 3 ids × 4 locales only N unique facilities ever got linked (was
 * N=8 → 428/436 = 98.2% of the family stayed orphaned, tripping the
 * new-shard check in audit:max-bfs-depth). No per-facility "care-assistant
 * openings" signal exists on {@link EmittedFacility} to split on topically
 * (the file header doc predates this — it was never actually implemented),
 * so instead `nurses`/`oss` take disjoint even/odd slices of the SAME
 * ranked list — a real, data-available way to make the two ids' link sets
 * non-overlapping — while `healthcare-ticino` keeps its TI-first behaviour.
 */
export function pickFacilities(id: NursingLandingId, all: readonly EmittedFacility[]): EmittedFacility[] {
  const byCount = [...all].sort((a, b) => b.liveCount - a.liveCount);
  if (id === 'healthcare-ticino') {
    const ti = byCount.filter((f) => f.canton === 'TI');
    const rest = byCount.filter((f) => f.canton !== 'TI');
    return [...ti, ...rest].slice(0, MAX_FACILITY_LINKS);
  }
  const parity = id === 'oss' ? 1 : 0;
  return byCount.filter((_, i) => i % 2 === parity).slice(0, MAX_FACILITY_LINKS);
}

function facilityLinkLabel(f: EmittedFacility, locale: HealthFacilityLocale): string {
  const opens =
    locale === 'it' ? `${f.liveCount} offerte`
    : locale === 'de' ? `${f.liveCount} Stellen`
    : locale === 'fr' ? `${f.liveCount} postes`
    : `${f.liveCount} jobs`;
  return `${f.name} — ${opens}`;
}

function renderBlock(
  locale: HealthFacilityLocale,
  facilities: readonly EmittedFacility[],
): string {
  const copy = NEAR_YOU_BLOCK[locale];
  const items = facilities
    .map((f) => {
      const href = buildHealthFacilityPath(locale, f.slug);
      return `<li class="s-au6GuP"><a class="s-z9nmhV" href="${esc(href)}">${esc(facilityLinkLabel(f, locale))}</a></li>`;
    })
    .join('');
  return `<aside class="s-t3iAsJ" ${MARKER}><p class="s-CwCrzh">${esc(copy.title)}</p><p class="s-IZUbGV">${esc(copy.intro)}</p><ul class="s-2T6Feu">${items}</ul></aside>`;
}

/**
 * The complete index injected into the HTML sitemap page: EVERY facility in
 * `emitted`, for the given locale, ordered by name.
 *
 * Two shape decisions, both taken on measurement rather than taste:
 *
 *  - **No cap, and no slice.** This function's contract is the invariant the
 *    family lacked — «every emitted facility is linked from a page the crawler
 *    reaches» — so it takes the list it is given whole. Anything that trims
 *    here silently re-orphans the tail, which is the exact bug #5434 records.
 *  - **Separator rows, not cards.** Same trade #5512 measured on the border
 *    comuni: at ~90 B per anchor the 107 facilities of the current corpus cost
 *    ≈ 10 KB, against ≈ 26 KB as `<li>` cards. The four sitemap pages are
 *    103–139 KB live (measured 2026-08-10) and `scripts/audit-page-weight.mjs`
 *    budgets 260 KB, so the compact form leaves the IT page — the heaviest —
 *    about 110 KB of headroom, i.e. room for the family to roughly double
 *    before the shape has to change.
 *
 * The `liveCount` is deliberately NOT in the label here (unlike the near-you
 * block): it churns every build, and this is an index, not a listing.
 */
export function renderFacilityIndexBlock(
  locale: HealthFacilityLocale,
  facilities: readonly EmittedFacility[],
): string {
  if (facilities.length === 0) return '';
  const copy = FACILITY_INDEX_BLOCK[locale];
  const links = [...facilities]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (f) =>
        `<a class="s-z9nmhV" href="${esc(buildHealthFacilityPath(locale, f.slug))}">${esc(f.name)}</a>`,
    )
    .join(' · ');
  return (
    `<aside class="s-t3iAsJ" ${INDEX_MARKER}>` +
    `<h3 class="s-CwCrzh">${esc(copy.title)}</h3>` +
    `<p class="s-IZUbGV">${esc(copy.intro)}</p>` +
    `<p class="s-2T6Feu">${links}</p>` +
    `</aside>`
  );
}

export function healthFacilitiesLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'health-facilities-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_HEALTH_FACILITIES === '1' || process.env.SKIP_NURSING === '1') return;
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Barrier: wait for all three producers so the target HTML is final and
      // we know which facilities cleared the floor this build.
      // `staticPagesFlushed` is the one that owns the HTML sitemap pages: read
      // before it resolves and the patch races the WriteCollector's background
      // flush and is silently lost — same failure the sibling injectors fixed.
      const [, emitted] = await Promise.all([
        nursingLandingsFlushed,
        healthFacilitiesFlushed,
        staticPagesFlushed,
      ]);
      if (!emitted || emitted.length === 0) {
        console.log('\x1b[33m[health-facilities-links]\x1b[0m No above-floor facilities — nothing to inject.');
        return;
      }

      let injected = 0;
      let missing = 0;
      for (const id of NURSING_LANDING_IDS) {
        const facilities = pickFacilities(id, emitted);
        if (facilities.length === 0) continue;
        for (const locale of NURSING_LOCALES) {
          if (!shouldEmitLocale(locale)) continue;
          const path = buildNursingLandingPath(locale as NursingLocale, id).replace(/^\/+/, '');
          const indexPath = np.join(distDir, path, 'index.html');
          if (!fs.existsSync(indexPath)) {
            // Nursing landing can be thin-skipped in some locales — not fatal.
            missing++;
            continue;
          }
          const html = fs.readFileSync(indexPath, 'utf-8');
          const block = renderBlock(locale as HealthFacilityLocale, facilities);
          const { html: patched, outcome } = injectBlockAfterMain(html, block, MARKER);
          if (outcome === 'inserted') {
            fs.writeFileSync(indexPath, patched, 'utf-8');
            injected++;
          }
        }
      }

      // ── Complete index on the HTML sitemap pages (issue #5434) ──────────
      // Not a bigger version of the block above: different page, different
      // contract. The near-you block ranks 24; this one links all of them,
      // and it is what keeps the family inside maxDepth: 4.
      const indexFailures: string[] = [];
      let indexInjected = 0;
      for (const locale of Object.keys(SITE_MAP_PAGE_DIR) as HealthFacilityLocale[]) {
        // Per-locale shard build (BUILD_LOCALE): a locale this shard did not
        // emit has no sitemap page on disk, and its facility pages are not in
        // this shard's dist either — skipping is correct, not a miss.
        if (!shouldEmitLocale(locale)) continue;
        const indexPath = np.join(distDir, SITE_MAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          indexFailures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderFacilityIndexBlock(locale, emitted);
        const { html: patched, outcome } = injectBlockAfterMain(html, block, INDEX_MARKER);
        if (outcome === 'inserted') {
          fs.writeFileSync(indexPath, patched, 'utf-8');
          indexInjected++;
        } else if (outcome === 'no-anchor') {
          indexFailures.push(` - [no-anchor] ${np.relative(distDir, indexPath)}`);
        }
        // 'duplicate' → already patched this build, no-op.
      }

      // Reference getHealthFacility so a future divergence between the emitted
      // list and the committed registry surfaces at type-check time.
      void getHealthFacility;

      console.log(
        `\x1b[36m[health-facilities-links]\x1b[0m Injected "near you" facility block into ${injected} nursing landings` +
          (missing > 0 ? ` (${missing} landing targets absent — thin-skipped)` : '') +
          `; complete ${emitted.length}-facility index into ${indexInjected} HTML sitemap page(s).`,
      );

      // Hard-fail only when we had facilities to link but hit ZERO targets —
      // that means the barrier/paths are wrong (a real regression), not a
      // benign per-locale thin-skip.
      if (injected === 0) {
        throw new Error(
          '[health-facilities-links] 0 nursing landings patched despite above-floor facilities — ' +
            'the "viceversa" link graph collapsed (BFS orphans). Check the nursingLandingsFlushed barrier and landing paths.',
        );
      }

      // Hard-fail on ANY sitemap-page miss, unlike the nursing landings above:
      // a nursing landing can legitimately be thin-skipped, an HTML sitemap
      // page of an emitted locale cannot. One un-patched page silently puts
      // that locale's whole facility family back over the depth budget, which
      // is invisible until the next post-deploy BFS run hours later — the same
      // reason employerProfilePagesLinksPlugin throws here.
      if (indexFailures.length > 0) {
        throw new Error(
          `[health-facilities-links] failed to inject the complete facility index into ${indexFailures.length} target(s):\n` +
            `${indexFailures.join('\n')}\n\n` +
            'This re-buries sitemap-health-facilities.xml (audit:max-bfs-depth, issue #5434). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
