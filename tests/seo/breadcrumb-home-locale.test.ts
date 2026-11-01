import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { localeHomeUrl, localizeBreadcrumbHome } from '../../build-plugins/shared/breadcrumbHome';
import { normalizeStaticJsonLdScripts } from '../../build-plugins/shared/seoPageShell';

const ROOT = 'https://frontaliereticino.ch';

function crumbs(home: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: home },
      { '@type': 'ListItem', position: 2, name: 'Section', item: `${ROOT}/en/section/` },
    ],
  };
}

describe('BreadcrumbList home crumb follows the page locale', () => {
  it.each([
    ['en', `${ROOT}/en/`],
    ['de', `${ROOT}/de/`],
    ['fr', `${ROOT}/fr/`],
    ['it', `${ROOT}/`],
  ])('%s', (locale, expected) => {
    for (const home of [ROOT, `${ROOT}/`]) {
      const [script] = normalizeStaticJsonLdScripts([JSON.stringify(crumbs(home))], { locale });
      expect(JSON.parse(script).itemListElement[0].item).toBe(expected);
    }
    expect(localeHomeUrl(locale, ROOT)).toBe(expected);
  });

  it('leaves a section first crumb and later crumbs untouched', () => {
    const list = {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { position: 1, name: 'Pharmacy directory', item: `${ROOT}/en/pharmacies/` },
        { position: 2, name: 'Root by mistake', item: `${ROOT}/` },
      ],
    };
    expect(localizeBreadcrumbHome(list, 'en')).toEqual(list);
  });

  it('reaches a BreadcrumbList nested in @graph and in arrays', () => {
    const graph = { '@graph': [crumbs(`${ROOT}/`)] };
    expect(localizeBreadcrumbHome(graph, 'de')['@graph'][0].itemListElement[0].item).toBe(`${ROOT}/de/`);
    expect(localizeBreadcrumbHome([crumbs(ROOT)], 'fr')[0].itemListElement[0].item).toBe(`${ROOT}/fr/`);
  });

  it('keeps emitters that bypass the shell off the Italian root', () => {
    const rootHome = /position: 1, name: 'Home', item: `\$\{BASE_URL\}\/`/;
    for (const file of [
      'build-plugins/jobSectorPagesPlugin.ts',
      'build-plugins/jobRecencyPagesPlugin.ts',
      'packages/articles/engine/ogPagesPlugin.ts',
      'packages/articles/engine/articleHubPagesPlugin.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(rootHome);
    }
  });
});
