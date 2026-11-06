/**
 * Regression guard for issue #5434 — every emitted health facility must be
 * linked from a page the crawler actually reaches, and the link surface may
 * not be a capped, curated slice.
 *
 * What went wrong, and why no existing test saw it
 * ------------------------------------------------
 * `healthFacilitiesPlugin` emits one indexable page per above-floor facility
 * × 4 locales and puts every one of them in `sitemap-health-facilities.xml`.
 * The only thing linking INTO them was the "facilities hiring near you" block
 * that `healthFacilitiesLinksPlugin` injects on three nursing landings, capped
 * at `MAX_FACILITY_LINKS` = 24 each. `pickFacilities()` draws `nurses` and
 * `oss` from disjoint even/odd slices of one ranked list and
 * `healthcare-ticino` from the head of the same list, so the UNION of the
 * three is bounded at 2 × MAX_FACILITY_LINKS = 48 — a constant, while the
 * emitted family grows with the job corpus.
 *
 * Measured on run 31369964810 (`validate-dist-postbuild-bfs`, build 727a13f3;
 * `offendersList` read from the job log, not the artifact — `topOffenders` is
 * capped at 100 global entries and holds none of this family):
 *
 *   sitemap-health-facilities.xml  total 428  reached 192  atDepthGtMax 380
 *
 * 428 = 107 facilities × 4 locales, and the 380 reproduce exactly as two
 * disjoint sets:
 *
 *   236 = 59 facilities × 4 locales at depth `unreachable` — ranked 49th or
 *         lower, linked from nowhere (59 + 48 = 107);
 *   144 = the other 48 × the 3 non-default locales at depth 5 / 7 / 9 — they
 *         hang off the nursing landings, which are themselves over budget in
 *         en/de/fr (`sitemap-nursing.xml`: 7 of 12,
 *         `/de/pflegehilfe-jobs-schweiz/` at depth 8). Their IT twins were all
 *         inside the budget, which is why the aggregate count hid the split.
 *
 * Every unit involved was locally correct — the cap is a legitimate
 * page-weight decision, the parity slices are a legitimate de-duplication —
 * and the defect exists only in the link graph, which does not come into being
 * until the build has finished. So the guard is written against the two
 * properties that are checkable from source:
 *
 *   1. the complete-index renderer links EVERY facility it is handed, in the
 *      locale-correct path shape, with no cap and no slice;
 *   2. the near-you shortlist provably cannot substitute for it — its union is
 *      bounded at 48 regardless of corpus size, which is the assertion that
 *      fails on the pre-fix tree.
 *
 * The assertions are on the invariants, not on today's counts: the family was
 * buried by corpus GROWTH against a fixed cap, not by an edit to the link
 * code, so a test pinned to 107 or to 380 would have expired the same way.
 */

import fs from 'node:fs';
import os from 'node:os';
import np from 'node:path';

import { afterAll, describe, it, expect } from 'vitest';

import {
  healthFacilitiesLinksPlugin,
  pickFacilities,
  renderFacilityIndexBlock,
} from '../../build-plugins/healthFacilitiesLinksPlugin';
import {
  HEALTH_FACILITIES,
  HEALTH_FACILITY_LOCALES,
  HEALTH_FACILITY_SECTION,
  buildHealthFacilityPath,
  type HealthFacilityLocale,
} from '../../build-plugins/healthFacilitiesData';
import {
  NURSING_LANDING_IDS,
  NURSING_LOCALES,
  buildNursingLandingPath,
} from '../../build-plugins/nursingLandingsData';
import { SITE_MAP_PAGE_DIR } from '../../build-plugins/shared/siteMapPageDir';
import { injectBlockAfterMain } from '../../build-plugins/shared/injectAfterMain';
import {
  resolveHealthFacilitiesFlushed,
  resolveNursingLandingsFlushed,
  resolveStaticPagesFlushed,
  type EmittedFacility,
} from '../../build-plugins/shared/buildSignals';

/** Mirrors the constant the plugin keeps private; asserted against below. */
const NEAR_YOU_CAP = 24;

