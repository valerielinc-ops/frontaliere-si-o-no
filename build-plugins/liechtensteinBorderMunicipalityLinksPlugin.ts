/**
 * Liechtenstein border-municipality hub — internal-links injector.
 *
 * {@link liechtensteinBorderMunicipalityPagesPlugin} emits
 * `/vivere-in-liechtenstein-lavorare-in-svizzera/{slug}/` (+ en/de/fr) plus
 * a `LIECHTENSTEIN_HUB_PATH` index per locale, and the hub itself already
 * links every above-floor Gemeinde below it — but nothing on a crawlable
 * page ever links INTO the hub, so the whole
 * `sitemap-comuni-liechtenstein.xml` shard would ship BFS-unreachable from
 * `/` (same orphan-tier hazard `audit:max-bfs-depth` flags — see
 * frenchBorderMunicipalityLinksPlugin.ts / germanBorderMunicipalityLinksPlugin.ts,
 * the templates this mirrors exactly for the third FR/DE/LI regime family).
 *
 * Closes the orphan tier the canonical way (CLAUDE.md regola #5 — real
 * internal `<a href>` links from a hub reachable from `/`, never by relaxing
 * the gate): after the Liechtenstein emitter AND staticPagesPlugin flush,
 * injects one link to `LIECHTENSTEIN_HUB_PATH[locale]` into each locale's
 * HTML sitemap page.
 *
 * Idempotent via the `data-liechtenstein-border-municipalities-links`
 * marker. Shares the pure insertion logic with the AE-3 injector
 * (build-plugins/shared/injectAfterMain), mirroring
 * frenchBorderMunicipalityLinksPlugin.ts / germanBorderMunicipalityLinksPlugin.ts.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { LIECHTENSTEIN_LOCALES, LIECHTENSTEIN_HUB_PATH, type LiechtensteinLocale } from './liechtensteinBorderMunicipalityData';
import { liechtensteinBorderMunicipalitiesFlushed, staticPagesFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-liechtenstein-border-municipalities-links';

const BLOCK_COPY: Record<LiechtensteinLocale, { heading: string; intro: string; linkLabel: string }> = {
  it: {
    heading: 'Vivere in Liechtenstein, lavorare in Svizzera',
    intro: 'Tassazione nello Stato di residenza, soglia dei 45 giorni e flusso del corridoio comune per comune per i frontalieri del Liechtenstein.',
    linkLabel: 'Guida ai comuni del Liechtenstein',
  },
  en: {
    heading: 'Living in Liechtenstein, working in Switzerland',
    intro: "Residence-state taxation, the 45-day threshold and the corridor's flow, municipality by municipality.",
    linkLabel: 'Guide to Liechtenstein municipalities',
  },
  de: {
    heading: 'In Liechtenstein leben, in der Schweiz arbeiten',
    intro: 'Besteuerung im Wohnsitzstaat, die 45-Tage-Schwelle und die Pendlerrichtung, Gemeinde für Gemeinde.',
    linkLabel: 'Leitfaden zu den Gemeinden Liechtensteins',
  },
  fr: {
    heading: 'Vivre au Liechtenstein, travailler en Suisse',
    intro: "Imposition dans l'État de résidence, seuil de 45 jours et flux du corridor, commune par commune.",
    linkLabel: 'Guide des communes du Liechtenstein',
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
export function renderLiechtensteinBorderHubLinkBlock(locale: LiechtensteinLocale): string {
  const copy = BLOCK_COPY[locale];
  return (
    `<aside ${MARKER}>` +
    `<h3 class="s-ghlfvV">${esc(copy.heading)}</h3>` +
    `<p>${esc(copy.intro)}</p>` +
    `<ul class="s--Vsbr1"><li class="s-xu5DGK"><a class="s-U9K6Vf" href="${esc(LIECHTENSTEIN_HUB_PATH[locale])}">${esc(copy.linkLabel)}</a></li></ul>` +
    `</aside>`
  );
}

export function liechtensteinBorderMunicipalityLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'liechtenstein-border-municipality-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_LIECHTENSTEIN_BORDER_MUNICIPALITY_PAGES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the Liechtenstein emitter (hub pages written) AND
      // staticPagesPlugin (writes the sitemap pages we patch) so both
      // producers have flushed to disk before we read+patch — mirrors the
      // AE-3 race fix.
      const [hubPaths] = await Promise.all([liechtensteinBorderMunicipalitiesFlushed, staticPagesFlushed]);
      if (!hubPaths || hubPaths.length === 0) {
        console.log('\x1b[33m[liechtenstein-border-municipality-links]\x1b[0m No Liechtenstein border hub pages emitted this build — nothing to inject.');
        return;
      }

      const failures: string[] = [];
      let injected = 0;
      for (const locale of LIECHTENSTEIN_LOCALES) {
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
        const block = renderLiechtensteinBorderHubLinkBlock(locale);
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
        `\x1b[36m[liechtenstein-border-municipality-links]\x1b[0m Injected Liechtenstein border-hub link into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-comuni-liechtenstein.xml orphan tier the audit hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[liechtenstein-border-municipality-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-comuni-liechtenstein.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
