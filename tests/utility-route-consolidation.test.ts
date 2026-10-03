import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLUG_TABLES } from '../services/routeSlugs.data';
import { buildFaqHubPath } from '../data/faq-hub/routes';

const root = path.resolve(__dirname, '..');
const sitemap = fs.readFileSync(path.join(root, 'public/sitemap-pages.xml'), 'utf8');
const redirects = fs.readFileSync(path.join(root, 'build-plugins/legacyRedirectsPlugin.ts'), 'utf8');

describe('canonical utility route families', () => {
  it('keeps complete FAQ hub HTML under its dedicated plugin ownership', () => {
    const source = fs.readFileSync(path.join(root, 'build-plugins/staticPagesPlugin.ts'), 'utf8');
    expect(source).toContain('if (FAQ_HUB_ROUTES.includes(`${normalizedPath}/`)) continue;');
    expect(source).toContain('if (ogPagesPaths.has(locNormalized) || FAQ_HUB_ROUTES.includes(`${locNormalized}/`)) continue;');
  });
  it.each([
    ['/about/', '/en/about-us/'],
    ['/contact/', '/en/contact-us/'],
    ['/privacy-policy/', '/en/privacy/'],
    ['/en/cross-border-faq/', '/en/frequently-asked-questions/'],
    ['/de/grenzgaenger-faq/', '/de/haeufige-fragen/'],
    ['/fr/faq-frontaliers/', '/fr/questions-frequentes/'],
  ])('retires %s from sitemap and keeps its bridge to %s', (from, to) => {
    expect(sitemap).not.toContain(`https://frontaliereticino.ch${from}`);
    expect(redirects).toContain(`'${from}': '${to}'`);
    expect(sitemap).toContain(`https://frontaliereticino.ch${to}`);
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('uses the existing FAQ hub for the %s route and sitemap', (locale) => {
    const route = `${locale === 'it' ? '' : `/${locale}`}/${SLUG_TABLES[locale].faq}/`;
    expect(route).toBe(buildFaqHubPath(locale));
    const faqGroup = sitemap.match(/<url>\s*<loc>https:\/\/frontaliereticino\.ch\/domande-frequenti-frontalieri\/<\/loc>[\s\S]*?<\/url>/)?.[0];
    expect(faqGroup).toContain(`hreflang="${locale}" href="https://frontaliereticino.ch${route}"`);
  });
});
