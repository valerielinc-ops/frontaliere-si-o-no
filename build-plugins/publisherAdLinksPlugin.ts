/**
 * Publisher-ad detail pages — internal-links injector.
 *
 * {@link publisherAdPagesPlugin} emits `/lavoro/{slug}/` (+ locale twins) —
 * paid content publishers bought a listing for — but no job-card renderer
 * anywhere on the site respects the ad's own canonical URL (they all build
 * their own canton/section href instead), so the family shipped with zero
 * crawlable inbound link (`audit:max-bfs-depth`, currently 1/1 URLs
 * unreachable — small today, but this is paid revenue content and will grow
 * as the publisher portal sells more listings).
 *
 * Rather than touch the many job-card call sites across the much larger
 * `jobsSeoPagesPlugin.ts` (broad, risky change for a currently-tiny family),
 * this plugin follows the same low-risk pattern already used for the other
 * orphaned tiers in this build: after the ad emitter AND staticPagesPlugin
 * flush, it injects a small "Offerte sponsorizzate" CTA block into each
 * locale's HTML sitemap page:
 *
 *   it → /mappa-del-sito/      (in the main nav → depth 1 from `/`)
 *   en → /en/site-map/         (in the /en/ nav  → depth 2 from `/`)
 *   de → /de/seitenplan/       (in the /de/ nav  → depth 2 from `/`)
 *   fr → /fr/plan-du-site/     (in the /fr/ nav  → depth 2 from `/`)
 *
 * Idempotent via the `data-publisher-ads-links` marker — see
 * `build-plugins/shared/injectAfterMain.ts` for why independent injectors
 * can safely stack on one file.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { publisherAdsFlushed, staticPagesFlushed, type EmittedPublisherAd } from './shared/buildSignals';
import { injectBlockAfterMain } from './shared/injectAfterMain';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SITE_MAP_PAGE_DIR as SITEMAP_PAGE_DIR } from './shared/siteMapPageDir';

const MARKER = 'data-publisher-ads-links';

const BLOCK_COPY: Record<EmittedPublisherAd['locale'], { heading: string; intro: string }> = {
  it: { heading: 'Offerte sponsorizzate', intro: 'Posizioni pubblicate direttamente dai datori di lavoro.' },
  en: { heading: 'Sponsored listings', intro: 'Positions published directly by employers.' },
  de: { heading: 'Gesponserte Stellen', intro: 'Von Arbeitgebern direkt veröffentlichte Stellen.' },
  fr: { heading: 'Offres sponsorisées', intro: 'Postes publiés directement par les employeurs.' },
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
export function renderPublisherAdsLinksBlock(
  locale: EmittedPublisherAd['locale'],
  items: readonly LinkItem[],
): string {
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

/** Group emitted ads into per-locale, sorted link items. Exported for unit testing. */
export function buildPublisherAdLinkItems(
  ads: readonly EmittedPublisherAd[],
): Record<EmittedPublisherAd['locale'], LinkItem[]> {
  const byLocale: Record<EmittedPublisherAd['locale'], LinkItem[]> = { it: [], en: [], de: [], fr: [] };
  for (const ad of ads) {
    byLocale[ad.locale].push({ href: ad.path, label: ad.label });
  }
  for (const loc of Object.keys(byLocale) as EmittedPublisherAd['locale'][]) {
    byLocale[loc].sort((a, b) => a.label.localeCompare(b.label));
  }
  return byLocale;
}

export function publisherAdLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'publisher-ad-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_PUBLISHER_AD_PAGES === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const [ads] = await Promise.all([
        publisherAdsFlushed,
        staticPagesFlushed,
      ]);

      if (ads.length === 0) {
        console.log('\x1b[36m[publisher-ad-links]\x1b[0m No emitted ads — nothing to link.');
        return;
      }

      const byLocale = buildPublisherAdLinkItems(ads);

      const failures: string[] = [];
      let injected = 0;
      for (const locale of Object.keys(SITEMAP_PAGE_DIR) as EmittedPublisherAd['locale'][]) {
        if (!shouldEmitLocale(locale)) continue;
        const items = byLocale[locale];
        if (items.length === 0) continue;
        const indexPath = np.join(distDir, SITEMAP_PAGE_DIR[locale], 'index.html');
        if (!fs.existsSync(indexPath)) {
          failures.push(` - [missing-file] ${np.relative(distDir, indexPath)}`);
          continue;
        }
        const html = fs.readFileSync(indexPath, 'utf-8');
        const block = renderPublisherAdsLinksBlock(locale, items);
        const { html: patched, outcome } = injectBlockAfterMain(html, block, MARKER);
        if (outcome === 'inserted') {
          fs.writeFileSync(indexPath, patched, 'utf-8');
          injected++;
        } else if (outcome === 'no-anchor') {
          failures.push(` - [no-anchor] ${np.relative(distDir, indexPath)}`);
        }
      }

      console.log(
        `\x1b[36m[publisher-ad-links]\x1b[0m Injected publisher-ad links into ${injected} locale sitemap page(s).`,
      );

      if (failures.length > 0) {
        throw new Error(
          `[publisher-ad-links] failed to inject into ${failures.length} target(s):\n${failures.join('\n')}\n\n` +
            'This re-orphans sitemap-publisher-ads.xml (audit:max-bfs-depth) — paid revenue content. ' +
            'The target sitemap page did not exist after staticPagesFlushed (race / slug drift) ' +
            'or had no <main>/</main>/</body> anchor. See build-plugins/shared/injectAfterMain.ts.',
        );
      }
    },
  };
}
