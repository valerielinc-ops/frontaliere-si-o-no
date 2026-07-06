/**
 * Per-canton profession landings — internal-links injector.
 *
 * {@link professionCantonLandings} emits `/lavoro-{canton}-{role}/` (+ /en/jobs-,
 * /de/arbeit-, /fr/travail-) but nothing on a crawlable page links INTO them, so
 * all 332 ship at BFS depth `unreachable` from `/` — `audit:max-bfs-depth` hard-
 * fails the family as an entirely-buried new content tier (reached 0/332).
 *
 * This plugin closes that orphan tier the canonical way (CLAUDE.md regola #5 —
 * real internal `<a href>` links from a hub reachable from `/`, never by
 * relaxing the gate): after the canton emitter AND staticPagesPlugin flush, it
 * injects one "Lavoro per cantone e professione" block into each locale's HTML
 * sitemap page:
 *
 *   it → /mappa-del-sito/      (in the main nav → depth 1 from `/`)
 *   en → /en/site-map/         (in the /en/ nav  → depth 2 from `/`)
 *   de → /de/seitenplan/       (in the /de/ nav  → depth 2 from `/`)
 *   fr → /fr/plan-du-site/     (in the /fr/ nav  → depth 2 from `/`)
 *
 * The sitemap page is on every page's nav, so each emitted canton landing lands
 * at depth ≤ 3 (IT ≤ 2) — well inside the audit's MAX_DEPTH=4. The job-board
 * hubs (/cerca-lavoro-ticino/ et al.) are NOT viable for the locales: they sit
 * at apex depth 5 (measured), so a link there would leave the canton pages at
 * depth 6 — still buried.
 *
 * Idempotent via the `data-profession-cantons-links` marker. Shares the pure
 * insertion logic with the AE-3 injector (build-plugins/shared/injectAfterMain).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import {
  PROFESSION_LOCALES,
  professionRoleKeywordAny,
  type AnyProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import {
  parseProfessionCantonPath,
} from './professionCantonData';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import { staticPagesFlushed, professionCantonsFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';

const MARKER = 'data-profession-cantons-links';

/** HTML sitemap page (relative dir under dist) per locale — main-nav reachable. */
const SITEMAP_PAGE_DIR: Record<ProfessionLocale, string> = {
  it: 'mappa-del-sito',
  en: 'en/site-map',
  de: 'de/seitenplan',
  fr: 'fr/plan-du-site',
};

const BLOCK_COPY: Record<ProfessionLocale, { heading: string; intro: string }> = {
  it: {
    heading: 'Lavoro per cantone e professione',
    intro: 'Offerte attive, datori reali e stipendio mediano per professione in ogni cantone svizzero.',
  },
  en: {
    heading: 'Jobs by canton and profession',
    intro: 'Active openings, real employers and median salary by profession in every Swiss canton.',
  },
  de: {
    heading: 'Stellen nach Kanton und Beruf',
    intro: 'Aktive Stellen, echte Arbeitgeber und Medianlohn nach Beruf in jedem Schweizer Kanton.',
  },
  fr: {
    heading: 'Emplois par canton et profession',
    intro: 'Offres actives, employeurs réels et salaire médian par métier dans chaque canton suisse.',
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Title-cased role keyword (mirror of professionCantonLandings.professionLabel). */
function professionLabel(locale: ProfessionLocale, id: AnyProfessionId): string {
  const role = professionRoleKeywordAny(locale, id).replace(/-/g, ' ');
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface LinkItem {
  href: string;
  label: string;
}

/** Build the injected block for one locale; '' when the locale has no links. */
export function renderCantonLinksBlock(locale: ProfessionLocale, items: readonly LinkItem[]): string {
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
 * Group emitted canonical paths into per-locale, sorted link items. Exported
 * for unit testing the grouping/label derivation without touching disk.
 */
export function buildCantonLinkItems(
  emittedPaths: readonly string[],
): Record<ProfessionLocale, LinkItem[]> {
  const byLocale: Record<ProfessionLocale, LinkItem[]> = { it: [], en: [], de: [], fr: [] };
  for (const path of emittedPaths) {
    const parsed = parseProfessionCantonPath(path);
    if (!parsed) continue;
    const { locale, cantonKey, id } = parsed;
    const canton = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
    const role = professionLabel(locale, id);
    byLocale[locale].push({ href: path, label: `${role} · ${canton}` });
  }
  for (const loc of PROFESSION_LOCALES) {
    byLocale[loc].sort((a, b) => a.label.localeCompare(b.label));
  }
  return byLocale;
}

export function professionCantonLandingsLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'profession-canton-landings-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_PROFESSION_CANTONS === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the canton emitter (gives us the emitted paths) AND
      // staticPagesPlugin (writes the sitemap pages we patch) so both producers
      // have flushed to disk before we read+patch — mirrors the AE-3 race fix.
      const [emittedPaths] = await Promise.all([
        professionCantonsFlushed,
        staticPagesFlushed,
      ]);

      const byLocale = buildCantonLinkItems(emittedPaths);

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
        const block = renderCantonLinksBlock(locale, items);
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
        `\x1b[36m[profession-canton-landings-links]\x1b[0m Injected per-canton links into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-profession-cantons.xml orphan tier the audit hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[profession-canton-landings-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-profession-cantons.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
