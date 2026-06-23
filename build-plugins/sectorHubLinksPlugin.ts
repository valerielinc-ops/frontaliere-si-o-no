/**
 * Sector-hub cross-linking — internal-links injector.
 *
 * Sibling of {@link professionLandingsLinksPlugin} / {@link salaryHubIndexLinkPlugin}.
 *
 * After {@link jobSectorPagesPlugin} writes the 49 sector-hub landings (×4
 * locales) and {@link staticPagesPlugin} writes the 4 job-board root hubs into
 * `dist/`, this plugin patches each root hub with a per-locale `<aside>` that
 * links the ~15 highest-demand sector hubs.
 *
 * Why this matters (2026-06 GSC/GA4 data pack):
 *   - The 3 winner sector hubs (infermieri / case-anziani / educatori) pull
 *     582 clicks/28d, but only 12 of the 49 sector hubs get ANY GSC
 *     impressions. The other ~37 are live (HTTP 200) but orphaned — the root
 *     hub links the sector INDEX once and 0 of the 49 sector-hub canonicals.
 *   - This single edge per hub surfaces the strongest sectors at depth 2 from
 *     the homepage's most-crawled page, spreading authority to the orphans.
 *
 * Targets (the 4 job-board root hubs):
 *   - `/cerca-lavoro-ticino/`        — IT
 *   - `/en/find-jobs-ticino/`        — EN
 *   - `/de/jobs-im-tessin/`          — DE
 *   - `/fr/trouver-emploi-tessin/`   — FR
 *
 * Idempotent via a NEW marker `data-sector-hub-links`, distinct from
 * `data-ae3-profession-links` so this `<aside>` coexists with the AE-3
 * profession-links block on the same hub pages (the shared injector keys
 * idempotency per marker — CLAUDE.md regola #6).
 *
 * Determinism note: identical to {@link professionLandingsLinksPlugin}.
 * Vite/Rollup runs `closeBundle` hooks in parallel, so we MUST await both
 * producers' explicit signals (`staticPagesFlushed` + `sectorPagesFlushed`)
 * before reading and patching the hub HTML. Polling mtime would race a late
 * background flush that silently overwrites the patch.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import type { JobBoardLocale } from './jobBoardSeo';
import {
  SECTOR_HUB_DISPLAY,
  buildSectorHubPath,
} from './jobSectorLanding';
import { TOP_DEMAND_SECTORS } from './shared/sectorHubClusters';
import {
  staticPagesFlushed,
  sectorPagesFlushed,
} from './shared/buildSignals';
import {
  injectBlockAfterMain,
  type InjectionOutcome,
} from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';

/** Idempotency marker for the sector-hub-links block (distinct from AE-3). */
const SECTOR_LINKS_MARKER = 'data-sector-hub-links';

const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];

interface InjectionTarget {
  readonly indexPath: string;
  readonly locale: JobBoardLocale;
  readonly title: string;
  readonly intro: string;
}

/** Per-locale relative path of each job-board root hub (`dist/<…>/index.html`). */
const HUB_REL: Record<JobBoardLocale, string> = {
  it: 'cerca-lavoro-ticino', // cathedral-allow: TI hub injection target
  en: 'en/find-jobs-ticino', // cathedral-allow: TI hub injection target
  de: 'de/jobs-im-tessin', // cathedral-allow: TI hub injection target
  fr: 'fr/trouver-emploi-tessin', // cathedral-allow: TI hub injection target
};

