/**
 * France border-municipality hub — internal-links injector.
 *
 * {@link frenchBorderMunicipalityPagesPlugin} emits
 * `/vivere-in-francia-lavorare-in-svizzera/{slug}/` (+ en/de/fr) plus a
 * `FRENCH_HUB_PATH` index per locale, and the hub itself already links every
 * above-floor commune below it — but nothing on a crawlable page ever linked
 * INTO the hub, so the whole `sitemap-comuni-francia.xml` shard would ship
 * BFS-unreachable from `/` (audit:max-bfs-depth regression #4593, the same
 * orphan-tier bug `fiscalMunicipalityLinksPlugin.ts` fixes for the Italian
 * fiscal family).
 *
 * Closes the orphan tier the canonical way (CLAUDE.md regola #5 — real
 * internal `<a href>` links from a hub reachable from `/`, never by relaxing
 * the gate): after the France emitter AND staticPagesPlugin flush, injects
 * one link to `FRENCH_HUB_PATH[locale]` into each locale's HTML sitemap page.
 *
 * Idempotent via the `data-french-border-municipalities-links` marker. Shares
 * the pure insertion logic with the AE-3 injector
 * (build-plugins/shared/injectAfterMain), mirroring fiscalMunicipalityLinksPlugin.ts.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { FRENCH_LOCALES, FRENCH_HUB_PATH, type FrenchLocale } from './frenchBorderMunicipalityData';
import { frenchBorderMunicipalitiesFlushed, staticPagesFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-french-border-municipalities-links';

const BLOCK_COPY: Record<FrenchLocale, { heading: string; intro: string; linkLabel: string }> = {
  it: {
    heading: 'Vivere in Francia, lavorare in Svizzera',
    intro: 'Affitti, tasse e distanza dal confine comune per comune per i frontalieri francesi.',
    linkLabel: 'Guida ai comuni di confine francesi',
  },
  en: {
    heading: 'Living in France, working in Switzerland',
    intro: 'Rent, taxes and border distance municipality by municipality for French cross-border workers.',
    linkLabel: 'Guide to French border municipalities',
  },
  de: {
    heading: 'In Frankreich leben, in der Schweiz arbeiten',
    intro: 'Miete, Steuern und Grenzentfernung Gemeinde für Gemeinde für französische Grenzgänger.',
    linkLabel: 'Leitfaden zu französischen Grenzgemeinden',
  },
  fr: {
    heading: 'Vivre en France, travailler en Suisse',
    intro: 'Loyers, impôts et distance à la frontière commune par commune pour les frontaliers français.',
    linkLabel: 'Guide des communes frontalières françaises',
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
export function renderFrenchBorderHubLinkBlock(locale: FrenchLocale): string {
  const copy = BLOCK_COPY[locale];
  return (
    `<aside ${MARKER}>` +
    `<h3 class="s-ghlfvV">${esc(copy.heading)}</h3>` +
    `<p>${esc(copy.intro)}</p>` +
    `<ul class="s--Vsbr1"><li class="s-xu5DGK"><a class="s-U9K6Vf" href="${esc(FRENCH_HUB_PATH[locale])}">${esc(copy.linkLabel)}</a></li></ul>` +
    `</aside>`
  );
}

export function frenchBorderMunicipalityLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'french-border-municipality-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_FRENCH_BORDER_MUNICIPALITY_PAGES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the France emitter (hub pages written) AND staticPagesPlugin
      // (writes the sitemap pages we patch) so both producers have flushed
      // to disk before we read+patch — mirrors the AE-3 race fix.
      const [hubPaths] = await Promise.all([frenchBorderMunicipalitiesFlushed, staticPagesFlushed]);
      if (!hubPaths || hubPaths.length === 0) {
        console.log('\x1b[33m[french-border-municipality-links]\x1b[0m No France border hub pages emitted this build — nothing to inject.');
        return;
      }

      const failures: string[] = [];
      let injected = 0;
      for (const locale of FRENCH_LOCALES) {
        // Per-locale shard build (BUILD_LOCALE): skip locales this shard did
        // not emit — their sitemap pages are absent and would hard-fail as
        // missing-file. No-op in the default all-locale build.
        if (!shouldEmitLocale(locale)) continue;
        const indexPath = np.join(distDir, SITE_MAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          failures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderFrenchBorderHubLinkBlock(locale);
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
        `\x1b[36m[french-border-municipality-links]\x1b[0m Injected France border-hub link into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-comuni-francia.xml orphan tier the audit hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[french-border-municipality-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-comuni-francia.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
