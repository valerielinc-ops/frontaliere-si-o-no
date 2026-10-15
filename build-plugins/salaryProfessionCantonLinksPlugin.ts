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
import { staticPagesFlushed, salaryProfessionCantonsFlushed, salaryStatsFlushed } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SALARY_STATS_CANTON_SLUGS, buildSalaryStatsPath } from './salaryStatsData';
import { SITE_MAP_PAGE_DIR as SITEMAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-salary-profession-cantons-links';
/** Marker for the per-canton hub→spoke block injected into /stipendi-{canton}/. */
const HUB_SPOKE_MARKER = 'data-salary-profession-spokes';

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

const HUB_SPOKE_COPY: Record<ProfessionLocale, { heading: (canton: string) => string }> = {
  it: { heading: (c) => `Stipendio per professione nel Canton ${c}` },
  en: { heading: (c) => `Salary by profession in Canton ${c}` },
  de: { heading: (c) => `Lohn nach Beruf im Kanton ${c}` },
  fr: { heading: (c) => `Salaire par métier dans le canton ${c}` },
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

/**
 * Group emitted salary spokes into per-(locale, cantonKey) link lists — the
 * data for the hub→spoke block injected into each `/stipendi-{canton}/` page.
 */
export function buildHubSpokeItems(
  emittedPaths: readonly string[],
): Map<string, { locale: ProfessionLocale; cantonKey: string; items: LinkItem[] }> {
  const out = new Map<string, { locale: ProfessionLocale; cantonKey: string; items: LinkItem[] }>();
  for (const path of emittedPaths) {
    const parsed = parseSalaryProfessionCantonPath(path);
    if (!parsed) continue;
    const { locale, cantonKey, id } = parsed;
    const key = `${locale}::${cantonKey}`;
    let entry = out.get(key);
    if (!entry) {
      entry = { locale, cantonKey, items: [] };
      out.set(key, entry);
    }
    entry.items.push({ href: path, label: professionLabel(locale, id) });
  }
  for (const entry of out.values()) {
    entry.items.sort((a, b) => a.label.localeCompare(b.label));
  }
  return out;
}

/** Render the per-canton hub→spoke block; '' when the canton has no spokes. */
export function renderHubSpokeBlock(locale: ProfessionLocale, cantonDisplay: string, items: readonly LinkItem[]): string {
  if (items.length === 0) return '';
  const heading = HUB_SPOKE_COPY[locale].heading(cantonDisplay);
  const lis = items
    .map((it) => `<li class="s-xu5DGK"><a class="s-U9K6Vf" href="${esc(it.href)}">${esc(it.label)}</a></li>`)
    .join('');
  return (
    `<aside ${HUB_SPOKE_MARKER}>` +
    `<h3 class="s-ghlfvV">${esc(heading)}</h3>` +
    `<ul class="s--Vsbr1">${lis}</ul>` +
    `</aside>`
  );
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
        salaryStatsFlushed,
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

      // Hub→spoke: inject each canton's profession-spoke block into its
      // /stipendi-{canton}/ salary-stats hub page (plan §4.2 bullet 3). This is
      // supplementary topical clustering — reachability is already guaranteed by
      // the sitemap-page injection above — so a missing/anchorless hub page is
      // logged, not hard-failed (unlike the sitemap injection).
      let hubInjected = 0;
      const hubMisses: string[] = [];
      for (const { locale, cantonKey, items } of buildHubSpokeItems(emittedPaths).values()) {
        if (!shouldEmitLocale(locale)) continue;
        const hubPath = buildSalaryStatsPath(locale, SALARY_STATS_CANTON_SLUGS[cantonKey][locale]);
        const hubIndex = np.join(distDir, hubPath.replace(/^\/+/, ''), 'index.html');
        if (!fs.existsSync(hubIndex)) {
          hubMisses.push(np.relative(distDir, hubIndex));
          continue;
        }
        const cantonDisplay = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
        const html = fs.readFileSync(hubIndex, 'utf-8');
        const block = renderHubSpokeBlock(locale, cantonDisplay, items);
        const { html: patched, outcome } = injectBlockAfterMain(html, block, HUB_SPOKE_MARKER);
        if (outcome === 'inserted') {
          fs.writeFileSync(hubIndex, patched, 'utf-8');
          hubInjected++;
        } else if (outcome === 'no-anchor') {
          hubMisses.push(np.relative(distDir, hubIndex));
        }
      }

      console.log(
        `\x1b[36m[salary-profession-canton-links]\x1b[0m Injected salary-intent links into ${injected} locale sitemap page(s); hub→spoke into ${hubInjected} canton salary hub(s)${hubMisses.length ? ` (${hubMisses.length} hub pages skipped: not on disk / no anchor)` : ''}.`,
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
