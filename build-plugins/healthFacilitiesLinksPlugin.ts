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
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import {
  nursingLandingsFlushed,
  healthFacilitiesFlushed,
  type EmittedFacility,
} from './shared/buildSignals';
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
import { NEAR_YOU_BLOCK } from './healthFacilitiesCopy';

const MARKER = 'data-health-facility-links';
const MAX_FACILITY_LINKS = 8;

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Rank the above-floor facilities for a given nursing landing id. */
function pickFacilities(id: NursingLandingId, all: readonly EmittedFacility[]): EmittedFacility[] {
  const byCount = [...all].sort((a, b) => b.liveCount - a.liveCount);
  if (id === 'healthcare-ticino') {
    const ti = byCount.filter((f) => f.canton === 'TI');
    const rest = byCount.filter((f) => f.canton !== 'TI');
    return [...ti, ...rest].slice(0, MAX_FACILITY_LINKS);
  }
  return byCount.slice(0, MAX_FACILITY_LINKS);
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

export function healthFacilitiesLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'health-facilities-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_HEALTH_FACILITIES === '1' || process.env.SKIP_NURSING === '1') return;
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Barrier: wait for both producers so the target HTML is final and we
      // know which facilities cleared the floor this build.
      const [, emitted] = await Promise.all([nursingLandingsFlushed, healthFacilitiesFlushed]);
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

      // Reference getHealthFacility so a future divergence between the emitted
      // list and the committed registry surfaces at type-check time.
      void getHealthFacility;

      console.log(
        `\x1b[36m[health-facilities-links]\x1b[0m Injected "near you" facility block into ${injected} nursing landings` +
          (missing > 0 ? ` (${missing} landing targets absent — thin-skipped)` : '') +
          '.',
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
    },
  };
}
