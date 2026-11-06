/**
 * Fiscal-municipality guide hub — internal-links injector.
 *
 * {@link fiscalMunicipalityPagesPlugin} emits `/tasse-frontalieri-comune/{slug}/`
 * (+ en/de/fr) plus a `FISCAL_HUB_PATH` index per locale, and the hub itself
 * already links every above-floor comune below it — but nothing on a
 * crawlable page ever linked INTO the hub, so the whole
 * `sitemap-comuni-fiscale.xml` shard (33/33 URLs) shipped BFS-unreachable
 * from `/` (audit:max-bfs-depth regression #4593, the fiscal family's own
 * sibling of the orphan-tier bug `professionCantonLandingsLinksPlugin.ts`
 * / `professionCityLinksPlugin.ts` already fix for their families).
 *
 * Closes the orphan tier the canonical way (CLAUDE.md regola #5 — real
 * internal `<a href>` links from a hub reachable from `/`, never by
 * relaxing the gate): after the fiscal emitter AND staticPagesPlugin flush,
 * injects one link to `FISCAL_HUB_PATH[locale]` into each locale's HTML
 * sitemap page:
 *
 *   it → /mappa-del-sito/      (in the main nav → depth 1 from `/`)
 *   en → /en/site-map/         (in the /en/ nav  → depth 2 from `/`)
 *   de → /de/seitenplan/       (in the /de/ nav  → depth 2 from `/`)
 *   fr → /fr/plan-du-site/     (in the /fr/ nav  → depth 2 from `/`)
 *
 * The sitemap page is on every page's nav, so the hub lands at depth ≤ 3
 * (IT ≤ 2) and every above-floor comune it links (already emitted by the
 * hub's own render) lands one hop further — well inside the audit's
 * MAX_DEPTH=4.
 *
 * Idempotent via the `data-fiscal-municipalities-links` marker. Shares the
 * pure insertion logic with the AE-3 injector (build-plugins/shared/injectAfterMain).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { FISCAL_LOCALES, FISCAL_HUB_PATH, type FiscalLocale } from './fiscalMunicipalityData';
import { fiscalMunicipalitiesFlushed, staticPagesFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR as SITEMAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-fiscal-municipalities-links';

const BLOCK_COPY: Record<FiscalLocale, { heading: string; intro: string; linkLabel: string }> = {
  it: {
    heading: 'Tasse frontalieri per comune',
    intro: 'Confronta vecchio e nuovo regime fiscale comune per comune, con addizionale comunale reale.',
    linkLabel: 'Guida fiscale per comune di residenza',
  },
  en: {
    heading: 'Cross-border taxes by municipality',
    intro: 'Compare the old and new tax regime municipality by municipality, with real local surtax.',
    linkLabel: 'Tax guide by municipality',
  },
  de: {
    heading: 'Grenzgängersteuer pro Gemeinde',
    intro: 'Vergleiche altes und neues Steuerregime Gemeinde für Gemeinde, mit echtem Gemeindezuschlag.',
    linkLabel: 'Steuerleitfaden pro Gemeinde',
  },
  fr: {
    heading: 'Impôts frontaliers par commune',
    intro: 'Comparez l’ancien et le nouveau régime fiscal commune par commune, avec la surtaxe communale réelle.',
    linkLabel: 'Guide fiscal par commune',
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the injected block for one locale. */
export function renderFiscalHubLinkBlock(locale: FiscalLocale): string {
  const copy = BLOCK_COPY[locale];
  return (
    `<aside ${MARKER}>` +
    `<h3 class="s-ghlfvV">${esc(copy.heading)}</h3>` +
    `<p>${esc(copy.intro)}</p>` +
    `<ul class="s--Vsbr1"><li class="s-xu5DGK"><a class="s-U9K6Vf" href="${esc(FISCAL_HUB_PATH[locale])}">${esc(copy.linkLabel)}</a></li></ul>` +
    `</aside>`
  );
}

export function fiscalMunicipalityLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'fiscal-municipality-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_FISCAL_MUNICIPALITY_PAGES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the fiscal emitter (hub pages written) AND staticPagesPlugin
      // (writes the sitemap pages we patch) so both producers have flushed
      // to disk before we read+patch — mirrors the AE-3 race fix.
      const [hubPaths] = await Promise.all([fiscalMunicipalitiesFlushed, staticPagesFlushed]);
      if (!hubPaths || hubPaths.length === 0) {
        console.log('\x1b[33m[fiscal-municipality-links]\x1b[0m No fiscal hub pages emitted this build — nothing to inject.');
        return;
      }

      const failures: string[] = [];
      let injected = 0;
      for (const locale of FISCAL_LOCALES) {
        // Per-locale shard build (BUILD_LOCALE): skip locales this shard did
        // not emit — their sitemap pages are absent and would hard-fail as
        // missing-file. No-op in the default all-locale build.
        if (!shouldEmitLocale(locale)) continue;
        const indexPath = np.join(distDir, SITEMAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          failures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderFiscalHubLinkBlock(locale);
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
        `\x1b[36m[fiscal-municipality-links]\x1b[0m Injected fiscal-hub link into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-comuni-fiscale.xml orphan tier the audit hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[fiscal-municipality-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-comuni-fiscale.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
