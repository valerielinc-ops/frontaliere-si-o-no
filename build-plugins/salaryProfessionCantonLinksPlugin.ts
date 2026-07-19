/**
 * Salary-intent profession×canton landings — internal-links injector.
 *
 * {@link salaryProfessionCantonPages} emits `/stipendio-{professione}-{cantone}/`
 * (+ /en/salary-, /de/gehalt-, /fr/salaire-) but nothing on a crawlable page
 * links INTO them, so they would ship at BFS depth `unreachable` from `/` —
 * `audit:max-bfs-depth` hard-fails a wholly-buried new content tier.
 *
 * This plugin closes that orphan tier the canonical way (CLAUDE.md regola #5 —
 * real internal `<a href>` links from a hub reachable from `/`, never by
 * relaxing the gate): after the salary emitter AND staticPagesPlugin flush, it
 * injects one "Stipendio per professione e cantone" block into each locale's
 * HTML sitemap page (main-nav reachable, depth ≤ 2 from `/`). Same mechanism,
 * marker discipline and hard-fail contract as professionCantonLandingsLinksPlugin.
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
import { parseSalaryProfessionCantonPath } from './salaryProfessionCantonData';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import { staticPagesFlushed, salaryProfessionCantonsFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';

const MARKER = 'data-salary-profession-cantons-links';

/** HTML sitemap page (relative dir under dist) per locale — main-nav reachable. */
const SITEMAP_PAGE_DIR: Record<ProfessionLocale, string> = {
  it: 'mappa-del-sito',
  en: 'en/site-map',
  de: 'de/seitenplan',
  fr: 'fr/plan-du-site',
};

const BLOCK_COPY: Record<ProfessionLocale, { heading: string; intro: string }> = {
  it: {
    heading: 'Stipendio per professione e cantone',
    intro: 'Mediana lorda, netto stimato e offerte attive per professione in ogni cantone svizzero.',
  },
  en: {
    heading: 'Salary by profession and canton',
    intro: 'Median gross, estimated net and active openings by profession in every Swiss canton.',
  },
  de: {
    heading: 'Lohn nach Beruf und Kanton',
    intro: 'Bruttomedian, geschätztes Netto und aktive Stellen nach Beruf in jedem Schweizer Kanton.',
  },
  fr: {
    heading: 'Salaire par métier et canton',
    intro: 'Médian brut, net estimé et offres actives par métier dans chaque canton suisse.',
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Title-cased role keyword (mirror of salaryProfessionCantonPages fallback). */
function professionLabel(locale: ProfessionLocale, id: AnyProfessionId): string {
  const role = professionRoleKeywordAny(locale, id).replace(/-/g, ' ');
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface LinkItem {
  href: string;
  label: string;
}

/** Build the injected block for one locale; '' when the locale has no links. */
export function renderSalaryProfessionLinksBlock(locale: ProfessionLocale, items: readonly LinkItem[]): string {
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

/** Group emitted canonical paths into per-locale, sorted link items. */
export function buildSalaryProfessionLinkItems(
  emittedPaths: readonly string[],
): Record<ProfessionLocale, LinkItem[]> {
  const byLocale: Record<ProfessionLocale, LinkItem[]> = { it: [], en: [], de: [], fr: [] };
  for (const path of emittedPaths) {
    const parsed = parseSalaryProfessionCantonPath(path);
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

export function salaryProfessionCantonLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'salary-profession-canton-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_SALARY_PROFESSION_CANTONS === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const [emittedPaths] = await Promise.all([
        salaryProfessionCantonsFlushed,
        staticPagesFlushed,
      ]);

      const byLocale = buildSalaryProfessionLinkItems(emittedPaths);

      const failures: string[] = [];
      let injected = 0;
      for (const locale of PROFESSION_LOCALES) {
        if (!shouldEmitLocale(locale)) continue;
        const items = byLocale[locale];
        if (items.length === 0) continue; // nothing emitted for this locale
        const indexPath = np.join(distDir, SITEMAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          failures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderSalaryProfessionLinksBlock(locale, items);
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
        `\x1b[36m[salary-profession-canton-links]\x1b[0m Injected salary-intent links into ${injected} locale sitemap page(s).`,
      );

      if (failures.length > 0) {
        throw new Error(
          `[salary-profession-canton-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-salary-profession-cantons.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
