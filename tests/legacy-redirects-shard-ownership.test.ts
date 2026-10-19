import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://frontaliereticino.ch';
const sections = {
  it: '/prezzi-benzina', en: '/en/gasoline-price-switzerland',
  de: '/de/benzinpreis-schweiz', fr: '/fr/prix-essence-suisse',
};
const aliases = {
  it: '/servizi-partner/', en: '/en/partner-services/',
  de: '/de/partner-dienste/', fr: '/fr/services-partenaires/',
};
const month = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
  .toLocaleDateString('sv-SE').slice(0, 7);
const page = (url: string) => '<!doctype html><html><head>'
  + `<link rel="canonical" href="${BASE}${url}"></head><body>Historical fuel observations</body></html>`;
let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('legacy redirects respect locale-shard ownership before gap-fill', () => {
  it.each(['it', 'en', 'de', 'fr', 'en,de', undefined])(
    'keeps the cross-shard fuel sitemap complete for BUILD_LOCALE=%s', async buildLocale => {
      vi.resetModules();
      vi.stubEnv('BUILD_LOCALE', buildLocale);
      vi.stubEnv('BUILD_EMIT_SKIP', '');
      const { legacyRedirectsPlugin } = await import('../build-plugins/legacyRedirectsPlugin');
      const { reconcileSitemapFuelWithDist } = await import('../build-plugins/sitemapAliasPlugin');
      const { extractSitemapLocs } = await import('../build-plugins/relatedSearchClustersPlugin');
      const { shouldEmitPath } = await import('../build-plugins/shared/localeEmitFilter');
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shard-sitemap-'));
      const dist = path.join(root, 'dist');
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(root, 'data/jobs.json'), '[]');
      fs.writeFileSync(path.join(root, 'data/article-redirects.json'), '{}');
      const file = (url: string) => path.join(dist, url.slice(1), 'index.html');
      const writePage = (url: string, html: string) => {
        fs.mkdirSync(path.dirname(file(url)), { recursive: true });
        fs.writeFileSync(file(url), html);
      };
      const archives = Object.values(sections).map(section => `${section}/mendrisio/${month}/`);
      // Same topology as production: the collector writes only owned pages,
      // but the shared IT sitemap lists the healthy URLs in every shard.
      for (const url of archives) if (shouldEmitPath(file(url), dist)) writePage(url, page(url));
      const owned = archives.find(url => shouldEmitPath(file(url), dist))!;
      const ownedSection = owned.slice(0, owned.indexOf('/mendrisio/'));
      const gap = `${ownedSection}/unavailable/${month}/`;
      const drift = `${ownedSection}/drift/${month}/`;
      const missing = `${ownedSection}/missing/${month}/`;
      writePage(drift, page(owned));
      fs.writeFileSync(path.join(root, 'data/seo-404-compat-paths.json'), JSON.stringify({ paths: [...archives, gap] }));
      const sitemap = path.join(dist, 'sitemap-fuel-daily.xml');
      fs.writeFileSync(sitemap, '<urlset>' + [...archives, gap, drift, missing]
        .map(url => `<url><loc>${BASE}${url}</loc></url>`).join('\n') + '</urlset>');

      const hook = legacyRedirectsPlugin(root).closeBundle;
      if (!hook || typeof hook !== 'object' || typeof hook.handler !== 'function') {
        throw new Error('Expected the ordered native legacy emitter');
      }
      await hook.handler.call({} as never);
      for (const [locale, alias] of Object.entries(aliases)) {
        const ownedAlias = shouldEmitPath(file(alias), dist);
        expect(fs.existsSync(file(alias)), `static bridge ${locale}`).toBe(ownedAlias);
        expect(fs.existsSync(path.join(dist, alias.slice(1, -1) + '.html'))).toBe(ownedAlias);
      }
      for (const url of archives) {
        if (shouldEmitPath(file(url), dist)) expect(fs.readFileSync(file(url), 'utf8')).toBe(page(url));
        else {
          expect(fs.existsSync(path.dirname(file(url))), `foreign compat directory ${url}`).toBe(false);
          expect(fs.existsSync(path.join(dist, url.slice(1, -1) + '.html'))).toBe(false);
        }
      }
      expect(fs.readFileSync(file(gap), 'utf8')).toContain('noindex');
      const bridgeBefore = fs.readFileSync(file(gap), 'utf8');
      await expect(reconcileSitemapFuelWithDist(dist)).resolves.toBe(3);
      expect(extractSitemapLocs(fs.readFileSync(sitemap, 'utf8'))).toEqual(archives.map(url => BASE + url));
      // The fix must not weaken dist-truth or destroy historical recovery HTML.
      expect(fs.readFileSync(file(gap), 'utf8')).toBe(bridgeBefore);
      expect(fs.readFileSync(file(drift), 'utf8')).toBe(page(owned));
      expect(fs.existsSync(file(missing))).toBe(false);
    },
  );
});
