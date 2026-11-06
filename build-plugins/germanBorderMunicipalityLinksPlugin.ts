/**
 * Germany border-municipality hub — internal-links injector.
 *
 * {@link germanBorderMunicipalityPagesPlugin} emits
 * `/vivere-in-germania-lavorare-in-svizzera/{slug}/` (+ en/de/fr) plus a
 * `GERMAN_HUB_PATH` index per locale, and the hub itself already links every
 * above-floor Gemeinde below it — but nothing on a crawlable page ever links
 * INTO the hub, so the whole `sitemap-comuni-germania.xml` shard would ship
 * BFS-unreachable from `/` (same orphan-tier hazard `audit:max-bfs-depth`
 * flags — see frenchBorderMunicipalityLinksPlugin.ts, the template this
 * mirrors exactly for the second FR/DE/LI regime family).
 *
 * Closes the orphan tier the canonical way (CLAUDE.md regola #5 — real
 * internal `<a href>` links from a hub reachable from `/`, never by relaxing
 * the gate): after the Germany emitter AND staticPagesPlugin flush, injects
 * one link to `GERMAN_HUB_PATH[locale]` into each locale's HTML sitemap page.
 *
 * Idempotent via the `data-german-border-municipalities-links` marker. Shares
 * the pure insertion logic with the AE-3 injector
 * (build-plugins/shared/injectAfterMain), mirroring
 * frenchBorderMunicipalityLinksPlugin.ts.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { GERMAN_LOCALES, GERMAN_HUB_PATH, type GermanLocale } from './germanBorderMunicipalityData';
import { germanBorderMunicipalitiesFlushed, staticPagesFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-german-border-municipalities-links';

const BLOCK_COPY: Record<GermanLocale, { heading: string; intro: string; linkLabel: string }> = {
  it: {
    heading: 'Vivere in Germania, lavorare in Svizzera',
    intro: 'Imposta alla fonte, giorni di non rientro e assicurazione malattia comune per comune per i frontalieri tedeschi.',
    linkLabel: 'Guida ai comuni di confine tedeschi',
  },
  en: {
    heading: 'Living in Germany, working in Switzerland',
    intro: 'Withholding tax, non-return days and health insurance town by town for German cross-border workers.',
    linkLabel: 'Guide to German border municipalities',
  },
  de: {
    heading: 'In Deutschland leben, in der Schweiz arbeiten',
    intro: 'Quellensteuer, Nichtrückkehrtage und Krankenversicherung Ort für Ort für deutsche Grenzgänger.',
    linkLabel: 'Leitfaden zu deutschen Grenzgemeinden',
  },
  fr: {
    heading: 'Vivre en Allemagne, travailler en Suisse',
    intro: "Impôt à la source, jours de non-retour et assurance maladie commune par commune pour les frontaliers allemands.",
    linkLabel: 'Guide des communes frontalières allemandes',
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
export function renderGermanBorderHubLinkBlock(locale: GermanLocale): string {
  const copy = BLOCK_COPY[locale];
  return (
    `<aside ${MARKER}>` +
    `<h3 class="s-ghlfvV">${esc(copy.heading)}</h3>` +
    `<p>${esc(copy.intro)}</p>` +
    `<ul class="s--Vsbr1"><li class="s-xu5DGK"><a class="s-U9K6Vf" href="${esc(GERMAN_HUB_PATH[locale])}">${esc(copy.linkLabel)}</a></li></ul>` +
    `</aside>`
  );
}

export function germanBorderMunicipalityLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'german-border-municipality-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_GERMAN_BORDER_MUNICIPALITY_PAGES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the Germany emitter (hub pages written) AND staticPagesPlugin
      // (writes the sitemap pages we patch) so both producers have flushed
      // to disk before we read+patch — mirrors the AE-3 race fix.
      const [hubPaths] = await Promise.all([germanBorderMunicipalitiesFlushed, staticPagesFlushed]);
      if (!hubPaths || hubPaths.length === 0) {
        console.log('\x1b[33m[german-border-municipality-links]\x1b[0m No Germany border hub pages emitted this build — nothing to inject.');
        return;
      }

      const failures: string[] = [];
      let injected = 0;
      for (const locale of GERMAN_LOCALES) {
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
        const block = renderGermanBorderHubLinkBlock(locale);
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
        `\x1b[36m[german-border-municipality-links]\x1b[0m Injected Germany border-hub link into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-comuni-germania.xml orphan tier the audit hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[german-border-municipality-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-comuni-germania.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
