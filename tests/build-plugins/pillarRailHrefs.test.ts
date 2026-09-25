/**
 * Regression guard for issue #5428 — the shallow SEO rails may not link a URL
 * the build does not emit, nor one it emits `noindex`.
 *
 * Why this file exists on top of `localeRootMainNav.test.ts`
 * ---------------------------------------------------------
 * #5509 fixed ONE pill of `ORPHAN_PILLAR_LINKS` — the DE FAQ hub, which
 * pointed at `/de/haeufig-gestellte-fragen/` (a 404) and was the reason the
 * 103 `/de/haeufige-fragen/<entry>/` pages sat at BFS depth 5 while IT/EN/FR
 * stayed inside the budget. It pinned that one href to `buildFaqHubPath()`.
 *
 * Eleven more pills of the same table were hand-written literals, and on
 * 2026-08-10 a probe of all 46 rail hrefs against production found twelve of
 * them broken — split IT 0/13, EN 5/12, DE 5/12, FR 2/12, which is the exact
 * shape of #5428's damage (DE worst hit, IT untouched):
 *
 *   4 × HTTP 404
 *   8 × HTTP 200 but `<meta name="robots" content="noindex,follow">`
 *
 * The second half is not a lesser problem. `scripts/audit-bfs-depth.mjs` does
 * `continue` on ANY `noindex` page while walking the graph, so a pill pointing
 * at a `searchConsoleCompat` catch-all is a wall wearing the costume of a
 * link: the rail's whole purpose — "expose the highest-value pillar/guide URLs
 * at BFS depth 1", per the block's own docstring — silently does not happen.
 *
 * All twelve had a live, `index,follow` replacement derivable from
 * `services/routeSlugs.data.ts`, the module centralised in #4315 precisely so
 * hand-copied literal tables would stop drifting. So the guard has two halves:
 *
 *   1. every rail href's SECTION segment must be a slug the site actually
 *      names for that locale (this is what `cross-border-worker-guide` and
 *      `grenzgaenger-leitfaden` failed);
 *   2. no build plugin may hard-code one of the twelve dead paths again.
 *
 * Part 2 is a source scan rather than a unit assertion on purpose: the same
 * two literals lived in FOUR plugins, and three of them are not reachable from
 * the rail at all (`holidaysLandingsPlugin`, `minimumWageLandingsPlugin`,
 * `companyHubFrontalierContext` shipped the EN 404 on every landing and every
 * company hub they emit). A test that only imported the rail would have left
 * those three red and called it green.
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { ORPHAN_PILLAR_LINKS } from '../../build-plugins/staticPagesPlugin';
import {
  COMPLETE_WORK_GUIDE_HREF,
  GUIDE_HUB_HREF,
  LAMAL_PILLAR_HREF,
  NEW_FRONTIER_TAX_SIM_HREF,
  PILLAR_GUIDE_LOCALES,
  PILLAR_LOCALE_PREFIX,
  TAXATION_HUB_HREF,
  WITHHOLDING_RATES_HREF,
} from '../../build-plugins/shared/pillarGuideHrefs';
import { SLUG_TABLES } from '../../services/routeSlugs.data';
import { FAQ_HUB_SLUG } from '../../data/faq-hub/routes';

const REPO_ROOT = np.resolve(np.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_PLUGINS_DIR = np.join(REPO_ROOT, 'build-plugins');

/**
 * Rail targets that are standalone landings with no `SLUG_TABLES` key — each
 * one emitted by its own plugin, each verified 200 + `index,follow` against
 * production on 2026-08-10. Listing them explicitly is the point: a new pill
 * whose section is a typo is NOT quietly waved through, it has to be added
 * here by someone who checked it resolves.
 */
const STANDALONE_LANDING_SECTIONS: Record<string, readonly string[]> = {
  it: ['giorni-festivi-ticino', 'stipendio-medio-svizzera-30-anni', 'salario-minimo'],
  en: ['public-holidays-ticino', 'average-salary-switzerland-age-30', 'minimum-wage'],
  de: ['feiertage-tessin', 'durchschnittslohn-schweiz-30-jahre', 'mindestlohn'],
  fr: ['jours-feries-tessin', 'salaire-moyen-suisse-30-ans', 'salaire-minimum'],
};

