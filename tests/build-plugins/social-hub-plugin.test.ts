import { describe, expect, it } from 'vitest';

import {
  __renderSocialHubPageForTest,
  __socialHubPathsForTest,
  socialHubPlugin,
} from '../../build-plugins/socialHubPlugin';

describe('social profile landing pages', () => {
  it('emits four locale routes with reciprocal same-origin paths', () => {
    expect(__socialHubPathsForTest()).toEqual({
      it: '/social/',
      en: '/en/social/',
      de: '/de/social/',
      fr: '/fr/social/',
    });
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('%s page is localized, indexable and useful without JavaScript', (locale) => {
    const { canonicalPath, html, wordCount } = __renderSocialHubPageForTest(locale, 'dist');
    const localizedJobLabel = {
      it: 'Offerte di lavoro in Ticino',
      en: 'Jobs in Ticino',
      de: 'Stellen im Tessin',
      fr: 'Emplois au Tessin',
    }[locale];
    const localizedDigestPath = {
      it: '/digest-settimanale/',
      en: '/en/weekly-digest/',
      de: '/de/woechentlicher-bericht/',
      fr: '/fr/digest-hebdomadaire/',
    }[locale];

    expect(wordCount).toBeGreaterThanOrEqual(50);
    expect(html).toContain(`https://frontaliereticino.ch${canonicalPath}`);
    expect(html).toContain('<main class="seo-static-content sh-main');
    expect(html).toMatch(/hreflang=(?:"x-default"|x-default)/u);
    expect(html).toContain(localizedJobLabel);
    expect(html).toContain('aria-label=');
    expect(html).toContain(`href="${localizedDigestPath}"`);
  });

  it('uses the static build plugin contract and emits in the final plugin phase', () => {
    const plugin = socialHubPlugin('project-root');
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
    expect(plugin.closeBundle).toBeTypeOf('function');
  });
});
