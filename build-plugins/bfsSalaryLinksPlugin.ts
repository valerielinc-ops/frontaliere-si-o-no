/**
 * BFS salary-by-age/education landings — internal-links injector.
 *
 * {@link bfsSalaryLandingsPlugin} emits `/stipendio-svizzera-{age}-anni/` and
 * `/stipendio-svizzera-{education}/` pages (+ locale twins) that only
 * cross-link their own 3-nearest siblings — a disconnected island with no
 * external inbound link — so 20 URLs (55.56%) ship beyond
 * `audit:max-bfs-depth`'s MAX_DEPTH=4.
 *
 * The whole family is tiny (5 age anchors + 4 education levels = 9
 * identities per locale), so rather than seed one page and rely on the
 * sibling ring to propagate (it doesn't reliably reach every node — see
 * bfsSalaryLandingsPlugin.ts's `others = ....slice(0, 3)` cross-links,
 * which always favour the same few array-order-adjacent entries), this
 * plugin links every emitted identity directly from the per-locale HTML
 * sitemap page:
 *
 *   it → /mappa-del-sito/      (in the main nav → depth 1 from `/`)
 *   en → /en/site-map/         (in the /en/ nav  → depth 2 from `/`)
 *   de → /de/seitenplan/       (in the /de/ nav  → depth 2 from `/`)
 *   fr → /fr/plan-du-site/     (in the /fr/ nav  → depth 2 from `/`)
 *
 * Idempotent via the `data-bfs-salary-links` marker — see
 * `build-plugins/shared/injectAfterMain.ts` for why independent injectors
 * can safely stack on one file.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import {
  SALARY_LOCALES,
  SALARY_AGE_ANCHORS,
  SALARY_EDUCATION_IDS,
  buildSalaryAgeLandingPath,
  buildSalaryEducationLandingPath,
  type SalaryLocale,
} from './bfsSalaryLandingsData';
import { bfsSalaryFlushed, staticPagesFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR as SITEMAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-bfs-salary-links';

const BLOCK_COPY: Record<SalaryLocale, { heading: string; intro: string }> = {
  it: { heading: 'Stipendio per età e formazione', intro: 'Stipendio medio in Svizzera per fascia d’età e livello di formazione.' },
  en: { heading: 'Salary by age and education', intro: 'Average salary in Switzerland by age bracket and education level.' },
  de: { heading: 'Lohn nach Alter und Ausbildung', intro: 'Durchschnittslohn in der Schweiz nach Altersgruppe und Ausbildungsniveau.' },
  fr: { heading: 'Salaire par âge et formation', intro: 'Salaire moyen en Suisse par tranche d’âge et niveau de formation.' },
};

const AGE_LABEL: Record<SalaryLocale, (age: number) => string> = {
  it: (a) => `${a} anni`,
  en: (a) => `age ${a}`,
  de: (a) => `${a} Jahre`,
  fr: (a) => `${a} ans`,
};

const EDU_LABEL: Record<SalaryLocale, Record<(typeof SALARY_EDUCATION_IDS)[number], string>> = {
  it: { 'scuola-obbligatoria': 'scuola obbligatoria', 'apprendistato-afc': 'apprendistato AFC', 'formazione-superiore': 'formazione superiore', universita: 'università' },
  en: { 'scuola-obbligatoria': 'compulsory school', 'apprendistato-afc': 'apprenticeship (AFC)', 'formazione-superiore': 'higher education', universita: 'university' },
  de: { 'scuola-obbligatoria': 'obligatorische Schule', 'apprendistato-afc': 'Berufslehre (EFZ)', 'formazione-superiore': 'höhere Bildung', universita: 'Universität' },
  fr: { 'scuola-obbligatoria': 'scolarité obligatoire', 'apprendistato-afc': 'apprentissage (CFC)', 'formazione-superiore': 'formation supérieure', universita: 'université' },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface LinkItem {
  href: string;
  label: string;
}

/** Build the injected block for one locale; '' when the locale has no links. */
export function renderBfsSalaryLinksBlock(locale: SalaryLocale, items: readonly LinkItem[]): string {
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
 * Build per-locale link items for every emitted age/education identity.
 * Exported for unit testing without touching disk.
 */
export function buildBfsSalaryLinkItems(
  emittedPaths: readonly string[],
): Record<SalaryLocale, LinkItem[]> {
  const emitted = new Set(emittedPaths);
  const byLocale: Record<SalaryLocale, LinkItem[]> = { it: [], en: [], de: [], fr: [] };
  for (const locale of SALARY_LOCALES) {
    for (const age of SALARY_AGE_ANCHORS) {
      const href = buildSalaryAgeLandingPath(locale, age);
      if (emitted.has(href)) byLocale[locale].push({ href, label: AGE_LABEL[locale](age) });
    }
    for (const eduId of SALARY_EDUCATION_IDS) {
      const href = buildSalaryEducationLandingPath(locale, eduId);
      if (emitted.has(href)) byLocale[locale].push({ href, label: EDU_LABEL[locale][eduId] });
    }
  }
  return byLocale;
}

export function bfsSalaryLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'bfs-salary-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_BFS_SALARY === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const [emittedPaths] = await Promise.all([
        bfsSalaryFlushed,
        staticPagesFlushed,
      ]);

      if (emittedPaths.length === 0) {
        console.log('\x1b[36m[bfs-salary-links]\x1b[0m No emitted pages — nothing to link.');
        return;
      }

      const byLocale = buildBfsSalaryLinkItems(emittedPaths);

      const failures: string[] = [];
      let injected = 0;
      for (const locale of SALARY_LOCALES) {
        if (!shouldEmitLocale(locale)) continue;
        const items = byLocale[locale];
        if (items.length === 0) continue;
        const indexPath = np.join(distDir, SITEMAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          failures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderBfsSalaryLinksBlock(locale, items);
        const { html: patched, outcome } = injectBlockAfterMain(html, block, MARKER);
        if (outcome === 'inserted') {
          fs.writeFileSync(indexPath, patched, 'utf-8');
          injected++;
        } else if (outcome === 'no-anchor') {
          failures.push(` - [no-anchor] ${np.relative(distDir, indexPath)}`);
        }
      }

      console.log(
        `\x1b[36m[bfs-salary-links]\x1b[0m Injected salary-by-age/education links into ${injected} locale sitemap page(s).`,
      );

      if (failures.length > 0) {
        throw new Error(
          `[bfs-salary-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-bfs-salary.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