/**
 * The twelve paths the rail and its three sibling plugins used to ship, with
 * the status measured on 2026-08-10. None may come back as a string literal
 * anywhere under `build-plugins/`.
 */
const DEAD_PATHS: ReadonlyArray<{ path: string; why: string }> = [
  // ── HTTP 404 ──────────────────────────────────────────────────────────
  { path: '/en/cross-border-worker-guide/', why: '404 — the guide section is /en/cross-border-guide/' },
  { path: '/en/cross-border-worker-guide/complete-cross-border-work-guide-switzerland-2026/', why: '404' },
  { path: '/en/cross-border-worker-guide/lamal-cross-border-workers/', why: '404' },
  { path: '/en/guide-cross-border-taxation-2026/', why: '404 — the hub is /en/cross-border-taxation-guide-2026/' },
  { path: '/de/leitfaden-grenzgaenger-besteuerung-2026/', why: '404 — the hub is /de/grenzgaenger-besteuerung-leitfaden-2026/' },
  { path: '/de/haeufig-gestellte-fragen/', why: '404 — the #5509 regression; kept pinned here too' },
  // ── HTTP 200 but noindex,follow → a wall for audit-bfs-depth.mjs ──────
  { path: '/de/grenzgaenger-leitfaden/vollstaendiger-grenzgaenger-leitfaden-schweiz-2026/', why: '200 noindex,follow' },
  { path: '/de/grenzgaenger-leitfaden/kvg-grenzgaenger/', why: '200 noindex,follow' },
  { path: '/en/taxes-and-pension/withholding-tax-rates-ticino-2026/', why: '200 noindex,follow' },
  { path: '/en/taxes-and-pension/new-cross-border-tax-simulation/', why: '200 noindex,follow' },
  { path: '/de/steuern-und-rente/quellensteuersaetze-tessin-2026/', why: '200 noindex,follow' },
  { path: '/de/steuern-und-rente/neue-grenzgaenger-steuersimulation/', why: '200 noindex,follow' },
  { path: '/fr/impots-et-retraite/taux-impot-source-tessin-2026/', why: '200 noindex,follow' },
  { path: '/fr/impots-et-retraite/simulation-impot-nouveaux-frontaliers/', why: '200 noindex,follow' },
];

/**
 * The two modules whose JOB is to name legacy paths — a redirect table and the
 * Search-Console compat map cannot be written without mentioning the URL they
 * retire. Excluding them keeps the scan a link check instead of a word ban.
 */
const LEGACY_PATH_OWNERS = new Set(['legacyRedirectsPlugin.ts', 'searchConsoleCompat.ts']);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = np.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts') && !LEGACY_PATH_OWNERS.has(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Drop `/* … *\/` blocks and whole-line `//` / ` * ` comments.
 *
 * Deliberately NOT a general comment stripper: a naive `//`-to-end-of-line
 * rule eats the tail of every `'https://…'` literal in the file and would turn
 * this guard into a false negative machine. Whole-line comments are the form
 * the post-mortems in these files actually use.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/** Section = first path segment after the locale prefix. */
function sectionOf(href: string, locale: string): string {
  const prefix = PILLAR_LOCALE_PREFIX[locale as keyof typeof PILLAR_LOCALE_PREFIX];
  const rest = prefix && href.startsWith(`${prefix}/`) ? href.slice(prefix.length) : href;
  return rest.split('/').filter(Boolean)[0] ?? '';
}

