/**
 * Austria border-municipality hub — internal-links injector.
 *
 * {@link austrianBorderMunicipalityPagesPlugin} emits
 * `/vivere-in-austria-lavorare-in-svizzera/{slug}/` (+ en/de/fr) plus an
 * `AUSTRIAN_HUB_PATH` index per locale, and the hub itself already links
 * every above-floor Gemeinde below it — but nothing on a crawlable page ever
 * links INTO the hub, so the whole `sitemap-comuni-austria.xml` shard would
 * ship BFS-unreachable from `/` (same orphan-tier hazard `audit:max-bfs-depth`
 * flags — see germanBorderMunicipalityLinksPlugin.ts, the template this
 * mirrors exactly for the fourth FR/DE/AT/LI regime family).
 *
 * Closes the orphan tier the canonical way (CLAUDE.md regola #5 — real
 * internal `<a href>` links from a hub reachable from `/`, never by relaxing
 * the gate): after the Austria emitter AND staticPagesPlugin flush, injects
 * one link to `AUSTRIAN_HUB_PATH[locale]` into each locale's HTML sitemap
 * page.
 *
 * Idempotent via the `data-austrian-border-municipalities-links` marker.
 * Shares the pure insertion logic with the sibling injectors
 * (build-plugins/shared/injectAfterMain), mirroring
 * germanBorderMunicipalityLinksPlugin.ts. The CSS classes below
 * (`s-ghlfvV`/`s--Vsbr1`/`s-xu5DGK`/`s-U9K6Vf`) are the same build-scoped
 * utility classes the German/Liechtenstein blocks use — copied byte-identical
 * on purpose, not reinvented, so the injected block styles consistently.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { AUSTRIAN_LOCALES, AUSTRIAN_HUB_PATH, type AustrianLocale } from './austrianBorderMunicipalityData';
import { austrianBorderMunicipalitiesFlushed, staticPagesFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-austrian-border-municipalities-links';

const BLOCK_COPY: Record<AustrianLocale, { heading: string; intro: string; linkLabel: string }> = {
  it: {
    heading: "Vivere in Austria, lavorare in Svizzera",
    intro: "Nessun regime frontalieri agevolato, tassazione ordinaria comune per comune per chi vive in Austria e lavora in Svizzera.",
    linkLabel: 'Guida ai comuni di confine austriaci',
  },
  en: {
    heading: 'Living in Austria, working in Switzerland',
    intro: 'No favourable cross-border regime, ordinary taxation town by town for Austria-based workers in Switzerland.',
    linkLabel: 'Guide to Austrian border municipalities',
  },
  de: {
    heading: 'In Österreich leben, in der Schweiz arbeiten',
    intro: 'Kein begünstigtes Grenzgänger-Regime, ordentliche Besteuerung Ort für Ort für Grenzgänger aus Österreich.',
    linkLabel: 'Leitfaden zu österreichischen Grenzgemeinden',
  },
  fr: {
    heading: 'Vivre en Autriche, travailler en Suisse',
    intro: "Aucun régime frontalier favorable, fiscalité ordinaire commune par commune pour les travailleurs résidant en Autriche.",
    linkLabel: 'Guide des communes frontalières autrichiennes',
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
export function renderAustrianBorderHubLinkBlock(locale: AustrianLocale): string {
  const copy = BLOCK_COPY[locale];
  return (
    `<aside ${MARKER}>` +
    `<h3 class="s-ghlfvV">${esc(copy.heading)}</h3>` +
    `<p>${esc(copy.intro)}</p>` +
    `<ul class="s--Vsbr1"><li class="s-xu5DGK"><a class="s-U9K6Vf" href="${esc(AUSTRIAN_HUB_PATH[locale])}">${esc(copy.linkLabel)}</a></li></ul>` +
    `</aside>`
  );
}

export function austrianBorderMunicipalityLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'austrian-border-municipality-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_AUSTRIAN_BORDER_MUNICIPALITY_PAGES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the Austria emitter (hub pages written) AND
      // staticPagesPlugin (writes the sitemap pages we patch) so both
      // producers have flushed to disk before we read+patch — mirrors the
      // AE-3 race fix.
      const [hubPaths] = await Promise.all([austrianBorderMunicipalitiesFlushed, staticPagesFlushed]);
      if (!hubPaths || hubPaths.length === 0) {
        console.log('\x1b[33m[austrian-border-municipality-links]\x1b[0m No Austria border hub pages emitted this build — nothing to inject.');
        return;
      }

      const failures: string[] = [];
      let injected = 0;
      for (const locale of AUSTRIAN_LOCALES) {
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
        const block = renderAustrianBorderHubLinkBlock(locale);
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
        `\x1b[36m[austrian-border-municipality-links]\x1b[0m Injected Austria border-hub link into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-comuni-austria.xml orphan tier the audit hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[austrian-border-municipality-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-comuni-austria.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
