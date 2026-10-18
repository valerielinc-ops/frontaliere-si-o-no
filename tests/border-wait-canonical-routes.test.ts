import { describe, expect, it } from 'vitest';
import {
  BORDER_WAIT_LEGACY_REDIRECTS,
  BORDER_WAIT_PRIMARY_LEGACY_BASES,
  canonicalizeBorderWaitLinks,
} from '@/build-plugins/shared/borderWaitLegacyRedirects';
import { BORDER_WAIT_CROSSINGS, buildOggiPath, buildRootHubPath } from '@/build-plugins/borderWaitData';
import { buildBorderWaitTodayPath } from '../scripts/lib/borderWaitSections.mjs';
import { WEATHER_BORDER_LEGACY_REDIRECTS } from '../scripts/lib/weather-border-links.mjs';

describe('border-wait canonical route migration', () => {
  it('shares the unchanged canonical builder for every known crossing and locale', () => {
    expect(buildOggiPath('it', 'ponte-tresa')).toBe('/traffico-dogane/ponte-tresa/oggi/');
    expect(buildOggiPath('en', 'ponte-tresa')).toBe('/en/border-wait/ponte-tresa/today/');
    expect(buildOggiPath('de', 'ponte-tresa')).toBe('/de/wartezeit-grenze/ponte-tresa/heute/');
    expect(buildOggiPath('fr', 'ponte-tresa')).toBe('/fr/temps-attente-douane/ponte-tresa/aujourd-hui/');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const crossing of BORDER_WAIT_CROSSINGS) {
        expect(buildBorderWaitTodayPath(locale, crossing)).toBe(buildOggiPath(locale, crossing));
      }
    }
    expect(Object.keys(WEATHER_BORDER_LEGACY_REDIRECTS)).toHaveLength(15);
  });

  it('leaves unknown weather crossings, archives and deeper neighbours unchanged', () => {
    for (const base of ['/en/border-traffic', '/de/grenze-verkehr', '/fr/trafic-frontalier']) {
      for (const tail of ['unknown/oggi/', 'chiasso-centro/oggi/', 'ponte-tresa/2026-04/', 'ponte-tresa/oggi/unknown/', 'ponte-tresa/oggix/']) {
        const from = `${base}/${tail}`;
        expect(BORDER_WAIT_LEGACY_REDIRECTS.has(from)).toBe(false);
        const html = `<a href="${from}">Keep</a>`;
        expect(canonicalizeBorderWaitLinks(html)).toBe(html);
      }
    }
  });

  it.each((['en', 'de', 'fr'] as const).flatMap(locale =>
    (['chiasso-brogeda', 'oria-gandria', 'rodero-stabio', 'gaggiolo', 'ponte-tresa'] as const).map(crossing => ({ locale, crossing })),
  ))('recovers the weather producer alias $locale/$crossing without a chain', ({ locale, crossing }) => {
    const base = { en: '/en/border-traffic', de: '/de/grenze-verkehr', fr: '/fr/trafic-frontalier' }[locale];
    const from = `${base}/${crossing}/oggi/`;
    const target = buildOggiPath(locale, crossing);
    expect(BORDER_WAIT_LEGACY_REDIRECTS.get(from)).toBe(target);
    expect(BORDER_WAIT_LEGACY_REDIRECTS.has(target)).toBe(false);
    expect(canonicalizeBorderWaitLinks(`<a href="${from}?source=weather">Crossing</a>`)).toBe(`<a href="${target}?source=weather">Crossing</a>`);
  });

  it('bridges every sitemap-backed guide route to the current live vertical', () => {
    for (const [locale, base] of Object.entries(BORDER_WAIT_PRIMARY_LEGACY_BASES)) {
      expect(BORDER_WAIT_LEGACY_REDIRECTS.get(`${base}/`)).toBe(buildRootHubPath(locale as 'it' | 'en' | 'de' | 'fr'));
      for (const crossing of BORDER_WAIT_CROSSINGS) {
        const from = `${base}/${crossing}/`;
        expect(BORDER_WAIT_LEGACY_REDIRECTS.get(from), from).toBe(buildOggiPath(locale as 'it' | 'en' | 'de' | 'fr', crossing));
      }
    }
  });

  it('normalizes the hand-authored crossing aliases without creating redirect chains', () => {
    const aliases = new Map([
      ['/guida-frontaliere/tempi-attesa-dogana/brogeda-chiasso/', '/traffico-dogane/chiasso-brogeda/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/chiasso-centro-ponte-chiasso/', '/traffico-dogane/chiasso-centro/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/gaggiolo-cantello-stabio/', '/traffico-dogane/gaggiolo/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/ponte-chiasso/', '/traffico-dogane/chiasso-centro/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/novazzano/', '/traffico-dogane/bizzarone-novazzano/oggi/'],
      ['/guida-frontaliere/tempi-attesa-dogana/stabio/', '/traffico-dogane/gaggiolo/oggi/'],
      ['/tempi-attesa-confine/chiasso-brogeda/', '/traffico-dogane/chiasso-brogeda/oggi/'],
      ['/en/border-traffic/gaggiolo/oggi/', '/en/border-wait/gaggiolo/today/'],
    ]);

    for (const [from, to] of aliases) {
      expect(BORDER_WAIT_LEGACY_REDIRECTS.get(from), from).toBe(to);
      expect(BORDER_WAIT_LEGACY_REDIRECTS.get(to)).toBeUndefined();
    }
  });

  it('rewrites embedded legacy links to direct canonical targets', () => {
    const html = '<a href="/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/">Brogeda</a>'
      + ' <a href="/en/cross-border-guide/border-waiting-times/">Border waits</a>';
    const rewritten = canonicalizeBorderWaitLinks(html);
    expect(rewritten).toContain('href="/traffico-dogane/chiasso-brogeda/oggi/"');
    expect(rewritten).toContain('href="/en/border-wait/"');
    expect(rewritten).not.toContain('border-waiting-times');
  });
});