const HUB_COPY: Record<JobBoardLocale, { title: string; intro: string }> = {
  it: {
    title: 'Offerte di lavoro per settore',
    intro:
      'Vai diretto al settore che cerchi: infermieri, case anziani, educatori, ingegneri e altri ambiti più richiesti in Ticino, con offerte aggiornate ogni giorno.',
  },
  en: {
    title: 'Jobs by sector',
    intro:
      'Jump straight to your field: nurses, elderly care, educators, engineers and the other most-in-demand sectors in Ticino, with listings refreshed daily.',
  },
  de: {
    title: 'Stellen nach Branche',
    intro:
      'Direkt zur gesuchten Branche: Pflegepersonal, Altenpflege, Erzieher, Ingenieure und weitere gefragte Bereiche im Tessin, täglich aktualisiert.',
  },
  fr: {
    title: 'Emplois par secteur',
    intro:
      'Accédez directement à votre domaine : infirmiers, maisons de retraite, éducateurs, ingénieurs et les autres secteurs les plus recherchés au Tessin, mis à jour chaque jour.',
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pure renderer — exported for unit tests. */
export function renderSectorHubLinksBlock(target: InjectionTarget): string {
  const items = TOP_DEMAND_SECTORS.map((sector) => {
    const href = buildSectorHubPath(target.locale, sector);
    const label = SECTOR_HUB_DISPLAY[target.locale][sector];
    return `<li class="s-sec-li"><a class="s-sec-a" href="${esc(href)}">${esc(label)}</a></li>`;
  }).join('');
  return (
    `<aside class="s-sec-links" ${SECTOR_LINKS_MARKER}>` +
    `<p class="s-sec-h">${esc(target.title)}</p>` +
    `<p class="s-sec-p">${esc(target.intro)}</p>` +
    `<ul class="s-sec-ul">${items}</ul>` +
    `</aside>`
  );
}

/**
 * Pure injector — exported for unit tests. Thin wrapper over the shared
 * {@link injectBlockAfterMain}, keyed on {@link SECTOR_LINKS_MARKER} so it
 * coexists with the AE-3 profession-links block on the same hub pages.
 */
export type { InjectionOutcome };

export function injectSectorHubLinks(
  html: string,
  block: string,
): { html: string; outcome: InjectionOutcome } {
  return injectBlockAfterMain(html, block, SECTOR_LINKS_MARKER);
}

interface PatchResult {
  readonly target: InjectionTarget;
  readonly outcome: InjectionOutcome | 'missing-file';
}

function patchFile(target: InjectionTarget): PatchResult {
  if (!fs.existsSync(target.indexPath)) {
    return { target, outcome: 'missing-file' };
  }
  const html = fs.readFileSync(target.indexPath, 'utf-8');
  const block = renderSectorHubLinksBlock(target);
  const { html: patched, outcome } = injectSectorHubLinks(html, block);
  if (outcome === 'inserted') {
    fs.writeFileSync(target.indexPath, patched, 'utf-8');
  }
  // Do not write the flat .html sibling — `flatHtmlRedirectPlugin` runs LAST
  // and converts every `<path>.html` with a sibling `<path>/index.html` into a
  // redirect bridge. Patching the flat copy here would be undone.
  return { target, outcome };
}

/** Build the per-locale root-hub injection targets. */
export function buildTargets(distDir: string): readonly InjectionTarget[] {
  return LOCALES.map((locale) => ({
    indexPath: np.join(distDir, HUB_REL[locale], 'index.html'),
    locale,
    title: HUB_COPY[locale].title,
    intro: HUB_COPY[locale].intro,
  }));
}

export function sectorHubLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'sector-hub-links',
    apply: 'build',
    // `closeBundle` hooks run in parallel across plugins, so `enforce: 'post'`
    // alone is NOT enough to guarantee ordering against the producers — we rely
    // on the explicit signals each producer resolves after flushing.
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for both producers. staticPagesFlushed guarantees the 4 root-hub
      // HTML files are fully written; sectorPagesFlushed guarantees the 49
      // sector-hub landings exist so the injected anchors resolve to real
      // pages (not future-404s).
      await Promise.all([staticPagesFlushed, sectorPagesFlushed]);

      // Per-locale shard build (BUILD_LOCALE): only inject into emitted locales
      // (the write-gate skips the others → their hub pages are absent). No-op in
      // the default all-locale build.
      const targets = buildTargets(distDir).filter((t) => shouldEmitLocale(t.locale));
      const results = targets.map((t) => patchFile(t));

      const inserted = results.filter((r) => r.outcome === 'inserted').length;
      const duplicate = results.filter((r) => r.outcome === 'duplicate').length;
      const missingFile = results.filter((r) => r.outcome === 'missing-file');
      const noAnchor = results.filter((r) => r.outcome === 'no-anchor');

      console.log(
        `\x1b[36m[sector-hub-links]\x1b[0m Injected sector-hub-links block into ${inserted}/${targets.length} job-board hubs` +
          (duplicate > 0 ? ` (${duplicate} already had the marker)` : '') +
          '.',
      );

      // Hard-fail on any non-idempotent miss. A successful build MUST inject the
      // block into every emitted hub — otherwise the ~37 orphaned sector hubs
      // stay unreachable from the most-crawled page and keep their ~0 internal
      // links (no GSC impressions).
      const failures = [...missingFile, ...noAnchor];
      if (failures.length > 0) {
        const lines = failures.map(
          (r) => ` - [${r.outcome}] ${np.relative(distDir, r.target.indexPath)}`,
        );
        throw new Error(
          `[sector-hub-links] injection failed for ${failures.length}/${targets.length} target(s):\n${lines.join('\n')}\n\n` +
            'This leaves the high-demand sector hubs orphaned from the job-board hubs. ' +
            'Diagnose: the hub file did not exist after the producer signals fired (race condition), ' +
            'or the HTML had no <main>/</main>/</body> anchor. See build-plugins/shared/buildSignals.ts.',
        );
      }
    },
  };
}