describe('pillar rail hrefs — every pill resolves to a page the build emits (#5428)', () => {
  it.each([...PILLAR_GUIDE_LOCALES])(
    'the %s rail only links sections the site actually names',
    (locale) => {
      const known = new Set<string>([
        ...Object.values(SLUG_TABLES[locale]),
        FAQ_HUB_SLUG[locale],
        ...STANDALONE_LANDING_SECTIONS[locale],
      ]);
      const unknown = ORPHAN_PILLAR_LINKS[locale]
        .map((link) => ({ href: link.href, section: sectionOf(link.href, locale) }))
        .filter((entry) => !known.has(entry.section));
      expect(unknown).toEqual([]);
    },
  );

  it.each([...PILLAR_GUIDE_LOCALES])(
    'every %s pill is absolute, trailing-slashed and inside its own locale subtree',
    (locale) => {
      const prefix = PILLAR_LOCALE_PREFIX[locale];
      for (const { href } of ORPHAN_PILLAR_LINKS[locale]) {
        expect(href.startsWith('/')).toBe(true);
        expect(href.endsWith('/')).toBe(true);
        if (prefix) expect(href.startsWith(`${prefix}/`)).toBe(true);
        else expect(/^\/(en|de|fr)\//.test(href)).toBe(false);
      }
    },
  );

  it('carries no duplicate pill inside a locale', () => {
    for (const locale of PILLAR_GUIDE_LOCALES) {
      const hrefs = ORPHAN_PILLAR_LINKS[locale].map((l) => l.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });
});

describe('pillar/guide hrefs are derived, not copied (#4315, #5428)', () => {
  it('resolves the guide section from SLUG_TABLES[locale].guida', () => {
    expect(GUIDE_HUB_HREF).toEqual({
      it: '/guida-frontaliere/',
      en: '/en/cross-border-guide/',
      de: '/de/grenzgaenger-ratgeber/',
      fr: '/fr/guide-frontalier/',
    });
  });

  it('resolves the four pillar families to the URLs production serves 200 + index,follow', () => {
    expect(COMPLETE_WORK_GUIDE_HREF.en).toBe(
      '/en/cross-border-guide/complete-guide-cross-border-work-switzerland-2026/',
    );
    expect(COMPLETE_WORK_GUIDE_HREF.de).toBe(
      '/de/grenzgaenger-ratgeber/komplettanleitung-grenzgaenger-arbeit-schweiz-2026/',
    );
    expect(TAXATION_HUB_HREF.en).toBe('/en/cross-border-taxation-guide-2026/');
    expect(TAXATION_HUB_HREF.de).toBe('/de/grenzgaenger-besteuerung-leitfaden-2026/');
    expect(LAMAL_PILLAR_HREF.en).toBe('/en/cross-border-guide/lamal-for-cross-border-workers/');
    expect(LAMAL_PILLAR_HREF.de).toBe('/de/grenzgaenger-ratgeber/krankenversicherung-grenzgaenger/');
    expect(WITHHOLDING_RATES_HREF.de).toBe('/de/steuern-und-vorsorge/quellensteuer-tessin-2026/');
    expect(NEW_FRONTIER_TAX_SIM_HREF.de).toBe(
      '/de/steuern-und-vorsorge/steuerberechnung-neue-grenzgaenger/',
    );
  });

  it('keeps the IT pillar hrefs byte-identical to the literals they replaced', () => {
    // IT was the one locale with zero broken pills, so it doubles as the
    // control: the derivation must be a no-op here or it is not a fix.
    expect(TAXATION_HUB_HREF.it).toBe('/guida-tassazione-frontalieri-2026/');
    expect(COMPLETE_WORK_GUIDE_HREF.it).toBe(
      '/guida-frontaliere/guida-completa-lavoro-frontaliere-svizzera-2026/',
    );
    expect(LAMAL_PILLAR_HREF.it).toBe('/guida-frontaliere/lamal-frontalieri/');
    expect(WITHHOLDING_RATES_HREF.it).toBe(
      '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/',
    );
    expect(NEW_FRONTIER_TAX_SIM_HREF.it).toBe(
      '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/',
    );
  });
});

describe('no build plugin hard-codes a dead pillar path (#5428)', () => {
  const files = listTsFiles(BUILD_PLUGINS_DIR);

  it('finds build-plugins/ sources to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(DEAD_PATHS)('never as a string literal: $path ($why)', ({ path }) => {
    // Quoted-literal form only, and comments stripped first — the post-mortem
    // notes in these very files quote the dead paths in backticks on purpose,
    // and banning the words would forbid documenting the bug.
    const needles = [`'${path}'`, `"${path}"`, `\`${path}\``];
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf-8'));
      if (needles.some((needle) => src.includes(needle))) {
        offenders.push(np.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