function fixtureFacilities(n: number): EmittedFacility[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `facility-${String(i).padStart(3, '0')}`,
    canton: i % 7 === 0 ? 'TI' : 'ZH',
    name: `Facility ${String(i).padStart(3, '0')}`,
    liveCount: 500 - i,
  }));
}

function hrefsIn(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

describe('health-facilities complete index — every emitted facility is linked', () => {
  it('links all of them, in every locale, even far past the near-you cap', () => {
    // 130 > 2 × NEAR_YOU_CAP: any surviving slice would show up as a shortfall.
    const facilities = fixtureFacilities(130);
    for (const locale of HEALTH_FACILITY_LOCALES) {
      const html = renderFacilityIndexBlock(locale, facilities);
      const hrefs = new Set(hrefsIn(html));
      expect(hrefs.size, `locale ${locale}`).toBe(facilities.length);
      for (const f of facilities) {
        expect(hrefs.has(buildHealthFacilityPath(locale, f.slug)), `${locale} ${f.slug}`).toBe(true);
      }
    }
  });

  it('never links a facility across locales — a DE index carries only DE paths', () => {
    // The index sits on the locale's own HTML sitemap page, so a cross-locale
    // href would send the crawler back up to a page it already has and leave
    // this locale's facilities unlinked — the failure would still read as
    // "links present" to any assertion that only counted anchors.
    for (const locale of HEALTH_FACILITY_LOCALES) {
      const html = renderFacilityIndexBlock(locale, fixtureFacilities(12));
      const expectedPrefix = `/${HEALTH_FACILITY_SECTION[locale]}/`;
      for (const href of hrefsIn(html)) {
        expect(href.startsWith(expectedPrefix), `${locale}: ${href}`).toBe(true);
      }
    }
  });

  it('covers the whole committed registry, not a leading window of it', () => {
    // Real data rather than the fixture: the defect arrived through corpus
    // growth, so the corpus is the input that has to be exercised.
    const asEmitted: EmittedFacility[] = HEALTH_FACILITIES.map((f) => ({
      slug: f.slug,
      canton: f.canton,
      name: f.name,
      liveCount: f.jobCountSnapshot,
    }));
    expect(asEmitted.length).toBeGreaterThan(2 * NEAR_YOU_CAP);
    const html = renderFacilityIndexBlock('it', asEmitted);
    const hrefs = new Set(hrefsIn(html));
    const missing = asEmitted
      .filter((f) => !hrefs.has(buildHealthFacilityPath('it', f.slug)))
      .map((f) => f.slug);
    expect(missing).toEqual([]);
  });

  it('escapes names and renders nothing at all for an empty list', () => {
    const html = renderFacilityIndexBlock('it', [
      { slug: 'a-b', canton: 'TI', name: 'Clinica "A" & <B>', liveCount: 3 },
    ]);
    expect(html).toContain('Clinica &quot;A&quot; &amp; &lt;B&gt;');
    expect(html).not.toContain('<B>');
    // An empty aside would still satisfy a "block is present" check while
    // linking nothing — the shape the pre-fix family had.
    expect(renderFacilityIndexBlock('it', [])).toBe('');
  });
});

describe('health-facilities complete index — the shortlist cannot stand in for it', () => {
  it('the near-you union is bounded by a constant however big the corpus gets', () => {
    // This is the assertion that fails on the pre-fix tree: before the complete
    // index existed, this bounded union WAS the family's entire link surface.
    //
    // The ceiling is NURSING_LANDING_IDS.length × NEAR_YOU_CAP. In production
    // the union measured 48, not 72, because `nurses`/`oss` take disjoint
    // even/odd slices of one ranked list and `healthcare-ticino` re-sorts the
    // same head TI-first; whether it contributes anything new depends on where
    // the TI facilities rank. Either way the bound is a CONSTANT while the
    // corpus grows — which is the whole defect, and why raising the cap was
    // never going to be the fix.
    const CEILING = NURSING_LANDING_IDS.length * NEAR_YOU_CAP;
    for (const size of [60, 130, 400]) {
      const facilities = fixtureFacilities(size);
      const union = new Set<string>();
      for (const id of NURSING_LANDING_IDS) {
        for (const f of pickFacilities(id, facilities)) union.add(f.slug);
      }
      expect(union.size, `size ${size}`).toBeLessThanOrEqual(CEILING);
      expect(union.size, `size ${size}: shortlist leaves a tail unlinked`).toBeLessThan(size);
    }
  });

  it('each nursing landing still gets a shortlist capped at 24', () => {
    // Guards the other direction: the fix must not have turned the curated
    // block into the uncapped one by accident (page weight on a landing).
    const facilities = fixtureFacilities(130);
    for (const id of NURSING_LANDING_IDS) {
      expect(pickFacilities(id, facilities).length, id).toBe(NEAR_YOU_CAP);
    }
  });
});

describe('health-facilities complete index — it lands on the shallow page', () => {
  it('targets the HTML sitemap page of every facility locale', () => {
    // The nursing landings are not a crawl-depth answer: three of the four
    // locales' landings are themselves offenders. SITE_MAP_PAGE_DIR is the
    // main-nav page every sibling *LinksPlugin uses for exactly this reason,
    // and in the same measurement every family injected there sat at zero
    // offenders (employer-profiles 498 @ deepest 3, profession-cantons 940 @ 4,
    // salary-hub 1768 @ 4, weekly-employers 460 @ 3, ...).
    for (const locale of HEALTH_FACILITY_LOCALES) {
      expect(SITE_MAP_PAGE_DIR[locale as HealthFacilityLocale]).toBeTruthy();
    }
    // The sitemap page and the facilities it links must live under the same
    // locale prefix, or the shallow page of one locale would be carrying
    // another locale's family.
    for (const locale of HEALTH_FACILITY_LOCALES) {
      if (locale === 'it') {
        expect(SITE_MAP_PAGE_DIR.it).not.toMatch(/^(en|de|fr)\//);
        expect(HEALTH_FACILITY_SECTION.it).not.toMatch(/^(en|de|fr)\//);
      } else {
        expect(SITE_MAP_PAGE_DIR[locale].startsWith(`${locale}/`)).toBe(true);
        expect(HEALTH_FACILITY_SECTION[locale].startsWith(`${locale}/`)).toBe(true);
      }
    }
  });

  it('injects under its own marker, so it cannot no-op against the near-you block', () => {
    // injectBlockAfterMain keys idempotency on the marker string. Reusing the
    // near-you marker would make whichever injector ran second a silent no-op,
    // and a silent no-op here is indistinguishable from the original bug.
    const page = '<html><body><main>sitemap</main></body></html>';
    const nearYouAlreadyThere = page.replace(
      '</main>',
      '</main><aside data-health-facility-links></aside>',
    );
    const block = renderFacilityIndexBlock('it', fixtureFacilities(5));
    const { outcome, html } = injectBlockAfterMain(
      nearYouAlreadyThere,
      block,
      'data-health-facility-index',
    );
    expect(outcome).toBe('inserted');
    expect(hrefsIn(html).length).toBe(5);

    // ...and it is idempotent against itself.
    const second = injectBlockAfterMain(html, block, 'data-health-facility-index');
    expect(second.outcome).toBe('duplicate');
  });
});

/**
 * The renderer being correct is not the same as the block reaching the page.
 * Both halves of this family's history are write-path bugs (the #4458 cap, and
 * before it an N=8 shortlist that left 98.2% orphaned), so the plugin is driven
 * for real against a throwaway `dist/`: signals resolved, closeBundle run,
 * files re-read from disk.
 */
describe('health-facilities complete index — the plugin actually writes it', () => {
  const tmpRoots: string[] = [];

  function makeDist(opts: { omitSitemapPage?: HealthFacilityLocale } = {}): string {
    const root = fs.mkdtempSync(np.join(os.tmpdir(), 'hf-index-'));
    tmpRoots.push(root);
    const dist = np.join(root, 'dist');
    const page = (title: string) =>
      `<html><body><main id="main-content">${title}</main></body></html>`;
    for (const locale of HEALTH_FACILITY_LOCALES) {
      if (opts.omitSitemapPage === locale) continue;
      const dir = np.join(dist, SITE_MAP_PAGE_DIR[locale]);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(np.join(dir, 'index.html'), page(`sitemap ${locale}`), 'utf-8');
    }
    for (const locale of NURSING_LOCALES) {
      for (const id of NURSING_LANDING_IDS) {
        const dir = np.join(dist, buildNursingLandingPath(locale, id).replace(/^\/+/, ''));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(np.join(dir, 'index.html'), page(`${locale} ${id}`), 'utf-8');
      }
    }
    return root;
  }

  const facilities = fixtureFacilities(130);
  // One resolution for the whole file — these are module singletons, exactly
  // as they are in a build. closeBundle can then be re-run against a second
  // dist because it only awaits already-settled promises.
  resolveNursingLandingsFlushed();
  resolveStaticPagesFlushed();
  resolveHealthFacilitiesFlushed(facilities);

  async function run(root: string): Promise<void> {
    const plugin = healthFacilitiesLinksPlugin(root) as unknown as {
      closeBundle: () => Promise<void>;
    };
    await plugin.closeBundle();
  }

  afterAll(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  });

  it('patches all four HTML sitemap pages with every facility', async () => {
    const root = makeDist();
    await run(root);
    for (const locale of HEALTH_FACILITY_LOCALES) {
      const html = fs.readFileSync(
        np.join(root, 'dist', SITE_MAP_PAGE_DIR[locale], 'index.html'),
        'utf-8',
      );
      expect(html, `locale ${locale}`).toContain('data-health-facility-index');
      const hrefs = new Set(hrefsIn(html));
      for (const f of facilities) {
        expect(hrefs.has(buildHealthFacilityPath(locale, f.slug)), `${locale} ${f.slug}`).toBe(true);
      }
    }
  });

  it('still patches the nursing landings, and keeps their shortlist capped', async () => {
    const root = makeDist();
    await run(root);
    const landing = fs.readFileSync(
      np.join(root, 'dist', buildNursingLandingPath('it', 'nurses').replace(/^\/+/, ''), 'index.html'),
      'utf-8',
    );
    expect(landing).toContain('data-health-facility-links');
    expect(landing).not.toContain('data-health-facility-index');
    expect(hrefsIn(landing).length).toBe(NEAR_YOU_CAP);
  });

  it('throws instead of shipping a locale whose sitemap page it could not patch', async () => {
    // The silent-degradation path: without this the build stays green and the
    // whole DE family goes back over budget until the next post-deploy BFS run
    // notices, hours later.
    const root = makeDist({ omitSitemapPage: 'de' });
    await expect(run(root)).rejects.toThrow(/missing-file.*seitenplan/s);
  });
});

describe('health-facilities complete index — page-weight headroom', () => {
  it('costs under 150 bytes per additional facility', () => {
    // Asserted as a DELTA, not an average: on a small list the aside's fixed
    // chrome dominates the mean and an average-based bound would pass for a
    // card layout too. 150 B is the line between a separator row (~90 B) and
    // an <li> card (~240 B) — the trade #5512 measured on the border comuni.
    const base = renderFacilityIndexBlock('it', fixtureFacilities(100)).length;
    const grown = renderFacilityIndexBlock('it', fixtureFacilities(200)).length;
    expect((grown - base) / 100).toBeLessThan(150);
    // And the whole committed registry has to fit the 260 KB budget of
    // scripts/audit-page-weight.mjs with room to spare on top of the 139 KB
    // the IT sitemap page already weighs live (measured 2026-08-10).
    const full = renderFacilityIndexBlock(
      'it',
      HEALTH_FACILITIES.map((f) => ({
        slug: f.slug,
        canton: f.canton,
        name: f.name,
        liveCount: f.jobCountSnapshot,
      })),
    );
    expect(full.length).toBeLessThan(60 * 1024);
  });
});
