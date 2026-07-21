/**
 * Profession × city landings — internal-links injector.
 *
 * {@link professionCityLandings} emits `/lavoro-{city}-{role}/` (+ /en/jobs-,
 * /de/arbeit-, /fr/travail-) but — unlike its sibling family
 * {@link professionCantonLandings}, which already has
 * {@link professionCantonLandingsLinksPlugin} — nothing on a crawlable page
 * links INTO these city pages, so 208 URLs (62.65%) ship beyond
 * `audit:max-bfs-depth`'s MAX_DEPTH=4 (epic #4301/#4488).
 *
 * This plugin closes that orphan tier the same way
 * {@link professionCantonLandingsLinksPlugin} closed the profession-canton
 * tier (CLAUDE.md regola #5 — real internal `<a href>` links from a hub
 * reachable from `/`, never by relaxing the gate): after the city emitter AND
 * staticPagesPlugin flush, it injects one "Lavoro per città e professione"
 * block into each locale's HTML sitemap page:
 *
 *   it → /mappa-del-sito/      (in the main nav → depth 1 from `/`)
 *   en → /en/site-map/         (in the /en/ nav  → depth 2 from `/`)
 *   de → /de/seitenplan/       (in the /de/ nav  → depth 2 from `/`)
 *   fr → /fr/plan-du-site/     (in the /fr/ nav  → depth 2 from `/`)
 *
 * Idempotent via the `data-profession-cities-links` marker, distinct from
 * {@link professionCantonLandingsLinksPlugin}'s and
 * {@link employerProfilePagesLinksPlugin}'s own markers on the same page —
 * see `build-plugins/shared/injectAfterMain.ts` for why independent
 * injectors can safely stack on one file.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import {
  PROFESSION_LOCALES,
  professionRoleKeyword,
  type ProfessionLocale,
  type ProfessionId,
} from './professionLandingsData';
import { parseProfessionCityPath, getProfessionCityDef } from './professionCityData';
import { staticPagesFlushed, professionCitiesFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR as SITEMAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-profession-cities-links';

const BLOCK_COPY: Record<ProfessionLocale, { heading: string; intro: string }> = {
  it: {
    heading: 'Lavoro per città e professione',
    intro: 'Offerte attive e stipendio mediano per professione nelle principali città svizzere.',
  },
  en: {
    heading: 'Jobs by city and profession',
    intro: 'Active openings and median salary by profession in major Swiss cities.',
  },
  de: {
    heading: 'Stellen nach Stadt und Beruf',
    intro: 'Aktive Stellen und Medianlohn nach Beruf in den wichtigsten Schweizer Städten.',
  },
  fr: {
    heading: 'Emplois par ville et profession',
    intro: 'Offres actives et salaire médian par métier dans les principales villes suisses.',
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Title-cased role keyword (mirror of professionCityLandings' internal label builder). */
function professionLabel(locale: ProfessionLocale, id: ProfessionId): string {
  const role = professionRoleKeyword(locale, id).replace(/-/g, ' ');
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface LinkItem {
  href: string;
  label: string;
}

/** Build the injected block for one locale; '' when the locale has no links. */
export function renderCityLinksBlock(locale: ProfessionLocale, items: readonly LinkItem[]): string {
  if (items.length === 0) return '';
  const copy = BLOCK_COPY[locale];
  const lis = items
    .map((it) => `<li class="s-xu5DGK"><a class="s-U9K6Vf" href="${esc(it.href)}">${esc(it.label)}</a></li>`)
    .join('');
  return (
    `<aside ${MARKER}>` +
    `<h3 class="s-ghlfvV">${esc(copy.heading)}</h3>` +
    `<p>${esc(copy.intro)}</p>` +
    `<ul class="s--Vsbr1">${lis}</ul>` +
    `</aside>`
  );
}

/**
 * Group emitted profession-city canonical paths into per-locale, sorted link
 * items. Exported for unit testing the grouping without touching disk.
 */
export function buildCityLinkItems(
  emittedPaths: readonly string[],
): Record<ProfessionLocale, LinkItem[]> {
  const byLocale: Record<ProfessionLocale, LinkItem[]> = { it: [], en: [], de: [], fr: [] };
  for (const path of emittedPaths) {
    const parsed = parseProfessionCityPath(path);
    if (!parsed) continue;
    const { locale, cityKey, id } = parsed;
    const city = getProfessionCityDef(cityKey)?.display ?? cityKey;
    const role = professionLabel(locale, id);
    byLocale[locale].push({ href: path, label: `${role} · ${city}` });
  }
  for (const loc of PROFESSION_LOCALES) {
    byLocale[loc].sort((a, b) => a.label.localeCompare(b.label));
  }
  return byLocale;
}

export function professionCityLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'profession-city-landings-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_PROFESSION_CITIES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the city emitter (gives us emitted paths) AND
      // staticPagesPlugin (writes the sitemap pages we patch) so both
      // producers have flushed to disk before we read+patch — mirrors
      // professionCantonLandingsLinksPlugin's race fix.
      const [emittedPaths] = await Promise.all([
        professionCitiesFlushed,
        staticPagesFlushed,
      ]);

      if (emittedPaths.length === 0) {
        console.log('\x1b[36m[profession-city-landings-links]\x1b[0m No emitted pages — nothing to link.');
        return;
      }

      const byLocale = buildCityLinkItems(emittedPaths);

      const failures: string[] = [];
      let injected = 0;
      for (const locale of PROFESSION_LOCALES) {
        // Per-locale shard build (BUILD_LOCALE): skip locales this shard did
        // not emit — their sitemap pages are absent and would hard-fail as
        // missing-file. No-op in the default all-locale build.
        if (!shouldEmitLocale(locale)) continue;
        const items = byLocale[locale];
        if (items.length === 0) continue; // nothing emitted for this locale
        const indexPath = np.join(distDir, SITEMAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          failures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderCityLinksBlock(locale, items);
        const { html: patched, outcome } = injectBlockAfterMain(html, block, MARKER);
        if (outcome === 'inserted') {
          fs.writeFileSync(indexPath, patched, 'utf-8');
          injected++;
        } else if (outcome === 'no-anchor') {
          failures.push(` - [no-anchor] ${np.relative(distDir, indexPath)}`);
        }
        // 'duplicate' → already patched this build, no-op.
      }

      console.log(
        `\x1b[36m[profession-city-landings-links]\x1b[0m Injected per-city links into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-profession-cities.xml orphan tier audit:max-bfs-depth hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[profession-city-landings-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-profession-cities.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
