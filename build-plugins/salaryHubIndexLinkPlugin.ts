/**
 * Salary-hub scenario-index — internal-links injector.
 *
 * After {@link salaryHubPlugin} writes `/calcola-stipendio/scenari/` (and 3
 * locale twins) and {@link staticPagesPlugin} writes the calculator-hub HTML
 * (`/calcola-stipendio/` + 3 locale twins) into `dist/`, this plugin patches
 * each calculator-hub page with a single anchor block linking to the new
 * scenario index. That single edge wires every salary-hub scenario page back
 * into the homepage BFS reachability graph:
 *
 *   /  →  /calcola-stipendio/  →  /calcola-stipendio/scenari/  →  every scenario
 *
 * Why a separate plugin (not inline in salaryHubPlugin)?
 *   - The calculator hub HTML is owned by `staticPagesPlugin` (it is built
 *     from the SEO entry table in `services/seo/seo-pages.ts`). Modifying
 *     it directly from `salaryHubPlugin` would require a) racing two
 *     producers on the same path, or b) hacking a side-channel into the
 *     SEO entry table. The injector pattern (used by
 *     `professionLandingsLinksPlugin`, `comparisonsHubLinksPlugin`,
 *     `faqHubLinksPlugin`) is the established convention — keep it.
 *
 * Determinism note: same as `professionLandingsLinksPlugin`. Vite/Rollup runs
 * `closeBundle` hooks in parallel, so we MUST await both producers' explicit
 * signals (`staticPagesFlushed` + `salaryHubFlushed`) before reading and
 * patching the hub HTML. If we polled mtime, a late background flush from
 * either producer could silently overwrite the patch.
 *
 * Idempotent via `data-salary-scenarios-link` marker — re-running the build
 * does not duplicate the block.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import {
  CALC_HUB_PATH,
  SCENARIO_INDEX_PATH,
  LOCALES,
  type Locale,
} from './salaryHubIndex';
import {
  staticPagesFlushed,
  salaryHubFlushed,
} from './shared/buildSignals';

interface InjectionTarget {
  readonly indexPath: string;
  readonly flatPath: string;
  readonly locale: Locale;
  readonly title: string;
  readonly intro: string;
  readonly cta: string;
  readonly hubPath: string;
  readonly indexHref: string;
}

const COPY: Record<Locale, { title: string; intro: string; cta: string }> = {
  it: {
    title: 'Tutti gli scenari disponibili',
    intro:
      'Sfoglia l\u2019indice completo degli scenari di stipendio netto per frontalieri: oltre 400 simulazioni dettagliate per ogni combinazione di reddito lordo, stato civile, figli, tipo di frontaliere e zona di distanza dal confine.',
    cta: 'Apri l\u2019indice degli scenari',
  },
  en: {
    title: 'All available scenarios',
    intro:
      'Browse the full directory of net-salary scenarios for cross-border workers: 400+ detailed simulations covering every combination of gross income, marital status, children, agreement type and distance zone.',
    cta: 'Open the scenario index',
  },
  de: {
    title: 'Alle verf\u00fcgbaren Szenarien',
    intro:
      'Durchsuchen Sie das vollst\u00e4ndige Verzeichnis der Nettogehaltsszenarien f\u00fcr Grenzg\u00e4nger: \u00fcber 400 detaillierte Simulationen f\u00fcr jede Kombination aus Bruttoeinkommen, Zivilstand, Kindern, Abkommenstyp und Distanzzone.',
    cta: 'Szenario-Index \u00f6ffnen',
  },
  fr: {
    title: 'Tous les sc\u00e9narios disponibles',
    intro:
      'Parcourez l\u2019index complet des sc\u00e9narios de salaire net pour frontaliers : plus de 400 simulations d\u00e9taill\u00e9es couvrant toutes les combinaisons de revenu brut, \u00e9tat civil, enfants, type d\u2019accord et zone de distance.',
    cta: 'Ouvrir l\u2019index des sc\u00e9narios',
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pure renderer — exported for tests so they don't have to call the plugin. */
export function renderSalaryIndexLinkBlock(target: InjectionTarget): string {
  return (
    `<aside data-salary-scenarios-link style="margin:1.5rem 0;padding:18px 20px;border:1px solid #e2e8f0;border-radius:14px;background:linear-gradient(135deg,#eef2ff 0%,#f5f3ff 100%);max-width:880px">` +
    `<p style="margin:0 0 8px;font-size:1rem;font-weight:700;color:#1e293b">${esc(target.title)}</p>` +
    `<p style="margin:0 0 12px;color:#475569;font-size:.95rem;line-height:1.55">${esc(target.intro)}</p>` +
    `<p style="margin:0"><a href="${esc(target.indexHref)}" style="display:inline-block;background:#533afd;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.95rem">${esc(target.cta)} \u2192</a></p>` +
    `</aside>`
  );
}

