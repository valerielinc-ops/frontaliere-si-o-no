/**
 * Employer-profile pages — internal-links injector.
 *
 * {@link employerProfilePagesPlugin} emits `/aziende/{slug}/` (+ locale
 * twins) but nothing on a crawlable page links INTO them, so all 468 ship at
 * BFS depth `unreachable` from `/` — `audit:max-bfs-depth` hard-fails the
 * family as an entirely-buried new content tier (reached 0/468, epic #4462).
 *
 * This plugin closes that orphan tier the same way
 * {@link professionCantonLandingsLinksPlugin} closed the profession-canton
 * tier (CLAUDE.md regola #5 — real internal `<a href>` links from a hub
 * reachable from `/`, never by relaxing the gate): after the profile emitter
 * AND staticPagesPlugin flush, it injects one "Aziende in Svizzera" block
 * into each locale's HTML sitemap page:
 *
 *   it → /mappa-del-sito/      (in the main nav → depth 1 from `/`)
 *   en → /en/site-map/         (in the /en/ nav  → depth 2 from `/`)
 *   de → /de/seitenplan/       (in the /de/ nav  → depth 2 from `/`)
 *   fr → /fr/plan-du-site/     (in the /fr/ nav  → depth 2 from `/`)
 *
 * The sitemap page is on every page's nav, so each emitted employer profile
 * lands at depth ≤ 3 (IT ≤ 2) — well inside the audit's MAX_DEPTH=4.
 *
 * Idempotent via the `data-employer-profiles-links` marker, distinct from
 * {@link professionCantonLandingsLinksPlugin}'s own marker on the same page —
 * see `build-plugins/shared/injectAfterMain.ts` for why two independent
 * injectors can safely target one file.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { employerProfilesFlushed, staticPagesFlushed, type EmittedEmployerProfile } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale, type EmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR as SITEMAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-employer-profiles-links';

const BLOCK_COPY: Record<EmitLocale, { heading: string; intro: string }> = {
  it: {
    heading: 'Aziende in Svizzera',
    intro: 'Profili aziendali con posizioni aperte, stipendio mediano e sedi reali.',
  },
  en: {
    heading: 'Companies in Switzerland',
    intro: 'Employer profiles with open positions, median salary and real locations.',
  },
  de: {
    heading: 'Unternehmen in der Schweiz',
    intro: 'Arbeitgeberprofile mit offenen Stellen, Medianlohn und echten Standorten.',
  },
  fr: {
    heading: 'Entreprises en Suisse',
    intro: 'Profils d’employeurs avec postes ouverts, salaire médian et sites réels.',
  },
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
export function renderEmployerLinksBlock(locale: EmitLocale, items: readonly LinkItem[]): string {
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
 * Group emitted employer profiles into per-locale, sorted link items.
 * Exported for unit testing the grouping without touching disk.
 */
export function buildEmployerLinkItems(
  profiles: readonly EmittedEmployerProfile[],
): Record<EmitLocale, LinkItem[]> {
  const byLocale: Record<EmitLocale, LinkItem[]> = { it: [], en: [], de: [], fr: [] };
  for (const p of profiles) {
    byLocale[p.locale].push({ href: p.path, label: p.label });
  }
  for (const loc of Object.keys(byLocale) as EmitLocale[]) {
    byLocale[loc].sort((a, b) => a.label.localeCompare(b.label));
  }
  return byLocale;
}

export function employerProfilePagesLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'employer-profile-pages-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_EMPLOYER_PROFILE_PAGES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Wait for the profile emitter (gives us the emitted profiles) AND
      // staticPagesPlugin (writes the sitemap pages we patch) so both
      // producers have flushed to disk before we read+patch — mirrors
      // professionCantonLandingsLinksPlugin's race fix.
      const [profiles] = await Promise.all([
        employerProfilesFlushed,
        staticPagesFlushed,
      ]);

      if (profiles.length === 0) {
        console.log('\x1b[36m[employer-profile-pages-links]\x1b[0m No emitted profiles — nothing to link.');
        return;
      }

      const byLocale = buildEmployerLinkItems(profiles);

      const failures: string[] = [];
      let injected = 0;
      for (const locale of Object.keys(SITEMAP_PAGE_DIR) as EmitLocale[]) {
        // Per-locale shard build (BUILD_LOCALE): skip locales this shard did
        // not emit — their sitemap pages are absent and would hard-fail as
        // missing-file. No-op in the default all-locale build.
        if (!shouldEmitLocale(locale)) continue;
        const items = byLocale[locale];
        if (items.length === 0) continue; // nothing emitted for this locale
        const indexPath = np.join(distDir, SITEMAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          failures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderEmployerLinksBlock(locale, items);
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
        `\x1b[36m[employer-profile-pages-links]\x1b[0m Injected employer-profile links into ${injected} locale sitemap page(s).`,
      );

      // Hard-fail on any miss: an un-patched sitemap page re-opens the
      // sitemap-employer-profiles.xml orphan tier the audit hard-fails on.
      if (failures.length > 0) {
        throw new Error(
          `[employer-profile-pages-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-employer-profiles.xml (audit:max-bfs-depth). ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
