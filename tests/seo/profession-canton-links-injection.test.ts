/**
 * Regression test for the per-canton profession-links injector
 * (build-plugins/professionCantonLandingsLinksPlugin.ts).
 *
 * Guards the pure grouping/render logic that de-orphans the ~332
 * /lavoro-{canton}-{role}/ pages: they were shipping at BFS depth `unreachable`
 * (audit:max-bfs-depth hard-fail, reached 0/332) because nothing on a crawlable
 * page linked into them. The plugin injects a per-locale link block into each
 * HTML sitemap page (main-nav reachable → canton pages at depth ≤ 3).
 */
import { describe, it, expect } from 'vitest';
import {
  buildCantonLinkItems,
  renderCantonLinksBlock,
} from '../../build-plugins/professionCantonLandingsLinksPlugin';
import {
  buildProfessionCantonPath,
  PROFESSION_CANTON_KEYS,
} from '../../build-plugins/professionCantonData';
import { PROFESSION_IDS } from '../../build-plugins/professionLandingsData';

const MARKER = 'data-profession-cantons-links';

describe('buildCantonLinkItems — group emitted paths by locale', () => {
  it('routes each emitted canonical path to its locale bucket with a derived label', () => {
    const canton = PROFESSION_CANTON_KEYS[0];
    const role = PROFESSION_IDS[0];
    const paths = [
      buildProfessionCantonPath('it', canton, role),
      buildProfessionCantonPath('en', canton, role),
      buildProfessionCantonPath('de', canton, role),
      buildProfessionCantonPath('fr', canton, role),
    ];

    const byLocale = buildCantonLinkItems(paths);

    expect(byLocale.it).toHaveLength(1);
    expect(byLocale.en).toHaveLength(1);
    expect(byLocale.de).toHaveLength(1);
    expect(byLocale.fr).toHaveLength(1);
    // href is the exact emitted canonical path (trailing slash preserved).
    expect(byLocale.it[0].href).toBe(buildProfessionCantonPath('it', canton, role));
    expect(byLocale.it[0].href.endsWith('/')).toBe(true);
    // Label carries both role and canton for crawlable anchor text.
    expect(byLocale.it[0].label).toContain('·');
    expect(byLocale.it[0].label.length).toBeGreaterThan(3);
  });

  it('sorts items within a locale by label (deterministic output)', () => {
    const role = PROFESSION_IDS[0];
    const paths = PROFESSION_CANTON_KEYS.slice(0, 5).map((c) =>
      buildProfessionCantonPath('it', c, role),
    );
    const byLocale = buildCantonLinkItems([...paths].reverse());
    const labels = byLocale.it.map((i) => i.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('ignores paths that are not per-canton profession landings', () => {
    const byLocale = buildCantonLinkItems(['/not-a-canton-page/', '/en/random/']);
    expect(byLocale.it).toHaveLength(0);
    expect(byLocale.en).toHaveLength(0);
  });
});

describe('renderCantonLinksBlock', () => {
  it('returns an empty string when there are no links (locale skipped)', () => {
    expect(renderCantonLinksBlock('it', [])).toBe('');
  });

  it('emits the idempotency marker, heading and one <a> per item', () => {
    const html = renderCantonLinksBlock('it', [
      { href: '/lavoro-argovia-infermiere/', label: 'Infermiere · Argovia' },
      { href: '/lavoro-basilea-cuoco/', label: 'Cuoco · Basilea' },
    ]);
    expect(html).toContain(MARKER);
    expect(html).toContain('href="/lavoro-argovia-infermiere/"');
    expect(html).toContain('href="/lavoro-basilea-cuoco/"');
    expect((html.match(/<a /g) ?? []).length).toBe(2);
  });

  it('escapes HTML-significant characters in labels and hrefs', () => {
    const html = renderCantonLinksBlock('it', [
      { href: '/x/?a=1&b=2', label: 'A & B <x>' },
    ]);
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<x>');
  });
});