/**
 * Pure injector — exported for unit tests.
 *
 * Inserts `block` immediately after the opening `<main …>` tag so the link
 * is visible early in the document order (good for both BFS and AdSense).
 * Falls back to before `</main>` then before `</body>` for synthetic /
 * mis-shapen HTML. Idempotent via the `data-salary-scenarios-link` marker.
 */
export type InjectionOutcome = 'inserted' | 'duplicate' | 'no-anchor';

export function injectSalaryIndexLink(
  html: string,
  block: string,
): { html: string; outcome: InjectionOutcome } {
  if (html.includes('data-salary-scenarios-link')) {
    return { html, outcome: 'duplicate' };
  }
  const mainOpen = html.match(/<main\b[^>]*>/);
  if (mainOpen && mainOpen.index !== undefined) {
    const insertAt = mainOpen.index + mainOpen[0].length;
    return {
      html: html.slice(0, insertAt) + block + html.slice(insertAt),
      outcome: 'inserted',
    };
  }
  if (html.includes('</main>')) {
    return {
      html: html.replace('</main>', `${block}</main>`),
      outcome: 'inserted',
    };
  }
  if (html.includes('</body>')) {
    return {
      html: html.replace('</body>', `${block}</body>`),
      outcome: 'inserted',
    };
  }
  return { html, outcome: 'no-anchor' };
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
  const block = renderSalaryIndexLinkBlock(target);
  const { html: patched, outcome } = injectSalaryIndexLink(html, block);
  if (outcome === 'inserted') {
    fs.writeFileSync(target.indexPath, patched, 'utf-8');
  }
  // Do not write the flat .html sibling — `flatHtmlRedirectPlugin` runs LAST
  // and converts every `<path>.html` with a sibling `<path>/index.html` into
  // a redirect bridge. Patching the flat copy here would be undone.
  return { target, outcome };
}

/** Build the per-locale calculator-hub injection targets. */
export function buildTargets(distDir: string): readonly InjectionTarget[] {
  const out: InjectionTarget[] = [];
  for (const loc of LOCALES) {
    const hubPath = CALC_HUB_PATH[loc];
    const indexPath = SCENARIO_INDEX_PATH[loc];
    // hubPath ends with '/', strip it for filesystem join: `/calcola-stipendio/`
    // → `dist/calcola-stipendio/index.html` and `dist/calcola-stipendio.html`.
    const hubRel = hubPath.replace(/^\/+/, '').replace(/\/+$/, '');
    out.push({
      indexPath: np.join(distDir, hubRel, 'index.html'),
      flatPath: np.join(distDir, `${hubRel}.html`),
      locale: loc,
      hubPath,
      indexHref: indexPath,
      title: COPY[loc].title,
      intro: COPY[loc].intro,
      cta: COPY[loc].cta,
    });
  }
  return out;
}

export function salaryHubIndexLinkPlugin(rootDir: string): Plugin {
  return {
    name: 'salary-hub-index-link',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for both producers. staticPagesFlushed guarantees the calc-hub
      // HTML is fully written; salaryHubFlushed guarantees the scenario
      // index pages are written so anchored links resolve to a real file.
      await Promise.all([staticPagesFlushed, salaryHubFlushed]);

      const targets = buildTargets(distDir);
      const results = targets.map((t) => patchFile(t));

      const inserted = results.filter((r) => r.outcome === 'inserted').length;
      const duplicate = results.filter((r) => r.outcome === 'duplicate').length;
      const missingFile = results.filter((r) => r.outcome === 'missing-file');
      const noAnchor = results.filter((r) => r.outcome === 'no-anchor');

      console.log(
        `\x1b[36m[salary-hub-index-link]\x1b[0m Injected scenario-index link into ${inserted}/${targets.length} calculator-hub pages` +
          (duplicate > 0 ? ` (${duplicate} already had the marker)` : '') +
          '.',
      );

      // Hard-fail on any non-idempotent miss. A successful build MUST inject
      // the anchor into every locale calculator hub — otherwise the salary-
      // hub link graph collapses and `sitemap-salary-hub.xml` regresses to
      // 1 732 orphans (Semrush gate).
      const failures = [...missingFile, ...noAnchor];
      if (failures.length > 0) {
        const lines = failures.map(
          (r) =>
            ` - [${r.outcome}] ${np.relative(distDir, r.target.indexPath)}`,
        );
        throw new Error(
          `[salary-hub-index-link] scenario-index injection failed for ${failures.length}/${targets.length} target(s):\n${lines.join('\n')}\n\n` +
            'This breaks BFS reachability for the 1 732 salary-hub scenario pages and creates sitemap-salary-hub.xml orphans. ' +
            'Diagnose: the calculator-hub file did not exist after the producer signals fired (race condition), ' +
            'or the HTML had no <main>/</main>/</body> anchor.',
        );
      }
    },
  };
}
